---
title: "@x402/hono on Cloudflare Workers: compatibility date and global-scope I/O"
date: 2026-10-25
area: sdk
tags: [cloudflare-workers, hono, nodejs_compat, x402-hono, wrangler]
symptom: "Build fails with 'Could not resolve \"url\"' (compatibility_date 2024-09-01), or every request returns 500 right after start"
---

## Problem
Two separate failures when putting `@x402/hono` (2.28.x) on a Worker under `wrangler dev`:

1. With `compatibility_date = "2024-09-01"` and no `nodejs_compat`, the build fails because `@x402/extensions` imports `url`.
2. With `paymentMiddleware(...)` called at module top level, every request returns 500. With `syncFacilitatorOnStart=false` it fails differently instead: "Facilitator does not support ... call initialize()".

## Cause
1. Node built-ins and `Buffer` are only available globally from a recent compatibility date, or with the `nodejs_compat` flag. The old date has neither.
2. `paymentMiddleware(...)` fetches the facilitator's `/supported` when it is created. Workers forbid network I/O in global scope, so the fetch fails. Turning the startup sync off only moves the failure to the first payment check, because the server never learned what the facilitator supports.

## Fix
1. Use `compatibility_date = "2026-10-01"` (or later). Both the 402 path and the paid path then work without `nodejs_compat`. Older projects need the flag or a newer date.
2. Build the payment middleware lazily on the first request, not at module top level:

```ts
let pay: MiddlewareHandler | undefined;
app.use(async (c, next) => {
  pay ??= paymentMiddleware(routes, server);
  return pay(c, next);
});
```

See `packages/analytics/examples/workers/src/index.ts`.

## Prevention
The README of `@op8x/analytics` and the example under `packages/analytics/examples/workers` use the lazy pattern and the new date, so copied code works. No automated test yet: the example is checked by hand under `wrangler dev` (no CI run of Workers).
