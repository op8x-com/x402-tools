# Workers example

A Hono app on Cloudflare Workers with `@op8x/analytics` in front of `@x402/hono`. It runs fully locally: a fake facilitator stands in for the real one, so no money moves and no network is needed.

`@op8x/analytics` is a pre-release that is not on npm, so this example installs it from the parent directory (`"@op8x/analytics": "file:../.."`). Build the package first. The `.npmrc` in this directory sets `install-links=true`, so the package is copied, not linked (a link would give it a second copy of `hono`, and `route` would come out empty). After rebuilding the package, run `npm install` here again.

## Run it

```
cd packages/analytics
npm ci
npm run build
cd examples/workers
npm install
```

Terminal 1, the fake facilitator (port 4021):

```
npm run facilitator
```

Terminal 2, the Worker (port 8787):

```
npm run dev
```

Terminal 3:

```
curl -i http://127.0.0.1:8787/paid
curl -i http://127.0.0.1:8787/
```

The first request returns `402 Payment Required` with a `PAYMENT-REQUIRED` header. In terminal 2 each request produces a line like:

```
op8x.analytics {"v":1,"id":"...","status":402,"ua":"curl","type":"challenge.issued","challenge":{"location":"header","version":2,...}}
```

## Notes

- `wrangler.toml` uses `compatibility_date = "2026-10-01"` and no `nodejs_compat`.
- The payment middleware is set up only on the paid route, with an explicit `initialize()` kept alive by `waitUntil` and retried after a failure. Workers forbid network I/O in global scope and cancel I/O that a request started once it ends, so a lazy setup on the first request of any route would leave `/paid` hanging when that request was a free route. The analytics middleware is built lazily, for simplicity, since bindings are read per request.
- Set `ANALYTICS_ENDPOINT` in `wrangler.toml` to also POST each record to a URL (https, or http on localhost).
- `payTo` is a dummy address. For real payments, set `FACILITATOR_URL` to a real facilitator and use your own address.
- Observed on Windows: `wrangler dev` failed with `SQLITE_CANTOPEN` when the project path is long (about 170+ characters). Use a shorter path.
