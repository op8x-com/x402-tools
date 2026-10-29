# op8x CLI: hint for v2 challenges that only live in the header

Status: proposed, 2026-10-27. Extends `2026-10-24-cli-check-design.md`.

## Problem

x402 v2 sends the challenge in the `PAYMENT-REQUIRED` header; the body may be `{}` or anything else. That is correct v2, and `op8x check` reports it as passing. v1 clients do not look at the header. `x402-fetch` and `x402-axios` read `x402Version` and `accepts` from the JSON body and parse every entry with the v1 `PaymentRequirementsSchema`:

```js
const { x402Version, accepts } = await response.json();
const parsedPaymentRequirements = accepts.map((x) => PaymentRequirementsSchema.parse(x));
```

With a body of `{}` this throws on `accepts.map` before the client has seen any terms. A public measurement in October 2026 found this pattern (v2 in the header, no challenge in the body) on 507 of 1,218 hosts that issue a challenge. Today `op8x check` says nothing about it.

## Change

One new finding, `v2-header-only`, level `info`. It never fails a check: the endpoint is correct v2, so this is context, not an error, and not a warning either (nothing is non-standard).

| id | Level | Condition |
| --- | --- | --- |
| `v2-header-only` | info | A 402 (or 412 `permit2_allowance_required`) whose `PAYMENT-REQUIRED` header decodes to a JSON object with `x402Version` equal to the number `2`, passes the official `PaymentRequiredV2Schema`, and whose body holds no challenge: empty, not JSON, or JSON without `x402Version` and without an `accepts` array (for example `{}`). |

- `title`: `v1 clients cannot read your terms: the body has no challenge`
- `detail`: `The PAYMENT-REQUIRED header holds an x402Version 2 challenge; the body holds none. v1 clients (x402-fetch, x402-axios) read accepts[] from the body only and fail before they see the terms. This is correct v2; current clients read the header.`
- `fix`: `Mirror the challenge in the body, generated from the same object as the header, so clients that read the body find the terms. To pay, v1 clients must move to @x402/fetch or @x402/axios.`
- `method`: per probe; identical GET and POST findings merge into `both`, as for every other finding.

Not reported when the header is missing or broken (`header-not-base64`, `header-not-json` already cover it), when the header decodes to anything other than `x402Version: 2`, when the header challenge fails the v2 schema (its errors come first), or when the body carries a challenge (then `header-body-drift` applies if the two differ). `header-body-drift` is unchanged.

The summary counts only `error` and `warn`, so with this finding alone the summary stays `0 errors, 0 warnings` and the exit code stays `0`. The id is stable; a CI job that requires v1 readability can test `findings[].id` in the `--json` report.

## Non-goals

- No change to `official-client`: it mirrors the current official client (`@x402/core`), which reads the header.
- No v1 parse of the body copy, no advice to serve a different dialect in the body.
- No new request, option, exit code or JSON field.

## Known limits

- The probe reads at most 1 MiB of the body, as `@x402/fetch` does (`readLimitedText`). A larger body is not parsed and the official client counts as unable to read the response. Real challenges are a few KB.

## Testing

- Unit tests in `rules.test.ts`: the finding appears for a v2 header with body `{}`, an empty body, a non-JSON body and a JSON body without a challenge; GET and POST merge into `both`; level `info`, no new errors. It does not appear for a mirrored body, a v2 or v1 challenge only in the body, a broken header, a header with `x402Version: 1` or `"2"`, a non-402 status, a header that fails the v2 schema (missing `accepts`, legacy network name), or a mirrored body with a leading BOM. It does appear for a 412 `permit2_allowance_required` with a valid v2 header. The extract test covers a body with a leading BOM.
- Integration test in `cli.test.ts` against the existing fixture route `/v2-good` (v2 header, body `{}`): title in the text report, `v2-header-only` with level `info` in JSON, exit code `0`, summary `0 errors, 0 warnings`.
- Regression: before the change, text and `--json` output and exit code are recorded for every fixture route; after the change the only difference is the new finding (three text lines, one JSON object) on routes that send a v2 header with a body that is not a challenge. Normalised before comparing: fixture server port, `checkedAt`, request timings.
