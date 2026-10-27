# @op8x/cli

Check an x402 endpoint from the outside: can real clients read its 402 challenge?

```
npx @op8x/cli check https://api.example.com/weather
```

Or install it once and use the short command: `npm install -g @op8x/cli`, then `op8x check <url>`.

`op8x check` makes two unpaid requests (GET and POST), repeats each 402 once with an `Origin` header as a browser would, sends a CORS preflight (`OPTIONS`) when the 402 is CORS-enabled, and reports problems that make paying clients fail silently:

- v2 challenge only in the body (the official v2 client reads the `PAYMENT-REQUIRED` header only)
- `PAYMENT-REQUIRED` header that is not standard base64 or not JSON
- header and body challenges that disagree
- `x402Version` missing or a string, mixed v1/v2 fields, legacy network names in v2
- GET and POST behaving differently, redirects, missing `Cache-Control: no-store`
- schema errors, checked with the official `@x402/core` schemas
- `extra.paymentFlow` that clients do not recognize (not `authorization`, `upfront` or `escrow`), or missing where the scheme default is not `authorization` (`auth-capture`, `upto` on Solana, `exact` on Lightning)
- CORS for browser clients (never errors): `PAYMENT-REQUIRED`/`PAYMENT-RESPONSE` not in `Access-Control-Expose-Headers`, `PAYMENT-SIGNATURE`/`Content-Type` not in `Access-Control-Allow-Headers`, missing v1 spellings (`X-PAYMENT`, `X-PAYMENT-RESPONSE`) on dual-version endpoints, a preflight that requires payment. A `*` does not count on credentialed requests. An endpoint without `Access-Control-Allow-Origin`, or one that refuses browser origins, only gets a hint: servers and agents need no CORS.

The plain requests carry no `Origin`, so a server that refuses browsers is still checked correctly; the repeat and the preflight send `Origin: https://op8x.com`. It never pays, needs no wallet and sends no telemetry. It only talks to the URL you give it.

## Options

```
--method <GET|POST>    probe only this method (default: both)
--json                 print a JSON report (for agents and CI)
--timeout <seconds>    per-request timeout (default: 10)
```

Exit codes: `0` no errors, `1` errors found, `2` usage error or the URL was unreachable.

## Example

```
op8x check https://api.example.com/weather

  GET  402  38 ms
  POST 402  5 ms
  GET  402  6 ms  (with Origin)
  POST 402  5 ms  (with Origin)

✖ error [both] v2 challenge only in the response body
        The body contains an x402Version 2 challenge, but the PAYMENT-REQUIRED header is missing. The official v2 client reads v2 challenges only from the header and fails before signing.
        Fix: Send the challenge in the PAYMENT-REQUIRED header (base64 JSON). A body copy is optional.
✖ error [both] Official x402 client cannot read the challenge
        The official client would fail before signing; see the other findings.
i info  [both] 402 without Access-Control-Allow-Origin
        A browser hides the whole 402 from cross-origin pages, so a web app cannot read the price. Fine if only servers and agents should pay. Affects browser clients only.
        Fix: If browser apps should pay this endpoint, send Access-Control-Allow-Origin on the 402 and on the preflight.

Reproduce:
  curl -i -X GET 'https://api.example.com/weather'
  curl -i -X POST -H 'Content-Type: application/json' -d '{}' 'https://api.example.com/weather'
  curl -i -X GET -H 'Origin: https://op8x.com' 'https://api.example.com/weather'
  curl -i -X POST -H 'Origin: https://op8x.com' -H 'Content-Type: application/json' -d '{}' 'https://api.example.com/weather'

Summary: 2 errors, 0 warnings
Listing and Bazaar checks: npx x402-listing-check https://api.example.com/weather
op8x · https://op8x.com
```

## MCP endpoints

x402 over MCP never answers with HTTP 402. An unpaid `tools/call` returns HTTP 200 with the payment requirement inside the tool result, so the plain GET and POST probes cannot see it. When the probes show an MCP server (HTTP 406 with a JSON-RPC error, which is how MCP Streamable HTTP rejects a request that accepts only `application/json`), `op8x check` reports the info finding `mcp-endpoint`. It replaces the error `no-402` and on its own does not fail the check (exit code 0 unless other errors are found).

`op8x check` does not check MCP payments itself. To check a paid tool, run (replace `YOUR_TOOL` with the name of a paid tool):

```sh
npx x402-listing-check@latest 'https://api.example.com/mcp' --mcp-tool YOUR_TOOL
```

Not detected: MCP servers that answer before the transport check (for example a stateful server that returns 400 without a session id, or a server that requires authentication), and runs with `--method GET`. These still report `no-402`; use `npx x402-listing-check@latest '<url>' --mcp-tool YOUR_TOOL` directly in that case.

`mcp-endpoint` is a stable id. A CI job that must not pass on an unchecked MCP endpoint can test `findings[].id` in the `--json` report. See the [x402 MCP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md).

## Related

For listing checks (Bazaar metadata, `/.well-known/x402`, OpenAPI), run [`x402-listing-check`](https://www.npmjs.com/package/x402-listing-check).

MIT · [op8x.com](https://op8x.com)
