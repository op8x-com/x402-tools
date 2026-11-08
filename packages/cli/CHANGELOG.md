# Changelog

## 0.1.0 (unreleased)

- First release on npm. `check` diagnoses the 402 challenge of an endpoint.
- New account commands: `init`, `login`, `logout`, `import-key`, `rotate` (`--now`, `--force-stop`), `delete`, `report`.
- Payer pseudonyms use a per-seller salt (`OP8X_SALT`).
- Built on `@x402/core` ~2.29 (zod 4): stricter CAIP-2 and `accepts` checks (at most 1024 entries), and schema findings use new wording.
- Requires Node.js 22 or later.
