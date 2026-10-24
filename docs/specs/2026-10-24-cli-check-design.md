# op8x CLI 0.0.1: `op8x check`

Status: approved design, 2026-10-24.

## Goal

A seller runs one command and learns, from the outside, whether their x402 endpoint issues a challenge that real clients can read, and if not, why and how to fix it.

```
npx @op8x/cli check <url> [--method GET|POST] [--json] [--timeout <seconds>]
```

Focus is **dialect diagnosis**: where the challenge lives (header, body, both), whether the official client can read it, whether header and body agree, whether v1/v2 conventions are mixed, and whether GET and POST behave alike. Directory and listing concerns (CORS, Bazaar, `/.well-known/x402`, OpenAPI) are out of scope; the report points to `npx x402-listing-check <url>` for those.

## Non-goals

- No payments, no wallet, no signing. Requests are always unpaid.
- No telemetry. The CLI talks only to the URL given.
- No Python package in 0.0.1.
- No receipt-header checks (they need a paid request).
- No publishing automation in this spec; release is a separate step (npm trusted publishing from GitHub Actions).

## Background facts (from @x402/core 2.28.0 and x402 1.2.0)

- **v2:** challenge in response header `PAYMENT-REQUIRED`, standard base64 of UTF-8 JSON (`/^[A-Za-z0-9+/]*={0,2}$/`; base64url and whitespace are rejected by the official decoder). Body is `{}` or custom; the official server sets `Cache-Control: no-store`. Shape: `x402Version: 2`, `resource {url, description?, mimeType?, ...}`, `accepts[]` (min 1) of `{scheme, network (CAIP-2), amount, asset, payTo, maxTimeoutSeconds, extra?}`, optional `error`, `extensions`.
- **v1:** challenge in JSON body: `x402Version: 1`, `accepts[]` of `{scheme, network (legacy name, e.g. base-sepolia), maxAmountRequired, resource, description, mimeType?, payTo, asset, maxTimeoutSeconds, outputSchema?, extra?}`, optional `error`.
- **Official client** (`x402HTTPClient.getPaymentRequiredResponse`): uses the `PAYMENT-REQUIRED` header if present; otherwise accepts the body only if `body.x402Version === 1`; otherwise throws. A v2 challenge that exists only in the body is therefore unreadable.

## Architecture

Package `op8x` in `packages/cli`, TypeScript, ESM, Node >= 20, single runtime dependency `@x402/core`. Small units with one job each:

| File | Job | Depends on |
| --- | --- | --- |
| `src/probe.ts` | Send unpaid requests, collect status, headers, body text, timing | global `fetch` |
| `src/extract.ts` | Decode header, parse body, classify challenge location and version | `@x402/core/http`, `@x402/core/schemas` |
| `src/rules.ts` | Pure functions: extracted data in, findings out | `@x402/core/schemas` |
| `src/report.ts` | Render findings as text or JSON | none |
| `src/cli.ts` | Parse arguments, wire the pipeline, set exit code | all of the above |

### Probe

- Methods: `GET` and `POST` (POST with `Content-Type: application/json`, body `{}`), unless `--method` restricts to one.
- Headers: `Accept: application/json`, `User-Agent: op8x-cli/<version> (+https://op8x.com)`. Never sends `X-PAYMENT` or `PAYMENT-SIGNATURE`.
- `redirect: "manual"`; a redirect is reported, not followed.
- Timeout per request, default 10 s. Body read capped at 256 KB.
- Network errors (DNS, TLS, timeout) become a probe result with an error, not an exception.

### Findings

```ts
type Level = "error" | "warn" | "info" | "pass";
interface Finding {
  id: string;          // stable, e.g. "v2-body-only"
  level: Level;
  method: "GET" | "POST" | "both";
  title: string;       // one line
  detail: string;      // what was observed
  fix?: string;        // what to change
}
```

## Rules

Each rule has a stable id. Levels: `error` breaks real clients, `warn` is risky or non-standard, `info` is context, `pass` confirms a check.

| id | Level | Condition | Fix hint |
| --- | --- | --- | --- |
| `no-402` | error | Neither method returns 402 (or 412 with `permit2_allowance_required`) | Return 402 with a challenge for unpaid requests; status shown (200 = not paywalled, 401/403 = auth or WAF, 404 = wrong path, 3xx = redirect) |
| `redirect` | warn | 3xx response | Serve the 402 at the final URL; many clients do not follow redirects before paying |
| `verb-mismatch` | warn | One method returns 402, the other does not (e.g. GET 405) | Clients probe with GET; issue the challenge on GET too, or document the method |
| `header-not-base64` | error | `PAYMENT-REQUIRED` present but not standard base64 (base64url, whitespace, padding) | Encode with standard base64 (`+` `/` `=`), no line breaks |
| `header-not-json` | error | Header decodes but is not JSON | Header must be base64 of the JSON challenge |
| `v2-body-only` | error | Body holds a v2 challenge, header missing | Move the challenge into the `PAYMENT-REQUIRED` header; the official v2 client ignores v2 bodies |
| `no-challenge` | error | 402 without readable challenge in header or body | Add the challenge (v2: header; v1: body) |
| `header-body-drift` | error | Header and body both carry a challenge and differ; detail lists differing field paths | Generate both from one object, or drop the body copy |
| `version-missing` | error | `x402Version` absent or not the number 1 or 2 (e.g. string `"2"`) | Set `x402Version` to the number 1 or 2 |
| `schema` | error | Official schema (`PaymentRequiredV1Schema` / `PaymentRequiredV2Schema`) rejects the challenge; one finding per issue path | Shown per field from the schema message |
| `v2-legacy-network` | error | v2 `network` without `:` (e.g. `base`) | Use CAIP-2, e.g. `eip155:8453`; known EVM names are mapped in the hint |
| `v1-caip2-network` | warn | v1 `network` contains `:` | v1 clients expect legacy names like `base-sepolia` |
| `mixed-dialect` | error | v2 entry uses v1 fields (`maxAmountRequired`, string `resource`) or v1 entry uses `amount` | Use one dialect consistently |
| `v1-legacy` | info | Valid v1 challenge | v1 works with v1 clients; v2 is the current standard |
| `cache-control` | warn | 402 without `no-store` in `Cache-Control` | Send `Cache-Control: no-store` so proxies do not cache challenges |
| `official-client` | pass/error | Whether the official client logic can read the challenge | Derived from the rules above |

Legacy-to-CAIP-2 hint map (EVM only): `base` → `eip155:8453`, `base-sepolia` → `eip155:84532`, `polygon` → `eip155:137`, `polygon-amoy` → `eip155:80002`, `avalanche` → `eip155:43114`, `avalanche-fuji` → `eip155:43113`.

## Output

Human report (default): URL, per-method status line, findings grouped by level with title, detail and fix, a `curl -i` command to reproduce, a one-line summary, and a pointer to `npx x402-listing-check <url>` for listing checks. Colours only when stdout is a TTY and `NO_COLOR` is unset.

JSON (`--json`):

```json
{
  "tool": "op8x",
  "version": "0.0.1",
  "url": "https://example.com/paid",
  "checkedAt": "2026-10-24T18:00:00.000Z",
  "requests": [{ "method": "GET", "status": 402, "ms": 120 }],
  "findings": [{ "id": "v2-body-only", "level": "error", "method": "GET", "title": "...", "detail": "...", "fix": "..." }],
  "summary": { "errors": 1, "warnings": 0 }
}
```

Exit codes: `0` no errors, `1` at least one `error` finding, `2` usage error or every request failed at network level.

## Testing

- Unit tests (Node's built-in `node:test`, run on TypeScript sources via Node's type stripping; no test framework dependency) for `extract` and every rule, with JSON fixtures: valid v2, valid v1, v2 body-only, drift, base64url header, string version, legacy network in v2, mixed dialect.
- Integration test: a local `node:http` server serving those fixtures; run the CLI pipeline against it and assert findings and exit codes.
- No tests against third-party live endpoints in CI.

## Distribution

- npm package `@op8x/cli`, owned by the `@op8x` organization, MIT license, `bin: { "op8x": "dist/bin.js" }` (global install gives the `op8x` command). The unscoped name `op8x` was rejected by npm on 2026-10-24 as too similar to `opn`, `open` and `cpx` (typosquatting protection). README in English with one command and an example report.
- The report links back to op8x.com once, in the footer.
