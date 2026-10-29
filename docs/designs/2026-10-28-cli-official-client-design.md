# op8x CLI: official client verdict from `@x402/core`

*   **Author:** op8x
*   **Status:** Approved
*   **Date:** 2026-10-28

--------------------------------------------------------------------------------

## Overview

`op8x check` ends every 402 response with one finding, `official-client`: can the official x402 client read this challenge, yes (`pass`) or no (`error`)? Today the CLI answers that question with its own copy of the client's logic (`officialClientCanRead` in `packages/cli/src/extract.ts`), written by hand against `@x402/core` 2.28 and updated by hand for 2.29. This design replaces the copy with a call to the real client code, `x402HTTPClient.getPaymentRequiredResponse` from `@x402/core/http`. The CLI's own header decoder stays, but only to explain *why* a header fails (`header-not-base64`, `header-not-json`), not to decide *whether* it fails; it decodes the same way as the official decoder, so both see the same value.

Extends `docs/specs/2026-10-24-cli-check-design.md` (the `official-client` rule and the `extract.ts` unit).

## The Problem

The `official-client` verdict is the finding sellers act on first: it says whether paying clients can get past the first step. It is only as true as the copy it comes from, and the copy is already wrong in one case.

The official client checks the header with `if (paymentRequired)`, so an **empty** `PAYMENT-REQUIRED` header counts as no header, and the client falls back to a v1 body. The copy checks `headerRaw !== undefined`, so for an empty header it tries to decode `""`, fails, and reports `official-client: error`. Reproduced against the installed `@x402/core` 2.28.0; the read path in the published 2.29.0 is the same (read on 2026-10-29), and the cases are re-run against 2.29.0 before building (see Verification Plan):

| Response | Official client | `op8x check` today |
| --- | --- | --- |
| Empty `PAYMENT-REQUIRED` header, v1 challenge in body | reads the v1 body | error: cannot read |
| No header, v2 challenge in body | throws `Invalid payment required response` | error (agrees) |
| base64url header | throws `Invalid payment required header` | error (agrees) |

The CLI's own decoder also differs from the official one. Both use the same regex, but the official decoder then uses `atob` and `TextDecoder`, the CLI uses `Buffer`:

| Header | Official decoder | CLI decoder today |
| --- | --- | --- |
| Standard base64 with wrong padding (`eyJhIjoxfQ=`) | `atob` throws | decodes `{"a":1}` |
| base64 of a UTF-8 BOM followed by JSON | `TextDecoder` drops the BOM, parses | `header-not-json` |

A hand-written copy also drifts silently whenever `@x402/core` changes how it reads challenges. Nothing in CI compares the copy with the real code, so the next difference would also go unnoticed until a seller reports a wrong verdict.

`docs/specs/2026-10-24-cli-check-design.md` (line 36) says `extract.ts` depends on `@x402/core/http` and `@x402/core/schemas`. It depends on neither; a drift check on 2026-10-28 found this.

## Goals

*   The `official-client` verdict comes from calling `x402HTTPClient.getPaymentRequiredResponse` of the installed `@x402/core`, with the response's headers and the body as `@x402/fetch` passes it on, not from a copy of its logic.
*   For every response that counts as a 402 (`is402`), `official-client` reports `pass` if and only if that call returns a JSON object without throwing.
*   An empty `PAYMENT-REQUIRED` header counts as no header, as in the official client, and is reported as `header-empty` (warn). A test pins the empty-header case above.
*   The CLI's own decoder decodes like the official one (`atob`, `TextDecoder`), so on every input known today it reads the same value as the official one.
*   The detailed header findings (`header-not-base64`, `header-not-json`) keep their wording; the CLI's own decoder remains their only source. `header-not-base64` now also covers base64 that `atob` rejects (wrong padding).
*   When the CLI's decoder and the official client still disagree, the official verdict stands, in both directions: an `official-client` error names the client's reason, and a header the official client reads gets `header-not-base64`/`header-not-json` only as `warn`.
*   The JSON report names the installed `@x402/core` version, so every verdict can be re-derived.
*   `docs/specs/2026-10-24-cli-check-design.md` describes the dependencies of `extract.ts` and the other units correctly.

## Non-Goals

*   No new rules except `header-empty`.
*   No change to the logic of any existing rule apart from the level of `header-not-*` on a decoder disagreement; their input changes as listed under Rollout.
*   No new runtime dependency; `@x402/core` stays the only one, at `~2.29.0` (as on `main` since 2026-10-29).
*   No schema validation inside the verdict: `getPaymentRequiredResponse` does not validate, and `schema` findings stay a separate rule. Only the JSON type of the result (object or not) is checked.
*   No payments, signing or wallet use; the client object is used only to read the challenge.
*   No changes to the website.

## Open Questions and Decisions

No open questions. Decisions taken while drafting and review (2026-10-28 and 2026-10-29):

*   **Disagreement between decoders**: the official verdict wins; the `official-client` detail carries the client's error message, and when the official client reads a header the own decoder rejects, `header-not-*` drops to `warn`. No extra rule. The own decoder decodes like the official one, so the known differences disappear.
*   **Version in the report**: the JSON report gets a top-level field with the installed `@x402/core` version, and the `official-client` detail names it.
*   **Empty header**: counts as "no header" everywhere, plus a new warning `header-empty`.
*   **Body passed to the client**: as `wrapFetchWithPayment` in `@x402/fetch` 2.29.0 builds it before calling `getPaymentRequiredResponse` (`dist/cjs/index.js`): the body text, decoded by `TextDecoder` (which drops a leading BOM), through `JSON.parse`; a parse failure gives `undefined`; the content type is not checked. That is `e.body` as `extract` builds it today. `@x402/axios` is not checked. (`x402HTTPClient.processResponse` in `@x402/core` checks the content type, but it is an app-level helper that swallows challenge-decoding errors, not the path a paying client takes.)
*   **Result that is not an object**: a header that decodes to `42`, `null` or a string does not make the call throw, but no client can pay it. It counts as not readable, reason "challenge is not a JSON object".
*   **Name and place**: the function stays in `extract.ts`; it returns a result with a reason instead of a boolean, so it is renamed `officialClientRead`.

## Technical Plan (Architecture)

### Data flow

```text
probe ──► ProbeResult (headers lower-cased, bodyText)
            │
            ▼
extract ──► Extracted
            ├─ headers (the probe's map), headerRaw (non-empty only), headerEmpty, headerError, header, body, bodyChallenge, location
            └─ official = officialClientRead(e) ──► x402HTTPClient.getPaymentRequiredResponse(getHeader, e.body)
                                         returns an object → { readable: true }
                                         returns other     → { readable: false, reason: "challenge is not a JSON object" }
                                         throws            → { readable: false, reason: cleanReason(err) }
            │
            ▼
rules (x402Core passed in) ──► header-empty, header-not-base64, header-not-json, ... (own decoder; warn if official.readable)
                               official-client pass/error (e.official + reason + @x402/core version)
            │
            ▼
report ──► JSON adds "x402Core": "<version>"; text unchanged apart from finding details
```

### Calling the official client

*   `extract.ts` imports `x402HTTPClient` from `@x402/core/http`. The instance is created on first use inside the `try` of `officialClientRead`, with an empty client object (`new x402HTTPClient({} as never)` or an equivalent typed stub), and kept for later calls. A constructor that throws in a future version becomes `{ readable: false, reason }`, not a crash of the CLI at load time. `getPaymentRequiredResponse` does not use the inner client; no network, no signing.
*   `officialClientRead(e: Extracted): OfficialRead` (type in `types.ts`) calls `getPaymentRequiredResponse(getHeader, e.body)`. `extract` calls it once and stores the result in `e.official`; `rules.ts` only reads `e.official`, so rule tests can set it directly.
    *   `getHeader(name)` returns `e.headers[name.toLowerCase()]`: every response header the probe saw, so a future `@x402/core` that reads another header sees it too. An empty `PAYMENT-REQUIRED` stays `""` in that map; the official logic, not ours, decides what an empty value means.
    *   `e.body` is the body as `@x402/fetch` passes it on (see Open Questions and Decisions): the parsed JSON after BOM removal, `undefined` if the body is not JSON, whatever the content type.
    *   A returned value that is not a non-null, non-array object gives `{ readable: false, reason: "challenge is not a JSON object" }`.
    *   Any exception becomes `{ readable: false, reason: cleanReason(err) }`. Nothing escapes the function.
*   `cleanReason(thrown: unknown): string` takes the thrown value: an `Error` (including `DOMException` from `atob`) with a non-empty message gives that message; an empty message or anything else gives `"unknown error"`. It then removes characters of the Unicode categories Cc (C0, DEL, C1), Cf (format and bidi characters such as U+200B, U+202A-U+202E, U+2066-U+2069), Zl and Zp (U+2028, U+2029) and Cs (lone surrogates), trims surrounding whitespace, drops one trailing period, and caps the text at 200 code points; a result that is empty gives `"unknown error"`.
*   `extract` calls it for every probe; the rules only read `e.official` for responses where `is402` holds (402, and 412 with `permit2_allowance_required`), as today; per-method rules stop earlier for other statuses.

### Own decoder

*   `decodeHeader` keeps the regex `^[A-Za-z0-9+/]*={0,2}$` (the same as `Base64EncodedRegex` in `@x402/core`), then decodes like `safeBase64Decode` in `@x402/core`: `atob`, bytes, `TextDecoder("utf-8")`. Both are global in Node 20. A regex or `atob` failure is `not-base64`; a `JSON.parse` failure is `not-json`.
*   With that, the two decoders agree on every input the CLI knows of. If a future `@x402/core` decodes differently, the official verdict still decides (Goals):
    *   official fails, own passes: an `official-client` error without a matching `header-*` finding; its detail names the reason.
    *   official reads, own fails (for example if the official decoder starts accepting base64url): `header-not-base64`/`header-not-json` become `warn`, and their detail adds "@x402/core <version> reads this header; clients with a stricter decoder may not." `official-client` passes.

### Empty header

*   `extract` treats a `PAYMENT-REQUIRED` value of `""` as absent for its own analysis: `headerRaw` stays `undefined`, a new field `headerEmpty: true` is set, and `location` ignores it. Node's `fetch` keeps an empty header and delivers a whitespace-only value as `""` too (checked on 2026-10-28 against a local `node:http` server), so both cases take this path; a test pins the whitespace case.
*   All existing rules that test `headerRaw` (`v2-body-only`, `mcp-endpoint`, `official-client` today) therefore see "no header" for an empty one. With an empty header and a v2 body, `v2-body-only` and `header-empty` appear together; `header-empty` explains that the header is present but empty, so the `v2-body-only` text stays unchanged.
*   New rule `header-empty`, level `warn`, per method, on 402 responses with `headerEmpty`: title "PAYMENT-REQUIRED header is empty"; detail "The header is present with an empty value. The official client ignores it and falls back to the body; clients that only check whether the header exists will fail."; fix "Remove the empty header, or put the base64 challenge in it."
*   Expected findings for two empty-header cases (402, `Cache-Control: no-store`; CORS findings are not part of these cases):
    *   with a v1 body: `header-empty` (warn), `v1-legacy` (info), `official-client` pass, exit 0;
    *   without a body challenge: `header-empty` (warn), `no-challenge` (error), `official-client` error, exit 1.

### Finding text for `official-client`

*   Pass: title unchanged; detail "@x402/core <version> reads the challenge where the official client looks for it."
*   Error: title unchanged; detail "@x402/core <version>: <reason>. The official client would fail before signing; see the other findings." The reason has no trailing period (`cleanReason`). When no other error finding explains the failure (a disagreement between decoders), this detail is the only explanation, by decision.

### Version of `@x402/core`

*   New unit `src/core-version.ts` exports `X402_CORE_VERSION: string`. It resolves `@x402/core/http` with `createRequire(import.meta.url).resolve` (the package has a `require` condition for `./http`; synchronous `import.meta.resolve` needs Node 20.6, while the CLI supports Node >= 20), walks up from that file to the first `package.json` whose `name` is `@x402/core`, and reads `version`. `@x402/core/package.json` cannot be imported directly (not in the package's `exports`; `ERR_PACKAGE_PATH_NOT_EXPORTED`). The CJS path only locates the package root; the ESM entry that `extract.ts` loads lives in the same package. Any failure gives `"unknown"`; the lookup never throws. Computed once at module load.
*   `runRules` and `buildReport` both take the version as a parameter, so tests stay deterministic; only `cli.ts` imports `X402_CORE_VERSION`.
*   `Report` gets a top-level field `x402Core: string` after `version`.
*   The text report shows the version only inside the `official-client` detail.

### Changed units

| File | Change | Depends on |
| --- | --- | --- |
| `src/extract.ts` | `headers`, `headerEmpty`, `official`; decoder like `@x402/core`; `officialClientRead` calls the official client | `@x402/core/http` |
| `src/core-version.ts` | new: installed `@x402/core` version | `node:module`, `node:fs`, `node:path` |
| `src/rules.ts` | `header-empty`; `official-client` and the level of `header-not-*` use `e.official` and the passed version | `@x402/core/schemas`, `report` |
| `src/report.ts` | `x402Core` field | `probe` |
| `src/types.ts` | `Extracted.headers`, `Extracted.headerEmpty`, `Extracted.official`, `OfficialRead` | none |
| `src/cli.ts` | passes the version to `runRules` and `buildReport` | as today, plus `core-version` |

`rules.ts` remains free of I/O and no longer touches `@x402/core/http`: it gets the version as a parameter and the official result in `e.official`. `officialClientRead` works on in-memory data only; its one piece of state is the cached client instance, which has no visible effect.

## Alternatives Considered

### Alternative A: Keep the hand-written copy, add a CI test against the real client

*   **Mechanism**: `officialClientCanRead` stays a copy. A new test feeds a table of responses (empty header, base64url, v2 body only, v1 body, valid header) to both the copy and `getPaymentRequiredResponse` and fails when they disagree.
*   **Pros**: No runtime dependency on `@x402/core/http`; the verdict cannot change between two installs of the same CLI version.
*   **Cons**: Only catches differences for inputs in the table; a new edge case in a future `@x402/core` (like the empty header was) is missed until someone adds it. The copy must still be fixed by hand for each difference found.
*   **Reason for Rejection**: The verdict claims to be the official client's verdict. A copy that is only checked on known inputs cannot make that claim.

### Alternative B: Use `decodePaymentRequiredHeader` from `@x402/core/http` for the detailed findings too

*   **Mechanism**: Drop the own decoder; derive `header-not-base64` and `header-not-json` from the official decoder's exception.
*   **Pros**: One decoder, no possible disagreement.
*   **Cons**: The official decoder fails in three ways: `Invalid payment required header` for a regex failure, a `DOMException` from `atob`, and a `SyntaxError` from `JSON.parse`. Telling them apart means matching exception types and messages, which change without notice between versions.
*   **Reason for Rejection**: The detailed findings and their fix hints would depend on message strings of another package. The own decoder for diagnosis is kept, by decision; it copies the official decoding steps, which are standard platform functions, not the messages.

### Alternative C: Pin `@x402/core` to an exact version instead of reporting it

*   **Mechanism**: Change the dependency from `~2.29.0` to `2.29.0`, so every install of a CLI version runs the same client.
*   **Pros**: The CLI version alone identifies the client; no version lookup at runtime.
*   **Cons**: Sellers and CI miss client patch releases until a new CLI release; an exact pin also blocks deduplication with other x402 packages in the same project.
*   **Reason for Rejection**: Reporting the installed version gives the same traceability without freezing patch updates.

### Alternative D: Add `@x402/fetch` as a devDependency and test the body handling against it

*   **Mechanism**: A CI test runs `wrapFetchWithPayment` (with a stub client) against the local test server routes and compares its read or failure with `officialClientRead` for the same responses.
*   **Pros**: The body handling copied from `@x402/fetch` is tested instead of read by hand; no runtime dependency.
*   **Cons**: A new devDependency with its own dependencies for four copied lines; the stub client must satisfy the signing hooks `wrapFetchWithPayment` calls after reading the challenge.
*   **Reason for Rejection**: Reading the body handling again before each `@x402/core` update (Verification Plan) covers four lines. Revisit if the body handling in `@x402/fetch` changes.

--------------------------------------------------------------------------------

## Risks & Mitigations

*   **Untrusted input in a third-party parser**: The CLI parses untrusted network input. The new call runs `atob`, `TextDecoder` and `JSON.parse` inside `decodePaymentRequiredHeader` on input the own decoder already parses; every exception is caught in `officialClientRead`. Headers are bounded by Node's HTTP header limit (16 KB by default), bodies by the 1 MiB limit of `readLimitedText` (see Body size). The exception message goes into report text. Mitigation: `cleanReason` removes control, format, bidi and line-separator characters, removes lone surrogates, trims, and caps the length at 200 code points.
*   **Verdict differs between installs of one CLI version**: `~2.29.0` allows patch updates, so two installs can run different client code. Mitigation: the report names the installed version (`x402Core`), so each verdict can be re-derived.
*   **Version lookup fails**: bundled or relocated installs, or a `package.json` more than 8 parent directories up, give `"unknown"`. Accepted limit: the report stays valid; the detail then reads "@x402/core unknown: ...".
*   **Constructor changes in a patch release**: Mitigation: the client is created inside the `try` on first use, so a failing constructor gives an `official-client` error instead of crashing every command, including `--help` and `--version`. Accepted limit: a failure while `@x402/core` modules load would stop every command, as it does today for `@x402/core/schemas`.
*   **Decoders drift apart again**: the own decoder copies the official decoding steps today. Mitigation: the official verdict decides in both directions (see Own decoder), so the report never contradicts it.
*   **Body handling is a small copy**: the body rule (text, `JSON.parse`, failure gives `undefined`) copies four lines of `@x402/fetch`, which is not a dependency. Mitigation: the Verification Plan reads that code in the version current at build time; a change there is a change to this design.
*   **Body size and broken bodies**: `@x402/fetch` 2.29.0 reads a 402 body with `readLimitedText(response, MAX_CONTROL_PLANE_RESPONSE_BYTES)` (1 MiB) before it looks at the header, and that call is not inside its `try`: a body over 1 MiB or a stream that breaks off makes the official client fail even with a valid header. The CLI reads every body with the same function and limit from `@x402/core/http`. A body error keeps status and headers and sets `ProbeResult.bodyError`; `officialClientRead` then returns `{ readable: false, reason: cleanReason(<body error>) }` without calling the client. This replaces the earlier 256 KB cap.
*   **Unfiltered server text elsewhere**: other findings already print server-controlled text unfiltered (`Location` in `redirect`, the first 40 characters of the header in `header-not-base64`, schema messages with field paths). `cleanReason` is the first place that removes control characters; applying the same cleaning to every server-derived string in finding details is a separate change. Accepted limit (separate change).

## Rollout

Ships with the next CLI release; no flag. Behaviour changes for these inputs:

*   **Empty `PAYMENT-REQUIRED` header**: no more `header-not-json`; new `header-empty` (warn, counted in `summary.warnings`); `location` is `body` or `none` instead of `both` or `header`. Then, by body:
    *   v1 body: `official-client` turns from error to pass, and the **exit code from 1 to 0**;
    *   v2 body: `v2-body-only` (error) now fires;
    *   no body challenge: `no-challenge` (error) now fires;
    *   a 406 JSON-RPC answer with an empty header now counts as an MCP signal.
*   **Base64 that `atob` rejects (wrong padding)**: now `header-not-base64` and `official-client` error. The header no longer yields a challenge, so the challenge comes from the body or is absent: `version-missing`, `schema`, `v2-legacy-network`, `mixed-dialect`, `payment-flow` and `v1-legacy` are computed from the body, `v2-header-only` and `header-body-drift` no longer fire, and the CORS version planning (`cors-expose-headers`, preflight headers) loses the header version.
*   **Header text with a BOM**: now read. The reverse of the previous case: the header becomes the challenge, and the same findings now apply to it; `header-not-json` disappears.
*   **Header that decodes to a non-object** (`42`, `null`, a string, an array): `official-client` was pass, now error.
*   **Every 402 response**: the `official-client` detail text changes, which affects consumers that match on `detail`. The JSON report gains one field (`x402Core`); existing fields are unchanged, so consumers that ignore unknown fields are not affected.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

Paths relative to `packages/cli/` unless marked "repository root". Before building, the branch is brought up to date with `origin/main`, which has `@x402/core ~2.29.0`, and `npm ci` runs in `packages/cli` of the worktree.

#### 1. `src/types.ts` (Modify)

*   **Type / Scope**: TypeScript types.
*   **Proposed Changes**: `Extracted` gets `headers: Record<string, string>` ("Response headers as the probe saw them, keys lower-cased"), `headerEmpty?: true` ("`PAYMENT-REQUIRED` present with an empty value; treated as absent") and `official: OfficialRead` ("What the official client of the installed `@x402/core` makes of this response"). The doc comment of `body` adds "as `@x402/fetch` passes it to the official client". New exported type `OfficialRead = { readable: true } | { readable: false; reason: string }`. The doc comment of `headerRaw` becomes "Raw non-empty `PAYMENT-REQUIRED` header value".

#### 2. `src/extract.ts` (Modify)

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**:
    *   `decodeHeader`: after the regex, decode with `atob`, convert to bytes and decode with `TextDecoder("utf-8")`, then `JSON.parse`. An `atob` failure returns `not-base64`. The comment above `BASE64` says the regex and the decoding steps match `@x402/core`.
    *   Import `x402HTTPClient` from `@x402/core/http`; the instance is created on first use inside the `try` of `officialClientRead` and kept in a module variable.
    *   In `extract`: copy `p.headers` into `headers`. If the `payment-required` value is `""`, set `headerEmpty: true` and leave `headerRaw` unset; `location` and `challenge` ignore the empty header. Body parsing is unchanged. Last step: `official = officialClientRead(out)`.
    *   Replace `officialClientCanRead(e): boolean` with `officialClientRead(e): OfficialRead`. `getHeader(name)` returns `e.headers[name.toLowerCase()]`. Body argument: `e.body`. A result that is not a non-null, non-array object gives `{ readable: false, reason: "challenge is not a JSON object" }`. `try/catch` around construction and call; the thrown value goes through the exported helper `cleanReason(thrown: unknown): string` (see Technical Plan).
    *   The comment above the function says it calls `@x402/core` and that the own decoder is for detailed findings only.

#### 3. `src/core-version.ts` (Create)

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**: `export function findPackageVersion(startDir: string, name: string): string | undefined` checks `startDir` and at most 8 parent directories, stopping early at the filesystem root (`dirname(dir) === dir`); in each it tries to read and `JSON.parse` `package.json` and returns `version` from the first file whose `name` equals `name` and whose `version` is a string. Unreadable or invalid files and files with another `name` are skipped. `export const X402_CORE_VERSION: string` = `findPackageVersion(dirname(createRequire(import.meta.url).resolve("@x402/core/http")), "@x402/core") ?? "unknown"`, inside one `try/catch` that also yields `"unknown"`. No exception leaves the module.

#### 4. `src/rules.ts` (Modify)

*   **Type / Scope**: TypeScript module (pure rules).
*   **Proposed Changes**:
    *   Drop the import of `officialClientCanRead`; the official result is read from `e.official`.
    *   `runRules(results, preflight?, url = "<url>", x402Core = "unknown")`: the version reaches `methodRules` as a second parameter, through `results.flatMap((e) => methodRules(e, x402Core))` (a bare `flatMap(methodRules)` would pass the array index).
    *   New finding `header-empty` (warn) in `methodRules`, right after the `is402` check and before `header-not-base64`, with the title, detail and fix from the Technical Plan.
    *   `official-client`: pass and error details as in the Technical Plan, from `e.official`, with the version and, on error, the reason.
    *   `header-not-base64` and `header-not-json`: level `warn` with the added sentence from Own decoder when `e.official.readable` is true; `error` otherwise, as today.
    *   No other rule changes. `v2-body-only` and `isMcpSignal` keep testing `headerRaw`, which now excludes empty headers.

#### 5. `src/report.ts` (Modify)

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**: `Report` gets `x402Core: string` between `version` and `url`. New signature `buildReport(url, version, x402Core, probes, findings, now?)`. Text rendering unchanged.

#### 6. `src/cli.ts` (Modify)

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**: Import `X402_CORE_VERSION` and pass it to `runRules` and `buildReport`. Nothing else.

#### 7. `test/extract.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Replace the four `officialClientCanRead` assertions with `extract(...).official.readable`. New tests:
    *   `extract` copies the probe's headers into `headers`, including an empty `payment-required`;
    *   empty header with v1 body → `headerEmpty`, `location: "body"`, readable;
    *   empty header without body → `location: "none"`, not readable with a reason;
    *   base64url header → not readable, reason contains `Invalid payment required header`;
    *   base64 header that is not JSON → not readable with a non-empty reason;
    *   standard base64 with wrong padding → `headerError: "not-base64"`, not readable;
    *   base64 of a BOM followed by a v2 challenge → decoded, readable, no `headerError`;
    *   base64 of `42` → not readable, reason "challenge is not a JSON object";
    *   `cleanReason`: removes control characters, DEL, bidi/format characters (U+202E, U+200B), U+2028 and lone surrogates, trims, drops a trailing period, caps at 200 code points without splitting a surrogate pair, maps an `Error` to its message, and an `Error` with an empty message or anything else to `"unknown error"`.

#### 8. `test/rules.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: `header-empty` appears for an empty header on a 402 and not for an absent header or a non-402; with a version passed to `runRules`, the `official-client` pass detail names it; the error detail contains the version and the client's reason; with `official` set to `{ readable: true }` on an extract that has `headerError: "not-base64"`, `header-not-base64` is `warn` with the added sentence and `official-client` passes; for the two empty-header cases in the Technical Plan (fixtures with `Cache-Control: no-store`), the findings other than CORS are exactly the ones listed.

#### 9. `test/report.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Update the `buildReport` calls to the new signature; assert `x402Core` in the JSON output, placed after `version`.

#### 10. `test/smoke.test.ts` (Modify)

*   **Type / Scope**: Smoke test.
*   **Proposed Changes**: `X402_CORE_VERSION` equals the `version` in `node_modules/@x402/core/package.json`, which the test finds by walking up from `packages/cli` independently of the code under test (works with or without hoisting), and its major and minor match the `~2.29.0` range in `package.json`. `findPackageVersion` on temporary directories: no matching `package.json` gives `undefined`; a `package.json` with invalid JSON is skipped; one with another `name` is skipped and the walk continues to the parent; a match 8 parents up is found; a match 9 parents up gives `undefined`.

#### 11. `test/server.ts` and `test/cli.test.ts` (Modify)

*   **Type / Scope**: Integration test.
*   **Proposed Changes**: New route `/empty-header-v1`: 402 with `PAYMENT-REQUIRED: ""`, a valid v1 body with `Content-Type: application/json` and `Cache-Control: no-store`. Test: exit 0, findings contain `header-empty` (warn) and `official-client` (pass), JSON `x402Core` equals `X402_CORE_VERSION`. Second route `/blank-header-v1`, the same with `PAYMENT-REQUIRED: " "`: the same findings, which pins that `fetch` delivers a whitespace-only value as `""`.

#### 12. `README.md` (Modify)

*   **Type / Scope**: Package documentation.
*   **Proposed Changes**: Add the empty header to the list of reported problems. Update the example: the `official-client` error detail now starts with `@x402/core <version>: Invalid payment required response`, with the installed version. State that the JSON report names the `@x402/core` version that read the challenge (`x402Core`).

#### 13. `docs/specs/2026-10-24-cli-check-design.md` (Modify, repository root)

*   **Type / Scope**: Design document.
*   **Proposed Changes**:
    *   Section "Background facts", bullet "Official client" (line 27 today): one sentence pointing to this design for how `official-client` is decided.
    *   Section "Architecture", units table (line 36 today): `extract.ts` depends on `@x402/core/http` only; `rules.ts` on `@x402/core/schemas`, `report`; `report.ts` on `probe`; the `cli.ts` row adds `core-version`; add rows for `core-version.ts`, `version.ts`, `bin.ts` and `types.ts`.
    *   Rules table, row `official-client` (line 84 today): add `header-empty` directly before `header-not-base64`; the `official-client` condition becomes "the official client of the installed `@x402/core` reads the challenge".
    *   Rules table, rows `header-not-base64` and `header-not-json` (lines 72-73 today): Level becomes "error (warn when the official client of the installed `@x402/core` reads the header)".
    *   JSON example adds `x402Core`.

#### 14. `docs/designs/2026-10-28-cli-official-client-design.md` (Modify, repository root)

*   **Type / Scope**: Design document (this document).
*   **Proposed Changes**: Set Status to "Approved" after review.

### Verification Plan

*   **Before building**: the branch is rebased on `origin/main`, `npm ci` runs in `packages/cli` of the worktree, and the installed `@x402/core` is confirmed to be 2.29.x; then the cases in both tables of The Problem are re-run against the installed 2.29.0, and the body handling of `wrapFetchWithPayment` in the current `@x402/fetch` is read again; the document is corrected if anything differs.
*   **Compilation/Build**: `npm run typecheck` and `npm run build` in `packages/cli`.
*   **Unit Tests**: `npm test` in `packages/cli`: all existing tests plus the new ones above.
*   **Static Analysis & Linting**: `node scripts/boundary-check.mjs` from the repository root (pre-commit hook and CI).
*   **Test Coverage Requirement**: every branch of `officialClientRead` (returns an object, returns something else, throws) and of `cleanReason` (`Error`, empty message, other value) has a test, and every branch of `findPackageVersion` (found, not found, invalid `package.json`, other `name`, depth limit). Exception: a throwing constructor needs module mocking and is covered by review only.
*   **E2E/Integration**: the new `cli.test.ts` case against the local server; a manual run of the built CLI (`node dist/bin.js check <url> --json`) against a local server with an empty header, output shown.
*   **Review**: red-team agent on the code change (network input, a new parser on untrusted data).
