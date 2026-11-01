# op8x CLI: `payTo` that changes on every challenge

Status: approved 2026-10-31 (design review rounds 1 and 2, plan review applied). Extends `../specs/2026-10-24-cli-check-design.md` and amends the first item under "Known limits" in `../specs/2026-10-25-cli-cors-payment-flow-design.md` (the challenge of the browser-like repeat is not read).

## Problem

Some x402 endpoints return a different `payTo` address each time a client asks for the challenge. A client signs its payment to the address in the challenge it read. That can cause two separate failures:

1. **On the seller's own server.** A v2 server built on `@x402/core` 2.x resolves `payTo` again when the paid request arrives. It accepts the payment only if the signed `accepted` entry equals one of the entries it has just built, `payTo` included. If the `payTo` function returns a new address for the paid request, the server answers `No matching payment requirements` with another 402. The server avoids this only if its `payTo` function returns, for the paid request, the address it issued to this buyer.
2. **On the buyer's side.** An open-source spend-control sidecar for agents (October 2026; self-reported, not verified by op8x) holds the first payment to an unknown pair of host and recipient above a threshold until a human approves it, and can pin `payTo` per host. A recipient that changes on every call looks like a new recipient every time, so such a tool may hold or refuse every payment. The spend controls of `@x402/core` itself have no recipient rule (only `allowedAssets` and `maxAmountPerPayment`).

The seller sees none of this; the buyer just never pays. A public series of test purchases in October 2026 (48 attempts; self-reported, not verified by op8x) found 2 endpoints that returned a new `payTo` on every request; the buyer's client could not pay either of them. For every method that answers 402 (or the permit2 412), `op8x check` already sends a second request (the browser-like repeat), but it does not compare the two challenges.

## Background facts

Verified against `@x402/core` 2.29.0, `@x402/evm` 2.29.0 and `@x402/hono` 2.29.0 on 2026-10-31.

- **Dynamic `payTo`.** A route's `payTo` can be a string or a function of the request context (`DynamicPayTo`). `buildPaymentRequirementsFromOptions` calls the function for every request, the paid retry included.
- **Payment header in the context.** The context passed to the function has `paymentHeader`, the raw base64 value that the framework middleware takes from `PAYMENT-SIGNATURE` (or `X-PAYMENT`). Decoded, it contains the `accepted` entry the client signed, `payTo` included.
- **v2 matching.** `findMatchingRequirements` compares the payload's `accepted` entry with each entry the server has just built and enriched. `paymentRequirementsMatchAccepted` deep-compares every field except `extra` (`deepEqual` on JSON strings, so letter case counts) and compares `extra` as a subset, without the scheme's `dynamicExtraFields`.
- **v1.** A stock `@x402/core` 2.x server issues only v2 challenges (`createPaymentRequiredResponse` sets `x402Version: 2`) and reads only `PAYMENT-SIGNATURE`. v1 challenges come from older or custom servers. The exact EVM facilitators reject a signed recipient that differs from `payTo` (`invalid_exact_evm_recipient_mismatch`, on the Permit2 path `invalid_permit2_recipient_mismatch`).
- **Extensions.** Resource-server extensions may fill a `payTo` that the route left blank (empty after trimming), and may not change one that is set. An extension that fills a new address on every request therefore rotates `payTo` in the same way.
- **Requests the CLI already sends.** For each method whose plain request returns 402 (or the permit2 412), the CLI repeats the request once with an `Origin` header. The plain request and the repeat differ only in that header.

The Python and Go SDKs are not covered; the texts name only `@x402/core`.

## Goals

- Tell a seller when two unpaid requests for the same method and URL, sent a moment apart, carry different `payTo` addresses for the same kind of payment option.
- Explain both consequences (own server, buyer-side spend tools) and a safe fix.
- Send no additional request, add no new runtime dependency, and leave the exit code unchanged.

## Non-goals

- No check over time (hours or days). A `payTo` that changes rarely, for example after a wallet migration, is out of scope.
- No comparison between GET and POST. A seller may route the two methods to different handlers on purpose.
- No check of `amount`; see `./2026-10-31-cli-amount-change-design.md`.
- No finding when a group of options only gains, loses or repeats addresses between the two challenges.
- No on-chain lookup and no judgement about whether the addresses belong to the same seller.

## Change

One new finding. It is a warning, so the exit code stays the same; the warning count in the summary and in the `--json` report changes.

| id | Level | Condition |
| --- | --- | --- |
| `payto-rotates` | warn | For one method, the plain request and the browser-like repeat both returned 402 with readable challenges of the same version, and in at least one group of payment options each side has a `payTo` address the other lacks. |

GET and POST each produce their own finding, because the detail names the method and its addresses; `merge` does not combine them. A server that rotates on both methods therefore adds two warnings.

### How the finding is decided

1. **Pairs.** For each method, the rule uses the plain response and the browser-like repeat of the same method. Both must be a literal 402 (`status === 402` and `originStatus === 402`), as for the spend rules, because clients pay only on 402. Both challenges must be objects with the same `x402Version` (1 or 2) and a non-empty `accepts[]`. Otherwise there is no pair and no finding. The CLI sends no extra request to get one.
2. **Groups.** An option is an `accepts[]` entry with string `scheme`, `network`, `asset` and `payTo`; other entries are skipped. Options are grouped by `scheme`, `network` and `asset`, in a `Map` keyed by `JSON.stringify([scheme, network, asset])`, so no server value becomes an object key and no two triples share a key. Only groups present in both challenges are compared; a group present on one side only is skipped.
3. **Comparing addresses.** For each group, the set of `payTo` values of the plain challenge is compared with the set of the repeat. Values are compared as exact strings on every network, as stock v2 matching does, so a change only in letter case counts. A group rotates if each side has at least one address the other side lacks. A server that reorders `accepts[]`, or a group that only gains, loses or repeats addresses, gives no finding.
4. **Result.** If at least one group rotates, the rule reports one `payto-rotates` finding for the method. For each rotating group it names the first option index in the plain challenge, the addresses only in the plain challenge, and the addresses only in the repeat. It lists up to three groups.

### Data

`withBrowserView` in `src/extract.ts` also takes the challenge of the repeat. Two new optional fields on `Extracted` hold `extract(browser).challenge` and `extract(browser).version`: `originChallenge?: unknown` and `originVersion?: 1 | 2`. They are decoded the same way as the plain probe (header first, then body) and set whenever the repeat returned a challenge; the rule checks `originStatus` itself. Nothing else in `Extracted` changes. `extract(browser)` also runs the official-client read on the repeat; its result is not stored (one extra in-memory parse, no extra request).

The JSON report gains no new field; the finding carries the information.

### Texts

- **title:** `payTo changes between two requests`
- **detail template:** `Two unpaid <METHOD> requests sent a moment apart, the second with an Origin header as a browser sends it, got different payTo addresses: <GROUPS>. A client signs its payment to the address in the challenge it read. <SERVER> Buyer-side spend tools that approve or pin recipients per host see a new recipient on every call and may hold or refuse the payment.`
  - `<GROUPS>`: up to three items `accepts[<i>] (<where>) <plain addresses>, then <repeat addresses>`, joined with `; `, followed by `; and <n> more` when more groups rotate. Several addresses on one side are joined with ` and `; each side lists at most three addresses, followed by ` and <k> more` when it has more, so a hostile challenge cannot inflate the report.
  - `<SERVER>` for v2: `A server built on @x402/core 2.x builds payTo again for the paid request and accepts the payment only if your payTo function returns, for that request, an address it issued to this buyer.`
  - `<SERVER>` for v1: `The facilitator rejects a payment signed to a different payTo than the one your server checks it against.`
  - Worked example (v2): `Two unpaid GET requests sent a moment apart, the second with an Origin header as a browser sends it, got different payTo addresses: accepts[0] (USDC on "eip155:8453") "0x1234…abcd", then "0x9876…ef01". A client signs …`
- **fix:** `Return one stable payTo for the resource on every request. If you must issue one address per payment, decode the payment header for the paid retry (context.paymentHeader, the base64 PAYMENT-SIGNATURE) and return its accepted.payTo only if it is an address you issued and have not used yet; never return it unchecked. Tell buyers which addresses are yours.`

**Formatting.** (Since `./2026-11-01-cli-server-text-design.md` every printed `payTo` value, short or in full, stands in double quotes, except the bare marker `(empty)`, and `"`, `'` and runs of spaces are escaped too.) `<where>` comes from a new helper `assetWhere(asset, network, version)` in `src/assets.ts`: the label from `findKnownAsset(asset, caip2(network, version))`, otherwise `cleanText(asset, 48)`; then ` on ` and the network as the server sent it, `cleanText(network, 48)`. `payTo` values are passed through `cleanText(value, 100)`; a value that is empty after cleaning prints as `(empty)`. In `payTo` values, every printed character outside printable ASCII (U+0020 to U+007E), and the backslash itself, is written as `\u{XXXX}` (hexadecimal code point), so look-alike letters and filler characters stay visible and no escape can be forged; valid addresses are ASCII without backslashes and are not affected. A cleaned value longer than 12 characters is shortened to its first 6 characters, `…`, and its last 4 (escapes are applied to the kept characters, never split). If any two printed values in a group look the same, the whole group is printed in full: each value escaped and cut at 100 printed characters on a character boundary, followed by `…` when cut. If two printed values still look the same, the group ends with `(these look the same here but differ)`, whatever the reason (cut, removed characters, or a value that reads like a marker).

## Alternatives considered

- **One extra plain request per method.** This would remove the `Origin` header from the comparison and also cover servers that refuse the repeat. It costs one more request on every run. The repeat already follows every 402; a pair is missing only when the repeat does not return 402, and that case is already reported as `cors-origin-refused`. Rejected for now; reconsider if real endpoints often refuse the repeat or pick `payTo` by `Origin`.
- **Compare GET with POST.** No extra request, but it would flag sellers who route methods to different wallets on purpose. Rejected.
- **Generic diff of both challenges with `diffPaths`.** Fields that may change per request make it noisy, it cannot group options or ignore reordering, and `amount` needs its own wording. Rejected.
- **Compare by index.** Simpler, but it reports a rotation when a server only reorders `accepts[]`. Rejected for the set comparison per group.
- **Multisets instead of sets.** They would also report groups that only change in size, which is not a `payTo` change and leaves one side of the text empty. Rejected.
- **Ignore letter case on EVM.** Checksum casing is the same address on chain, but stock v2 matching compares strings, so a case change breaks the paid retry. Rejected.
- **Level error.** A server can rotate and still accept payments if its `payTo` function returns the issued address, and two samples cannot prove that the address changes every time. Rejected.
- **Level info.** On a stock server the paid retry fails, and buyer-side tools with recipient rules may hold or refuse each payment; both mean lost sales. Rejected; the finding is a warning.

## Changed units

| File | Change |
| --- | --- |
| `packages/cli/src/types.ts` | `Extracted.originChallenge?: unknown`, `Extracted.originVersion?: 1 \| 2` |
| `packages/cli/src/extract.ts` | `withBrowserView` sets both fields from `extract(browser)` |
| `packages/cli/src/assets.ts` | new `assetWhere(asset, network, version)` |
| `packages/cli/src/spend.ts` | `Entry` gets `version: 1 \| 2`, set in `entries()`; `where` calls `assetWhere` (no behaviour change) |
| `packages/cli/src/payto.ts` (new) | `findRotation(e: Extracted): Rotation \| undefined` (pairing, grouping, comparison; returns every rotating group) and `paytoRule(e: Extracted): Finding \| undefined` (texts and formatting on top of it, caps applied here) |
| `packages/cli/src/rules.ts` | `methodRules` calls `paytoRule(e)` in its own `try`/`catch` next to the spend block, inside `if (e.status === 402)`; a returned finding is pushed as is |
| `packages/cli/test/payto.test.ts` (new) | unit tests listed below |
| `packages/cli/test/assets.test.ts` | `assetWhere` for a known asset, an unknown asset and a v1 network name |
| `packages/cli/test/spend.test.ts` | one case that pins the offered text on a v1 network |
| `packages/cli/test/extract.test.ts` | `withBrowserView` with and without a challenge in the repeat |
| `packages/cli/test/rules.test.ts` | integration cases listed below |
| `packages/cli/test/server.ts` | route `/payto-rotates` with a request counter |
| `packages/cli/test/cli.test.ts` | one end-to-end case against that route |
| `packages/cli/README.md` | the new finding in the list of checks |
| `docs/specs/2026-10-24-cli-check-design.md` | pointer to this design in the list of later additions; `/payto-rotates` in the list of test server routes |
| `docs/specs/2026-10-25-cli-cors-payment-flow-design.md` | the first item under "Known limits" now points here; `originChallenge` and `originVersion` in the field list of `withBrowserView` |
| `docs/solutions/2026-10-31-printed-server-values-look-alike.md` (new) | learning note on printing server values side by side |

## Testing

**Unit tests (`payto.test.ts`):** the decision cases (1-12, 18, 19) assert on `findRotation`, the text cases on `paytoRule`; case 18 checks that `findRotation` returns every group and that `paytoRule` lists at most three.

1. v2, same `payTo` in both challenges: no finding.
2. v2, different `payTo` on `accepts[0]`: one `warn` finding with method, index, `<where>`, both shortened addresses and the v2 server sentence.
3. Addresses that differ only in letter case (EVM checksum): finding.
4. Reordered `accepts[]` with the same addresses: no finding.
5. Two options with the same `scheme`, `network` and `asset` and fixed, different addresses, order swapped in the repeat: no finding.
6. A group that only gains or loses an address ([A, B] against [A]) or repeats one ([A, A] against [A]): no finding.
7. Two groups, only the second rotates: the finding names that group only.
8. Repeat missing, not 402 (including 412), or without a readable challenge: no finding.
9. Plain challenge v2, repeat v1: no finding.
10. A group present on one side only (different asset in the repeat): skipped, no finding.
11. Non-string or missing `payTo`: entry skipped, no crash.
12. v1 challenge with a different `payTo`: finding with the v1 server sentence.
13. Server-controlled text with control characters or a very long `payTo`: text cleaned and capped.
14. Values of 12 characters or fewer: printed unshortened.
15. Two addresses equal in their first 6 and last 4 characters: the group printed in full.
16. Values that still look the same after printing in full (differing only in characters `cleanText` removes, only after the cut, or one being the literal text `(empty)` against a value empty after cleaning): the group ends with `(these look the same here but differ)`. A value empty after cleaning: printed as `(empty)`. Two values that differ by a Cyrillic letter or U+3164: printed with `\u{…}` escapes, so they look different. A value containing the literal text `\u{3164}` against one containing U+3164: they print differently, because the backslash is escaped.
17. More than three rotating groups: three listed, then `and <n> more`. A group with five addresses only on each side: three listed per side, each followed by ` and 2 more`.
18. A large `accepts[]` (1,000 entries): returns and lists at most three groups.
19. `"__proto__"`, `"constructor"` and `"toString"` as `scheme`, `network` and `asset`, and two triples that would collide if joined with `|`: grouped correctly, no crash.

**Integration tests (`extract.test.ts`, `rules.test.ts`):**

- `withBrowserView` sets `originChallenge` and `originVersion` when the repeat has a challenge and leaves them unset otherwise.
- `runRules` returns the finding for a rotating pair.
- A rotating pair on GET and on POST gives two findings, not one with method `both`.
- Spend findings of the same response survive when `paytoRule` throws (a throwing getter on `originChallenge.accepts`, which only `paytoRule` reads). The reverse direction needs a test seam in `rules.ts` and is checked in code review instead: both `try` blocks have the same shape.

**End-to-end test (`cli.test.ts`):**

- `test/server.ts` gets a route `/payto-rotates` that counts requests and returns the v2 fixture as header with a new, schema-valid `payTo` each time, with `cache-control: no-store` as `/v2-good` does. The `--json` report of `op8x check` on it has two findings with id `payto-rotates` (GET and POST), and the exit code is 0.
- Existing tests stay unchanged and green.

## Risks and limits

- **False positive: a server that settles anyway.** A server whose `payTo` function returns the issued address for the paid request is reported although its own payments work.
  - Accepted risk: buyer-side recipient controls still see a new recipient on every call, and the detail names the condition under which the server itself is fine.
- **False positive: a fixed `payTo` per `Origin`.** A server that picks one address per origin (for example per partner) shows every client the same address on challenge and retry, so it works, but it is reported.
  - Accepted risk: such servers are rare, and the detail names the `Origin` header so the seller can tell. The extra plain request in "Alternatives considered" would remove this case.
- **False negatives.** A server that rotates on a timer or every few requests may return the same address twice. A server that refuses the `Origin` repeat, or a rate limit that answers it with 429, gives no pair. A server that also changes the spelling of `asset` or `network` between the two responses (for example letter case of the token address) forms different groups, so the rotation is not reported.
  - Accepted risk: the finding is a hint from two samples, not proof of stable addresses; a refused repeat is already reported by the CORS rules.
- **Seller follows the fix unsafely.** Returning the signed address from the payment header without a check lets an attacker sign a payment to an address of their own and get the resource for free.
  - Mitigation: the fix text puts one stable address first, says to accept only addresses the seller issued and has not used, and says never to return the address unchecked.
- **Look-alike asset or network names.** Resolved by `./2026-11-01-cli-server-text-design.md`: `<where>` prints an unknown asset and the network in double quotes, escaped and cut to 48 characters, the same as in the spend findings.
- **Rule throws on a hostile challenge.** Server input could trigger an unexpected exception in the new code.
  - Mitigation: `paytoRule` runs in its own `try`; on an exception it reports nothing, and the spend findings and the rest of the report are unaffected (tested for a throwing `paytoRule`). Groups live in a `Map`, so hostile names such as `__proto__` stay plain data. It only reads strings, never evaluates them, and prints them through `cleanText` with a length limit.
- **`@x402/core` matching changes.** A later core version could match `payTo` differently and make the v2 sentence wrong.
  - Mitigation: the texts name `@x402/core` 2.x, the background facts carry the verified version, and the facts are checked again on the next core upgrade of the CLI.
