# op8x CLI: CORS, preflight and payment flow checks

Status: implemented, 2026-10-25 (after the 0.0.3 release; not yet published, and the package version stays 0.0.3 until the next release). Extends `2026-10-24-cli-check-design.md`, which listed CORS as out of scope in 0.0.1 and now points here. Updated 2026-10-31 to match `@x402/core` 2.29: an unknown flow is also reported in v1, and `paymentFlow: null` counts as omitted.

## Problem

Two classes of failure were invisible to `op8x check`:

- **Browser clients.** The x402 v2 HTTP transport ("Browser clients") requires CORS for web apps that pay: the 402 must carry `Access-Control-Allow-Origin`, expose the payment headers, and the preflight for the paid retry must allow the payment header. A server that gets this wrong works for agents and servers and fails silently in browsers, often as a network error with no status.
- **Payment flow.** Core spec v2, section 6.1, defines `extra.paymentFlow` (`authorization`, `upfront`, `escrow`). Clients must skip an entry with an unknown value, and the spec requires the field whenever the scheme default is not `authorization`.

## Goals and non-goals

Goals:

- Report CORS gaps that break payments from web apps, without failing endpoints that agents and servers can pay.
- Report an `extra.paymentFlow` that clients must skip (v1 and v2), or a v2 entry where it is missing although the spec requires it.

Non-goals:

- `Access-Control-Allow-Methods` and `Access-Control-Max-Age` are not checked. GET and POST are CORS-safelisted methods.
- No configurable origin (see "Alternatives considered").
- A missing `extra.paymentFlow` is not reported in v1 challenges (the requirement is part of spec v2), and an explicit valid value is not compared with the scheme default.

## Probe sequence

`cli.ts` runs the requests one after another:

1. Plain probes (GET and POST, or the one `--method` names) as in the base design, **without** `Origin`. A server may refuse browser origins on a paid route; the plain probes must still diagnose the challenge.
2. For each plain probe that returned a 402 (or 412 with `permit2_allowance_required`): one repeat of the same request with `Origin: https://op8x.com` (`probe(url, method, opts, true)`). Its status, error and CORS headers are merged into the extracted result (`withBrowserView`, fields `originStatus`, `originError`, `originChallenge`, `originVersion`, `allowOrigin`, `exposeHeaders`, `allowCredentials`).
3. At most one `OPTIONS` preflight, planned by `preflightPlan(results)`, only when at least one 402 is CORS-ready: the browser-like repeat also got a 402 and carried `Access-Control-Allow-Origin` (any value). Headers sent: `Origin`, `Access-Control-Request-Method`, `Access-Control-Request-Headers`.

`preflightPlan` picks POST if any CORS-ready 402 came from POST, else GET. The requested headers (lower case, comma-separated) depend on the challenge versions seen: `payment-signature` for v2 (or when no version is known), `content-type` for POST, `x-payment` for v1.

The preflight body is read like a probe body (same 1 MiB cap and timeout) and then discarded; no rule uses it. A timeout while reading it counts as a failed preflight; an oversized or broken body is ignored. `redirect: "manual"` and network-error handling are as for the plain probes.

## Rules

CORS findings are `warn` or `info`, never `error`: they affect browser clients only, and all except `cors-client-retry` say so in the detail. Server-to-server and agent payments need no CORS, so an endpoint without CORS still passes. An unknown `extra.paymentFlow` is an `error` and makes the exit code 1.

| id | Level | Method | Condition | Fix hint |
| --- | --- | --- | --- | --- |
| `cors-origin-refused` | info | GET/POST | Plain probe got a 402 (or the permit2 412); the repeat with `Origin` failed or returned anything but 402 | Answer requests with an Origin header with the same 402 plus CORS headers, if browser apps should pay |
| `cors-allow-origin` | info | GET/POST | Repeat got a 402 without `Access-Control-Allow-Origin` | Send `Access-Control-Allow-Origin` on the 402 and the preflight |
| `cors-expose-headers` | warn | GET/POST | CORS-ready 402 whose `Access-Control-Expose-Headers` lacks `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE` (v2 or unknown version) or `X-PAYMENT-RESPONSE` (v1) | Add the missing names, merged with the existing value |
| `cors-preflight` | warn | OPTIONS | Preflight failed at network level (the four `cors-preflight` rows are checked in this order; only the first match is reported) | Answer OPTIONS preflights for this URL |
| `cors-preflight` | warn | OPTIONS | Preflight returned 402 | Answer the preflight without requiring payment, with a non-trivial `Access-Control-Max-Age` |
| `cors-preflight` | warn | OPTIONS | Preflight returned a non-2xx status | Answer the preflight with 204 and the CORS headers |
| `cors-preflight` | warn | OPTIONS | 2xx preflight without `Access-Control-Allow-Origin` | Send `Access-Control-Allow-Origin` on the preflight too |
| `cors-allow-headers` | warn | OPTIONS | 2xx preflight with `Access-Control-Allow-Origin` whose `Access-Control-Allow-Headers` lacks a requested header | Add the missing names |
| `cors-client-retry` | info | OPTIONS | 2xx preflight with `Access-Control-Allow-Origin` whose `Access-Control-Allow-Headers` lacks `Access-Control-Expose-Headers` (sent on the paid retry by `@x402/fetch` and `@x402/axios` 2.28.0 and 2.29.0; x402-foundation/x402#3478 still open on 2026-10-29) | Until the fix ships, add `Access-Control-Expose-Headers` to `Access-Control-Allow-Headers` |
| `payment-flow` | error | GET/POST | v1 or v2 entry with `extra.paymentFlow` not in `authorization`, `upfront`, `escrow` (`null` counts as omitted, as in the official client) | Use one of the three, or omit it for the scheme default |
| `payment-flow` | warn | GET/POST | v2 entry without `extra.paymentFlow` whose scheme default is not `authorization` | Set `extra.paymentFlow` to the default |

Details:

- Outside the browser-like repeat, "402" includes the 412 with `permit2_allowance_required` (`is402`); the repeat itself must return a literal 402.
- Header lists are compared case-insensitively after splitting on commas. `*` counts as a wildcard only when `Access-Control-Allow-Credentials` is not `true` (case-insensitive, read from the same response); on credentialed responses it is a literal name, and the details of `cors-expose-headers` and `cors-allow-headers` say so.
- Without any CORS-ready 402, only `cors-origin-refused` and `cors-allow-origin` can appear; nothing else in CORS has an effect without `Access-Control-Allow-Origin`.
- Versions come from both header and body challenges: for the preflight plan, of the CORS-ready 402s only; for `cors-expose-headers`, of all 402s.
- Scheme defaults for `payment-flow` (from the scheme specs in the x402 repository at commit `4241d56`): `auth-capture` → `escrow`; `upto` on a network in the `solana` namespace → `escrow`; `exact` on a network in the `lnbtc` namespace → `upfront`; everything else → `authorization`. The missing-flow warning applies to v2 only; `@x402/core` 2.29 drops an unknown flow in v1 too, so the error covers both versions. The rule reads the header challenge if it decodes, otherwise the body challenge.
- The CORS rules run once over all results (`corsRules(results, preflight)`), after the per-method rules and before identical GET and POST findings are merged into `both`.

## Types and report

- `Finding.method` adds `"OPTIONS"` for preflight findings.
- `PreflightResult` (`types.ts`): `method: "OPTIONS"`, `url`, `requestMethod`, `requestHeaders`, `status?`, lower-cased `headers`, `ms`, `error?`.
- `ProbeResult.origin` is set on the browser-like repeat.
- JSON report `requests[]` lists plain probes, then browser-like repeats, then the preflight. Entries add `error` when the request failed, `origin` for repeats and the preflight, and `requestHeaders` (`access-control-request-method`, `access-control-request-headers`) for the preflight.
- Text report: repeats are marked `(with Origin)`; the reproduce block has a `curl -i` line per request, with `-H 'Origin: …'` for repeats and an `OPTIONS` line with `Origin` and both `Access-Control-Request-*` headers for the preflight.
- Exit code 2 ("every request failed") is computed over the plain probes only; a failed repeat or preflight does not change it.

## Alternatives considered

- **`Origin` on every probe.** Rejected: a server that refuses browser origins would then hide its challenge, and the base checks would report a missing 402 instead of the real problem.
- **One preflight per CORS-ready method.** Rejected: GET and POST share the payment header; one preflight (POST if possible, since it also needs `content-type`) covers the stricter case with one request less.
- **CORS findings as `error`.** Rejected: agents and servers pay without CORS, so a CORS gap must not fail an endpoint that works for them.
- **An unknown `extra.paymentFlow` as `warn`.** Rejected: clients must skip such an entry, so it can never be paid; that is an error for the seller, like other entries no client can pay.
- **Configurable origin (`--origin`).** Not built: a fixed origin is enough to see whether CORS is set up at all, and the findings it can get wrong are `info` only. `https://op8x.com` is a real origin, so sellers can recognize these requests in their logs. A flag can be added when sellers with origin allow-lists need it.

## Known limits

- Of the browser-like repeat, only the status, the CORS headers and (since `../designs/2026-10-31-cli-payto-rotation-design.md`) the `payTo` values and (since `../designs/2026-10-31-cli-amount-change-design.md`) the amounts of its challenge are used; nothing else of its challenge is checked, so a server that sends browsers a different challenge in other fields is not detected.
- The origin is fixed (`https://op8x.com`). A server that allows only listed origins answers it differently from its real web app, so `cors-origin-refused` or `cors-allow-origin` can appear although the app works. Both are `info`, so they never change the exit code.
- The value of `Access-Control-Allow-Origin` is not compared with the origin sent; any value, including `null`, another origin, or `*` together with `Access-Control-Allow-Credentials: true` (which browsers reject for credentialed requests), counts as CORS-ready.
- The browser-like repeat must return 402. An endpoint that answers both requests with the permit2 412 gets `cors-origin-refused` and no further CORS checks.
- Only one preflight is sent. When POST is CORS-ready, a preflight problem that affects only GET is not seen.
- A check sends up to five requests to the endpoint: two plain probes, two repeats and one preflight. A rate limit that answers the repeat with 429 shows up as `cors-origin-refused`.
- All requests are unpaid and carry no credentials or payment headers; the preflight only asks which headers are allowed.
- `cors-client-retry` exists only because of an SDK bug (x402-foundation/x402#3478); it should be removed once a fixed SDK version is released.
- The scheme defaults for `payment-flow` are a copy of the scheme specs at x402 commit `4241d56` and must be updated when those change.

## Testing

- `rules.test.ts`: every rule above, including `*` with and without credentials, v1 and dual-version header names, and each `cors-preflight` branch.
- `probe.test.ts`: plain probes carry no `Origin`; the repeat and the preflight carry it with the planned headers.
- `cli.test.ts` and `test/server.ts`: end-to-end against a local server with CORS-enabled, CORS-less and origin-refusing routes.
- `report.test.ts`: `(with Origin)` marker and curl lines.
