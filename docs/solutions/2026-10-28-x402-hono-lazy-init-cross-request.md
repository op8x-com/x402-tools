---
title: "@x402/hono on Workers: paid route hangs when the first request goes to a free route"
date: 2026-10-28
area: sdk
tags: [cloudflare-workers, hono, x402-hono, wrangler]
symptom: "After a request to a free route, every request to the paid route hangs without a response; the facilitator never receives /supported"
---

## Problem
With the lazy pattern from `2026-10-25-x402-hono-on-workers.md` (`pay ??= paymentMiddleware(...)` in an `app.use` for all routes), a fresh isolate whose first request is `GET /` answers that request, but every later `GET /paid` hangs. Reproduced under `wrangler dev` 4.152.0 with `@x402/hono` 2.28.0. If the first request goes to `/paid`, everything works.

## Cause
`paymentMiddleware(...)` starts `initialize()` (a fetch of the facilitator's `/supported`) as soon as it is created. Created during `GET /`, that fetch belongs to the `/` request, and Workers cancel a request's outstanding I/O when it ends. The init promise never settles, and the middleware awaits it on every protected request.

## Fix
`apps/demo-api/src/index.ts`: mount the payment setup only on the paid path (`app.use("/paid", ...)`), initialize explicitly with `x402HTTPResourceServer.initialize()`, keep the setup alive with `c.executionCtx.waitUntil(...)`, then build the middleware with `paymentMiddlewareFromHTTPServer(http, undefined, undefined, false)`. A failed setup is dropped and retried on the next request (`503` meanwhile).

## Prevention
None automated yet: Workers are checked by hand under `wrangler dev` (no CI run of Workers). Manual check: request `/` first, then `/paid`, on a fresh `wrangler dev`.
