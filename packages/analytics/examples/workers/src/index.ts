import { Hono, type MiddlewareHandler } from "hono";
import { analytics } from "@op8x/analytics/hono";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

interface Bindings {
  FACILITATOR_URL: string;
  ANALYTICS_ENDPOINT?: string;
}

const app = new Hono<{ Bindings: Bindings }>();

// The analytics middleware is built on the first request, because its options come from the
// bindings. It goes first so it sees the 402 challenge that the payment middleware produces.
let track: MiddlewareHandler | undefined;
app.use(async (c, next) => {
  track ??= analytics({ log: true, endpoint: c.env.ANALYTICS_ENDPOINT });
  return track(c, next);
});

// The payment middleware needs the facilitator's /supported answer before it can issue a challenge.
// Workers forbid network I/O in global scope, and I/O started by one request is cancelled when that
// request ends. So the setup runs only on the paid route (never on a free route that happens to
// come first), is kept alive with waitUntil, and is retried on the next request if it fails.
let pay: Promise<MiddlewareHandler> | undefined;

async function buildPayment(env: Bindings): Promise<MiddlewareHandler> {
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: env.FACILITATOR_URL, timeoutMs: 10_000 })).register(
    "eip155:84532",
    new ExactEvmScheme(),
  );
  const http = new x402HTTPResourceServer(server, {
    "GET /paid": {
      accepts: {
        scheme: "exact",
        price: "$0.01",
        network: "eip155:84532", // Base Sepolia (testnet)
        payTo: "0x1111111111111111111111111111111111111111", // dummy address
      },
      description: "Example paid route",
    },
  });
  await http.initialize(); // fetches /supported and validates the route configuration
  return paymentMiddlewareFromHTTPServer(http, undefined, undefined, false);
}

app.use("/paid", async (c, next) => {
  const ready = (pay ??= buildPayment(c.env));
  c.executionCtx.waitUntil(ready.then(() => undefined, () => undefined));
  let handler: MiddlewareHandler;
  try {
    handler = await ready;
  } catch (err) {
    if (pay === ready) pay = undefined; // retry on the next request
    console.error("payment setup failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "payment setup failed" }, 503);
  }
  return handler(c, next);
});

app.get("/", (c) => c.text("free route"));
app.get("/paid", (c) => c.json({ ok: true }));

export default app;
