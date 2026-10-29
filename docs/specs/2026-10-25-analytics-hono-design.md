# @op8x/analytics 0.0.1: Hono middleware for Cloudflare Workers

Status: approved design, 2026-10-25. Updated 2026-10-29 to match the implementation. The write key (`key` option, `OP8X_KEY`, `Authorization` header) and the ingest contract are specified in `2026-10-28-analytics-write-key-design.md`.

## Goal

A seller adds one middleware to a Hono app on Cloudflare Workers and gets one metadata record per request: was it unpaid, was a 402 challenge issued, did a payment arrive, did a receipt come back, and was the paid response delivered. Records go to a configurable HTTP endpoint and/or, with `log: true`, to the Worker log (`wrangler tail`).

```ts
import { Hono } from "hono";
import { analytics } from "@op8x/analytics/hono";

const app = new Hono();
app.use(analytics({ endpoint: "https://collector.example/v1/events", log: true }));
app.use(paymentMiddleware(routes, server)); // from @x402/hono, or any other 402 implementation
```

`analytics()` does no I/O when it is created, so it can be built at module top level as above. The Workers example (`examples/workers/src/index.ts`) builds it on the first request instead, because its options come from bindings (`c.env`), which exist only per request; `paymentMiddleware` must be built lazily there anyway (see Background facts).

The middleware works at the transport level: it reads request headers, the response status and response headers, and (only for 402 responses) a copy of the response body. It does not depend on `@x402/hono` or `@x402/core`, so it also sees hand-written 402 responses.

## Hard requirements

1. **Never break the seller's response.** Status, headers and body leave the middleware exactly as they arrived. Errors thrown by the seller's own handlers propagate unchanged; errors inside the middleware are caught and never reach the seller.
2. **Never slow the seller's response.** All work that can wait (body copy, hashing, sending, logging) runs after the response is returned, via `c.executionCtx.waitUntil`. The synchronous part before returning is limited to cheap steps: resolving the write key (including the `OP8X_KEY` lookup in the Hono environment), copying the response headers, walking the matched routes, and starting one `clone()` for 402 responses.
3. **Fail open.** An unreachable, slow, failing or misconfigured endpoint changes nothing for the seller. One send attempt per request, aborted after `timeoutMs`.
4. **Metadata only.** No request or response bodies, no query strings, no concrete paths, no IP addresses, no payment signatures. Every field in a record comes from an explicit allowlist (below).

## Non-goals (0.0.1)

- No default endpoint and no npm release until a collector exists.
- No batching across requests, no retries, no sampling, no persistence.
- No `@x402/core` hooks (verify and settle details come only from what the response carries).
- No adapters other than Hono. Express, Next.js and MCP come later on the same core.
- No configuration beyond the six options below.

## Background facts

Checked on 2026-10-25 against `@x402/core` 2.28.0, `@x402/hono` 2.28.0, `hono` 4.13 and `wrangler` 4.152 (spike under `wrangler dev`):

- Request payment header: v2 `PAYMENT-SIGNATURE`, v1 `X-PAYMENT`; both are base64 of a JSON payment payload. v2 payload: `{ x402Version, resource?, accepted: { scheme, network, amount, asset, payTo, ... }, payload }`. v1 payload: `{ x402Version: 1, scheme, network, payload }`.
- Receipt header: v2 `PAYMENT-RESPONSE`, v1 `X-PAYMENT-RESPONSE`; base64 JSON settle response `{ success, transaction, network, payer?, errorReason?, amount? }`.
- Challenge: v2 in the `PAYMENT-REQUIRED` header (base64 JSON, optional `error` field such as the verify failure reason); v1 in the JSON body. Details in `docs/specs/2026-10-24-cli-check-design.md`.
- **Workers and `@x402/hono`:** with `compatibility_date = "2026-10-01"` both the 402 path and the paid path work without the `nodejs_compat` flag (`Buffer` is available globally). With `compatibility_date = "2024-09-01"` the build fails because `@x402/extensions` imports `url`; older projects need `nodejs_compat` or a newer date.
- **Workers and global scope:** calling `paymentMiddleware(...)` at module top level starts a facilitator request in global scope, which Workers forbid; requests to routes protected by the payment middleware then fail with 500 ("Disallowed operation called within global scope"), while unprotected routes keep working. Building the payment middleware lazily on the first request works. This affects the example app and our docs, not this package.
- `hono/route` exports `matchedRoutes(c)` (since hono 4.8.0). After `await next()` the route is the last matched route registered after the middleware whose method is not `ALL`, else `""` (for example `/posts/:id`); `app.use` middlewares registered after it do not count. `matchedRoutes` reads a module-private Symbol, so with a second hono copy it fails; then the request's own deprecated `c.req.matchedRoutes` getter (present from 4.8 to at least 4.13) is used, and if that fails too, one warning is logged and the route is `""`.

## Package

`packages/analytics`, npm name `@op8x/analytics`, version `0.0.1` (not published), MIT, ESM only, TypeScript strict, same toolchain as `packages/cli` (Node `node:test` on `.ts` sources, `tsc` build).

- Runtime dependencies: none.
- Peer dependency: `hono` `^4.8.0` (4.8.0 is the first version with `hono/route`, verified against the 4.8.0 tarball; 4.7.11 has none). CI (`.github/workflows/ci.yml`) also runs the tests against 4.8.0.
- Exports:
  - `@op8x/analytics` (core): types `AnalyticsOptions`, `AnalyticsRecord`, `ChallengeInfo`, `PaymentInfo`, `ReceiptInfo`, `UaClass`, `RecordInput`, `RecordOptions`, `Transport`, `TransportDeps`; functions `buildRecord`, `hashPayer`, `createTransport`; constant `VERSION`.
  - `@op8x/analytics/hono`: `analytics()` middleware and a re-export of the `AnalyticsOptions` type.
  - Internal helpers shared between units (`clampTimeout`, `validEndpoint` in `transport.ts`; `firstTime`, `rateLimitOk`, `resetWarnings` in `warnings.ts`; `checkKey`, `envKey`, `resolveKey`, `isOp8xEndpoint`, `OP8X_ORIGIN`, `KEY_PREFIX`, the type `KeyResolution` and the warning texts in `key.ts`; `clean`, `parseJson`, `decodeBase64Json` in `decode.ts`; `uaClass` in `ua.ts`) are exported from their files but not from the package entry points.
- Uses only Web APIs available on Workers and Node >= 20: `fetch`, `AbortSignal.timeout`, `crypto.subtle`, `crypto.randomUUID`, `atob`, `TextDecoder`.

### Units

| File | Job | Depends on |
| --- | --- | --- |
| `src/types.ts` | `AnalyticsRecord`, `AnalyticsOptions`, sub-types | none |
| `src/version.ts` | `VERSION` constant, used in the transport User-Agent | none |
| `src/warnings.ts` | Module-scoped warning state: once-per-isolate keys and per-message rate limit, shared by every `analytics()` instance and transport in the isolate | none |
| `src/decode.ts` | Safe base64-JSON decode, never throws: strict padded standard base64 only (length a multiple of 4, no base64url, no whitespace), input capped at 16384 decoded bytes before decoding, UTF-8 decoded with `fatal: true`, result must be a plain JSON object | none |
| `src/ua.ts` | User-Agent to class | none |
| `src/record.ts` | Pure: request headers, response status and headers, optional body text → `AnalyticsRecord` | `decode`, `ua` |
| `src/hash.ts` | HMAC-SHA-256 of the payer address with the seller's salt | `crypto.subtle` |
| `src/key.ts` | Write key: check it, read `OP8X_KEY` from the Hono environment, decide which key a send uses (see the write-key document) | none |
| `src/transport.ts` | Send one record (POST with timeout, optional `Authorization`) and/or log it; swallow and rate-limit errors | `fetch`, `version`, `key`, `warnings` |
| `src/hono.ts` | `analytics(options)` middleware: wires the above into Hono | `hono`, `hono/route`, all above |
| `src/index.ts` | Public exports of the core | all except `hono.ts` |

## Options

```ts
interface AnalyticsOptions {
  endpoint?: string;   // https URL (http allowed only for localhost/127.0.0.1), no username or password; omitted = no network sends
  key?: string;        // write key; see the write-key document
  log?: boolean;       // default false; one console.log line per record
  salt?: string;       // enables payer hashing; omitted = no payer field at all
  timeoutMs?: number;  // default 2000, clamped to 100..10000
  chainCheck?: boolean; // default false; true adds receipt.transaction for an on-chain settlement check
}
```

Invalid options never throw. Warnings, all prefixed `op8x.analytics:`:

| Situation | Warning | When and how often |
| --- | --- | --- |
| Neither `endpoint` nor `log: true` | `no endpoint and log disabled, nothing is recorded` | On a request; once per isolate. The middleware then does no work at all. |
| Invalid `endpoint` (unparsable, wrong scheme, username or password in the URL), `log` not `true` | `invalid endpoint, sending disabled` | On a request; once per isolate. No work at all, as above. |
| Invalid `endpoint`, `log: true` | `invalid endpoint, sending disabled` | From the transport on the first record of each `analytics()` instance, rate-limited to one per 60 s per isolate. Records are still logged. |
| `salt` set but not a string with non-whitespace content | `salt must be a non-empty string, payer hashing disabled` | On the first recorded request of the instance, once per isolate. Never emitted while the middleware is idle (rows 1 and 2). |
| Setting up the middleware throws | `setup failed, analytics disabled` | When `analytics()` is called, once per isolate. Requests then pass through untouched. |
| Send fails (network, timeout, non-2xx) | `send failed (network)`, `send failed (timeout)`, `send failed (status <code>)` | At most one per 60 s per isolate per text, so each status code has its own budget (see Transport). |
| Matched routes unreadable (second hono copy) | `route unavailable (duplicate hono copy?)` | On a request; once per isolate. The record gets route `""`. |
| Key missing, invalid or refused | texts in the write-key document | On each request where nothing can be sent, at most one per 60 s per isolate per text. With `log: true` the record is still logged. |

"Once per isolate" state lives in `src/warnings.ts` at module scope, so a seller who builds `analytics()` per request does not flood the log.

With `chainCheck: true` the record includes the public transaction hash so the collector can confirm settlement on-chain. The hash links the record to the payer address on-chain. op8x's hosted collector uses it only for that check, stores only the result and deletes the hash afterwards. If you point `endpoint` at your own server, handle it the same way. With `log: true` the hash also appears in the Worker log, where this deletion does not apply. Without `chainCheck` the transaction field is never read.

## Record format (version 1)

One record per request that passes through the middleware. All strings are trimmed, stripped of control characters (C0, C1 and Unicode bidi controls) and capped at 128 characters (256 for `challenge.error` and `receipt.errorReason`). Unknown or undecodable values are omitted, never guessed.

```ts
interface AnalyticsRecord {
  v: 1;
  id: string;                 // crypto.randomUUID(), correlates future events of the same request
  ts: string;                 // ISO 8601, start of request
  ms: number;                 // time spent downstream of the middleware
  method: string;             // GET, POST, ...
  route: string;              // matched route pattern, e.g. "/posts/:id"; "" when none matched
  status: number;             // final response status
  ua: UaClass;
  type: "request.unpaid" | "challenge.issued" | "payment.received";
  challenge?: ChallengeInfo;  // present when status is 402
  payment?: PaymentInfo;      // present when a payment header was sent
  receipt?: ReceiptInfo;      // present when a receipt header was returned
  delivery?: "ok" | "failed"; // present with payment: status < 400 → ok, else failed
}

type UaClass = "x402-client" | "axios" | "node" | "python" | "go" | "curl" | "browser" | "op8x" | "none" | "other";

interface ChallengeInfo {
  location: "header" | "body" | "both" | "none";
  version?: 1 | 2;
  drift?: boolean;            // both present and the decoded objects differ
  error?: string;             // the challenge's "error" field
  accepts?: Array<{ scheme?: string; network?: string; amount?: string; asset?: string }>; // max 5 entries; amount falls back to v1 maxAmountRequired
}

interface PaymentInfo {
  header: "PAYMENT-SIGNATURE" | "X-PAYMENT";
  decodable: boolean;
  version?: 1 | 2;
  scheme?: string;
  network?: string;
  amount?: string;            // v2 accepted.amount
  asset?: string;
  payer?: string;             // hex HMAC-SHA-256(salt, trimmed lowercase address), first 32 hex chars; only with salt
}

interface ReceiptInfo {
  header: "PAYMENT-RESPONSE" | "X-PAYMENT-RESPONSE";
  decodable: boolean;
  success?: boolean;
  transaction?: string;       // only with chainCheck: true
  network?: string;
  errorReason?: string;
}
```

A body counts as a challenge only if it parses as a JSON object with a numeric `x402Version`; an empty `{}` body next to a header challenge gives `location: "header"`. When both exist, `version`, `error` and `accepts` come from the header challenge alone; header and body fields are never merged, the body only feeds `drift`.

Rules for `type`:

| Request has payment header | Status | `type` |
| --- | --- | --- |
| yes | any | `payment.received` |
| no | 402 | `challenge.issued` |
| no | other | `request.unpaid` |

The payer address comes from the receipt's `payer`, falling back to `payload.authorization.from` in the payment payload. It is trimmed and lowercased (by the caller in `record.ts` and again inside `hashPayer`, so direct callers of the exported `hashPayer` get the same result), hashed before it leaves `src/hash.ts`, and only when `salt` is set; the receipt's `payer` is used even when the payment header is undecodable.

Never read or recorded: `cf-connecting-ip`, `x-forwarded-for`, `x-real-ip`, any IP source; the URL path and query; cookies and `authorization`; the `payload` part of payment headers except `authorization.from` for hashing; the receipt's `transaction` unless `chainCheck` is true; response bodies other than the 402 challenge, and of that only the fields above.

User-Agent classes, matched case-insensitively in this order: contains `op8x` → `op8x`; `x402` → `x402-client`; `axios` → `axios`; `python` → `python`; `go-http-client` → `go`; `curl` → `curl`; `mozilla` → `browser`; `node` or `undici` → `node`; empty or missing → `none`; else `other`. The raw User-Agent is never stored.

## Data flow in the middleware

```
request ─► read headers, start timer ─► await next() ─► (seller's errors propagate)
                                             │
                                             ▼
                        context not finalized? → record nothing, do not touch c.res
                                             │
                                             ▼
                        status 402? → res.clone() (body stream copy, not read yet)
                                             │
                                             ▼
                            return; seller's response leaves unchanged
                                             │
                       waitUntil(async () => {
                          yield one macrotask (setTimeout 0) before any decoding
                          read clone, max 64 KB, within timeoutMs; then cancel rest
                          buildRecord(...)  → hash payer → send and/or log
                       })   // everything inside try/catch, send aborted after timeoutMs
```

The clone read has its own deadline (the clamped `timeoutMs`): a tee only cancels its source once both branches are cancelled, so a stalled 402 body would otherwise keep the copy open and stop a client cancel from reaching the seller's stream. On expiry the clone is cancelled (not awaited) and the record is built from what was read; a read stops at the first non-byte chunk. With neither `endpoint` nor `log: true` none of this runs.

If `c.executionCtx` is unavailable (for example in plain Node tests without an execution context), the background task is started without `waitUntil` and its promise is caught; it still never blocks the response.

## Transport

- `POST <endpoint>` with `content-type: application/json`, body = one `AnalyticsRecord`, `user-agent: op8x-analytics/<version>`; the module adds only these two headers, plus `authorization: Bearer <key>` when a key applies (see the write-key document). The Workers runtime itself may add a `cf-worker` header to outgoing requests. The wire format is described in `packages/analytics/docs/ingest-contract.md`.
- Abort after `timeoutMs` via `AbortSignal.timeout`. Redirects are not followed (`redirect: "manual"`), so a redirect cannot bypass the endpoint rule or repeat the POST. The response body is not read; any non-2xx status, including 3xx, counts as a failure.
- Errors (network, timeout, non-2xx) are swallowed. At most one `console.warn` per 60 seconds per isolate for each kind of failure (keyed by warning text; a non-2xx status is part of the text, so each status code counts separately), without record data, so failures are visible in `wrangler tail` but cannot flood it.
- With `log: true`, each record is written as `console.log("op8x.analytics", JSON.stringify(record))`.

## Testing

- Unit tests (`node:test`) for `decode`, `ua`, `record` (every `type` row, v1 and v2 challenge in header/body/both, drift, broken base64, huge headers, `__proto__` keys, control characters, and privacy: requests with IP headers, cookies, query strings and signed payment payloads produce records that contain none of them), `hash` and `transport`.
- Middleware tests with `app.request()` and a fake execution context that collects `waitUntil` promises:
  - byte-identical status, headers and body with and without the middleware, for 200, 402 (header and body challenge), streamed bodies and thrown handler errors;
  - the response is returned before the background task finishes, also when the endpoint hangs;
  - the endpoint is unreachable, returns 500, or never answers: response unchanged, background task settles within `timeoutMs` plus margin.
- A local mock collector (`node:http`) under `test/` receives and stores posted records.
- An example app in `packages/analytics/examples/workers` (Hono, `@x402/hono`, lazy payment middleware, `wrangler.toml` with a current `compatibility_date`, no `nodejs_compat`) for the end-to-end check under `wrangler dev`. It is not part of CI.

## Documentation

`packages/analytics/README.md`: one install command, the copyable example above (with the lazy `paymentMiddleware` pattern for Workers), the full list of record fields, what is never collected, and the fail-open guarantees. Link to op8x.com in the README and in `homepage`.
