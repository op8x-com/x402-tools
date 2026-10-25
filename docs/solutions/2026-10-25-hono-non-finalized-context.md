---
title: A pass-through Hono middleware can change the response of a non-finalized context
date: 2026-10-25
area: sdk
tags: [hono, middleware, context, finalized]
symptom: "Outer middleware's fallback response gains headers, or c.res becomes a Context object"
---

## Problem
When an inner middleware forgets to return a response, the context stays non-finalized and an outer middleware may set `c.res` itself. Two things in the analytics middleware changed that outer response:

1. Reading `c.res` after `await next()` made Hono create its internal response from the prepared headers (`c.header(...)` calls). The outer `c.res = new Response(...)` then merged those headers in.
2. The disabled path used `return next()`. `next()` resolves to the Context, and Hono's compose assigns a truthy return value to `c.res` when the context is not finalized, so the outer middleware read a Context instead of a Response.

## Cause
`get res()` in Hono's `context.js` lazily creates `#res`; `set res()` merges `#res` headers into the new response. `compose.js` does `if (res && (context.finalized === false || isError)) context.res = res`.

## Fix
In `packages/analytics/src/hono.ts`: check `c.finalized` before touching `c.res` and record nothing otherwise; disabled paths use `await next(); return;` instead of `return next()`.

## Prevention
Tests "a non-finalized context is left untouched and nothing is recorded" and "disabled middleware (...) does not return next()'s value into a non-finalized context" in `packages/analytics/test/hono.test.ts`.
