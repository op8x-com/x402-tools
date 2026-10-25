# @op8x/analytics

Fail-open request analytics for x402 sellers on Cloudflare Workers. A Hono middleware that writes one metadata record per request: was it unpaid, was a 402 challenge issued, did a payment arrive, did a receipt come back, was the paid response delivered.

> **Pre-release (0.0.1), not on npm yet.** `npm install @op8x/analytics` does not work today. Build it from a clone, see below.

Records go to an HTTP endpoint you choose (`endpoint`) and/or to the Worker log (`log: true`, read it with `wrangler tail`). There is no default endpoint: without `endpoint` nothing leaves your Worker. With neither option set, the middleware logs one warning on the first request and records nothing.

## Install

From a clone:

```
git clone https://github.com/op8x-com/x402-tools
cd x402-tools/packages/analytics
npm ci
npm run build
```

Then, in your seller project:

```
npm install --install-links <path-to>/x402-tools/packages/analytics
```

`--install-links` copies the package instead of linking it. Without it, the linked package resolves its own copy of `hono` (a dev dependency in the clone) next to yours, and `route` in the records comes out empty, with one warning `op8x.analytics: route unavailable (duplicate hono copy?)` if the fallback lookup fails as well.

`hono` (^4.8.0) is a peer dependency. The package has no runtime dependencies.

## Quick start

The snippet also uses these packages (the 2.28 line is what the example is tested with):

```
npm install hono @x402/hono@~2.28.0 @x402/core@~2.28.0 @x402/evm@~2.28.0
```

```ts
import { Hono, type MiddlewareHandler } from "hono";
import { analytics } from "@op8x/analytics/hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const app = new Hono();

// Analytics goes first, so it sees the 402 that the payment middleware produces.
app.use(analytics({ log: true }));

// Workers forbid network I/O in global scope, and paymentMiddleware() contacts the
// facilitator when it is created. Build it on the first request instead.
let pay: MiddlewareHandler | undefined;
app.use(async (c, next) => {
  pay ??= paymentMiddleware(
    {
      "GET /paid": {
        accepts: { scheme: "exact", price: "$0.01", network: "eip155:84532", payTo: "0xYourAddress" },
        description: "Paid route",
      },
    },
    new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://your-facilitator.example" })).register(
      "eip155:84532",
      new ExactEvmScheme(),
    ),
  );
  return pay(c, next);
});

app.get("/paid", (c) => c.json({ ok: true }));

export default app;
```

Deploy or run `wrangler dev`, send a request, and watch the log with `wrangler tail`:

```
op8x.analytics {"v":1,"id":"...","ts":"2026-10-25T16:13:37.144Z","ms":19,"method":"GET","route":"/paid","status":402,"ua":"curl","type":"challenge.issued","challenge":{"location":"header","version":2,"error":"Payment required","accepts":[{"scheme":"exact","network":"eip155:84532","amount":"10000","asset":"0x036C..."}]}}
```

Build `analytics()` once per isolate (at module scope, as above, or lazily once), not per request. One-time warnings are deduplicated per isolate either way, but a per-request instance does needless setup work on every request.

A complete, runnable app with a local fake facilitator (no money, no network) is in [`examples/workers`](examples/workers).

The middleware works at the transport level: it reads request headers, the response status and headers, and, for 402 responses only, a copy of the response body. It does not depend on `@x402/hono` or `@x402/core`, so it also records hand-written 402 responses.

## Options

```ts
analytics({
  endpoint: "https://collector.example/v1/events",
  log: true,
  salt: "a-long-random-secret",
  timeoutMs: 2000,
  chainCheck: false,
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `endpoint` | none | `https` URL that receives each record as a JSON `POST` (`http` only for `localhost` and `127.0.0.1`). Omitted: no network sends. An invalid value is not an error: one warning is logged and sending stays off. |
| `log` | `false` | Write one `console.log("op8x.analytics", <json>)` line per record. |
| `salt` | none | Enables the `payer` field (a keyed hash of the payer address). Omitted: no `payer` field at all. A blank or non-string value also disables hashing and logs one warning, `op8x.analytics: salt must be a non-empty string, payer hashing disabled`. Keep it secret. |
| `timeoutMs` | `2000` | Abort the send after this long; also the limit for reading the 402 body copy. Clamped to 100..10000. |
| `chainCheck` | `false` | Add `receipt.transaction` so the collector can confirm settlement on-chain. Omitted: the transaction hash is never read. |

## Record fields

Version 1. One record per request that passes through the middleware. Strings are trimmed, stripped of control characters (including Unicode bidi controls) and capped at 128 characters (256 for `challenge.error` and `receipt.errorReason`). Unknown or undecodable values are omitted, never guessed.

| Field | Meaning |
| --- | --- |
| `v` | Record format version, `1`. |
| `id` | Random UUID per request. |
| `ts` | ISO 8601 time the request started. |
| `ms` | Time spent downstream of the middleware, in milliseconds. |
| `method` | HTTP method. |
| `route` | Pattern of the last matched route registered after the middleware, such as `/posts/:id`. `app.use` middlewares and `app.all()` handlers (method `ALL`) are ignored, so a handler registered with `app.all()` records `""`, as does a request where no such route matched. Never the concrete path. |
| `status` | Final response status. |
| `ua` | User-Agent class: `x402-client`, `axios`, `node`, `python`, `go`, `curl`, `browser`, `op8x`, `none` or `other`. The raw header is never stored. |
| `type` | `payment.received` when the request carried a payment header, else `challenge.issued` for a 402, else `request.unpaid`. |
| `challenge` | With status 402. `location` (`header`, `body`, `both`, `none`), `version` (1 or 2), `drift` (header and body challenges both present and different), `error`, and up to 5 `accepts` entries with `scheme`, `network`, `amount`, `asset`. |
| `payment` | When a payment header was sent. `header` (`PAYMENT-SIGNATURE` or `X-PAYMENT`), `decodable`, `version`, `scheme`, `network`, `amount`, `asset`, and `payer` (first 32 hex characters of HMAC-SHA-256 over the lowercase address, only with `salt`). The address is taken from the receipt's `payer`, falling back to `payload.authorization.from` in the payment header, and is hashed with the salt; it can be present even when the payment header itself was undecodable (`decodable: false`). |
| `receipt` | When a receipt header came back. `header` (`PAYMENT-RESPONSE` or `X-PAYMENT-RESPONSE`), `decodable`, `success`, `network`, `errorReason`, and `transaction` only with `chainCheck: true`. |
| `delivery` | With `payment`: `ok` when the final status is below 400, else `failed`. |

## What is never collected

- Request bodies and response bodies. The one exception is the 402 challenge: only the fields listed above are taken from it, and at most 64 KB of the body is read.
- IP addresses (`cf-connecting-ip`, `x-forwarded-for` and any other source).
- The URL path and query string; only the route pattern is recorded.
- Cookies, `authorization` and the raw User-Agent.
- Payment signatures and the payment payload, except the payer address, which is hashed with your `salt` before it leaves the middleware and is not recorded at all without a `salt`.
- The receipt's transaction hash, unless you set `chainCheck: true`. With `chainCheck: true` the record includes the public transaction hash so the collector can confirm settlement on-chain. The hash links the record to the payer address on-chain. op8x's hosted collector uses it only for that check, stores only the result and deletes the hash afterwards. If you point `endpoint` at your own server, handle it the same way. With `log: true` the hash also appears in the Worker log, where this deletion does not apply.

## Guarantees

- **Fail-open.** Errors inside the middleware are caught and never reach your code. An unreachable, slow, failing or misconfigured endpoint changes nothing for your API and its buyers. One send attempt per request, aborted after `timeoutMs`; send failures produce at most one warning per minute per isolate for each kind of failure, without record data. Each send is a `POST` with the headers `content-type` and `user-agent` only; the Workers runtime itself may add a `cf-worker` header to outgoing requests.
- **No added latency.** Body copy, hashing, sending and logging run after the response is returned, through `waitUntil`. Before returning, the middleware only reads headers and starts one `clone()` of a 402 response.
- **Response unchanged.** Status, headers and body leave the middleware exactly as they arrived. Errors thrown by your own handlers propagate unchanged.

## Workers notes

- **Compatibility date.** With `compatibility_date = "2026-10-01"` or later, `@x402/hono` runs without the `nodejs_compat` flag. With `2024-09-01` the build fails because `@x402/extensions` imports `url`; older projects need `nodejs_compat` or a newer date.
- **Global scope.** Do not call `paymentMiddleware(...)` at module top level: it contacts the facilitator, which Workers forbid in global scope. Requests to routes protected by the payment middleware then return 500 ("Disallowed operation called within global scope"); unprotected routes keep working. Build it lazily on the first request as in the quick start.
- **Body challenges over 64 KB.** Only the first 64 KB of a 402 body are read, and only within `timeoutMs`. A longer or slower body challenge is truncated, does not parse, and is recorded as `location: "none"` (or `"header"` when a header challenge is present).
- **`ms` on Workers.** Workers advance the clock only across I/O, so `ms` covers time spent waiting on I/O downstream (fetches, KV, the facilitator); CPU time in your handlers does not advance it.

## Not in 0.0.1

No batching, retries, sampling or persistence; no adapters other than Hono; no default endpoint.

## Links

- Website: <https://op8x.com>
- Source: <https://github.com/op8x-com/x402-tools>
- Also free for sellers: `npx @op8x/cli check <url>` diagnoses the 402 challenge of an endpoint.

MIT license.
