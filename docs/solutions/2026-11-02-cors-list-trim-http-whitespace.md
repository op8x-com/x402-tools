---
title: CORS list items must be trimmed of HTTP whitespace only
date: 2026-11-02
area: cli
tags: [cors, input-validation, unicode]
symptom: "A refused preflight with Access-Control-Allow-Methods: GET, POST<U+00A0> was reported as allowing POST, so the hint pointed away from the broken CORS configuration"
---

## Problem
`op8x check` reads `Access-Control-Allow-Methods` from a preflight refused with 400, 401 or 403 and names the method the list leaves out. A list ending in `POST` followed by a no-break space was treated as containing `POST`, and the finding blamed authentication or a firewall instead. Found by the adversarial review before merge.

## Cause
The items were cleaned with `String.prototype.trim()`, which removes every Unicode white space character, including U+00A0, U+FEFF and U+2028. The Fetch Standard strips only HTTP tab or space around list items, so a browser does not read `POST<U+00A0>` as `POST`.

## Fix
`refusalHint` in `packages/cli/src/rules.ts` cleans each item with `trimHttp`, which strips only leading and trailing space and tab. The test "refused preflight trims only HTTP whitespace around methods" in `packages/cli/test/rules.test.ts` covers the no-break space and keeps spaces and tabs allowed.

A first fix used the regex `/^[ \t]+|[ \t]+$/g`. Its second alternative is retried from every position of a long space run, so an item like `x`, many spaces, `x` took quadratic time (200,000 spaces: about 32 s). `trimHttp` walks in from both ends with two loops and is linear; a test with that input and a 200 ms limit guards it.

## Prevention
When comparing tokens from HTTP header lists, trim space and tab only, never with `trim()`. Write such characters in tests as escapes (` `, `\t`) so editors and formatters cannot change them unnoticed. `headerNames` in the same file, which the header-name checks share, still uses `trim()`; it has the same weakness for header names and is a known open point.
