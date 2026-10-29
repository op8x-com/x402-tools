# op8x

Free tools for x402 sellers: APIs that get paid over HTTP 402.

Website: https://op8x.com

## Structure

| Path | Contents |
| --- | --- |
| `packages/cli/` | `@op8x/cli`: `npx @op8x/cli check <url>` diagnoses the 402 challenge of an x402 endpoint |
| `packages/analytics/` | `@op8x/analytics` (pre-release, not on npm yet): fail-open Hono middleware for Cloudflare Workers that records one metadata entry per request to an x402 route |
| `docs/` | Documentation |
