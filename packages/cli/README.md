# op8x

Check an x402 endpoint from the outside: can real clients read its 402 challenge?

```
npx op8x check https://api.example.com/weather
```

`op8x check` makes two unpaid requests (GET and POST) and reports dialect problems that make paying clients fail silently:

- v2 challenge only in the body (the official v2 client reads the `PAYMENT-REQUIRED` header only)
- `PAYMENT-REQUIRED` header that is not standard base64 or not JSON
- header and body challenges that disagree
- `x402Version` missing or a string, mixed v1/v2 fields, legacy network names in v2
- GET and POST behaving differently, redirects, missing `Cache-Control: no-store`
- schema errors, checked with the official `@x402/core` schemas

It never pays, needs no wallet and sends no telemetry. It only talks to the URL you give it.

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

✖ error [both] v2 challenge only in the response body
        The body contains an x402Version 2 challenge, but the PAYMENT-REQUIRED header is missing. The official v2 client reads v2 challenges only from the header and fails before signing.
        Fix: Send the challenge in the PAYMENT-REQUIRED header (base64 JSON). A body copy is optional.
✖ error [both] Official x402 client cannot read the challenge
        The official client would fail before signing; see the other findings.

Reproduce:
  curl -i -X GET 'https://api.example.com/weather'
  curl -i -X POST -H 'Content-Type: application/json' -d '{}' 'https://api.example.com/weather'

Summary: 2 error(s), 0 warning(s)
Listing, CORS and Bazaar checks: npx x402-listing-check https://api.example.com/weather
op8x · https://op8x.com
```

## Related

For listing checks (CORS, Bazaar metadata, `/.well-known/x402`, OpenAPI), run [`x402-listing-check`](https://www.npmjs.com/package/x402-listing-check).

MIT · [op8x.com](https://op8x.com)
