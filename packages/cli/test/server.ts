import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { b64, v1, v2 } from "./fixtures.ts";

export async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const json = (status: number, headers: Record<string, string>, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const challenge = { "payment-required": b64(v2), "cache-control": "no-store" };
    switch (path) {
      case "/v2-good":
        return json(402, challenge, {});
      case "/v2-body-only":
        return json(402, { "cache-control": "no-store" }, v2);
      case "/v1-good":
        return json(402, { "cache-control": "no-store" }, v1);
      case "/drift":
        return json(402, challenge, { ...v2, accepts: [{ ...v2.accepts[0], amount: "20000" }] });
      case "/get-405":
        if (req.method === "GET") {
          res.writeHead(405);
          return res.end();
        }
        return json(402, challenge, {});
      case "/free":
        return json(200, {}, { ok: true });
      case "/redirect":
        res.writeHead(302, { location: "/v2-good" });
        return res.end();
      case "/cors-good":
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "access-control-allow-origin": "https://op8x.com",
            "access-control-allow-headers": "PAYMENT-SIGNATURE, Content-Type, Access-Control-Expose-Headers",
            "access-control-max-age": "600",
          });
          return res.end();
        }
        return json(
          402,
          {
            ...challenge,
            "access-control-allow-origin": "https://op8x.com",
            "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
          },
          {},
        );
      case "/cors-paid-preflight":
        return json(402, { ...challenge, "access-control-allow-origin": "*" }, {});
      case "/echo-preflight":
        res.writeHead(204, {
          "x-echo-method": req.method ?? "",
          "x-echo-origin": String(req.headers["origin"]),
          "x-echo-acrm": String(req.headers["access-control-request-method"]),
          "x-echo-acrh": String(req.headers["access-control-request-headers"]),
        });
        return res.end();
      case "/echo-headers":
        return json(200, {}, { method: req.method, headers: req.headers });
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
