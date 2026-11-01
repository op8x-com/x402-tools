# op8x CLI: `amount` that changes between two challenges

Status: approved 2026-10-31 (design review rounds 1 and 2, plan review applied). Extends `./2026-10-31-cli-payto-rotation-design.md` and resolves its non-goal "No check of `amount`"; adds a later addition and a test server route to `../specs/2026-10-24-cli-check-design.md`; amends a known limit in `../specs/2026-10-25-cli-cors-payment-flow-design.md`. Builds after `./2026-10-31-cli-challenge-hints-design.md`, which changes the same files.

## Problem

An x402 route can compute its price per request, for example from a per-request quote, a random or counter-based price, or a short price window. A client signs the amount in the challenge it read. If the server computes a different amount for the paid request, the payment fails:

1. **v2 on `@x402/core` 2.x.** The route's `price` can be a function of the request context (`DynamicPrice`). `buildPaymentRequirementsFromOptions` calls it for every request, the paid retry included. `findMatchingRequirements` accepts the payment only if the signed `accepted` entry matches one of the entries the server has just built and enriched: every field except `extra` exactly, `amount` included (`paymentRequirementsMatchAccepted`; strings, so `"1000"` and `"01000"` differ), and `extra` as a subset. Otherwise the client gets another 402 with `No matching payment requirements`.
2. **v1.** A stock `@x402/core` 2.x server issues only v2 challenges. With older or custom v1 servers, the exact facilitators of `@x402/evm` and `@x402/svm` require the signed amount to equal the `maxAmountRequired` the server passes to verify (`invalid_exact_evm_authorization_value`, `invalid_exact_svm_payload_amount_mismatch`).

A price that changes is legitimate only if the server accepts the amount the client signed for the paid request. The buyer gets another 402 on the paid retry; the seller sees no sale and no error. `op8x check` already holds the challenge of the plain request and of the browser-like repeat (`originChallenge`, added for `payto-rotates`), but compares only `payTo`.

Prices by time of day or load rarely differ between two requests sent close together, so the check mostly misses them; it catches prices that change per request and the occasional window boundary. op8x has no field observation of changing prices, so the check is speculative. It is accepted because it sends no request and shares the pairing code with `payto-rotates`; its own code is one rule file and its tests.

## Background facts

Verified against `@x402/core` 2.29.0, `@x402/evm` 2.29.0 and `@x402/svm` 2.29.0 on 2026-10-31.

- `DynamicPrice = (context: HTTPRequestContext) => Price | Promise<Price>`; the context carries `paymentHeader` as for `DynamicPayTo`.
- `Price = Money | AssetAmount`. A price function that returns a string or number is read as a decimal money amount (US dollars by default; a ticker suffix or a registered money parser can change that) and converted with the asset's decimals. Only an object `{ amount, asset, extra }` (`AssetAmount`) is taken as atomic units.
- The server builds each entry's `extra` from the price's `extra` merged with the route option's `extra`. Whatever a price function returns in `extra` therefore becomes part of the requirements.
- The price function also runs for unpaid requests, before the server checks for a payment header. `context.paymentHeader` is the raw header; `@x402/core/http` exports `decodePaymentSignatureHeader`, which throws on a header that does not decode.
- v2 `amount`, v1 `maxAmountRequired`: a string of digits in atomic units. The `@x402/core` schema only requires a non-empty string.
- In the `upto` scheme (`@x402/evm` and `@x402/svm` 2.29.0) `amount` is the maximum the client authorizes; the server may settle less (through the `Settlement-Overrides` response header of `@x402/core`). Matching still compares `amount` exactly, so a changing maximum fails the same way.
- No open tool compares `amount` between two challenges of one run (checked by op8x on 2026-10-31 in their published source: two listing and lint tools check price formats or compare a manifest with the live 402; a debugging proxy compares a captured signed value with the requirements of the same payment).
- The Python and Go SDKs are not covered; the texts name only `@x402/core`.

## Goals

- Tell a seller when two unpaid requests for the same method and URL, sent close together, carry different amounts for the same kind of payment option.
- Explain the consequence, and that a varying price is fine only if the paid request accepts the signed amount; give a safe fix.
- Send no additional request, add no new runtime dependency, and leave the exit code unchanged.

## Non-goals

- No check over time (hours or days). A price that changes rarely is out of scope.
- No comparison of other fields that matching also compares (`maxTimeoutSeconds`, `extra`). Possible follow-up if seen in the field.
- No judgement whether a price is too high, too low or below a facilitator minimum.
- No finding when a group only gains, loses or repeats amounts between the two challenges.
- No format check of amounts; an amount that is not an atomic integer is skipped (see Risks).

## Change

One new finding. It is a warning, so the exit code stays the same; the warning count in the summary and in the `--json` report changes.

| id | Level | Condition |
| --- | --- | --- |
| `amount-changes` | warn | For one method, the plain request and the browser-like repeat both returned 402 with readable challenges of the same version, and in at least one group of payment options each side has an amount the other lacks. |

GET and POST each produce their own finding, as for `payto-rotates`. One option whose `payTo` and `amount` both change gives both findings; each has its own fix.

### How the finding is decided

1. **Pairs.** Same as `payto-rotates`: `status === 402`, `originStatus === 402`, same `x402Version`, non-empty `accepts[]` on both sides.
2. **Options and groups.** An option is an `accepts[]` entry with string `scheme`, `network` and `asset` and an atomic amount: v2 `amount` or v1 `maxAmountRequired`, a string of 1 to 78 digits, read by a new helper `atomicAmount`, shared with the spend rules (see "Shared helper"). Other entries are skipped without a finding; the `schema` rule reports only a missing or empty amount. Options are grouped by `scheme`, `network` and `asset` as in `payto-rotates`; a group present on one side only is skipped.
3. **Comparing amounts.** Per group, the set of amounts of the plain challenge against the set of the repeat. v2 values are compared as exact strings, as stock matching does. v1 values are compared as integers (leading zeros ignored), as the v1 facilitators do. A group changes if each side has at least one amount the other lacks.
4. **Result.** `findAmountChange` returns every changing group. If there is at least one, `amountRule` reports one `amount-changes` finding for the method. For each changing group it names the first option index in the plain challenge, the amounts only in the plain challenge, and the amounts only in the repeat. It lists at most three groups.

### Shared helper

The pairing and grouping of `src/payto.ts` move into `src/pairs.ts`, so both rules share one hardened copy:

- `changedGroups(e: Extracted, valueOf: (entry: Record<string, unknown>, version: 1 | 2) => string | undefined): ChangedPair | undefined`
- `ChangedPair = { method, x402Version, groups: ChangedGroup[] }`, `ChangedGroup = { index, scheme, network, asset, plainOnly, repeatOnly }`; groups are ordered by first option index in the plain challenge; `plainOnly` and `repeatOnly` hold values in first-seen order, deduplicated.
- An entry is skipped when it is not an object, when `scheme`, `network` or `asset` is not a string, or when `valueOf` returns `undefined`. The helper reads the compared value only through `valueOf`.
- Groups live in a `Map` keyed by `JSON.stringify([scheme, network, asset])`, so no server value becomes an object key.
- `findRotation` keeps its signature and behaviour and calls `changedGroups` with `payTo` as the value. `Rotation` and `RotatingGroup` are used only inside `payto.ts` and are replaced by `ChangedPair` and `ChangedGroup`.
- `atomicAmount(entry, version)` in `src/assets.ts` only reads and validates: it returns `amount` (v2) or `maxAmountRequired` (v1) as sent if it matches `ATOMIC`, else `undefined`. `entries()` in `src/spend.ts` reads its amount through it (no behaviour change). The amount `valueOf` in `src/amount.ts` calls it and normalises v1 values with `BigInt(x).toString()`.

### Texts

- **title:** `Price changes between two requests`
- **detail template:** `Two unpaid <METHOD> requests sent a moment apart, the second with an Origin header as a browser sends it, asked different amounts: <GROUPS>. A client signs the amount in the challenge it read. <SERVER> A price that follows time or load works only if the paid request accepts the amount the client signed.`
  - `<GROUPS>`: up to three items `accepts[<i>] (<where>) <plain amounts>, then <repeat amounts>`, joined with `; `, followed by `; and <n> more` when more groups change. `<where>` comes from `assetWhere`, as in `payto-rotates`. Several amounts on one side are joined with ` and `; at most three per side, then ` and <k> more`.
  - Each amount prints as the compared atomic string (in v2 as the server sent it, in v1 without leading zeros), followed by ` (<human> <symbol>)` when the asset is known (`findKnownAsset(asset, caip2(network, version))`, decimals from the asset table). The atomic string is always printed, so `1000` and `01000` never look the same. Digits only, at most 78 per value, so no escaping is needed.
  - `<SERVER>` for v2: `A server built on @x402/core 2.x runs your price function again for the paid request and accepts the payment only if the result equals the signed amount; otherwise the paid retry gets another 402.`
  - `<SERVER>` for v1: `The facilitator rejects a payment whose signed amount differs from the maxAmountRequired your server checks it against.`
  - Worked example (v2): `Two unpaid GET requests sent a moment apart, the second with an Origin header as a browser sends it, asked different amounts: accepts[0] (USDC on "eip155:8453") 1000 (0.001 USDC), then 1200 (0.0012 USDC). A client signs …`
- **fix**, chosen by version like `<SERVER>`:
  - v2: `Keep one price per resource for as long as a payment takes, for example from a price table. If the price must vary, keep a record of each quote: return an AssetAmount from your price function ({ amount, asset, extra } with a quote id in extra; a plain number is read as money, by default US dollars), and store amount, asset and extra under that id together with the request inputs it was quoted for. Unpaid requests create quotes, so let them expire after the payment timeout and cap how many you keep. For the paid retry, decode context.paymentHeader with decodePaymentSignatureHeader from @x402/core/http, treat a header that does not decode as no quote, and return the stored AssetAmount only if the quote id in its accepted entry is recent, unused and was quoted for the same inputs. Never copy the amount or extra from the payment header. For prices by usage, the upto scheme with a fixed maximum, settling the actual amount, fits better. If your paid retry accepts quoted amounts this way, this warning stays and can be ignored.`
  - v1: `Keep one price per resource for as long as a payment takes. If the price must vary, keep a record of each quote and pass verify the maxAmountRequired you quoted to this buyer for this request, not a newly computed price. If your server does this, this warning stays and can be ignored.`

## Alternatives considered

- **Extend `payto-rotates` to a generic `requirements-change` finding.** One finding for every field matching compares. It mixes two fixes in one text and makes the payTo texts longer. Rejected; the shared helper keeps the code in one place.
- **Compare amounts as numbers everywhere.** Friendlier for `1000` and `01000`, but stock v2 matching compares strings, so such a server fails. Rejected for v2.
- **Compare v1 amounts as strings too.** Simpler, but it reports v1 servers whose facilitator accepts the payment. Rejected; the normalisation is one line in the amount `valueOf`.
- **Share the list formatting with `payto-rotates`.** The payTo output prints each group with look-alike handling; a shared formatter would need hooks for it and would touch the hardened payTo output. Rejected; the caps are three constants.
- **One extra plain request per method.** It would remove the `Origin` header from the comparison and with it the false positive for prices per origin. Rejected for the same reason as in the payTo design (one more request on every run); reconsider for both rules together if field data shows prices or addresses chosen by `Origin`.
- **Fix: return the signed amount from the payment header after checks.** Shorter, but the buyer then chooses `extra` keys the seller did not set, and checks on age alone let a cheap quote pay for other inputs. Rejected for a quote record on the server.
- **Level info.** On a stock server the paid retry fails, which means a lost sale. Rejected.
- **Level error.** Two samples cannot prove that the server rejects the signed amount, and a server may accept it. Rejected.

## Changed units

| File | Change |
| --- | --- |
| `packages/cli/src/pairs.ts` (new) | `changedGroups`, `ChangedPair`, `ChangedGroup` as in "Shared helper" |
| `packages/cli/src/payto.ts` | pairing and grouping replaced by `changedGroups`; `findRotation` and `paytoRule` unchanged in behaviour; `Rotation`, `RotatingGroup` replaced by the shared types |
| `packages/cli/src/amount.ts` (new) | `findAmountChange(e)` (decision, every group) and `amountRule(e)` (texts, formatting, caps) |
| `packages/cli/src/assets.ts` | `ATOMIC` and `human(atomic, decimals)` moved here from `spend.ts`; new `atomicAmount(entry, version)` |
| `packages/cli/src/spend.ts` | imports `atomicAmount` and `human`; `entries()` reads the amount through `atomicAmount` (no behaviour change) |
| `packages/cli/src/rules.ts` | `methodRules` calls `amountRule(e)` inside the same `if (e.status === 402)` block, in its own `try`/`catch` after the `paytoRule` block |
| `packages/cli/test/amount.test.ts` (new) | unit tests listed below |
| `packages/cli/test/assets.test.ts` | `atomicAmount` for v2, v1 with leading zeros (returned as sent), and invalid values |
| `packages/cli/test/rules.test.ts` | integration cases below |
| `packages/cli/test/server.ts` | route `/amount-changes` with its own counter |
| `packages/cli/test/cli.test.ts` | one end-to-end case against that route |
| `packages/cli/README.md` | the new finding in the list of checks |
| `docs/specs/2026-10-24-cli-check-design.md` | pointer to this design; `/amount-changes` in the list of test server routes |
| `docs/specs/2026-10-25-cli-cors-payment-flow-design.md` | the first item under "Known limits" also names the amounts of the repeat's challenge |
| `docs/designs/2026-10-31-cli-payto-rotation-design.md` | the non-goal on `amount` points here; nothing else changes |

## Testing

**Unit tests (`amount.test.ts`):** decision cases (1, 6-10, 12, 14) assert on `findAmountChange`, text cases (2, 3, 5, 11) on `amountRule`; cases 4, 13 and 15 assert on both.

1. v2, same amount in both challenges: no finding.
2. v2, different amount on `accepts[0]` (known USDC): one `warn` finding with method, index, `<where>`, both atomic amounts with human values, the v2 server sentence and the v2 fix.
3. v2, `1000` against `01000`: finding; both printed as sent.
4. v1, `1000` against `01000`: no finding. v1 with a known asset on a legacy network name, `1000` against `02000`: finding with the v1 server sentence and the v1 fix, printed `2000` with its human value.
5. Unknown asset: atomic amounts only, no human value.
6. Reordered `accepts[]` with the same amounts: no finding.
7. A group that only gains, loses or repeats an amount: no finding.
8. Two groups, only the second changes: the finding names that group only.
9. Repeat missing, not 402, without a readable challenge, or with another version: no finding.
10. Amount missing, not a string, decimal (`"0.001"`), negative or longer than 78 digits: entry skipped, no crash.
11. More than three changing groups: three listed, then `; and <n> more`. Five amounts only on each side: three per side, each followed by ` and 2 more`.
12. `"__proto__"`, `"constructor"`, `"toString"` as `scheme`, `network`, `asset`: grouped correctly, no crash. Triples that would collide if joined with `|` stay covered by `payto.test.ts` through the shared helper.
13. `payTo` and `amount` change on the same option: `paytoRule` and `amountRule` each return their finding.
14. A group present on one side only (different asset in the repeat): skipped, no finding.
15. A large `accepts[]` (1,000 changing groups): `findAmountChange` returns all of them, in plain-challenge order; `amountRule` lists three.

**Refactor guard:** all existing tests stay unchanged and green, in particular `payto.test.ts`, `spend.test.ts`, `assets.test.ts` and the `payto-rotates` end-to-end case.

**Integration tests (`rules.test.ts`):**

- `runRules` returns the finding for a changing pair.
- A changing pair on GET and on POST gives two findings, not one with method `both`.
- `payto-rotates` and spend findings of the same response survive when `amountRule` throws: a throwing getter on `amount` of a repeat entry whose `payTo` also changes. Only the amount `valueOf` reads it; the spend rules read only the plain challenge.
- `amount-changes` survives when `paytoRule` throws: a throwing getter on `payTo` of a repeat entry whose `amount` also changes.

**End-to-end test (`cli.test.ts`):**

- Route `/amount-changes` in `test/server.ts` has its own request counter `n` and returns the mainnet v2 fixture (`v2main`) with `resource.url` set to the requested URL, `amount` = `String(10000 + n)` and `cache-control: no-store`. The `--json` report of `op8x check` on it has two findings with id `amount-changes` (GET and POST), no other warning from this route's challenge, and the exit code is 0.

## Risks and limits

- **False positive: a server that accepts the signed amount.** A server that keeps quote records accepts the paid retry, but its prices still differ between challenges, so it is reported on every run.
  - Accepted risk: the detail names the condition under which it is fine, and the fix says the warning can then be ignored.
- **False positive: a fixed price per `Origin`.** A server that prices by origin (for example per partner) shows each client the same price on challenge and retry, so it works, but it is reported.
  - Accepted risk: the detail names the `Origin` header as the only difference; see the extra plain request under "Alternatives considered".
- **False positive: a price window that ends between the two requests.** The two requests of a method are up to about two request timeouts apart (`--timeout`, default 10 s; the other method's request runs in between unless `--method` is set), so a per-minute price crosses a boundary now and then.
  - Accepted risk: the same crossing breaks a real paid retry; the fix's quote record covers it.
- **False negatives.** A price that changes on a timer may be equal in both samples; a refused repeat gives no pair; a changed spelling of `asset` or `network` forms different groups; an amount that is not an atomic integer (`"0.001"`, `"-5"`) is skipped and reported by no rule.
  - Accepted risk: the finding is a hint from two samples; a format check of amounts is out of scope.
- **Seller follows the fix unsafely: copied amount or extra.** Returning the signed amount lets a buyer pay any price; returning the signed `extra` lets the buyer choose requirement fields the seller did not set (for example the token's signing domain or scheme-specific settings).
  - Mitigation: the fix rebuilds the price from the seller's own quote record and says never to copy amount or `extra` from the payment header.
- **Seller follows the fix unsafely: a quote reused for other inputs or later.** A cheap quote for a small request could pay for a large one, or an off-peak quote could be used at peak time.
  - Mitigation: the fix accepts a quote only if it is recent, unused and was quoted for the same inputs.
- **Seller follows the fix: the quote store fills up.** Unpaid requests create quotes, so a store without expiry or limit can be filled cheaply.
  - Mitigation: the fix says to expire quotes after the payment timeout and to cap how many are kept.
- **Seller follows the fix: a malformed payment header.** The price function runs outside the server's own error handling, so decoding an attacker's header by hand can throw.
  - Mitigation: the fix names the SDK's decoder and says to treat a header that does not decode as no quote.
- **Quote fishing.** With random prices a buyer can fetch many unpaid challenges and sign the lowest.
  - Accepted risk: every such price is one the seller chose to offer; a seller who does not want this should not randomise prices.
- **Seller returns a plain number.** It is read as money (by default US dollars), so the paid retry still fails.
  - Mitigation: the fix says to return an AssetAmount and why.
- **Rule throws on a hostile challenge.** Server input could trigger an unexpected exception in the new code.
  - Mitigation: own `try` in `methodRules`, tested in both directions; `Map` for groups; values printed only after the digit test.
- **Refactor changes `payto-rotates` or the spend rules.** Moving the pairing and the amount reader could change existing output.
  - Mitigation: refactor guard above; the existing tests stay unchanged and must pass.
- **`@x402/core` matching changes.** A later core version could match `amount` differently and make the v2 sentence wrong.
  - Mitigation: texts name `@x402/core` 2.x; facts are checked again on the next core upgrade.
