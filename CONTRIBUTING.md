# Contributing

Thanks for helping make x402 easier for sellers. This repository holds the open tools: `@op8x/cli` in `packages/cli`, `@op8x/analytics` in `packages/analytics`, a demo API in `apps/demo-api` and the static site in `apps/site`.

## Setup

Node 24 for development (packages run on Node 20+ and Cloudflare Workers).

```bash
cd packages/cli
```

```bash
npm ci && npm run typecheck && npm test && npm run build
```

The same commands work in `packages/analytics`. CI runs them for every pull request.

## Principles

- Metadata only: no request bodies, no plain IP addresses, no secrets in logs or telemetry.
- Code that runs inside a seller's server must never break, block or slow the seller's response.
- Implement the x402 standard as specified (v1 and v2); do not invent formats.
- As few dependencies as possible.

## Pull requests

- One topic per pull request, with tests for every behaviour change.
- Commit messages follow Conventional Commits (`feat(cli): ...`, `fix(analytics): ...`, `docs: ...`).
- Update the package README when behaviour or options change. Every documented step should be a command you can copy and run.
- Typecheck, tests and build must pass.

## Problem notes

Before non-trivial work, search `docs/solutions/`. After solving something surprising, add a short note there; the format is in `docs/solutions/README.md`.

## Boundary check

CI runs `scripts/boundary-check.mjs`, which keeps unpublished wording and private paths out of this repository. Its rules are not public; if it flags your pull request, a maintainer will tell you what to change.

## Security

Please report vulnerabilities privately to security@op8x.com instead of opening an issue.
