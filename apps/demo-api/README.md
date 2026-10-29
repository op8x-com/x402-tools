# Demo API

A small paid API on Cloudflare Workers that shows `@op8x/analytics` in an x402 flow on testnet. It is the [Workers example](../../packages/analytics/examples/workers) made deployable:

- `GET /` is free and describes the API.
- `GET /paid` costs $0.001 in USDC on Base Sepolia (`eip155:84532`, scheme `exact`), settled through the public testnet facilitator `https://x402.org/facilitator`. Testnet USDC has no value.
- Every request produces one analytics record, logged with `log: true` and, once `ANALYTICS_ENDPOINT` is set, sent to that endpoint with the write key `OP8X_KEY`.

## Configuration

| Name | Kind | Where | Purpose |
| --- | --- | --- | --- |
| `FACILITATOR_URL` | var | `wrangler.toml` | x402 facilitator; the public testnet facilitator by default |
| `PAY_TO` | var | `wrangler.toml` | Address that receives the testnet payments |
| `ANALYTICS_ENDPOINT` | var | `wrangler.toml` | Where records are sent (the op8x collector); unset, or without `OP8X_KEY`, records are only logged |
| `OP8X_KEY` | secret | `npx wrangler secret put OP8X_KEY` | Write key for the op8x collector; never in a file |

## The module comes from a packed tarball

`@op8x/analytics` is installed from `vendor/op8x-analytics-0.0.1.tgz`, the output of `npm pack` in `packages/analytics`, so the demo runs exactly the artifact a seller would install. `vendor/SOURCE` records the source commit and the tarball's SHA-256. To check the tarball, pack `packages/analytics` afresh and compare the two file by file. The check also verifies the SHA-256 in `SOURCE` and the dependency in `package.json`. Changes to `devDependencies` alone do not count, since they never reach the demo. CI runs the same check, so a forgotten repack or a hand-edited tarball fails the pull request:

```
cd packages/analytics
npm ci
cd ../../apps/demo-api
npm run check-vendor
```

To pack a new version (after committing the changes in `packages/analytics`):

```
cd packages/analytics
npm ci
cd ../../apps/demo-api
npm run pack-analytics
npm install ./vendor/op8x-analytics-0.0.1.tgz
```

The script refuses to pack while `packages/analytics` has uncommitted changes. Naming the file in `npm install` refreshes the integrity in `package-lock.json`.

## Run it locally

Locally the demo uses the fake facilitator from the Workers example instead of the public one, so it runs without network access and no money moves. `npm run dev` overrides `FACILITATOR_URL` with `http://127.0.0.1:4021`.

```
cd apps/demo-api
npm ci
```

Terminal 1, the fake facilitator:

```
npm run facilitator
```

Terminal 2, the Worker on port 8787:

```
npm run dev
```

Terminal 3:

```
curl.exe -i http://127.0.0.1:8787/
curl.exe -i http://127.0.0.1:8787/paid
```

`/paid` (and `HEAD /paid`) returns `402 Payment Required` with a `PAYMENT-REQUIRED` header. Terminal 2 shows one `op8x.analytics {...}` line per request.

To run against the public testnet facilitator instead:

```
npx wrangler dev --ip 127.0.0.1 --port 8787
```

## Deploy

The Worker is named `demo-api` and is served only under `workers.dev` (no routes, no custom domain). All commands run in PowerShell from `apps/demo-api`; `npx wrangler deploy` asks you to log in to Cloudflare if you are not logged in yet.

1. Install the exact dependencies:

   ```
   npm ci
   ```

2. Deploy. `wrangler.toml` sets `ANALYTICS_ENDPOINT` to the op8x collector; until step 3 sets the write key, nothing is sent: records are only logged, with a warning that sending is disabled. To deploy with logging only, put a `#` in front of that line first:

   ```
   npx wrangler deploy
   ```

3. On the first deploy only, store the write key as the secret `OP8X_KEY`. The prompt hides what you type, so no value appears on screen, and the secret is set on the deployed Worker and never written to a file in this repository. Later deploys keep the secret:

   ```
   npx wrangler secret put OP8X_KEY
   ```

4. Check that the Worker answers and that `/paid` asks for payment (expect `200` and `402`):

   ```
   curl.exe -s -o NUL -w "%{http_code}\n" https://demo-api.<your-subdomain>.workers.dev/
   curl.exe -s -o NUL -w "%{http_code}\n" https://demo-api.<your-subdomain>.workers.dev/paid
   ```

   Replace `<your-subdomain>` with the account subdomain that `npx wrangler deploy` prints in its output URL.

To watch the log lines of the deployed Worker:

```
npx wrangler tail demo-api
```

## Notes

- The payment middleware is set up on the first request to `/paid`, not in global scope and not on other routes: Workers forbid network I/O in global scope, and I/O started by one request is cancelled when that request ends. The facilitator client times out after 10 seconds. If the facilitator cannot be reached, `/paid` answers `503` and the setup is retried on the next request.
- Workers observability is off; console output is visible only live through `wrangler tail`.
