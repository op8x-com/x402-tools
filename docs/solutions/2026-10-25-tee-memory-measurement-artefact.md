---
title: A cloned 402 body looked like a memory leak only because the test loop never yielded
date: 2026-10-25
area: sdk
tags: [streams, response-clone, tee, memory, gc, measurement]
symptom: "~128 KB retained per request when an outer middleware replaces a streamed 402; OOM after a few thousand requests in a Node loop"
---

## Problem
Red-team hypothesis: when an outer Hono middleware replaces a streamed 402 response, the seller's tee branch of the cloned body is never read, so `@op8x/analytics` leaks it. A Node loop over `app.fetch` showed retained memory growing with the request count, up to a V8 OOM, and the machine hung.

## Cause
A measurement artefact, not a leak. The loop awaited only promises (microtasks) between requests, so the event loop never ran a task. Node's `Response.clone()` (undici) registers the body stream with a `WeakRef` in a `FinalizationRegistry`. Memory held through that path is released only once the event loop gets a turn. A real server always gets one between requests, and so does the current middleware, which waits for a `setTimeout(0)` in its background task. The memory sat in `arrayBuffers`, which `--max-old-space-size` does not limit, so the process grew until the whole machine ran short.

Measured on Node 24.13, `--max-old-space-size=256 --expose-gc`, one process at a time, sequential requests, a 402 body that streams 64 KB chunks without end, an outer middleware that replaces the 402, and `arrayBuffers` measured after `gc()`:

| Variant | 2000 requests, microtask-only loop | 2000 requests, `setTimeout(0)` between requests | After the loop: one 100 ms tick, then `gc()` |
| --- | --- | --- | --- |
| No middleware | +0.0 MB | | 0.0 MB |
| `cc982bd` | +262 MB (linear, ~128 KB/request) | +26 MB, flat | 0.0 MB |
| Plain `clone()`, read once, cancel the clone (no analytics) | +262 MB (linear) | +30 MB, flat | 0.0 MB |
| Current (`2eb9e72`) | +25 MB, flat | | 0.0 MB |
| Current, client cancels instead of replacing | +26 MB, flat | | 0.0 MB |

The "flat" values are requests in flight at the sample point and do not grow with N. The plain-`clone()` row shows that the effect comes from the runtime, not from the middleware.

## Fix
No code change. The proposed fix of cancelling both tee branches at the cap or deadline would be wrong. The seller's branch is the response the client is still reading, and cancelling it would cut that response short.

## Prevention
Memory tests of streamed bodies must let the event loop run a task between requests (`await new Promise((r) => setTimeout(r, 0))`). They should settle with one task plus `gc()` before reading `process.memoryUsage()`, and include `arrayBuffers`. Guard the run with an RSS check, not only `--max-old-space-size`. No automated test yet: a meaningful one needs `--expose-gc` and a few seconds of runtime, and the plain `npm test` run uses neither.
