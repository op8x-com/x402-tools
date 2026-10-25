---
title: Awaiting cancel() on one branch of a cloned Response can hang
date: 2026-10-25
area: sdk
tags: [streams, response-clone, tee, waituntil]
symptom: "Background task reading a cloned 402 body never settles for large bodies"
---

## Problem
The analytics middleware clones a 402 response and reads at most 64 KB of the clone in a background task. For bodies larger than the cap, the task hung after reading, so `waitUntil` never settled.

## Cause
`Response.clone()` tees the body stream. Cancelling one branch of a tee does not resolve until the other branch is also consumed or cancelled. The other branch is the seller's response, which is still being sent to the client, so `await reader.cancel()` in the background task waits for something outside its control.

## Fix
Cancel without awaiting and swallow the rejection: `reader.cancel().catch(() => {})` (in `readCapped` in `packages/analytics/src/hono.ts`). Nothing after the cancel depends on it finishing.

## Prevention
The 1 MB body test in `packages/analytics/test/hono.test.ts` fails if the background task does not settle in time.

## Follow-up: stalled bodies
A 402 body that stalls under 64 KB kept the clone reader waiting in `read()`. The tee cancels its source only when both branches are cancelled, so a client cancel of the seller's response never reached the seller's stream and the background task outlived `timeoutMs`. `readCapped` now races each read against a deadline (the clamped `timeoutMs`) and cancels the clone on expiry. Test: "a stalled 402 body: the copy gives up after timeoutMs, so a client cancel reaches the source".
