# op8x CLI: MCP endpoints in `op8x check`

Status: implemented, 2026-10-27. Extends `2026-10-24-cli-check-design.md`.

## Problem

x402 over MCP never answers with HTTP 402. An unpaid `tools/call` comes back as HTTP 200 whose tool result carries the payment requirement (`isError: true`, `PaymentRequired` in `structuredContent` and in `content[0].text`; see the [x402 MCP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md)). The plain GET and POST probes of `op8x check` never reach a tool, so on an MCP endpoint they see a non-402 status and report the error `no-402` with exit code 1. That error does not exist.

Observed on 2026-10-27 against a public MCP endpoint (stateless Streamable HTTP):

```
  GET  405  206 ms
  POST 406  96 ms

✖ error [both] No 402 challenge
        GET → 405, POST → 406
```

The POST response body was a JSON-RPC 2.0 error:

```json
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"},"id":null}
```

MCP Streamable HTTP requires clients to accept both `application/json` and `text/event-stream`. The probes send `Accept: application/json` only, so the transport of the official TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.2) rejects the POST with 406 and a JSON-RPC error before it looks at the body, in stateful, stateless and JSON-response mode.

## Goal

When the existing probes show an MCP endpoint, `op8x check` reports no error. It says that x402 over MCP does not use HTTP 402 and prints the command that does check it: `npx x402-listing-check@latest '<url>' --mcp-tool YOUR_TOOL`. `op8x check` does not check MCP payments itself.

## Non-goals

- No MCP client: no `initialize`, `tools/list` or `tools/call`. No new requests; detection uses only the probes that already run.
- No checks of the `PaymentRequired` inside a tool result (x402-listing-check does that).
- No new CLI option, no new exit code, no new top-level field in the JSON report.
- No change for any endpoint that does not match the detection below: its report stays byte for byte the same.

## Detection

Plain JSON-RPC is not enough: paid JSON-RPC APIs (for example blockchain RPC) and A2A servers also answer with JSON-RPC 2.0, and a JSON-RPC body on such an endpoint must keep the `no-402` error. The rule therefore uses the one answer that is specific to MCP Streamable HTTP: 406 to a request that accepts only `application/json`.

A probe is an **MCP signal** when all hold:

- status is exactly `406`;
- the body parses to a plain JSON object (not an array) with `jsonrpc` equal to the string `"2.0"`;
- it has an `error` object whose `code` is an integer, and no `result` key;
- it has no `PAYMENT-REQUIRED` header (an x402 challenge on a non-402 status stays an error);

The **MCP case** applies when all hold:

- no probe returned a 402 (the condition of `no-402` today);
- every probe that got a response has a 4xx status (any 2xx means something was served unpaid; any 3xx stays a redirect);
- at least one probe is an MCP signal.

The JSON-RPC `message` and `id` are not read. No text from the response is copied into the report.

## Report

In the MCP case the finding `no-402` is replaced, in the same position (first), by:

| id | Level | method | Title |
| --- | --- | --- | --- |
| `mcp-endpoint` | info | `both`, or the one method that showed the signal | MCP endpoint: x402 over MCP does not use HTTP 402 |

- `detail`: `GET → 405, POST → 406. The POST answer is a JSON-RPC error from an MCP server. x402 over MCP returns the payment requirement inside the tools/call result with HTTP 200, so this HTTP check does not apply. If this URL is meant to be paid per HTTP request, it returned no 402.` The status list is built as in `no-402`; the sentence names the method(s) with the signal.
- `fix`: `Check a paid tool over MCP: npx x402-listing-check@latest '<url>' --mcp-tool YOUR_TOOL (replace YOUR_TOOL with the name of a paid tool).`
- The footer line `Listing and Bazaar checks: …` becomes `MCP payment check: npx x402-listing-check@latest '<url>' --mcp-tool YOUR_TOOL` in the MCP case only.

The URL is single-quoted as in the `Reproduce` lines. `YOUR_TOOL` is used instead of `<name>`, because `<` is a redirect in every common shell. `@latest` makes npx fetch the current version instead of reusing a cached one that may predate `--mcp-tool` (added in 0.3.0).

Other findings are unchanged (for example `request-failed` if one probe failed). With only `info` findings the summary shows `0 errors` and the exit code is `0`, following the existing rule (`1` only for `error` findings). The id `mcp-endpoint` is stable; CI jobs that must not pass on an unchecked MCP endpoint can test `findings[].id` in the `--json` report.

## Known limits

These stay as today (`no-402` or `request-failed`) and are out of scope:

- MCP servers that answer the POST with something other than 406 (for example a stateful app that checks the session first and returns 400).
- Auth-gated MCP (401 with an OAuth error body): reported as "authentication or a firewall".
- Servers that open a `text/event-stream` on GET (legacy HTTP+SSE): the probe times out.
- JSON-RPC errors sent as SSE frames (`data: {…}`): not parsed.

## Testing

- Unit tests in `rules.test.ts`:
  - MCP case: GET 405 (JSON or plain text) + POST 406 JSON-RPC error → `mcp-endpoint` with method `POST`; GET 406 + POST 406 → method `both`; `id` other than `null` (e.g. `"server-error"`) still matches; `--method POST` alone matches.
  - Stays `no-402`: POST 400 JSON-RPC error; POST 200 JSON-RPC error; POST 200 JSON-RPC `result`; GET 200 + POST 406 JSON-RPC; 406 with `"jsonrpc": "1.0"`, `"jsonrpc": 2`, an array, an `error` without integer `code`, or a `result` key; 406 with a non-JSON body.
  - A 402 on either method keeps today's findings.
  - One probe failed + POST 406 JSON-RPC → `request-failed` and `mcp-endpoint`, exit code 1.
  - The JSON-RPC message never appears in any finding field.
  - A URL containing `'` is quoted as in `Reproduce`.
- Integration test in `cli.test.ts` against a new fixture route `/mcp` (GET 405, POST 406 JSON-RPC error): exit code 0, title, command and new footer in text, `mcp-endpoint` in JSON, only the GET and POST requests sent.
- Regression: before the change, text and `--json` output and exit code are recorded for every other fixture route; after the change they must match exactly. Normalised before comparing: the fixture server port, `checkedAt`, and request timings (`<n> ms` in text, `"ms": <n>` in JSON).
