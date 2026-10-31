# op8x CLI: `op8x check`

Status: approved design, 2026-10-24; first release 0.0.1. Updated 2026-10-29 to match the implementation. Later additions have their own documents:

- `2026-10-25-cli-cors-payment-flow-design.md`: browser-like repeat, CORS preflight, `cors-*` and `payment-flow` rules
- `2026-10-27-cli-v2-header-only-design.md`: `v2-header-only` hint
- `2026-10-27-cli-mcp-endpoint-design.md`: `mcp-endpoint` hint
- `../designs/2026-10-28-cli-official-client-design.md`: `official-client` from the official client, `header-empty`, `x402Core` in the report
- `../designs/2026-10-30-cli-spend-controls-design.md`: `default-asset`, `default-cap` and `eurc-same-amount` (spend controls of default clients)
- `../designs/2026-10-31-cli-payto-rotation-design.md`: `payto-rotates` (`payTo` that differs between the plain request and the browser-like repeat)
- `../designs/2026-10-31-cli-challenge-hints-design.md`: `testnet-only`, `extensions-placement`, `resource-url-mismatch`, `self-payment`, `post-needs-body`, the option `--payer` and the `notChecked` list

## Goal

A seller runs one command and learns, from the outside, whether their x402 endpoint issues a challenge that real clients can read, and if not, why and how to fix it.

```
npx @op8x/cli check <url> [--method GET|POST] [--json] [--timeout <seconds>] [--payer <address>]
```

Focus is **dialect diagnosis**: where the challenge lives (header, body, both), whether the official client can read it, whether header and body agree, whether v1/v2 conventions are mixed, and whether GET and POST behave alike. Directory and listing concerns (Bazaar, `/.well-known/x402`, OpenAPI) are out of scope apart from two listing rules that read the unpaid response (`extensions-placement`, `resource-url-mismatch`); for everything else the report's `notChecked` list points to CDP's validation endpoint and `npx x402-listing-check <url>`. CORS for browser clients was out of scope in 0.0.1 and is now covered by `2026-10-25-cli-cors-payment-flow-design.md`.

## Non-goals

- No payments, no wallet, no signing. Requests are always unpaid.
- No telemetry. The CLI talks only to the URL given.
- No Python package in 0.0.1.
- No receipt-header checks (they need a paid request).
- No publishing automation in this spec; release is a separate step (npm trusted publishing from GitHub Actions).

## Background facts (from @x402/core 2.28.0 and 2.29.0, x402 1.2.0)

- **v2:** challenge in response header `PAYMENT-REQUIRED`, standard base64 of UTF-8 JSON (`/^[A-Za-z0-9+/]*={0,2}$/`; base64url and whitespace are rejected by the official decoder). Body is `{}` or custom; the official server sets `Cache-Control: no-store`. Shape: `x402Version: 2`, `resource {url, description?, mimeType?, ...}`, `accepts[]` (min 1) of `{scheme, network (CAIP-2), amount, asset, payTo, maxTimeoutSeconds, extra?}`, optional `error`, `extensions`.
- **v1:** challenge in JSON body: `x402Version: 1`, `accepts[]` of `{scheme, network (legacy name, e.g. base-sepolia), maxAmountRequired, resource, description, mimeType?, payTo, asset, maxTimeoutSeconds, outputSchema?, extra?}`, optional `error`.
- **Official client** (`x402HTTPClient.getPaymentRequiredResponse`): uses the `PAYMENT-REQUIRED` header if present; otherwise accepts the body only if `body.x402Version === 1`; otherwise throws. A v2 challenge that exists only in the body is therefore unreadable. How `official-client` is decided is described in `docs/designs/2026-10-28-cli-official-client-design.md`.

## Architecture

Package `@op8x/cli` (command `op8x`) in `packages/cli`, TypeScript, ESM, Node >= 20, single runtime dependency `@x402/core` (`~2.29.0`). Small units with one job each:

| File | Job | Depends on |
| --- | --- | --- |
| `src/types.ts` | Shared types: `Finding`, `ProbeResult`, `PreflightResult`, `Extracted`, `OfficialRead` | none |
| `src/version.ts` | `VERSION` constant, used in the User-Agent and the report | none |
| `src/core-version.ts` | Installed `@x402/core` version (`X402_CORE_VERSION`, `"unknown"` if not found) | `node:module`, `node:fs`, `node:path` |
| `src/probe.ts` | Send unpaid requests, collect status, headers, body text (read like `@x402/fetch`), timing; `ORIGIN` for browser-like requests | global `fetch`, `@x402/core/http` |
| `src/extract.ts` | Decode header, parse body, classify challenge location and version; ask the official client whether it reads the challenge | `@x402/core/http` |
| `src/rules.ts` | Pure functions: extracted data in, findings out | `@x402/core/schemas`, `report` (`quote` for fix commands) |
| `src/report.ts` | Render findings as text or JSON | `probe` (`ORIGIN` for the preflight entry) |
| `src/cli.ts` | Parse arguments, wire the pipeline, set exit code | all of the above |
| `src/bin.ts` | Executable entry: runs `cli` with process I/O, colour from TTY and `NO_COLOR`, sets the exit code | `cli` |

### Probe

- Methods: `GET` and `POST` (POST with `Content-Type: application/json`, body `{}`), unless `--method` restricts to one. After these plain probes, each 402 is repeated once with an `Origin` header and an `OPTIONS` preflight may follow (see the CORS document).
- Headers: `Accept: application/json`, `User-Agent: op8x-cli/<version> (+https://op8x.com)`. Never sends `X-PAYMENT` or `PAYMENT-SIGNATURE`. Plain probes send no `Origin`.
- `redirect: "manual"`; a redirect is reported, not followed.
- Timeout per request, default 10 s. Bodies are read like `@x402/fetch` reads them (`readLimitedText`, 1 MiB from `@x402/core/http`). A body over that limit or one that breaks off keeps status and headers, is not parsed, and the official client counts as unable to read the response. A body that is still unread when the CLI's own timeout fires is a request error (`request-failed`), because `@x402/fetch` has no such timeout.
- Network errors (DNS, TLS, timeout) become a probe result with an error, not an exception.

### Extract

- The body text is parsed as `readLimitedText` returns it; its decoder has already dropped one leading UTF-8 byte order mark, as for `@x402/fetch`.
- A body counts as a challenge if it is a JSON object with `x402Version` or an `accepts` array.
- The challenge a client acts on is the decoded header, else the body challenge.

### Findings

```ts
type Level = "error" | "warn" | "info" | "pass";
interface Finding {
  id: string;          // stable, e.g. "v2-body-only"
  level: Level;
  method: "GET" | "POST" | "OPTIONS" | "both"; // OPTIONS: preflight findings
  title: string;       // one line
  detail: string;      // what was observed
  fix?: string;        // what to change
}
```

`runRules(results, preflight?, url?, x402Core?, opts?)` takes the extracted results, the optional preflight result, the checked URL (used in the `mcp-endpoint` fix command), the installed `@x402/core` version (used in the `official-client` detail, default `"unknown"`) and `opts: { payer?: string }` (the value of `--payer`, used by `self-payment`).

## Rules

Each rule has a stable id. Levels: `error` breaks real clients, `warn` is risky or non-standard, `info` is context, `pass` confirms a check.

| id | Level | Condition | Fix hint |
| --- | --- | --- | --- |
| `request-failed` | error | The request failed at network level, or the timeout fired before the body was read | Check that the URL is reachable from the public internet |
| `no-402` | error | Neither method returns 402 (or 412 with `permit2_allowance_required`) and `mcp-endpoint` does not apply | Hint by the status of the first method probed (GET when both are probed): 200 = not paywalled, 401/403 = auth or WAF, 404 = wrong path, 5xx = server failed; otherwise "return 402 with a challenge". When `post-needs-body` fires, the fix adds one sentence that points to it |
| `redirect` | warn | 3xx response | Serve the 402 at the final URL; many clients do not follow redirects before paying |
| `verb-mismatch` | warn | One method returns 402, the other does not (e.g. GET 405) | Clients probe with GET; issue the challenge on GET too, or document the method. When `post-needs-body` fires, the fix adds one sentence that points to it |
| `header-empty` | warn | 402 with an empty `PAYMENT-REQUIRED` header | Remove the empty header, or put the base64 challenge in it |
| `header-not-base64` | error (warn when the official client of the installed `@x402/core` reads the header) | `PAYMENT-REQUIRED` present but not standard base64 (base64url, whitespace, padding) | Encode with standard base64 (`+` `/` `=`), no line breaks |
| `header-not-json` | error (warn when the official client of the installed `@x402/core` reads the header) | Header decodes but is not JSON | Header must be base64 of the JSON challenge |
| `header-not-object` | error (the official client accepts only an object, so there is no warn case) | Header decodes to JSON that is not an object (array, string, number, boolean, `null`); detail names the type | Header must be base64 of the JSON challenge object |
| `v2-body-only` | error | Body holds a v2 challenge, header missing | Move the challenge into the `PAYMENT-REQUIRED` header; the official v2 client ignores v2 bodies |
| `v2-header-only` | info | Valid v2 header challenge, no body challenge | See `2026-10-27-cli-v2-header-only-design.md` |
| `no-challenge` | error | 402 without readable challenge in header or body | Add the challenge (v2: header; v1: body) |
| `header-body-drift` | error | Header and body both carry a challenge and differ; detail lists up to 10 differing field paths | Generate both from one object, or drop the body copy |
| `version-missing` | error | `x402Version` absent or not the number 1 or 2 (e.g. string `"2"`) | Set `x402Version` to the number 1 or 2 |
| `schema` | error | Official schema (`PaymentRequiredV1Schema` / `PaymentRequiredV2Schema`) rejects the challenge; one finding per issue path | Shown per field from the schema message |
| `v2-legacy-network` | error | v2 `network` without `:` (e.g. `base`) | Use CAIP-2, e.g. `eip155:8453`; v1 names that default clients know (EVM and Solana, `V1_NETWORKS` in `assets.ts`) are mapped in the hint |
| `v1-caip2-network` | warn | v1 `network` contains `:` | v1 clients expect legacy names like `base-sepolia` |
| `mixed-dialect` | error | v2 entry uses v1 fields (`maxAmountRequired`, string `resource`) or v1 entry has `amount` but no `maxAmountRequired` | Use one dialect consistently |
| `payment-flow` | error/warn | Unknown `extra.paymentFlow` (v1 and v2) or missing one (v2) | See `2026-10-25-cli-cors-payment-flow-design.md` |
| `v1-legacy` | info | Valid v1 challenge | v1 works with v1 clients; v2 is the current standard |
| `cache-control` | warn | 402 without `no-store` in `Cache-Control` | Send `Cache-Control: no-store` so proxies do not cache challenges |
| `official-client` | pass/error | Whether the official client of the installed `@x402/core` reads the challenge | No `fix` field; the error detail names what the official client rejects and points to the other findings (the two decoders can disagree) |
| `cors-*` | warn/info | CORS for browser clients | See `2026-10-25-cli-cors-payment-flow-design.md` |
| `mcp-endpoint` | info | No 402, and a 406 JSON-RPC error marks an MCP server | See `2026-10-27-cli-mcp-endpoint-design.md` |

Order and scope of the per-method rules:

- `request-failed` and `redirect` end the checks for that method; no other per-method rule runs.
- Non-402 responses get no per-method findings; `no-402`, `verb-mismatch` and `mcp-endpoint` are decided across methods.
- If `x402Version` is invalid, `version-missing` replaces `schema`, `mixed-dialect`, `payment-flow`, the network rules and `v1-legacy`.
- `schema` skips issue paths already reported by `v2-legacy-network` or `mixed-dialect`.
- `mixed-dialect` checks `maxAmountRequired` and string `resource` inside `accepts[]` only.
- `cache-control` and `official-client` run for every 402, also without a readable challenge.
- A header that decodes to JSON is the challenge, even when that JSON is not an object; as in the official client, a body challenge is then ignored. The version, schema, network and dialect rules run only on a challenge that is a JSON object. For any other decoded header, `header-not-object` names the JSON type, and `no-challenge` and `header-body-drift` do not apply.
- Identical findings on GET and POST are merged into one with method `both`.

Legacy-to-CAIP-2 hint map (EVM only): `base` → `eip155:8453`, `base-sepolia` → `eip155:84532`, `polygon` → `eip155:137`, `polygon-amoy` → `eip155:80002`, `avalanche` → `eip155:43114`, `avalanche-fuji` → `eip155:43113`.

## Command line

- `op8x check <url>` with `--method <GET|POST>` (case-insensitive), `--json`, `--timeout <seconds>` (positive number), `--payer <address>` (one `0x` plus 40 hex digits or 32 to 44 base58 characters; compared with every `payTo`, never printed).
- `-h`/`--help` prints usage, `-v`/`--version` prints the version; both exit 0.
- Unknown options, a missing or extra positional argument, a URL that does not parse or is not http/https, and invalid `--method`, `--timeout` or `--payer` values are usage errors (exit 2).

## Output

Human report (default): URL, one status line per request (browser-like repeats marked `(with Origin)`), findings grouped by level with title, detail and fix, a `curl -i` command per request to reproduce, a one-line summary, and the block "Not checked by op8x check" (`notChecked`: Bazaar indexing with CDP's validation command per method and `npx x402-listing-check <url>`, delivery after a real payment, facilitator limits; for `mcp-endpoint` the first entry is the MCP tool check and the Bazaar entry is left out). Colours only when stdout is a TTY and `NO_COLOR` is unset.

JSON (`--json`):

```json
{
  "tool": "op8x",
  "version": "0.0.3",
  "x402Core": "2.29.0",
  "url": "https://example.com/paid",
  "checkedAt": "2026-10-24T18:00:00.000Z",
  "requests": [{ "method": "GET", "status": 402, "ms": 120 }],
  "findings": [{ "id": "v2-body-only", "level": "error", "method": "GET", "title": "...", "detail": "...", "fix": "..." }],
  "summary": { "errors": 1, "warnings": 0 },
  "notChecked": [{ "topic": "Bazaar indexing and metadata", "where": "curl -X POST ... (one line per command, joined with a line break)" }]
}
```

`requests[]` entries add `error` for failed requests; the browser-like repeats and the preflight add the fields described in the CORS document.

Exit codes: `0` no errors, `1` at least one `error` finding, `2` usage error or every plain probe failed at network level.

## Testing

- Unit tests (Node's built-in `node:test`, run on TypeScript sources via Node's type stripping; no test framework dependency) for `extract`, `probe`, `report` and every rule. `test/fixtures.ts` holds a valid v2 and a valid v1 challenge (Base Sepolia) and base64 builders, plus `v2main` and `v1main` (the same challenges on Base mainnet, used by the test server); the variants (v2 body-only, drift, base64url header, string version, legacy network in v2, mixed dialect and others) are built from them inside the rule tests.
- Integration test: a local `node:http` server (`test/server.ts`; every route answers with `v2main`/`v1main` and sets the v2 `resource.url` per request from the Host header, so the routes raise neither `testnet-only` nor `resource-url-mismatch`) with routes for valid v2 and v1, v2 body-only, drift, empty headers, a 405 on GET, no paywall, a redirect, CORS, MCP, `/payto-rotates` and body limits; run the CLI pipeline against it and assert findings and exit codes. The other rule variants are covered by the rule tests only.
- Smoke tests: the fixtures pass the official schemas, and `VERSION` matches `package.json`.
- No tests against third-party live endpoints in CI.

## Distribution

- npm package `@op8x/cli`, owned by the `@op8x` organization, MIT license, `bin: { "op8x": "dist/bin.js" }` (global install gives the `op8x` command). The unscoped name `op8x` was rejected by npm on 2026-10-24 as too similar to `opn`, `open` and `cpx` (typosquatting protection). README in English with one command and an example report.
- Build with `tsc` to `dist/`; the package ships `dist`, `README.md` and `LICENSE` (`files`), declares `engines.node >= 20` and `publishConfig.access: public`; `prepublishOnly` runs typecheck, tests and build.
- The report links back to op8x.com once, in the footer.
