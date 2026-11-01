---
title: Server text in findings must be quoted, escaped and checked centrally
date: 2026-11-01
area: cli
tags: [security, output, terminal, escape-sequences]
symptom: "a finding printed an ESC sequence, or a line that looked like a pass line, taken from a header value, an object key or a JSON.parse error of the checked server"
---

## Problem
Findings of `op8x check` repeat text from the response of the server being checked. Several rules printed it without escaping: the `Location` header (`redirect`), the start of an invalid `PAYMENT-REQUIRED` header, object keys in the paths of `header-body-drift`, `x402Version`, network names, `extra.paymentFlow` and `Cache-Control`. A server could send ESC sequences, a line break followed by text that looks like a finding (`✔ pass …`), or sentences addressed to an agent that reads the output. The message of a `SyntaxError` thrown by the official client's JSON parse also repeated server text.

## Cause
Escaping was done per rule with `printEscaped` or `printFull`, and only where a rule author remembered it. Escaped text still sat in the sentence without a boundary, so a value could not be told from the CLI's own words, and quote characters and runs of spaces could forge a boundary. Nothing checked the finding fields after the rules had run.

## Fix
Two layers, in `packages/cli/src`:
- Layer 1, at the places that print: `printEscaped` and `printFull` (`extract.ts`) put the value in double quotes, write `"`, `'`, the backslash, characters outside printable ASCII and a space after a space as `\u{XXXX}`, and cut to 100 characters with `…`. The CLI's own words use single quotes. Numbers, status codes, digit-only amounts, simple path segments and the markers `(empty)`, `not set` and `(none)` stay bare. `header-body-drift` formats paths from segment lists and keeps the detail within 300 characters. The `official-client` reason for a non-JSON header is the fixed text `the decoded PAYMENT-REQUIRED header is not JSON`.
- Layer 2, central: `buildReport` applies `neutralize` (`extract.ts`) to every string field of every finding and to `requests[].error`, so a rule that forgets layer 1 still cannot emit a control character.

## Prevention
- Every new rule prints every server value through `printEscaped` or `printFull` and keeps fix texts free of server values and of double quotes.
- `packages/cli/test/server-text.test.ts` runs a table of hostile fixtures through `runRules`, `buildReport`, `renderText` and `renderJson`. It checks that layer 1 alone leaves nothing for `neutralize` to change, that no control character survives, that the number of finding lines equals the number of findings, and, with `assertQuoting`, that every quoted span is the helper output of a value the fixture sent. A new rule needs a hostile fixture in this table that fires it; without one, layer 1 for that rule is untested.
- `packages/cli/test/cli.test.ts` repeats the forged-line case over real HTTP (route `/drift-hostile`).
- Design: `../designs/2026-11-01-cli-server-text-design.md`. Earlier note on look-alike values: `2026-10-31-printed-server-values-look-alike.md`.
