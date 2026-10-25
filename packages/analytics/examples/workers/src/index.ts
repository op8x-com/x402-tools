import { Hono, type MiddlewareHandler } from "hono";
import { analytics } from "@op8x/analytics/hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

interface Bindings {
  FACILITATOR_URL: string;
  ANALYTICS_ENDPOINT?: string;
}

const app = new Hono<{ Bindings: Bindings }>();

// Workers forbid network I/O in global scope, and paymentMiddleware() starts a request to the
// facilitator when it is created. Build it on the first request instead.
// The analytics middleware is built on the first request too, for simplicity: its options come
// from the bindings, which are read per request here.
let track: MiddlewareHandler | undefined;
let pay: MiddlewareHandler | undefined;

// Analytics goes first so it sees the 402 challenge that the payment middleware produces.
app.use(async (c, next) => {
  track ??= analytics({ log: true, endpoint: c.env.ANALYTICS_ENDPOINT });
  return track(c, next);
});

app.use(async (c, next) => {
  pay ??= paymentMiddleware(
    {
      "GET /paid": {
        accepts: {
          scheme: "exact",
          price: "$0.01",
          network: "eip155:84532", // Base Sepolia (testnet)
          payTo: "0x1111111111111111111111111111111111111111", // dummy address
        },
        description: "Example paid route",
      },
    },
    new x402ResourceServer(new HTTPFacilitatorClient({ url: c.env.FACILITATOR_URL })).register(
      "eip155:84532",
      new ExactEvmScheme(),
    ),
  );
  return pay(c, next);
});

app.get("/", (c) => c.text("free route"));
app.get("/paid", (c) => c.json({ ok: true }));

export default app;
