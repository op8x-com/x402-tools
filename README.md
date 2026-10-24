# op8x

Free tools for x402 sellers: APIs that get paid over HTTP 402.

Website: https://op8x.com

## Structure

| Path | Contents |
| --- | --- |
| `apps/site/` | Landing page for op8x.com, static on Cloudflare Workers (`npm run deploy`) |
| `packages/cli/` | `op8x` CLI: checks a URL for a valid x402 challenge |
| `packages/analytics/` | 402 analytics for sellers |
| `docs/` | Documentation |
