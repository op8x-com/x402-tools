# op8x CLI: finding cap and own-property drift comparison

*   **Author:** op8x
*   **Status:** Approved, 2026-11-01
*   **Date:** 2026-11-01

Extends `../specs/2026-10-24-cli-check-design.md` (the rule engine and its
output) and `./2026-11-01-cli-server-text-design.md` (the quoting rules the
summary finding follows).

--------------------------------------------------------------------------------

## Overview

`op8x check` turns one 402 answer into a list of findings. Some rules emit one
finding per `accepts[]` entry, and nothing limits how many entries a server
sends. This design limits findings per rule id, level and method to 10 and
replaces the rest with one summary finding. It also makes `merge` linear.
Separately, the header/body drift comparison reads inherited properties, so a
`__proto__` key present on one side only goes unreported; the comparison will
read own properties only.

## The Problem

1.  **Unbounded findings.** Five rules in `methodRules` add findings per
    `accepts[]` entry:
    *   `v2-legacy-network`, `v1-caip2-network`, `mixed-dialect` and
        `payment-flow`: one finding per entry each;
    *   `schema`: one finding per zod issue, which is one per missing or
        invalid field of each entry (5 per entry `{"network":"a"}` on v2, 7 on
        v1).

    The `@x402/core` 2.29 schemas allow at most 1,024 `accepts[]` entries, on
    v1 and on v2. Above that, zod reports a single `schema` issue (`Too big:
    expected array to have <=1024 items`), so `schema` stops growing at about
    1,024 entries, while the other four rules keep growing with every entry. A
    body just under the 1 MiB read limit holds about 65,000 entries
    `{"network":"a"}`.

    Measured on Node 24 with the code before this change: `runRules` called
    directly on a GET and a POST answer that carry the challenge in the body,
    with a valid `resource` whose URL is the checked URL:

    | Version | Entries `{"network":"a"}` | `runRules` time | Findings | Of them `schema` |
    |---|---|---|---|---|
    | v2 | 1,000 | 0.27 s | 6,004 | 5,000 |
    | v2 | 4,000 | 0.29 s | 4,005 | 1 |
    | v2 | 16,000 | 3.9 s | 16,005 | 1 |
    | v2 | 65,000 | 94.2 s | 65,005 | 1 |
    | v1 | 1,000 | 0.35 s | 7,004 | 7,000 |
    | v1 | 65,000 | 0.05 s | 5 | 1 |

    Over HTTP, a 65,000-entry v2 body without `resource` took 75.9 s and
    printed 11.5 MB with 65,004 error lines (two `schema` issues instead of
    one, because `resource` was missing). Almost all of the time is spent in
    `merge`, which calls `out.find` for every finding (quadratic); the same
    65,000-entry case takes 0.40 s with a linear `merge`. `--timeout` applies
    to each request, not to the whole check, so it does not stop this. An
    agent that runs `op8x check` waits over a minute and receives megabytes of
    text it cannot use.

2.  **`__proto__` hides drift.** `diffPaths` compares header and body
    challenges key by key and reads `a[k]` and `b[k]` directly. `JSON.parse`
    creates `"__proto__": {}` as an own property. On the side without that key,
    `b["__proto__"]` returns `Object.prototype`, which has no enumerable keys,
    so both sides look like empty objects and no `header-body-drift` finding is
    reported. With `"__proto__": {"x": 1}` the drift is found, so the effect is
    a missed finding, not a crash.

Both gaps predate the server-text design; an adversarial review of that change
found them.

## Goals

*   Before `merge`, at most 10 findings per rule id, level and method are kept,
    however many entries the server sends; when more exist, one summary finding
    states the exact number not shown (at most 11 findings per combination).
    After `merge`, at most 11 per id and level remain when GET and POST return
    the same challenge, and at most 22 when they differ.
*   Findings of other rules are never dropped by the cap (for example
    `official-client` and the CORS findings stay visible).
*   `runRules` finishes in under 2 s for every challenge that fits the 1 MiB
    read limit, including the worst case of each version, where every entry
    triggers three per-entry rules at once (v2: `v2-legacy-network`,
    `mixed-dialect`, `payment-flow`; v1: `v1-caip2-network`, `mixed-dialect`,
    `payment-flow`). Measured with a linear `merge` and no cap, these cases
    take 0.26 to 0.40 s, so the bound is a test ceiling that catches a return
    of quadratic work, not a runtime budget: the CLI runs in Node on the
    caller's machine.
*   `merge` runs in linear time and keeps its current result: the same list in
    the same order, with two identical findings on GET and POST folded into one
    with method `both`.
*   `summary.errors`, `summary.warnings` and the exit code count the findings
    shown, the summary finding included.
*   A key present on one side of the drift comparison only, including
    `__proto__`, is reported as a differing path.
*   The summary finding follows the server-text rules: no server values, own
    words in single quotes.

## Non-Goals

*   A time limit for the whole check; `--timeout` stays per request.
*   Changing the JSON or text format beyond adding the summary finding (no new
    fields such as `omitted`).
*   Stopping the per-entry rule loops early; the rules still visit every entry.
*   Changes to spend rules or hint rules, which already summarize entries
    (spend findings list at most 5 entries; hints report the first match).
*   Other open items from the server-text review (asset labels with invisible
    characters, the length bound of the short `payTo` form, the shown end of
    long `payTo` values). They belong to their own change.

## Open Questions and Decisions

Decided on 2026-11-01:

*   At most 10 findings per rule id, level and method, then one summary
    finding.
*   `summary.errors`, `summary.warnings` and the exit code count the findings
    shown, the summary included.
*   No new JSON field; the count stands in the summary's title.
*   One generic step limits all rules; the rules themselves do not count.

No open questions.

## Critical User Journeys (CUJs)

### CUJ 1: Hostile server with many entries

*   **Given**: A server answers GET and POST with 402, no `Cache-Control`, no
    `PAYMENT-REQUIRED` header, and a body with a v2 challenge whose
    `resource.url` is the checked URL and which has 65,000 `accepts[]` entries
    `{"network":"a"}`.
*   **When**: An agent runs `op8x check <url>` or `op8x check --json <url>`.
*   **Then**: The check finishes within a few seconds. Findings, all with
    method `both`: `v2-body-only` (error); 10 `v2-legacy-network` errors and
    their summary `64990 more 'v2-legacy-network' errors not shown`; one
    `schema` error (`accepts`, too big); `cache-control` (warn);
    `official-client` (error); `cors-allow-origin` (info). `summary.errors` is
    14, `summary.warnings` is 1, and the exit code is 1.

### CUJ 2: Seller with a few entries

*   **Given**: A seller offers 3 entries on v2, all with legacy network names.
*   **When**: The seller runs `op8x check <url>`.
*   **Then**: The output is unchanged from today: 3 `v2-legacy-network`
    findings, no summary finding.

### CUJ 3: Exactly at the cap

*   **Given**: A challenge with 10 entries that each trigger the same rule, and
    another with 11.
*   **When**: `op8x check` runs on each.
*   **Then**: The first shows 10 findings and no summary. The second shows 10
    findings and the summary `1 more '<id>' error not shown`.

### CUJ 4: Error and warning of the same rule

*   **Given**: A v2 challenge with 12 entries whose `extra.paymentFlow` is
    `"x"` (unknown: error) and 12 entries with `scheme: "auth-capture"` and no
    declared flow (escrow by default: warning). Both are `payment-flow`.
*   **When**: `op8x check` runs.
*   **Then**: 10 errors plus `2 more 'payment-flow' errors not shown`, and 10
    warnings plus `2 more 'payment-flow' warnings not shown`. A warning never
    hides an error.

### CUJ 5: Every per-entry rule at once

*   **Given**: A v2 challenge in the body of GET and POST with as many entries
    `{"network":"a","maxAmountRequired":"1","extra":{"paymentFlow":"x"}}` as
    fit under 1 MiB (15,418).
*   **When**: `runRules` runs on both answers.
*   **Then**: It finishes in under 2 s. `v2-legacy-network`, `mixed-dialect`
    and `payment-flow` each show 10 findings plus one summary. Because one
    entry adds its three findings one after another, the result starts with
    `v2-body-only` (index 0), then the findings of the first 10 entries
    (indices 1 to 30), then the three summaries in rule order (indices 31 to
    33).

### CUJ 6: Many schema issues from a real seller

*   **Given**: A v2 challenge with 4 entries, each missing `scheme`, `asset`
    and `payTo` (12 `schema` issues).
*   **When**: `op8x check` runs.
*   **Then**: 10 `schema` errors and `2 more 'schema' errors not shown`. After
    the seller fixes the fields shown, the next run shows the rest.

### CUJ 7: `__proto__` on one side

*   **Given**: Header and body challenges are identical except that the body
    has a top-level `"__proto__": {}`.
*   **When**: `op8x check` runs.
*   **Then**: `header-body-drift` reports `Differing fields: __proto__`. The
    same holds when only the header has the key.

## Technical Plan (Architecture)

The change is in `packages/cli/src/rules.ts`, plus one exported helper from
`packages/cli/src/assets.ts`. No rule changes what it reports; one new step
limits the list before `merge`, and `merge` and `diffPaths` change their
internals.

```text
results (GET, POST)
   │
   ├─ methodRules(e) + safeHints(e)   per method, unchanged
   ├─ no-402 / mcp / verb-mismatch / post-needs-body / corsRules   unchanged
   ▼
all: Finding[]                         up to about 130,000 findings
   │
   ▼
limitPerGroup(all)      NEW: ≤ 10 per (id, level, method) + 1 summary each
   │
   ▼
merge(limited)          CHANGED: Map lookup instead of out.find, same result
   │
   ▼
runRules result  →  buildReport (summary counts, exit code)   unchanged
```

### `limitPerGroup`

*   One pass over the findings in their current order. A `Map` counts findings
    per group key, built from `id`, `level` and `method`.
*   The first 10 findings of a group are kept in place.
*   When the 11th finding of a group arrives, a summary finding is inserted at
    its position and remembered in the map; this and every later finding of the
    group only raise the summary's count. Findings of other groups may stand
    between the group's 10th finding and its summary (CUJ 5).
*   After the pass, each summary gets its text from its final count `N`,
    written as plain digits (`String(N)`, no thousands separator). `<kind>`
    depends on the level and on `N`:

    | Level | `N` is 1 | `N` is not 1 |
    |---|---|---|
    | `error` | `error` | `errors` |
    | `warn` | `warning` | `warnings` |
    | `info` | `note` | `notes` |
    | `pass` | `pass` | `passes` |

    *   `id`, `level`, `method`: those of the group.
    *   `title`: `N more '<id>' <kind> not shown`, for example
        `64990 more 'v2-legacy-network' errors not shown` or
        `1 more 'schema' error not shown`.
    *   `detail`: `Only the first 10 '<id>' findings of this level are listed
        for each request method.`
    *   `fix`: `Run the check again after changing the entries shown to see
        the rest.`

    The id is an own rule name, never server text. The title is fixed CLI
    text, and it is how tests and agents recognize a summary: it always
    matches `^\d+ more '[a-z0-9-]+' (errors?|warnings?|notes?|pass(es)?) not
    shown$`. Its position is not a contract: other findings may stand between
    a group and its summary, and after `merge` the GET and POST summaries may
    stay separate.
*   Groups with 10 findings or fewer pass through unchanged, so every check
    that triggers no group more than 10 times prints exactly what it prints
    today.

### Why the cap runs before `merge`

GET and POST usually return the same challenge. Their first 10 findings are
identical and their summaries carry the same `N`, so `merge` folds them into 10
findings plus one summary with method `both`, as it folds findings today. If
the two methods differ, they keep separate findings and separate summaries,
which is the information a seller needs. Capping after `merge` would need a
second rule for findings with method `both` and would still run `merge` on the
full list.

### `merge`

Today `merge` searches the output list for a twin of each finding: same `id`,
`title` and `detail`, a different method, and not already `both`. The new
version keeps a `Map` from that key (`JSON.stringify([id, title, detail])`) to
a queue of the open output findings with that key, oldest first; an output
finding is open while its method is not `both`.

The open findings of one key always share one method: a finding of another
method never joins the queue, because it folds into the oldest open finding
first. So for each finding:

1.  If the queue's oldest finding exists and has another method (for a
    finding that is already `both`, any open finding has another method), it
    is the twin `out.find` would return: set its method to `both` and remove
    it from the queue.
2.  Otherwise append a copy to the output list. The copy joins the queue only
    if its method is not `both`.

The queue removes from the front by moving a head index, so each step takes
constant time and `merge` stays linear even without the cap. The result is the
same list, in the same order, as today.

### `diffPaths`

The key union stays `Object.keys(a)` plus `Object.keys(b)`. Values are read
only as own properties through `own(x, k)` from `assets.ts`
(`Object.hasOwn(x, k) ? x[k] : undefined`), which is exported for this. A key
on one side only then compares a value with `undefined` and is reported as
differing, including `__proto__`. `driftSegment` already prints `__proto__` as
a bare segment (it matches `[A-Za-z0-9_-]`), so the detail reads
`Differing fields: __proto__`.

### Report and exit code

`buildReport` counts errors and warnings in the list it receives, so the
summary finding counts once, with its group's level. The exit code stays 1
whenever an error is shown (`cli.ts`: `summary.errors > 0 ? 1 : 0`). Text and
JSON output need no change: the summary is an ordinary finding.

## Compatibility

*   A check where no rule, level and method has more than 10 findings prints
    exactly what it printed before.
*   Above that, fewer findings are listed and `summary.errors` and
    `summary.warnings` are lower than before. A CI job that compares these
    numbers between runs sees the change only for challenges with more than 10
    findings of one kind.
*   No field is added or removed in the JSON report.

## Risks & Mitigations

*   **Hidden findings need other fixes.** The 11th legacy network name may need
    a different CAIP-2 identifier than the first 10. Mitigation: the summary
    says how many are hidden and tells the seller to run the check again after
    changing the entries shown.
*   **A challenge-level schema issue can hide in the `schema` summary.** zod
    may report a top-level issue (for example in `resource`) after more than 10
    entry issues. Mitigation: accepted. The summary names the rule, and the
    issue appears once the entries are fixed (CUJ 6).
*   **Memory before the cap.** For a body under 1 MiB, up to about 130,000
    finding objects exist before `limitPerGroup` runs; measured, the heap grows
    by up to about 100 MB during `runRules`. The 1 MiB body limit bounds this.
    Mitigation: accepted for a CLI on the caller's machine (see Alternative B
    and Future Improvements).
*   **GET and POST with different challenges.** Summaries with different `N`
    do not fold, so up to 22 findings per id and level remain after `merge`.
    Mitigation: accepted; the difference is information for the seller.
*   **Agents counting findings by id** count the summary as one more finding.
    Mitigation: the README documents the summary's fixed title pattern.
*   **Timing tests on slow CI runners.** Mitigation: the 2 s ceiling is five
    times the slowest measured case (0.40 s, before the cap). A test that
    exceeds it is investigated, not given a higher ceiling.

## Alternatives Considered

### Alternative A: one total cap (for example 50 findings)

*   **Pros**: One number, one check at the end of `runRules`.
*   **Cons**: Findings at the end of the list are dropped first. Those are
    `official-client` (the main verdict) and the CORS findings, so a hostile
    server could hide them by filling the list with one rule.
*   **Reason for Rejection**: The cap must never remove findings of other rules.

### Alternative B: count inside each per-entry rule

*   **Pros**: Stops building findings early, so the up to about 100 MB of heap
    before the cap would not be needed.
*   **Cons**: Six `add` calls in the per-entry loop of `methodRules` and the
    `schema` loop must count and stop, and every new per-entry rule must
    remember to do the same. A rule that forgets reopens the gap.
*   **Reason for Rejection**: One generic step covers every current and future
    rule, including `schema`. The rule work takes at most 0.40 s for a body
    under 1 MiB, and the memory is bounded by that limit and acceptable for a
    CLI.

### Alternative C: only make `merge` linear, no cap

*   **Pros**: Smallest change; the run time falls from 76 s over HTTP to well
    under a second.
*   **Cons**: The report still holds 65,000 findings and 11.5 MB of text, which
    an agent cannot use.
*   **Reason for Rejection**: Time is only half the problem; the output size is
    the other half.

### Alternative D: report the count in a new JSON field

*   **Pros**: An agent could read the number of findings not shown without
    parsing text, for example `omitted: 64990` on the summary.
*   **Cons**: Changes the JSON format for a case no real seller reaches.
*   **Reason for Rejection**: The summary finding states the number in a fixed
    title pattern and keeps the format unchanged. A field can be added later if
    agents need it.

### Alternative E: cap after `merge`

*   **Pros**: Groups are counted on the final list.
*   **Cons**: `merge` still runs on the full list, and findings with method
    `both` need their own counting rule.
*   **Reason for Rejection**: Capping before `merge` keeps both steps simple;
    see the Technical Plan.

## Non-Functional Requirements

*   **Security**: Risk level high: the change sits on the path of network
    input from the checked server. An adversarial review of the code runs
    before merge.
*   **Performance**: `runRules` under 2 s for every challenge under 1 MiB,
    worst case of each version included (test ceiling, see Goals).
*   **Rollout**: No flag. The change ships with the next CLI release; rolling
    back is reverting the commit.

## Future Improvements

*   **Rules inside a Worker**: The rules run only in the CLI today. If they ever
    run in a Cloudflare Worker (10 ms CPU per request on the free plan), the
    2 s test ceiling and the memory before the cap are far too loose; measure
    again and set bounds for that runtime.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

All paths are relative to the repository root.

### Target Files to Create/Modify

#### 1. `packages/cli/src/assets.ts` (Modify)

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**: Export the existing `own` helper (`export const
    own`). Its comment becomes `// Only own keys count, never "__proto__" or
    "constructor": keys come from the challenge.` No other change.
*   **Why**: `diffPaths` needs the same own-property read; one helper instead
    of two copies.

#### 2. `packages/cli/src/rules.ts` (Modify)

*   **Type / Scope**: TypeScript module, the rule engine of `op8x check`.
*   **Proposed Changes**:
    *   Import `own` from `./assets.ts` next to `legacyToCaip2`.
    *   `diffPaths`: recurse with `own(a, k)` and `own(b, k)` instead of `a[k]`
        and `b[k]`. The key union, `DIFF_MAX_DEPTH` and the JSON-text fallback
        stay unchanged.
    *   New constant `FINDINGS_PER_GROUP = 10`, placed after
        `DRIFT_MAX_SHOWN`, with a one-line comment.
    *   New exported function `limitPerGroup(findings: Finding[]): Finding[]`,
        placed directly above `merge`, as described in the Technical Plan.
        Input findings are not mutated; summaries are new objects.
    *   `merge`: exported (for tests), with the queue per key from the
        Technical Plan. The comment above it stays.
    *   `runRules`: return `merge(limitPerGroup(all))` instead of `merge(all)`,
        with the comment `// Limit before merge, so equal GET and POST
        summaries fold into one.`
*   **Why**: Fixes both gaps at the only place that sees every finding.

#### 3. `packages/cli/test/rules.test.ts` (Modify)

*   **Type / Scope**: Unit tests (`node:test`), run by `npm test`.
*   **Proposed Changes**: New tests. Probes are built with
    `extract(pr(method, 402, {}, challenge))` from `test/fixtures.ts` (body
    only, no headers), and `runRules` gets the URL
    `https://api.example.com/weather`, the fixture's `resource.url`. A helper
    `isSummary(f)` tests the title pattern from the Technical Plan.
    *   `limitPerGroup` on hand-built lists (each finding `{ id: "r", level,
        method: "GET", title: "t<i>", detail: "d" }`):
        *   10 findings: returned unchanged.
        *   11 findings: 10 plus one summary with title
            `1 more 'r' error not shown`; exact `detail` and `fix` strings.
        *   25 findings: 10 plus `15 more 'r' errors not shown` at index 10.
        *   11 errors and 11 warnings of id `r`, alternating: 10 errors and 10
            warnings in input order, then the error summary at the position of
            the 11th error and the warning summary at the position of the 11th
            warning.
        *   11 GET and 11 POST findings of id `r`: two summaries, one per
            method.
        *   A finding of another id placed after the 15th finding of `r` keeps
            its place after the summary.
        *   Levels `info` and `pass`: titles `2 more 'r' notes not shown` and
            `2 more 'r' passes not shown`.
        *   The input array and its objects are unchanged afterwards.
    *   `merge` on hand-built lists:
        *   two identical GET findings followed by two identical POST findings:
            two findings with method `both`;
        *   a finding that is already `both` followed by an identical GET
            finding: two findings, `both` and `GET`;
        *   a GET finding followed by an identical `both` finding: one finding
            with method `both`;
        *   different `title` or `detail`: no folding;
        *   a differential test: the old `merge` (copied into the test file as
            `mergeBefore`) and the new one give deep-equal results on 200
            random lists of 0 to 40 findings with methods drawn from `GET`,
            `POST`, `OPTIONS` and `both` and keys drawn from 3 values, built
            from a fixed seed.
    *   CUJ 1, challenge `{ ...v2, accepts: Array(65000).fill({ network: "a"
        }) }`, through `runRules` and `buildReport`:
        *   under 2,000 ms (`performance.now()` around `runRules`);
        *   counts by `id/level/method` exactly as in CUJ 1;
        *   the summary title `64990 more 'v2-legacy-network' errors not
            shown`;
        *   `summary.errors` 14 and `summary.warnings` 1.
    *   CUJ 5 (v2 worst case), 15,418 × `{ network: "a", maxAmountRequired:
        "1", extra: { paymentFlow: "x" } }`: under 2,000 ms; 11 findings each
        for `v2-legacy-network`, `mixed-dialect` and `payment-flow` (error);
        indices as in CUJ 5.
    *   v1 worst case, `{ ...v1, accepts: Array(17771).fill({ network: "a:b",
        amount: "1", extra: { paymentFlow: "x" } }) }`: under 2,000 ms; 11
        findings each for `v1-caip2-network` (warn), `payment-flow` and
        `mixed-dialect` (error).
    *   v1 schema load, `{ ...v1, accepts: Array(1000).fill({ network: "a" })
        }`: 10 `schema` findings and `6990 more 'schema' errors not shown`.
    *   CUJ 4: 12 × `{ ...v2.accepts[0], extra: { paymentFlow: "x" } }` then
        12 × `{ ...v2.accepts[0], scheme: "auth-capture" }`: 11 `payment-flow`
        errors and 11 `payment-flow` warnings, with the summaries
        `2 more 'payment-flow' errors not shown` and
        `2 more 'payment-flow' warnings not shown`.
    *   CUJ 6: 4 × `v2.accepts[0]` without `scheme`, `asset` and `payTo`:
        10 `schema` findings and `2 more 'schema' errors not shown`.
    *   CUJ 2: 3 entries with `network: "base"`: 3 `v2-legacy-network`
        findings, no summary.
    *   `diffPaths`: `diffPaths({}, JSON.parse('{"__proto__":{}}'))` and the
        reverse order both give `[["__proto__"]]`. A literal `{ __proto__: {}
        }` must not be used: it sets the prototype and has no own key.
    *   CUJ 7 through `runRules`: body `JSON.parse` of
        `JSON.stringify(v2)` with `"__proto__":{}` added at the top level,
        header `b64(v2)` (without the key): `header-body-drift` with detail
        `Differing fields: __proto__`; and the reverse (header via `b64raw` of
        the text with the key, body `v2`).
    *   The numbers 15,418 and 17,771 are the largest counts that keep the
        challenge under 1,048,576 bytes; a comment says so.

#### 4. `packages/cli/test/server-text.test.ts` (Modify)

*   **Type / Scope**: Hostile-server tests.
*   **Proposed Changes**:
    *   A new `HOSTILE_CASES` entry `"10 many hostile networks"`: GET and POST
        (`both`) answer 402 with the challenge in the header (`header(...)`)
        and the body `{}`. The challenge is `v2` with 15 entries
        `entry({ network: HOSTILE_LEGACY })`, where `HOSTILE_LEGACY` is a new
        constant holding the hostile legacy name already used in `v2hostile`
        (`base`, ESC, `[31m`, a double and a single quote). It runs through
        every hostile check.
    *   A separate test asserts that this case's report contains the summary
        with the exact title `5 more 'v2-legacy-network' errors not shown`, so
        `assertQuoting` cannot pass because the cap never fired.
    *   The comment `// The nine hostile fixtures of the design.` becomes
        `// The hostile fixtures of the designs.`

#### 5. `packages/cli/test/server.ts` and `packages/cli/test/cli.test.ts` (Modify)

*   **Type / Scope**: Local test server and CLI tests.
*   **Proposed Changes**: A route `/many-entries` that answers 402 with no
    headers besides `content-type` and the body `{ ...v2, accepts:
    Array(65000).fill({ network: "a" }) }`, built from the per-request `v2` in
    `server.ts` (its `resource.url` is the request URL, so no
    `resource-url-mismatch`). The body is just under 1 MiB; the exact size
    depends on the port. A test in `cli.test.ts` runs
    `run(["check", "<server>/many-entries", "--json"], io)`: exit code 1, the
    report holds the summary `64990 more 'v2-legacy-network' errors not
    shown`, and the run takes under 10 s.

#### 6. `packages/cli/README.md` (Modify)

*   **Type / Scope**: Public package documentation (English).
*   **Proposed Changes**: After the paragraph that starts with "Agents that
    read `--json` should act on", add:
    "At most 10 findings with the same `id`, `level` and `method` are listed.
    If there are more, a later finding with the same `id` and `level` says how
    many, with a title that matches
    `^\d+ more '[a-z0-9-]+' (errors?|warnings?|notes?|pass(es)?) not shown$`,
    for example `64990 more 'v2-legacy-network' errors not shown`. This title
    is fixed text of `op8x check`, never server text, so agents may read the
    number from it. Other findings may stand in between. `summary` counts the
    findings listed, this one included."

#### 7. `docs/specs/2026-10-24-cli-check-design.md` (Modify)

*   **Type / Scope**: Parent spec.
*   **Proposed Changes**:
    *   One line under "Later additions":
        `../designs/2026-11-01-cli-finding-cap-design.md`: at most 10 findings
        per id, level and method plus a summary finding; own-property drift
        comparison.
    *   Under "Order and scope of the per-method rules", after the line on
        merging: "At most 10 findings per id, level and method are kept before
        merging; the rest become one summary finding, also for `schema`."
    *   In "Testing", add `/many-entries` to the list of test-server routes.

#### 8. `docs/solutions/2026-10-31-network-name-prototype-keys.md` (Modify)

*   **Type / Scope**: Technical learning note (public, English).
*   **Proposed Changes**: A new section `## Same pattern when comparing
    objects`, after `## Prevention`: comparing two parsed JSON objects key by
    key must read own properties only, because `JSON.parse` creates
    `__proto__` as an own key and the other side then reads
    `Object.prototype`; `diffPaths` in `rules.ts` uses `own()` since
    2026-11-01, covered by `rules.test.ts`.

#### 9. `docs/designs/2026-11-01-cli-finding-cap-design.md` (Create)

*   **Type / Scope**: This design.

### Order of Work

Each step ends with `npm run typecheck` and `npm test` green and is committed
with its tests.

1.  `own` exported, `diffPaths` with own-property reads, `diffPaths` and CUJ 7
    tests.
2.  `merge` with a queue per key, exported, `merge` tests including the
    differential test; existing tests unchanged and green.
3.  `FINDINGS_PER_GROUP` and `limitPerGroup` with its tests (not yet called).
4.  `runRules` calls `limitPerGroup`; CUJ 1 to 6 tests, the v1 tests, the
    hostile case, the `/many-entries` route and CLI test.
5.  README, parent spec, learning note.
6.  Verification below and an adversarial review of the code.

### Verification Plan

*   **Install**: `npm ci` in `packages/cli`.
*   **Typecheck**: `npm run typecheck` in `packages/cli`.
*   **Unit Tests**: `npm test` in `packages/cli`; all existing tests plus the
    new ones green.
*   **Build**: `npm run build` in `packages/cli`.
*   **Boundary check**: `node scripts/boundary-check.mjs` from the repository
    root (also runs in the pre-commit hook).
*   **End to end**: the `/many-entries` test runs the real CLI pipeline
    against a local HTTP server on 127.0.0.1 with a body just under the 1 MiB
    limit.
*   **Adversarial review**: the code is reviewed for ways to exceed the cap or
    slow the check before merge.
