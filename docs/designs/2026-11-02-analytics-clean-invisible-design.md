# op8x analytics: invisible characters in cleaned strings

*   **Author:** op8x
*   **Status:** Approved, 2026-11-02
*   **Date:** 2026-11-02

Extends `packages/analytics/docs/ingest-contract.md` (record format, string cleaning) and follows `./2026-10-28-cli-official-client-design.md` (the CLI's `cleanReason`, which removes the Unicode categories Cc, Cf, Cs, Zl and Zp).

--------------------------------------------------------------------------------

## Overview

`@op8x/analytics` cleans every string it takes from network input (challenge fields, receipt fields, method, route) with `clean()` in `packages/analytics/src/decode.ts`. `clean()` removes characters matched by the regex `CONTROL`, trims, caps the length, and turns an empty result into `undefined`.

`CONTROL` lists C0/C1 controls and the bidi controls U+200E, U+200F, U+202A-U+202E and U+2066-U+2069. It misses U+061C (ARABIC LETTER MARK), which is also a bidi control, and it keeps other invisible format characters such as U+200B (ZERO WIDTH SPACE) and U+2060 (WORD JOINER).

## The Problem

A value made only of a missed character survives `clean()` as a non-empty string. Reproduced with `buildRecord` at the head of `feat/analytics-has-transaction`:

*   A receipt `{"success":false,"transaction":"\u061c"}` gives `receipt.hasTransaction: true`, and with `chainCheck` also a `transaction` made of one invisible character. The same holds for `"\u200b"` and `"\u2060"`.
*   The same applies to every field `clean()` cleans: `scheme`, `network`, `amount`, `asset`, `error`, `errorReason`, `method`, `route`. A value can also carry the characters in the middle (`"base\u200b"`), so two records that look equal on screen differ in the data.

Only the seller's own server produces these values, so the impact is wrong statistics, not a breach. The comment on `CONTROL` promises "Unicode bidi controls", which U+061C contradicts.

U+00A0, U+FEFF, U+2028 and U+2029 at the start or end are already removed by `trim()`, but not in the middle.

## Goals

*   No string that `clean()` returns contains U+061C.
*   A value made only of removed characters becomes `undefined`, so `hasTransaction` is `false` for it.
*   The ingest contract states exactly which characters are removed.

## Non-Goals

*   Normalizing look-alike letters (for example Cyrillic `а` in a network name) or Unicode normalization (NFC).
*   Changing the length caps, the record format version, or which fields are cleaned.
*   Changing the CLI.

## Open Questions and Decisions

*   No open questions.
*   Decided on 2026-11-02: option C. `clean()` removes the Unicode categories Cc, Cf, Cs, Zl and Zp, the same set as the CLI (`packages/cli/src/extract.ts`): `/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu`. Options considered and not chosen:
    *   **A. Add only U+061C.** Smallest change, but U+200B, U+2060 and other invisible format characters stay.
    *   **B. Add U+061C, U+200B and U+2060.** Closes the three cases the review found, but the list stays hand-written and other format characters (U+00AD, U+200C, U+200D, U+2061-U+2064, U+FEFF in the middle, tag characters U+E0000-U+E007F) stay.
*   Consequence of C: lone surrogates and U+2028/U+2029 in the middle are removed too, and so is U+200D (ZERO WIDTH JOINER), which splits joined emoji into their parts; no cleaned field is expected to carry emoji.

*   Decided on 2026-11-02, after review: the length cap must not split a surrogate pair. `clean()` caps at `max` UTF-16 code units as before; when the cut leaves a high surrogate at the end, that unit is dropped and the result is trimmed again. Without this, a value whose character at the cap is an emoji or another character outside the Basic Multilingual Plane ended in a lone surrogate, which contradicts removing Cs.

## Design

`CONTROL` in `packages/analytics/src/decode.ts` becomes `/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu`; its comment and the doc comment of `clean()` name the removed characters. `clean()` keeps its order: remove, trim, cap, trim, empty becomes `undefined`.

`packages/analytics/docs/ingest-contract.md` (line on string cleaning) names the removed characters.

The vendored copy in `apps/demo-api/vendor` is repacked in the same change.

## Testing

New cases in `packages/analytics/test/decode.test.ts`, written before the fix:

*   `clean("\u061c")` is `undefined`; `clean("a\u061cb")` is `"ab"`.
*   The same for U+200B and U+2060.
*   U+00AD, U+200D, U+FEFF, U+2028 and a lone surrogate in the middle are removed; letters, digits, `:`, `-`, `.` and non-Latin letters (`"é"`, `"ж"`) stay.
*   A receipt `{"success":false,"transaction":"\u061c"}` gives `hasTransaction: false` (test next to the existing `hasTransaction` tests).

*   A value with a surrogate pair across the cap (127 `x` plus an emoji, with `max` 128 and 256) loses the whole pair; a pair inside the cap stays; a space before the cut pair is trimmed.

## Risks & Mitigations

*   **A seller value loses a character it needs.** Removed characters are invisible and do not belong in scheme, network, amount, asset or route values. Mitigation: tests that ordinary and non-Latin letters stay.
*   **Regex support.** The regex needs the `u` flag and Unicode property escapes (ES2018). Cloudflare Workers, Node 18+ and current browsers support them; the CLI already uses the same regex.
