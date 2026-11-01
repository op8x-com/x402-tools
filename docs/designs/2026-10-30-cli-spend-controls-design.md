# op8x CLI: spend controls, offers that default clients refuse to pay

Status: draft, 2026-10-30; updated 2026-10-31 (review rounds 1 and 2 applied). Extends `../specs/2026-10-24-cli-check-design.md`.

## Problem

Since `@x402/core` 2.23.0, every `x402Client` applies spend controls before it picks an accept. A client built without `spendControls` gets these defaults:

- **Default assets only.** Only assets that the registered scheme's `findDefaultAsset` recognises are allowed. In `@x402/evm` and `@x402/svm` these are USD stablecoins on a fixed list of networks. EURC is not allowed on any network, and USDC is not allowed on a network outside the list.
- **A price cap.** A payment in a default asset may not exceed `DEFAULT_MAX_AMOUNT_PER_PAYMENT` (`"$1"`).
- **Nothing left means no payment.** If no entry survives, the client throws and pays nothing.

The buyer can lift these limits, but the seller sees none of it: a default client simply never pays. `op8x check` says nothing about price level or asset today.

A second, smaller problem concerns sellers who offer both USDC and EURC. When both entries carry the same number, EURC buyers pay a different price for the same resource, because EURC tracks the euro and USDC the US dollar.

## Background facts

Verified against `@x402/core` 2.22.0, 2.23.0 and 2.29.0, and against `@x402/evm`, `@x402/svm` and `@x402/fetch` 2.29.0. Release data were checked with `npm view` on 2026-10-30.

- **Version.** 2.22.0 has no spend controls. 2.23.0 (published 2026-08-18) has the `"$1"` default. `@x402/fetch` and `@x402/axios` 2.23.0 depend on `@x402/core ~2.23.0`.
- **Selection order** in `selectPaymentRequirements`:
  1. Drop entries whose network and scheme have no registered client.
  2. Drop entries with an unknown `extra.paymentFlow`.
  3. Apply spend controls: first the default-asset allowlist, then the caps.
  4. Apply the buyer's policies.
  5. Prefer `authorization` over `upfront` and `escrow`.
  6. Call the selector; the default selector takes the first entry.
- **Selector hook.** `selectPaymentRequirements` is private. The public `createPaymentPayload` runs it and calls the selector passed to `new x402Client(selector)` only when entries survive.
- **Default registration.** The stock helpers register:
  - `registerExactEvmScheme`: `exact` on `eip155:*` for v2, and on every legacy name of `EVM_NETWORK_CHAIN_ID_MAP` for v1.
  - `registerExactSvmScheme`: `exact` on `solana:*` for v2, and on `solana`, `solana-devnet` and `solana-testnet` for v1.
- **Cap check.** The cap is converted to the asset's decimals and checked as `amount <= cap`, so exactly 1 USD passes.
- **Default asset lists.** They contain USDC, USDC.e, USDT, USDT0, USDG, PYUSD, CASH, SBC, mUSD, MegaUSD and USAT, and no EURC. EVM matches addresses case-insensitively and returns no default asset for a chain without a row. `@x402/svm` matches mints exactly and throws for a `solana:*` network other than mainnet, devnet and testnet.
- **Opt-outs.** The buyer can use any of these:
  - `spendControls: false`;
  - `maxAmountPerPayment` set higher or to `false`;
  - `allowedAssets: true`;
  - `allowedAssets` entries. An entry needs the network and the token address, because a symbol matches only default assets. It takes an optional `maxAmountPerPayment` in atomic units.
- **Refusal message.** It starts with `All payment requirements were rejected by spendControls`, and `@x402/fetch` adds the prefix `Failed to create payment payload:`.

The Python and Go SDKs are not covered; the texts name only the TypeScript clients.

## Goals

- Tell a seller when default TypeScript x402 clients refuse every entry of the challenge on their spend controls, and why (asset or price).
- Tell a seller who offers USDC and EURC at the same number that the two prices differ.
- Stay an outside check: no new request, no new runtime dependency, no exit-code change.

## Non-goals

- No check of the buyer's balances, networks beyond the default registration, or custom policies.
- No exchange rate: `eurc-same-amount` compares numbers only and does not suggest a converted amount.
- No new request, option, exit code or JSON field.

## Change

Three new findings. None is an error, so the exit code does not change; the warning count in the summary and in the `--json` report does. The terms they use (*default client*, *eligible*, *default asset*) are defined in "How the findings are decided" below.

| id | Level | Condition |
| --- | --- | --- |
| `default-asset` | warn | The challenge is eligible. A default client pays it with spend controls off, but refuses it even with the price cap removed. |
| `default-cap` | warn | The challenge is eligible. A default client pays it with the price cap removed, but refuses it with the default spend controls. |
| `eurc-same-amount` | info | A USDC entry and an EURC entry ask for the same human amount. |

`method` is per probe for all three; identical GET and POST findings merge into `both`, as usual.

### How the findings are decided

The rules live in a new `src/spend.ts`. `methodRules` calls them once, after the per-entry loop, for the challenge the client would act on. The call sits in a `try`: if a rule throws on a hostile challenge anyway, the three hints are skipped and the rest of the report stands. Table lookups use only own keys, so network names such as `__proto__` or `constructor` match nothing.

**Preconditions.** All three rules run only when:

- the status is 402 (`@x402/fetch` pays only on 402, so a 412 is not in scope),
- the challenge is an object,
- `x402Version` is the number 1 or 2, and
- `accepts` is a non-empty array.

**Eligible challenge.** `default-asset` and `default-cap` additionally require that every entry:

- is an object, and
- has string values for `scheme`, `network` and `asset`, and
- has a price field (`amount` in v2, `maxAmountRequired` in v1) of 1 to 78 digits. Core throws on other amounts (`"$0.01"`, `"1e4"`, a missing field), which would read as a cap refusal; 78 digits hold any uint256, and
- if its network is `solana:*`, uses one of the three Solana networks `@x402/svm` knows. On any other Solana network the real client throws inside `findDefaultAsset`.

If an entry fails any of these, both rules stay silent.

**Default client.** The CLI builds an `x402Client` from `@x402/core`, the existing runtime dependency. It registers stub `exact` scheme clients exactly as the stock helpers do, using the network patterns listed under Background facts. Each stub's `findDefaultAsset(asset, network)` looks the asset up in the vendored `DEFAULT_ASSETS`. In v1, the network is first mapped through `V1_NETWORKS`. The stub never signs anything.

**Three runs.** The client's selector notes that it was reached and throws to stop the payment. `createPaymentPayload` is async, but it runs the whole selection before its first `await`, so the note is set synchronously and `runRules` stays synchronous; the returned promise is rejected and ignored. The CLI calls `createPaymentPayload(challenge)` up to three times, once per setting:

| Run | `spendControls` | Selector not reached |
| --- | --- | --- |
| 1 | `false` | Stop, no finding. The entries fail on network, scheme or flow, which other rules report. |
| 2 | `{ maxAmountPerPayment: false }` | `default-asset` |
| 3 | `{}` (default) | `default-cap` |

The CLI reads no error text. Only "selector reached" (entries survived) or "not reached" (refused) matters. Flow filtering, the cap arithmetic and the price field per version (`amount`, `maxAmountRequired`) are handled by core itself.

**Default asset.** A *default asset* is a `(network, asset)` pair in `DEFAULT_ASSETS`. Lookup follows the SDKs: EVM addresses case-insensitively, Solana mints exactly.

**`eurc-same-amount`.** This rule needs no client. It looks for:

- a USDC entry: a row with symbol `USDC` in `DEFAULT_ASSETS` (not `USDC.e`), and
- an EURC entry: a row in `EURC_ASSETS`,
- both with a price field of 1 to 78 digits and the same value after division by `10^decimals`.

The two entries may be on different networks. A v1 legacy name is mapped through `V1_NETWORKS` first. There is one finding per challenge, naming the pair completed first when `accepts[]` is read in order; one pass with a map keeps large challenges linear.

### Data

A new module `src/assets.ts`. The header names the source versions.

- `DEFAULT_ASSETS`: CAIP-2 network to rows of `{ asset, symbol, decimals }`, copied from the `DEFAULT_ASSETS` export of `@x402/evm` and `@x402/svm` 2.29.0.
- `EURC_ASSETS`: EURC rows (6 decimals) on Base, Base Sepolia, Ethereum, Sepolia, Avalanche, Avalanche Fuji, Solana and Solana Devnet. Source: [Circle EURC contract addresses](https://developers.circle.com/stablecoins/eurc-contract-addresses) (read 2026-10-30). These are not default assets.
- `V1_NETWORKS`: v1 name to CAIP-2. It is built from `EVM_NETWORK_CHAIN_ID_MAP` of `@x402/evm/v1` (numeric chain ids, written as `eip155:<id>`) and `V1_TO_V2_NETWORK_MAP` of `@x402/svm`.

The existing `LEGACY_TO_CAIP2` in `rules.ts` stays the hint map for `v2-legacy-network`. Deriving those hints from `V1_NETWORKS` is a separate follow-up, so hint quality does not change here. (Done on 2026-10-31: `v2-legacy-network` now takes its hint from `V1_NETWORKS` via `legacyToCaip2`.)

### Texts

Amounts are shown in human units. Asset and network strings from the challenge are shown as labels. A label is the symbol from `DEFAULT_ASSETS` or `EURC_ASSETS` if there is one. Otherwise it is the raw string, cleaned and cut with the existing `UNSAFE` filter and code-point cut from `extract.ts` (`cleanReason`). Superseded by `./2026-11-01-cli-server-text-design.md`: an unknown asset and the network now print in double quotes, escaped and cut to 48 characters (`printFull`). `<cap>` is `DEFAULT_MAX_AMOUNT_PER_PAYMENT` as a number of USD, read from its string or number form.

- `default-asset`
  - title: `Default x402 clients refuse every asset you offer`
  - detail: `No accepts[] entry pays in an asset that default clients recognise (USD stablecoins such as USDC, on the networks their SDK lists). Clients built on @x402/core 2.23.0 or later (for example @x402/fetch, @x402/axios) without spendControls drop other assets and pay nothing. Offered: <label> on <network>, ... (default asset list of @x402/evm and @x402/svm 2.29)`
  - fix: `Add a USDC entry on a listed network. Buyers who want another asset must opt in.`
  - When an EURC entry is offered, the fix adds: `EURC: add it to spendControls.allowedAssets (network and EURC token address) with its own maxAmountPerPayment in atomic units, for example "1000000" for 1 EURC.`
- `default-cap`
  - title: `Price above the default client cap of <cap> USD`
  - detail: `Every accepts[] entry in a default asset asks for more than <cap> USD (offered: <amount> <label> on <network>, ...). Clients built on @x402/core 2.23.0 or later (for example @x402/fetch, @x402/axios) without spendControls refuse payments above <cap> USD and pay nothing.`
  - fix: `Either lower the price (default clients accept an entry in a default asset at or below <cap> USD, so they will pay that entry rather than a higher one), or tell buyers to raise spendControls.maxAmountPerPayment.`
- `eurc-same-amount`
  - title: `Same amount in USDC and EURC`
  - detail: `accepts[i] asks <x> USDC and accepts[j] asks <x> EURC. EURC tracks the euro and USDC the US dollar, so the same number means a different price.`
  - fix: `If the price is meant in euros, say so in the resource description. Otherwise convert one of the two amounts at challenge time and round to base units. Clients that opted into EURC pay the first entry they may pay among entries with the same payment flow, so list EURC first if EURC buyers should pay in EURC.`

## Alternatives considered

- **Re-implement the selection by hand.** The rules would copy the client's flow filter, the cap arithmetic, the price field per version and the default registration. Rejected: the copy already missed step 1 (registered network and scheme), and every copied step can drift from core without any test noticing. Asking the client through the public `createPaymentPayload` keeps only the asset table as a copy.
- **Read the client's error messages.** Map `All payment requirements were rejected by spendControls...` to finding ids. Rejected: the wording is not an API, and a change breaks the mapping silently. The sentinel selector needs no text.
- **Depend on `@x402/evm` and `@x402/svm` at runtime.** This would avoid the copied table. Rejected: they pull in viem and @solana/kit, and the CLI has `@x402/core` as its only runtime dependency. They are devDependencies for the drift test only.
- **One combined finding, or `info` for `default-asset`.** A seller who offers only EURC may target opted-in buyers on purpose. Rejected: default clients pay nothing, which is the silent loss this CLI reports, and the fix text names the opt-in. Two ids keep the cause (asset or price) machine-readable.
- **A hint "list USDC before EURC".** Clients take the first remaining entry, so order looked like the real default. Not built, because the client code contradicts it:
  - A default client drops EURC before the selector runs, so it pays USDC whatever the order, as long as USDC is within the cap.
  - A client that opted into EURC keeps both entries and takes the first remaining one. With USDC first it pays USDC, so EURC buyers would no longer pay in EURC.
  - The client also prefers `authorization` over `upfront` and `escrow` before the selector runs.

  Order only decides which asset opted-in clients pay. The `eurc-same-amount` fix states this.

## Changed units

| File | Change |
| --- | --- |
| `packages/cli/src/assets.ts` | New: `DEFAULT_ASSETS`, `EURC_ASSETS`, `V1_NETWORKS`, lookup helpers. |
| `packages/cli/src/spend.ts` | New: stub default client, the three runs, the three rules. |
| `packages/cli/src/rules.ts` | `methodRules` calls the spend rules once. |
| `packages/cli/src/extract.ts` | `cleanText` split out of `cleanReason`, shared with the labels. |
| `packages/cli/test/assets.test.ts` | New: lookups and drift test. |
| `packages/cli/test/spend.test.ts` | New: tests for the three rules. |
| `packages/cli/package.json` | devDependencies `@x402/evm`, `@x402/svm` `~2.29.0` (raised together with the `@x402/core` pin) and `@solana/kit` (peer of `@x402/svm`). |
| `packages/cli/README.md` | The three findings in the list of checks, the EURC opt-in sentence and a copyable command. |
| `docs/specs/2026-10-24-cli-check-design.md` | Pointer to this design in the list of later additions. |

## Testing

- `default-asset`:
  - fires for EURC-only on Base, and for USDC on a chain without a row (`eip155:10`);
  - does not fire for USDC on Base Sepolia.
- `default-cap`:
  - `amount` `1000000` USDC does not fire; `1000001` fires;
  - an 18-decimal asset (mUSD) at `10^18` does not fire; `10^18 + 1` fires;
  - a mixed offer with one entry within the cap does not fire;
  - v1 `maxAmountRequired` on network `base` fires above the cap.
- Silence:
  - v1 entry on `eip155:8453` (not registered in v1);
  - v2 entry on `base`;
  - only `upto` entries;
  - an unknown `solana:*` network;
  - a non-string `asset`;
  - an entry with an unknown flow, which run 1 refuses.
- Silence for prices that are not atomic: `"$0.01"`, `"1e4"`, `"abc"` next to a valid entry, a missing field, v1 with `amount` instead of `maxAmountRequired`, 79 digits.
- Hostile input: `__proto__`, `constructor` and `toString` as network names in v1 and v2 produce no finding and no crash; 9000 entries finish in well under two seconds.
- `eurc-same-amount`:
  - fires for `10000` USDC on Base and `10000` EURC on Base;
  - does not fire for different amounts or for `USDC.e`;
  - gives one finding for two pairs.
- Address case: an EVM address in lower case still matches; a Solana mint with changed case does not.
- Labels: a challenge asset with control or bidi characters is cleaned.
- Merge: identical GET and POST findings merge into `both`.
- Drift:
  - `DEFAULT_ASSETS` equals the exports of `@x402/evm` and `@x402/svm`;
  - `V1_NETWORKS` equals their v1 maps;
  - no `EURC_ASSETS` row appears in `DEFAULT_ASSETS`.
- Existing fixtures (USDC on Base Sepolia, `10000`) report none of the new findings. The end-to-end tests now run against the test server with `v2main`/`v1main` (the same challenges on Base mainnet), see `2026-10-31-cli-challenge-hints-design.md`.

## Risks and limits

- **Stale or skewed asset list.** The default list depends on the buyer's `@x402/evm` and `@x402/svm` version. A newer list makes the CLI's copy give false `default-asset` warnings. An older one hides refusals by buyers who are behind.
  - Mitigation: the drift test runs whenever the devDependencies move together with the `@x402/core` pin, and the detail names the list version.
- **Silent cases (the client refuses, the CLI says nothing).**
  - an unknown `solana:*` network, a non-string field or a price that is not 1 to 78 digits (the real client throws or the CLI cannot tell cap from parse error);
  - an unknown `solana:*` entry that core would drop before spend controls (wrong scheme or flow), next to entries it refuses;
  - other namespaces;
  - buyers who registered other schemes or networks than the stock helpers;
  - v1 entries with an unknown flow, which the client drops and which `payment-flow` (v2 only) does not report. (Closed on 2026-10-31: `payment-flow` now reports them.)

  Mitigation: all of these are listed here, and staying silent is preferred over guessing. The v1 flow gap is a follow-up for `payment-flow`.
- **Buyers with their own spend controls.** For such buyers a warning is wrong.
  - Mitigation: the texts say "default clients" and name the opt-out.
- **Other clients.** Clients older than `@x402/core` 2.23.0, the legacy `x402-fetch`/`x402-axios` packages and other SDKs may behave differently.
  - Mitigation: the details name the TypeScript versions.
- **Coupling to core behaviour.** The three runs rely on three things: `createPaymentPayload` calls the selector only for surviving entries, it does so before its first `await`, and `spendControls` accepts these settings.
  - Mitigation: the tests run against the pinned core, and a core bump that changes any point fails them. If selection ever moves behind an `await`, run 1 never reaches the selector and the rules fall silent instead of warning wrongly.
- **Server-controlled text in the report.** Strings from the challenge could carry terminal control or bidi characters.
  - Mitigation: labels go through the existing `UNSAFE` filter and code-point cut.
- **EURC addresses.** They are copied by hand from Circle, with no automatic check.
  - Accepted risk: a wrong address only hides `eurc-same-amount` or shows a raw address instead of "EURC". The source URL and date are in `assets.ts`, and the disjointness test keeps EURC out of the default list.
