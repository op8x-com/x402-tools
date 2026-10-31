# op8x CLI: challenge hints

*   **Author:** op8x
*   **Status:** Implemented, 2026-10-31
*   **Date:** 2026-10-31

Extends `../specs/2026-10-24-cli-check-design.md`, `../specs/2026-10-25-cli-cors-payment-flow-design.md` and `./2026-10-30-cli-spend-controls-design.md`. Shares files with `./2026-10-31-cli-payto-rotation-design.md`.

--------------------------------------------------------------------------------

## Overview

`op8x check <url>` sends unpaid requests to an x402 endpoint and explains why agents might not pay it. This design adds five small rules that read the responses the CLI already receives, plus one optional flag. Each rule covers a mistake that sellers have reported in public support channels and that a seller cannot see from their own logs. The CLI also gets a short list of things it does not check, so a seller knows where its answer ends.

## The Problem

A seller can set up x402 so that the endpoint answers 402 with a valid challenge and still gets no payments, or never shows up in the CDP Bazaar. The causes below are visible in the unpaid response, but `op8x check` does not report them today:

1. **Testnet only.** Every entry in `accepts[]` is on a test network (for example `eip155:84532`, Base Sepolia). Agents that pay on mainnet find no option they can use. The endpoint still works with test wallets, so the seller often does not notice.
2. **Price needs a valid body.** The CLI sends its POST probe with `Content-Type: application/json` and the body `{}`. Some POST endpoints answer that with 400, 409 or 422 instead of 402. Buyers that ask for the price with no body or an empty one then never learn the price: an agent wallet was reported to send no body (report 1 below), and CDP's Bazaar sends an empty body when the route declares no example `input`. With `@x402/hono`, a price function that reads the body of a request without one gets `undefined` and does not fail with 400, so the 4xx comes from the seller's own validation running before the payment middleware.
3. **Resource URL differs from the URL called.** In v2 the server fills `resource.url` from the route setting or, if unset, from the request URL it sees (`adapter.getUrl()`; with Hono, `c.req.url`). Behind a proxy that ends TLS, that URL starts with `http://` although the public URL is `https://`. A different host or path also appears when the route setting is stale. `@x402/core` does not compare this URL when a payment arrives, so payments still work. The Bazaar listing uses this URL, and CDP asks sellers to deploy at a public HTTPS URL.
4. **Extensions in the wrong place.** In v2, `extensions` (for example `extensions.bazaar`) belongs at the top level of the challenge, next to `accepts`. `@x402/core` writes it there. A server that builds the challenge by hand and puts `extensions` only inside an `accepts[]` entry declares nothing the Bazaar can read. The v2 schema in `@x402/core` strips the extra key instead of rejecting it, so the existing `schema` rule does not report it.
5. **Paying yourself.** A seller who tests the endpoint with the wallet that receives the money pays from `payTo` to `payTo`. One seller reported that the CDP facilitator rejects this (report 2). The open-source facilitator in `@x402/evm` 2.29 has no such check, and CDP does not document it. The CLI cannot know the payer unless the seller tells it.

Reports from sellers (CDP developer Discord, x402 channel; self-reported, not verified by op8x):

1. 2026-03-04: an agent wallet's pay command does not send the request body when it fetches the payment requirements; a route whose price depends on the body answers 400.
2. 2026-05-12: a payment from the `payTo` address to itself was rejected by the CDP facilitator.
3. 2026-03-04 and 2026-05-07: a minimum price per request was named once as 1 cent and once as 0.001 USD; below it the facilitator answered `invalid_payload`.

## Goals

*   `op8x check` reports each of causes 1 to 4 when it is present in the responses the CLI already receives, with no extra request.
*   With a new option `--payer <address>`, `op8x check` reports when that address equals a `payTo` in the challenge (cause 5).
*   Each finding says what is wrong, why it stops payments or listing, and one concrete fix, in the same format as the existing findings.
*   The CLI output and the README name what `op8x check` does not check (for example delivery after payment, and whether the Bazaar has indexed the endpoint), and where the answer is.
*   Wording claims only what the sources show: the rule for cause 3 does not say that CDP rejects `http://`; the rule for cause 1 does not say the endpoint will not be listed (CDP indexes testnet resources too); the rule for cause 2 names a likely cause, not a certain one; the rule for cause 5 says "some facilitators reject".

## Non-Goals

*   No payment, no wallet, no signing. `--payer` is compared as text and is never used to sign.
*   No change to the requests the CLI sends; the POST probe keeps its `{}` body. The CLI does not get a `--data` option in this design.
*   No network calls beyond the requests the CLI sends today (no Bazaar lookup, no facilitator call).
*   No minimum-price rule (report 3 disagrees with itself, and CDP does not document a minimum). This waits for an own test payment.
*   No URL rule for v1 challenges, whose `accepts[].resource` is a string per entry.
*   No changes to the payTo-rotation rule or to how the CLI repeats requests.
*   Python and Go SDK behaviour is not covered.

## Open Questions and Decisions

No open questions. Decided on 2026-10-31:

*   `post-needs-body` is `info` and is worded around the `{}` body the CLI sends.
*   `testnet-only` is `warn`; `resource-url-mismatch` is `info` (see Alternative F).
*   The URL comparison includes the path.
*   `--payer` takes one address.
*   The "not checked" list names tools under fixed rules.
*   Test networks come from v1 names only.

## Critical User Journeys (CUJs)

### CUJ 1: Seller forgot to switch to mainnet

*   **Given**: An endpoint answers 402; every `accepts[]` entry uses `eip155:84532`.
*   **When**: The seller runs `npx @op8x/cli check https://api.example.com/data`.
*   **Then**: The report shows a warning `testnet-only` that names the networks, says mainnet buyers cannot pay, and suggests adding a mainnet entry (for example `eip155:8453`, or `base` in v1) next to the test entry. As in every run, the report ends with the block "Not checked by op8x check".

### CUJ 2: POST endpoint validates before the paywall

*   **Given**: GET answers 405; POST with the body `{}` answers 422 with a plain JSON error.
*   **When**: The seller runs `op8x check`.
*   **Then**: Besides the existing `no-402` error, the report shows `post-needs-body`: the endpoint rejects an empty JSON body before asking for payment, so buyers that send no body or an empty one likely never see the price. Fix: run the payment middleware before body validation. If the route needs a body, also declare an example `input` so the Bazaar's probe passes.

### CUJ 3: HTTPS ends at the proxy

*   **Given**: The CLI calls `https://api.example.com/data`; the v2 challenge has `resource.url` `http://api.example.com/data`.
*   **When**: The seller runs `op8x check`.
*   **Then**: The report shows the hint `resource-url-mismatch` with both URLs. Fix: set the route's `resource` to the public URL, or let the server trust the forwarded scheme from the proxy.

### CUJ 4: Seller tests with the receiving wallet

*   **Given**: The challenge has a `payTo` address on `eip155:8453`.
*   **When**: The seller runs `op8x check <url> --payer <same address, other letter case>`.
*   **Then**: The report shows `self-payment`: payer and receiver are the same, and some facilitators reject this. Fix: test with a second wallet.

### CUJ 5: Hand-built challenge with extensions in an offer

*   **Given**: A v2 challenge with `extensions.bazaar` inside `accepts[0]` and no top-level `extensions`.
*   **When**: The seller runs `op8x check`.
*   **Then**: The report shows `extensions-placement`. Fix: move `extensions` to the top level of the challenge, next to `accepts`.

## Technical Plan (Architecture)

All new rules are pure functions over data the CLI already has. Nothing changes in how requests are sent.

```text
cli.ts: parse args (+ --payer) -> probe GET/POST -> extract -> runRules(results, preflight, url, core, { payer })
                                                                   |
                         existing rules  <-------------------------+
                         spendRules      <-------------------------+
                         hintRules (new, src/hints.ts) <-----------+  status 402, version 1 or 2, own try/catch
                           - testnet-only
                           - extensions-placement  (v2)
                           - resource-url-mismatch (v2, compared with called URL)
                           - self-payment          (only when --payer is set)
                         postNeedsBody (new, src/hints.ts) <-------+  POST result, not 402
                                                                   |
                         merge() joins GET+POST twins  -> report.ts (text/JSON, + notChecked)
```

`hintRules` checks its own gate and returns `[]` unless `e.status === 402`, `e.version` is 1 or 2, and `e.challenge` is an object, the same gate as `spendRules` (clients pay only on 402, so the 412 `permit2_allowance_required` answer that `is402` also accepts is left out). It runs inside its own `try`/`catch`, like `spendRules`: on an exception the hints are skipped, never the report. A readable challenge for these rules has `accepts` as a non-empty array; entries that are not objects, or whose `network` or `payTo` is not a string, are skipped.

### Where each rule gets its data

| Rule | Input | Fires when | Level |
|---|---|---|---|
| `testnet-only` | `accepts[].network` | At least one valid entry exists and every valid entry's network is a known test network. Networks are mapped with `caip2(network, e.version)`. A v2 challenge that uses a v1 name stays silent; `v2-legacy-network` already reports it. An unknown network is not a known test network, so the rule stays silent. | warn |
| `extensions-placement` | challenge with `e.version === 2` | Any `accepts[i]` has an own key `extensions` and the challenge has no top-level `extensions`. | warn |
| `resource-url-mismatch` | `challenge.resource.url` (v2), the URL the CLI called | `resource.url` is a non-empty string (otherwise silent; `schema` reports it), and it is not a parseable absolute URL (a relative URL counts as not parseable) or its scheme, host (with port) or path differs from the called URL. The query string and one trailing slash are ignored. If the called URL is not parseable (the `"<url>"` placeholder in unit tests), the rule stays silent. The detail says which part differs and names a scheme change separately ("http behind a proxy"); for a path difference it adds that a route that serves many paths on purpose can ignore the finding, and for any difference that a staging copy checked with production settings will show it. | info |
| `self-payment` | `--payer`, `accepts[].payTo`, `accepts[].network` | The payer equals a `payTo`, compared with `sameAddress(payer, payTo, caip2(network, e.version))`: case-insensitive on `eip155:*` networks (so v1 names such as `base` too), exact elsewhere. One finding at most, naming the first matching index. | warn |
| `post-needs-body` | `Extracted` for POST and GET | All of: POST `status` is 400, 409 or 422 with no challenge; the POST body is not a JSON-RPC 2.0 error object (MCP servers answer 400 without a session id); there is no `mcp-endpoint` finding; GET was not probed, failed at network level, or does not have the same status. The detail calls the body the likely cause. Level `info` because the same response already raises `verb-mismatch` or `no-402`; this finding explains it. | info |

Server-supplied strings in finding details (`resource.url`, network names) are printed with the helpers `payto.ts` uses today, moved to `src/extract.ts`: every character outside printable ASCII, and the backslash, as `\u{XXXX}`, at most 100 characters, a cut marked with `…` (see `docs/solutions/2026-10-31-printed-server-values-look-alike.md`). The called URL is printed as `new URL(url).href`. Because the detail also names which part differs, two URLs that print alike still get an exact answer.

### Finding texts

Placeholders in `{}`; `{x}` printed as described above.

| Rule | Title | Detail | Fix |
|---|---|---|---|
| `testnet-only` | `Only test networks offered` | `Every payment option is on a test network: {networks}. Buyers that pay on mainnet find no option they can use. Ignore this if the endpoint is meant for testing.` Networks deduplicated in order, at most 3, then `and {n} more`. | `Add a mainnet option next to the test one, for example eip155:8453 (v1: base) with USDC.` |
| `extensions-placement` | `extensions inside accepts[]` | `accepts[{i}] has an extensions field and the challenge has none at the top level. In x402 v2, extensions such as bazaar belong at the top level next to accepts; the @x402/core schema drops them inside an offer, so the Bazaar does not see them.` `{i}` is the first such index. | `Move extensions to the top level of the challenge, next to accepts. @x402/core puts them there when you declare extensions on the route.` |
| `resource-url-mismatch` | `resource.url differs from the URL checked` | `resource.url is {resourceUrl}; the URL checked is {calledHref}. Differs in: {parts}.` `{parts}` is a comma-separated list of `scheme`, `host`, `path` in that order. Then, as they apply: `The server likely sees http behind a proxy that ends TLS.` (scheme http vs https); `If this route serves many paths on purpose, you can ignore this.` (path); always `This is expected when you check a staging copy with production settings.` Not parseable: `resource.url is not an absolute URL: {resourceUrl}.` followed by the staging sentence. | `Set the route's resource to the public URL, or let the server trust the forwarded scheme and host from the proxy. The Bazaar lists the URL from resource.url.` |
| `self-payment` | `Payer is the payTo address` | `The address given with --payer is the payTo of accepts[{i}] ({network}). Payer and receiver are the same; some facilitators reject such a payment.` | `Test with a second wallet that is not the payTo.` |
| `post-needs-body` | `POST without a usable body gets no price` | `POST with the body {} returned {status} instead of 402. Likely cause: the endpoint checks the request body before asking for payment. Buyers that ask for the price with no body or an empty one (some agent wallets, and the Bazaar when no example input is declared) then never see the price.` | `Run the payment middleware before body validation. If the route needs a body, also declare an example input so the Bazaar's probe passes.` |

Sentence added to the `fix` of `no-402` and `verb-mismatch` when `post-needs-body` fires: `See post-needs-body: the POST answer looks like body validation before payment.`

`sameUrl(a, b)` returns the list of differing parts (`[]` when equal).

### Test networks

`@x402/evm` and `@x402/svm` 2.29 have no machine-readable flag that marks a network as a test network. The CLI already keeps `V1_NETWORKS` (copied from those packages, guarded by `test/assets.test.ts`). The set of test networks is derived from it: every CAIP-2 value whose v1 name contains `sepolia`, `testnet`, `devnet`, `fuji` or `amoy`. Today that gives `eip155:11155111`, `eip155:11124`, `eip155:84532`, `eip155:43113`, `eip155:1328`, `eip155:80002`, `eip155:324705682`, `eip155:10143`, `eip155:2201`, and Solana devnet and testnet. A test pins this list, so a new SDK network shows up as a test failure instead of being missed.

**Known gap (accepted):** `DEFAULT_ASSETS` in `@x402/evm` 2.29 also lists 15 v2-only networks without a v1 name, among them `eip155:421614` (Arbitrum Sepolia), `eip155:11142220` (Celo Sepolia) and `eip155:5042002` (Arc testnet). `eip155:4801` (World Sepolia), which the CDP facilitator supports, is in neither SDK table. The rule uses v1 names only and stays silent for these networks: no own list to maintain, and no false alarm. An own list checked against a chain registry is a future improvement.

### Interplay with existing findings

*   `post-needs-body` describes the same POST response as `no-402` (no method returns 402) or `verb-mismatch` (GET returns 402). Those findings stay; when `post-needs-body` fires, their `fix` text gets one sentence that points to it, so the seller reads one explanation, not two that disagree. `runRules` therefore evaluates `postNeedsBody` before it adds `no-402` and `verb-mismatch`.
*   The JSON-RPC test that `postNeedsBody` uses is the body check of today's `isMcpSignal` without its 406 condition, moved into a shared function that both use.
*   `extensions-placement` and `resource-url-mismatch` skip challenges whose `accepts` is not an array or whose `resource` is not an object; the existing `schema` rule already reports those for 402 responses, and the hint rules do not run on other responses.
*   `merge()` already joins a GET and a POST finding with the same id, title and detail into one with method `both`.

### "Not checked" list

`Report` gets a fixed field `notChecked: { topic: string; where?: string }[]`. In the text output, the block "Not checked by op8x check" replaces today's footer line ("Listing and Bazaar checks: …" or "MCP payment check: …"); `op8x · https://op8x.com` stays the last line. The JSON field is new, so existing readers of the JSON keep working.

Each entry may point to where the answer is, under fixed rules:

1. A primary source is named with a copyable command.
2. A tool is named only if it is free, open source with a license, and published as a package that installs by name (`x402-listing-check`, MIT, on npm, is already named in today's footer).
3. Anything else (paid services, tools that install only from a Git URL) is described by kind, without a name.

Entries:

| Topic | Where |
|---|---|
| Bazaar indexing and metadata (omitted when `mcp-endpoint` was found) | CDP's validation endpoint, no key: `curl -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate -H 'Content-Type: application/json' -d <payload>`, one command per method whose plain probe returned status 402; if none did, one per method that was probed. `<payload>` = `quote(JSON.stringify({ resource: url, method }))`. Then `npx x402-listing-check <url>`. Then: `Indexing also needs one settled payment through the CDP facilitator.` |
| Delivery after a real payment | By kind: `a tool that pays the endpoint once and checks the response.` |
| Facilitator limits such as minimum prices | By kind: `your facilitator's documentation.` |
| MCP payments (only when `mcp-endpoint` was found, listed first) | `npx x402-listing-check@latest <url> --mcp-tool YOUR_TOOL` |

URLs in commands are built with `quote()` from `src/report.ts`. `buildReport` takes no new parameter: it reads the methods from `probes` (entries without `origin` and with `status === 402`) and the MCP case from `findings`. In JSON, `where` holds the lines joined with `\n` and is omitted when empty. Rendered text, normal case:

```text
Not checked by op8x check:
  - Bazaar indexing and metadata:
      curl -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate -H 'Content-Type: application/json' -d '{"resource":"https://api.example.com/x","method":"GET"}'
      npx x402-listing-check 'https://api.example.com/x'
      Indexing also needs one settled payment through the CDP facilitator.
  - Delivery after a real payment: a tool that pays the endpoint once and checks the response.
  - Facilitator limits such as minimum prices: your facilitator's documentation.
op8x · https://op8x.com
```

MCP case: the first entry is `- MCP payments:` with `npx x402-listing-check@latest '<url>' --mcp-tool YOUR_TOOL`; the Bazaar entry is left out; the other two entries stay.

### `--payer`

One new string option that takes one address (more than one can be added later as a repeatable option without breaking this form). Input that is neither `0x` plus 40 hex digits nor 32 to 44 base58 characters exits with code 2 and a one-line error that does not repeat the value, like `--method` today. The value appears in the report only inside the `self-payment` detail, and only when it matched; it is the seller's own address.

## Risks and Mitigations

*   **Staging copies.** A staging, localhost or tunnel deployment whose `resource` is set to the production URL raises `resource-url-mismatch`. Mitigation: the rule is `info`, and the detail says this is expected when checking a staging copy.
*   **Endpoints that are meant for testnet.** `testnet-only` warns on every run, including op8x's own demo API. Mitigation: the detail says to ignore it if the endpoint is for testing; an opt-out flag is a future improvement (Alternative F).
*   **False alarms from `post-needs-body`.** A 400 on `{}` can also come from a missing API key, an unsupported content type or an unpaid POST handler. Mitigation: the rule is `info`, stays silent when GET has the same status or the body is a JSON-RPC error, and names the body as the likely cause only.
*   **Hostile challenges.** Rules read untrusted server input. Mitigation: they run only on 402 responses with a valid version, inside their own `try`/`catch`, and print server text only escaped and capped (`printFull`).
*   **Unrecognised test networks.** See "Known gap" above.
*   **Drift.** Facts were checked against `@x402/core`, `@x402/hono` and `@x402/evm` 2.29.0 and the CDP documentation on 2026-10-31. Mitigation: recheck the SDK facts on the next `@x402/core` upgrade (the pinned `TEST_NETWORKS` test fails when `V1_NETWORKS` changes) and the CDP endpoint in the "not checked" list before each CLI release.

## Alternatives Considered

### Alternative A: Own list of test networks

*   **Pros**: Also covers v2-only test networks such as Arbitrum Sepolia, Celo Sepolia, Arc testnet and World Sepolia.
*   **Cons**: A second list to maintain; every SDK update with a new network needs a manual decision; a wrong entry causes false warnings.
*   **Reason for Rejection**: The gap is small today and a silent rule is better than a wrong one. Kept as a future improvement.

### Alternative B: A `--data` option that sends a request body

*   **Pros**: The CLI could probe POST endpoints the way the Bazaar does when an example `input` is declared, and see the real 402.
*   **Cons**: Sending seller-chosen bodies changes the CLI from "unpaid look at the challenge" to "calls the API"; more input handling, more ways to trigger side effects on the seller's server.
*   **Reason for Rejection**: A body option would let the seller send a body that passes validation and so hide the case where buyers send none or an empty one. Can be added later if sellers ask for it.

### Alternative C: Look up the Bazaar during the check

*   **Pros**: Could say directly whether the endpoint is listed.
*   **Cons**: A network call to a third party on every run; the answer depends on CDP's indexer and lags up to 15 minutes behind a payment.
*   **Reason for Rejection**: Out of scope (no extra network calls). The "not checked" list points to CDP's validation endpoint instead.

### Alternative D: A separate command for listing problems

*   **Pros**: Keeps payment problems and listing problems apart.
*   **Cons**: Sellers would have to know which command to run; three of the five rules concern payment (`testnet-only`, `post-needs-body`, `self-payment`), two concern listing (`resource-url-mismatch`, `extensions-placement`), and all read the same responses.
*   **Reason for Rejection**: One `op8x check` that reports everything it can see is simpler for the seller.

### Alternative E: Minimum-price rule now

*   **Pros**: Would cover a failure that sellers reported with a generic `invalid_payload`.
*   **Cons**: The reports disagree (0.001 USD and 1 cent) and CDP does not document a minimum; a wrong threshold would warn sellers who are fine or miss those who are not.
*   **Reason for Rejection**: Waits for an own test payment on Base Sepolia.

### Alternative F: Other levels, or an opt-out flag

*   **Options compared**: (1) `testnet-only` and `resource-url-mismatch` both `warn`; (2) `testnet-only` `warn`, `resource-url-mismatch` `info`; (3) either level plus a flag such as `--ignore <id>`.
*   **Pros of (1)**: A wrong `http://` behind a proxy stands out as much as a testnet-only offer.
*   **Cons of (1)**: Staging checks and routes with a fixed `resource` raise a warning although nothing is broken for payments.
*   **Pros of (3)**: Sellers with intentional setups can silence a finding.
*   **Cons of (3)**: A new option for every rule that can be intentional; not asked for yet.
*   **Reason for choosing (2)**: Findings that stop payments are warnings, findings that only affect the listing are hints, as with `post-needs-body`. The flag is a future improvement.

## Future Improvements

*   **Test networks without v1 names**: an own list checked against a public chain registry (Alternative A).
*   **Minimum price**: a rule once an own test payment confirms the threshold.
*   **`--payer` with several addresses**: as a repeatable option.
*   **Opt-out flag**: `--ignore <id>` for intentional setups (Alternative F).

## Non-Functional Requirements

*   **Security & Privacy**: No new requests, no secrets. `--payer` is a public address, never a key. An EVM private key (64 hex digits) fails validation; any value that does not match a `payTo` is never printed, so a pasted Solana seed is not echoed either.
*   **Compatibility**: New finding ids and the new JSON field `notChecked` are additive. Exit codes do not change: all new findings are `warn` or `info`. The text footer changes (see "Not checked" list).
*   **Rollout**: Ships with the next CLI release; the CLI is not published on npm yet (checked 2026-10-31), so there are no existing users to migrate.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

All paths are relative to `packages/cli/` unless they start with `../../`. The payTo-rotation change this builds on is merged (#19). References to test asserts name their content; line numbers are given only as of commit `1fe53c7`. The parallel amount-change design (`./2026-10-31-cli-amount-change-design.md`) shares `src/assets.ts`, `src/rules.ts`, `test/server.ts`, `test/assets.test.ts`, `test/rules.test.ts`, `test/cli.test.ts`, `README.md` and the check spec; whichever lands second rebases on `main`, and its new server routes use `v2main` with the per-request `resource.url` (item 8).

### Target Files to Create/Modify

#### 1. `src/assets.ts` (Modify)

*   **Type / Scope**: TypeScript module (data).
*   **Proposed Changes**: Export `TEST_NETWORKS: ReadonlySet<string>`, built from `V1_NETWORKS`: the CAIP-2 value of every entry whose v1 name contains `sepolia`, `testnet`, `devnet`, `fuji` or `amoy`. Export `isTestNetwork(network: string, version: 1 | 2): boolean`, which maps the name with the existing `caip2(network, version)` first. Export `sameAddress(a: string, b: string, network: string): boolean` (case-insensitive when the CAIP-2 network starts with `eip155:`, exact otherwise) and use it inside `lookup`, so both rules share one comparison. No new data is copied from the SDK.

#### 2. `src/extract.ts`, `src/payto.ts` (Modify)

*   **Type / Scope**: TypeScript modules (helpers).
*   **Proposed Changes**: Export the existing `isObject` so `hints.ts` can use it without importing `rules.ts` (avoids a `rules.ts` ↔ `hints.ts` import cycle). Move `escapeChar` and `full` from `payto.ts` to `extract.ts` and export them (as `escapeChar` and `printFull`); `payto.ts` imports them instead of defining them. No behaviour change in `payto.ts`.

#### 3. `src/hints.ts` (Create)

*   **Type / Scope**: TypeScript module (rules).
*   **Proposed Changes**: `export function hintRules(e: Extracted, url: string, payer?: string): Finding[]` with `testnet-only`, `extensions-placement`, `resource-url-mismatch` and `self-payment`; `export function isJsonRpcError(body: unknown): boolean` (the body check moved out of `isMcpSignal`); `export function postNeedsBody(post: Extracted, get: Extracted | undefined): Finding | undefined`. `hintRules` checks the gate itself and returns `[]` outside it. Title, detail and fix texts exactly as in "Finding texts". Server text through `printFull`. Helper `sameUrl(a: URL, b: URL): ("scheme" | "host" | "path")[]` compares protocol, host (with port), and pathname without one trailing slash. Uses `isObject`, `printFull` and `escapeChar` from `extract.ts`, `sameAddress`, `caip2` and `isTestNetwork` from `assets.ts`, and `e.version`.

#### 4. `src/rules.ts` (Modify)

*   **Type / Scope**: TypeScript module (rule runner).
*   **Proposed Changes**: `runRules` gets a fifth optional parameter `opts: { payer?: string } = {}`. For each result it adds `hintRules(e, url, opts.payer)` inside its own `try`/`catch` (the gate is inside `hintRules`). Before adding `no-402` and `verb-mismatch`, it computes the MCP finding and calls `postNeedsBody(post, get)` unless there is one; when that returns a finding, it is added and the `fix` of `no-402` and `verb-mismatch` gets the sentence from "Finding texts". `isMcpSignal` uses `isJsonRpcError` from `hints.ts`.

#### 5. `src/report.ts` (Modify)

*   **Type / Scope**: TypeScript module (output).
*   **Proposed Changes**: `buildReport` keeps its signature (including the positional `now`) and builds `notChecked: { topic: string; where?: string }[]` from `probes` and `findings` as described in the "Not checked" list, with `quote()` for URLs and `quote(JSON.stringify({ resource: url, method }))` for the validation payload; `where` is omitted when empty. `renderText` prints the block exactly as in the rendered example instead of today's "Listing and Bazaar checks" or "MCP payment check" line; `op8x · https://op8x.com` stays last. `renderJson` includes the field.

#### 6. `src/cli.ts` (Modify)

*   **Type / Scope**: TypeScript module (arguments).
*   **Proposed Changes**: Option `payer: { type: "string" }`, a line in `USAGE` aligned with the existing descriptions (`--payer <address>      your own paying wallet; warns if it is a payTo`, descriptions start in column 24), validation (EVM `0x` plus 40 hex, or 32 to 44 base58 characters; otherwise exit 2 with `--payer must be a wallet address`, without the value), and passing `{ payer }` to `runRules`.

#### 7. `test/fixtures.ts`, `test/server.ts` (Modify)

*   **Type / Scope**: Test fixtures and local test server.
*   **Proposed Changes**: `v2` and `v1` in `fixtures.ts` stay as they are (Base Sepolia), so unit tests built on them (`payto.test.ts`, `spend.test.ts`, the parallel `amount.test.ts`) do not change. `fixtures.ts` adds `v2main` and `v1main`: the same challenges on `eip155:8453` / `base` with USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` from `DEFAULT_ASSETS`, so the spend rules stay silent. The test server uses `v2main`/`v1main` for every route, in the header and in the body (including `/v2-body-only`, `/drift` and `/payto-rotates`), and sets the v2 `resource.url` to `http://<Host header><path>` per request, so end-to-end tests stay free of `testnet-only` and `resource-url-mismatch`. This keeps the zero-warning asserts in `test/cli.test.ts` (at `1fe53c7`: lines 135, 178, 195, 202) valid. In the unit test `test/rules.test.ts` "empty header with v1 body" (line 524), `testnet-only` joins the exact list; that is the one expected change to an existing assert.

#### 8. `test/hints.test.ts` (Create)

*   **Type / Scope**: Unit tests (`node:test`).
*   **Proposed Changes**: For each rule one case that fires and the cases that must stay silent: mixed mainnet and testnet `accepts`; empty or invalid `accepts` entries; unknown network; v1 name `base-sepolia` in a v1 challenge (fires) and in a v2 challenge (silent); missing `x402Version` (silent); a 412 `permit2_allowance_required` response (silent); `extensions` only inside `accepts[0]` (fires), at top level (silent), in both places (silent); v1 challenge (silent for `extensions-placement` and `resource-url-mismatch`); `resource.url` with `http` versus called `https`; other host; other path; same path with trailing slash or query (silent); relative `resource.url` (fires); non-string `resource.url` (silent); placeholder called URL (silent); control characters and a 10,000-character `resource.url` (escaped and capped); a Cyrillic look-alike host (printed as `\u{…}`, parts name `host`); a difference only after character 100 (parts name `path`); 1,000 test-network entries (at most 3 named); a 200 response with a challenge-shaped body (silent); payer equal with other letter case on `eip155:8453` (fires) and on v1 `base` (fires), Solana address equal (fires), Solana address with other case (silent), different (silent), no payer (silent); POST 422 plain JSON with GET 405 (fires), with GET failed at network level (fires), GET 422 and POST 422 (silent), POST 400 with a challenge (silent).

#### 9. `test/assets.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: Pin the exact content of `TEST_NETWORKS` (11 entries today), so an SDK update that adds or renames a v1 network makes the test fail and forces a look. Test `sameAddress` for EVM and Solana.

#### 10. `test/rules.test.ts`, `test/report.test.ts`, `test/cli.test.ts` (Modify)

*   **Type / Scope**: Unit tests and end-to-end tests against the local test server.
*   **Proposed Changes**: `rules`: the extra sentence in `no-402` and `verb-mismatch` fixes appears only when `post-needs-body` fires; GET 405 plus POST 400 JSON-RPC stays `no-402` without `post-needs-body` (next to the existing case "POST 400 JSON-RPC error"); GET 406 JSON-RPC plus POST 422 gives `mcp-endpoint` and no `post-needs-body`; GET and POST twins merge into one finding with method `both`; other findings survive when `hintRules` throws; `testnet-only` added to the exact list in "empty header with v1 body". `report`: `notChecked` in JSON and text, matching the rendered example; the validation payload with `"` and `'` in the URL; the JSON round-trip still holds; the asserts on today's footer (the `npx x402-listing-check` match and the "Listing and Bazaar checks" line, at `1fe53c7` lines 63, 90-94) move to the new block. `cli`: the MCP footer asserts ("MCP payment check" and the absence of "Listing and Bazaar checks", at `1fe53c7` lines 175-176) move to the new block; `--payer` with a valid address reports `self-payment` end to end; an invalid value and a 64-hex string exit 2 without echoing the value; exit codes unchanged when only new warnings appear.

#### 11. `README.md` (Modify)

*   **Type / Scope**: Package documentation (public, English).
*   **Proposed Changes**: one line per new finding in the list of reported problems at the top (as for `payto-rotates` and `eurc-same-amount`); `--payer` under "Options"; the example output updated to the new footer; after "MCP endpoints" and before "Related", a short section "What the hints mean" with one line per new finding id and a section "What op8x check does not check" with the same entries as `notChecked`; "Related" points to that section.

#### 12. `../../docs/specs/2026-10-24-cli-check-design.md`, `../../docs/specs/2026-10-27-cli-mcp-endpoint-design.md`, `../../docs/designs/2026-10-30-cli-spend-controls-design.md` (Modify)

*   **Type / Scope**: Design documents.
*   **Proposed Changes**: In the check spec (found by content): add this design to the list "Later additions have their own documents"; the usage synopsis gets `--payer`; the `runRules` signature gets `opts`; the `no-402` and `verb-mismatch` fix descriptions mention the added sentence; command-line options and usage errors include `--payer`; the scope sentence on listing concerns says two listing rules are in scope and the pointer to other tools lives in `notChecked`; the human-report description and the JSON example get `notChecked`; the fixtures and test-server description mention `v2main`/`v1main` and the per-request `resource.url`. In the MCP-endpoint spec: the "MCP payment check" footer line becomes the first `notChecked` entry. In the spend-controls design: the sentence on existing fixtures notes that end-to-end tests now use `v2main`/`v1main`.

### Verification Plan

*   **Compilation/Build**: `npm run build` in `packages/cli`.
*   **Typecheck**: `npm run typecheck`.
*   **Unit and end-to-end tests**: `npm test` (`test/cli.test.ts` and `test/probe.test.ts` run against the local test server).
*   **Boundary check**: `node scripts/boundary-check.mjs` from the repo root (runs in the pre-commit hook and CI).
*   **Manual**: in `packages/cli`, `node src/bin.ts check https://demo-api.op8x.workers.dev/paid` against the demo API on Base Sepolia exits 0 and shows `testnet-only`, no other new finding, and the block "Not checked by op8x check"; `--payer abc` exits 2; `--method GET` shows no `post-needs-body`.
