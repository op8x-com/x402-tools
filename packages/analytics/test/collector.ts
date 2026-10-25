import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { AnalyticsRecord } from "../src/types.ts";

export type CollectorMode = "ok" | "fail" | "hang";

export interface Collector {
  url: string;
  /** Parsed JSON bodies of requests the collector accepted (mode "ok"). */
  records: AnalyticsRecord[];
  /** Every request received, in any mode. */
  requests: Array<{ method: string; headers: IncomingHttpHeaders; body: unknown }>;
  close(): Promise<void>;
}

export async function startCollector(mode: CollectorMode): Promise<Collector> {
  const records: AnalyticsRecord[] = [];
  const requests: Collector["requests"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = undefined;
      }
      requests.push({ method: req.method ?? "", headers: req.headers, body });
      if (mode === "hang") return;
      if (mode === "ok" && body !== undefined) records.push(body as AnalyticsRecord);
      res.writeHead(mode === "ok" ? 204 : 500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/ingest`,
    records,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
