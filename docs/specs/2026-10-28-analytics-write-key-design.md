# @op8x/analytics: write key and ingest contract

Status: approved design, 2026-10-28.

## Goal

The module sends each record to the op8x collector with the seller's write key, and the wire format that a collector accepts is written down in one public place. A small demo API shows the module in a real x402 flow on testnet.

```ts
app.use(analytics({ endpoint: "https://ingest.op8x.com/v1/events" }));
// The write key comes from the Worker environment: OP8X_KEY (wrangler secret put OP8X_KEY).
```

## Key handling

1. **Sources.** An explicit option `key` wins. Without it, the module reads `OP8X_KEY` from the Hono context's environment (`c.env`) on every request, so a new secret takes effect without a code change.
2. **Only for the op8x collector.** The environment variable is read only when the endpoint's origin is `https://ingest.op8x.com`. For any other endpoint the module sends an `Authorization` header only when `key` is set explicitly, and never a key that starts with `op8x_w_`: such a key is not sent to an origin other than `https://ingest.op8x.com` (nothing is sent, one warning `op8x.analytics: op8x write key refused for a non-op8x endpoint`). Explicit keys without that prefix work for other endpoints. A key meant for op8x is never sent to another host by accident. Endpoints with a username or password in the URL are invalid.
3. **Header.** `Authorization: Bearer <key>`, added to the existing `content-type` and `user-agent`. Redirects are not followed (as today), so the header never reaches a second host.
4. **Missing key.** op8x endpoint and no key: nothing is sent, one warning `op8x.analytics: OP8X_KEY missing, sending disabled` (Hono middleware; `createTransport` used directly warns `op8x.analytics: no key for the op8x endpoint (set the key option or OP8X_KEY), sending disabled`, because it never reads the environment). Other endpoints without `key`: unchanged behaviour, no header.
5. **Invalid key.** Not a string, empty after trimming, longer than 256 characters, or containing characters outside printable ASCII; for the op8x endpoint also a missing `op8x_w_` prefix. Nothing is sent, one warning without the value. The module does not check the length of the random part; the collector does.
6. **Warning rate.** Key warnings (missing, invalid, refused) are limited to one line per minute per message and isolate, like send failures, so a long-lived process shows a misconfiguration again.
7. **Never visible.** The key never appears in records, `log: true` output, warnings or error messages.
7. **Fail open as before.** A `401` or any other status changes nothing for the seller's response.

## Ingest contract

A new file `packages/analytics/docs/ingest-contract.md` becomes the single description of what the module sends; the README links to it instead of keeping its own field list. It contains:

- path `POST /v1/events`, one JSON object per request, at most 16 KB;
- the headers (`content-type`, `user-agent`, `authorization`);
- the fields the module sends today, with types;
- the response codes (`202`, `400`, `401`, `413`, `429`, `503`, all with an empty body) and that the module ignores them apart from one rate-limited warning;
- the five compatibility rules: optional new fields do not change `v`; a collector accepts a field before a module sends it, until then it drops it; a missing field means "unknown"; the meaning of a field never changes within `v: 1`; unknown fields are dropped, never refused;
- a note that the contract may change until the first npm release.

## Demo API

`apps/demo-api` turns `packages/analytics/examples/workers` into a deployable Worker:

- one free route and one paid route (`exact` scheme, Base Sepolia testnet, a public facilitator), `payTo` from a variable;
- the module installed from a packed tarball (`npm pack`), with the source commit and the tarball's SHA-256 recorded, so it runs the same artifact a seller would install;
- `ANALYTICS_ENDPOINT` and `OP8X_KEY` set per deployment (`OP8X_KEY` only as a secret);
- deployed under `workers.dev`; no route on another zone.

## Non-goals

- No default endpoint, no npm release.
- No salt from the environment (unchanged option `salt`).
- No new record fields.
- No buyer or test client in this repository.

## Testing

- Unit tests for every rule in "Key handling", with a sentinel key that must never appear in any `console` call or record.
- Transport test: header present exactly in the specified cases.
- Demo API: typecheck, and a local run against the fake facilitator with `log: true`.
