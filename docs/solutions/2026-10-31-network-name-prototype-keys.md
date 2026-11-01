---
title: Network names from a challenge must not index plain objects
date: 2026-10-31
area: cli
tags: [security, input-validation, prototype]
symptom: "TypeError: e.key.startsWith is not a function / table[network]?.find is not a function, op8x check prints a stack trace instead of a report"
---

## Problem
A 402 challenge with `accepts[].network` set to `"__proto__"`, `"constructor"` or `"toString"` crashed `op8x check`: no report, no exit code 0/1/2. Found by the red-team review of the spend-control rules before merge.

## Cause
The asset and network tables in `packages/cli/src/assets.ts` are object literals. `table["constructor"]` returns `Object`, `table["__proto__"]` returns `Object.prototype`. Neither is nullish, so `table[network]?.find(...)` and `V1_NETWORKS[network] ?? network` do not fall back, and the next call on the result throws. `runRules` is not wrapped in `try`, so the throw ends the run.

## Fix
`packages/cli/src/assets.ts`: every lookup keyed by challenge input goes through `own()` (`Object.hasOwn(table, key) ? table[key] : undefined`). `packages/cli/src/rules.ts`: the spend rules run inside `try`, so a throw skips those hints instead of the report.

## Prevention
`packages/cli/test/spend.test.ts` ("prototype keys as network names do not crash the report") covers the three names in v1 and v2. For new tables keyed by network input, use `own()`, a `Map`, or `Object.create(null)`. The older `LEGACY_TO_CAIP2` hint map in `rules.ts` had the same pattern: it did not crash, but `"constructor"` printed a function's source in the fix text. It was replaced on 2026-10-31 by `legacyToCaip2` in `assets.ts`, which uses `own()`; `rules.test.ts` covers the prototype names.

## Same pattern when comparing objects
Comparing two parsed JSON objects key by key must read own properties only. `JSON.parse` creates `__proto__` as an own key, so on the side without it `obj["__proto__"]` returns `Object.prototype`; both sides then look like empty objects and the difference is missed. Since 2026-11-01 `diffPaths` in `packages/cli/src/rules.ts` reads both sides through `own()` from `assets.ts`; `rules.test.ts` covers `__proto__` on either side.
