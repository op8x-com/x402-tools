---
title: "@x402/hono on Cloudflare Workers: compatibility date and global-scope I/O"
date: 2026-10-25
area: sdk
tags: [cloudflare-workers, hono, nodejs_compat, x402-hono, wrangler]
symptom: "Build fails with 'Could not resolve \"url\"' (compatibility_date 2024-09-01), or requests to payment-protected routes return 500 right after start"
---

## Problem
Two separate failures when putting `@x402/hono` (2.28.x) on a Worker under `wrangler dev`:

1. With `compatibility_date = "2024-09-01"` and no `nodejs_compat`, the build fails because `@x402/extensions` imports `url`.
2. With `paymentMiddleware(...)` called at module top level, requests to routes protected by the payment middleware return 500 ("Disallowed operation called within global scope"); unprotected routes keep working. With `syncFacilitatorOnStart=false` it fails differently instead: "Facilitator does not support ... call initialize()".

## Cause
1. Node built-ins and `Buffer` are only available globally from a recent compatibility date, or with the `nodejs_compat` flag. The old date has neither.
2. `paymentMiddleware(...)` fetches the facilitator's `/supported` when it is created. Workers forbid network I/O in global scope, so the fetch fails. Turning the startup sync off only moves the failure to the first payment check, because the server never learned what the facilitator supports.

## Fix
1. Use `compatibility_date = "2026-10-01"` (or later). Both the 402 path and the paid path then work without `nodejs_compat`. Older projects need the flag or a newer date.
2. Do not create the payment middleware at module top level. Do not build it lazily for all routes either: that pattern hangs the paid route when a free route is requested first (see `2026-10-28-x402-hono-lazy-init-cross-request.md`). Build it on the paid route only, initialize it explicitly and keep the setup alive with `waitUntil`:

```ts
app.use("/paid", async (c, next) => {
  const ready = (pay ??= buildPayment(c.env)); // await http.initialize(), then paymentMiddlewareFromHTTPServer(http, undefined, undefined, false)
  c.executionCtx.waitUntil(ready.then(() => undefined, () => undefined));
  return (await ready)(c, next);
});
```

See `packages/analytics/examples/workers/src/index.ts` for the complete version with error handling.

## Prevention
The README of `@op8x/analytics` and the example under `packages/analytics/examples/workers` use the paid-route-only pattern and the new date, so copied code works. No automated test yet: the example is checked by hand under `wrangler dev` (no CI run of Workers).
