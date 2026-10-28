import { Hono, type MiddlewareHandler } from "hono";
import { analytics } from "@op8x/analytics/hono";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const NETWORK = "eip155:84532"; // Base Sepolia (testnet)
const PRICE = "$0.001";

interface Bindings {
  FACILITATOR_URL: string;
  PAY_TO: string;
  ANALYTICS_ENDPOINT?: string;
  // Write key for the op8x collector, set with `wrangler secret put OP8X_KEY`.
  // The analytics middleware reads it from the environment itself.
  OP8X_KEY?: string;
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
// request ends, so the setup runs only on the paid route, is kept alive with waitUntil, and is
// retried on the next request if it fails.
let pay: Promise<MiddlewareHandler> | undefined;

async function buildPayment(env: Bindings): Promise<MiddlewareHandler> {
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: env.FACILITATOR_URL })).register(
    NETWORK,
    new ExactEvmScheme(),
  );
  const http = new x402HTTPResourceServer(server, {
    "GET /paid": {
      accepts: { scheme: "exact", price: PRICE, network: NETWORK, payTo: env.PAY_TO },
      description: "Demo paid route",
    },
  });
  await http.initialize(); // fetches /supported and validates the route configuration
  return paymentMiddlewareFromHTTPServer(http, undefined, undefined, false);
}

app.use("/paid", async (c, next) => {
  if (!c.env.FACILITATOR_URL || !c.env.PAY_TO) {
    console.error("demo-api: FACILITATOR_URL and PAY_TO must be set");
    return c.json({ error: "not configured" }, 500);
  }
  const ready = (pay ??= buildPayment(c.env));
  c.executionCtx.waitUntil(ready.then(
    () => undefined,
    () => undefined,
  ));
  let handler: MiddlewareHandler;
  try {
    handler = await ready;
  } catch (err) {
    if (pay === ready) pay = undefined;
    console.error("demo-api: payment setup failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "payment setup failed" }, 503);
  }
  return handler(c, next);
});

app.get("/", (c) =>
  c.json({
    about: `Demo x402 API on testnet. GET /paid costs ${PRICE} in USDC on Base Sepolia.`,
    paid: "/paid",
    tools: "https://op8x.com",
  }),
);
app.get("/paid", (c) => c.json({ ok: true, paid: PRICE, network: NETWORK }));

export default app;
