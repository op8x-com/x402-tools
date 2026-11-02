# op8x analytics: `receipt.hasTransaction` for settlements that fail after the transfer

*   **Author:** op8x
*   **Status:** Approved, 2026-11-02
*   **Date:** 2026-11-02

Extends the [ingest contract](../../packages/analytics/docs/ingest-contract.md)
(record format `v: 1`).

--------------------------------------------------------------------------------

## Overview

`@op8x/analytics` is middleware for x402 sellers. It sits in front of the
payment middleware, turns each request into a metadata record and can send
that record to a collector, the consumer of the record. The ingest contract
defines the record's fields. The receipt's transaction hash goes into the
record only with the `chainCheck` option.

Since `@x402/core` 2.29 a seller's `afterSettle` hook can throw
`AfterSettleAbortError`
([x402-foundation/x402#3994](https://github.com/x402-foundation/x402/pull/3994)).
The transfer has already succeeded on-chain, but the seller answers 402 and its
`PAYMENT-RESPONSE` says `success: false`. The record built for this case looks
the same as the record for a settlement where no money moved. This design adds
one boolean, `receipt.hasTransaction`. It says whether the receipt names a
transaction, without the hash. The design also states how a consumer of the
record reads `success: false` together with this flag.

## The Problem

`buildRecord` in `packages/analytics/src/record.ts` reads `success`, `network`,
`errorReason` and `payer` from the receipt header. It reads `transaction` only
with the `chainCheck` option. So without `chainCheck`, a consumer sees
`receipt.success: false` and has to count the payment as failed, even when the
buyer paid.

### What the x402 specification says

Cited from x402-foundation/x402 at commit
[`8cd4cc2`](https://github.com/x402-foundation/x402/tree/8cd4cc25847418bda424d4c8522917be8376ca7c/specs):

*   [v2 specification](https://github.com/x402-foundation/x402/blob/8cd4cc25847418bda424d4c8522917be8376ca7c/specs/x402-specification-v2.md),
    §5.3.2 (`SettlementResponse`): `transaction` is required; it is the
    "Blockchain transaction hash (empty string if no transaction was
    broadcast; MUST be non-empty when `errorReason` is `settlement_pending`)".
*   v2 §9 defines `settlement_pending` as a non-terminal failure: the
    transaction was broadcast and may still confirm on chain.
*   [v1 specification](https://github.com/x402-foundation/x402/blob/8cd4cc25847418bda424d4c8522917be8376ca7c/specs/x402-specification-v1.md),
    §5.3.2: `transaction` is the "Blockchain transaction hash (empty string if
    settlement failed)".

So under v2 a receipt with `success: false` and a non-empty `transaction`
asserts that a transaction was broadcast although the settlement is reported
as failed. Under v1 that combination is not expected.

### What `@x402/core` 2.29 does

The behaviour below was read from the published packages `@x402/core` 2.29.0
(`server/x402ResourceServer.ts`, `http/x402HTTPResourceServer.ts`) and
`@x402/hono` 2.29.0, then measured:

1.  `runAfterSettleHooks` runs after a successful facilitator settle. It also
    runs on a result that a `beforeSettle` hook supplies through `skip`; there
    the seller sets `transaction` itself. When a hook throws
    `AfterSettleAbortError(reason, message)`, it changes the settle result in
    place: `success = false`, `errorReason = reason`, `errorMessage = message`
    (or `reason` when no message is given). `transaction`, `network`,
    `payer`, `amount` and `extra` are kept. Later hooks do not run, and
    `enrichSettlementResponse` is skipped. Any other error thrown by a hook is
    only logged.
2.  **`errorReason` is not a fixed value.** It is the `reason` argument the
    seller's hook passes to the constructor. `@x402/core` defines no constant
    for this case. Even an empty `reason` reaches the header unchanged as
    `"errorReason": ""`, because the header is encoded from the raw settle
    result and not from the `"Settlement failed"` fallback that
    `processSettlement` uses internally.
3.  The only marker of an abort is the symbol `x402.afterSettleAborted` on the
    in-process object (`isAfterSettleAborted`). It is defined as
    non-enumerable, so `JSON.stringify` drops it and it never reaches the
    header.
4.  `processSettlement` turns every `success: false` result into
    `buildSettlementFailureResponse`: **HTTP status 402**, header
    `PAYMENT-RESPONSE` (base64 JSON of the result without
    `extensionResponses`), `Cache-Control` of a 402 answer, and an empty JSON
    body unless the route sets `settlementFailedResponseBody`. `@x402/hono`
    replaces the handler's response with exactly this response. The same holds
    for flows that settle before the handler.

The measurement used `hono`, `@x402/hono`, `@x402/core` and `@x402/evm`
2.29.0, the `exact` EVM server scheme, a stub facilitator whose `settle`
answer is given per case, and the vendored `@op8x/analytics` build in
`apps/demo-api` (packed from 7c12856; `packages/analytics/src` is unchanged
up to e3d7a40). The receipts are decoded and shortened here (`0xab…` and
`0x11…` stand for the full hash and address):

| Case | Status | `PAYMENT-RESPONSE` | `receipt` in the record today |
|---|---|---|---|
| M1. Settle ok, hook aborts with `"fulfilment_failed"` | 402 | `success:false`, `transaction:"0xab…"`, `network`, `payer:"0x11…"`, `amount:"1000"`, `errorReason:"fulfilment_failed"`, `errorMessage` | `success:false`, `network`, `errorReason:"fulfilment_failed"` |
| M2. Settle ok without `amount`, hook aborts with `""` | 402 | `success:false`, `transaction:"0xab…"`, `network`, `payer:"0x11…"`, `errorReason:""`, `errorMessage` | `success:false`, `network` |
| M3. Facilitator reports `invalid_exact_evm_transaction_failed` with a hash | 402 | `success:false`, `errorReason:"invalid_exact_evm_transaction_failed"`, `transaction:"0xab…"`, `network`, `payer:"0x11…"` | `success:false`, `network`, `errorReason:"invalid_exact_evm_transaction_failed"` |
| M4. Facilitator: rejected before broadcast | 402 | `success:false`, `errorReason:"invalid_exact_evm_payload_signature"`, `transaction:""`, `network`, `payer:"0x11…"` | `success:false`, `network`, `errorReason:"invalid_exact_evm_payload_signature"` |
| M5. Settle ok | 200 | `success:true`, `transaction:"0xab…"`, `network`, `payer:"0x11…"` | `success:true`, `network` |

In all failure cases `type` is `payment.received` and `delivery` is `failed`.
In the record, M1 and M3 differ only in the free-text `errorReason`; the
records for M2 and M4 differ only in that M4 has an `errorReason`. The
receipts M1-M5 become fixtures in `record.test.ts` that replay them through
`buildRecord` (see the implementation plan); the x402 side (status, header
after the abort) is described above from the package sources.

### A transaction hash alone does not prove that money moved

`@x402/evm` 2.29 also returns `success: false` **with** a non-empty
`transaction` when:

*   the transaction was mined but reverted
    (`invalid_exact_evm_transaction_failed`);
*   a pending transfer could not be persisted for the retry: the
    `settlement_pending` result is then rewritten to
    `invalid_exact_evm_transaction_failed` and keeps the hash, so that reason
    can also mean "may still confirm";
*   the receipt did not show the expected transfer event
    (`invalid_exact_evm_transfer_event_mismatch`);
*   the receipt could not be awaited (`settlement_pending`). `@x402/core`
    retries such a settle once.

So a receipt with `success: false` and a transaction can mean "paid, then
aborted by the seller", "paid, outcome still pending" or "broadcast, but no
transfer". Only the chain can tell these apart.

### An empty transaction is not proof either

A receipt with `success: false` and an empty `transaction` asserts that no
transaction was broadcast (v2 §5.3.2). The seller's server cannot always know
that:

*   `@x402/core` 2.29 writes `""` when the call to the facilitator fails with
    a transport error or a non-JSON 5xx answer.
*   `@x402/evm` writes `""` when the signer returned an unusable hash after
    sending.
*   The single retry after `settlement_pending` returns the second answer,
    which can lack the hash of the first broadcast.
*   In flows that settle before the handler, a failed cancellation produces
    `success: false`, `transaction: ""` although the deposit has already
    moved; its hash is only in `extra.depositTransaction`.

Some paths end without any receipt: a facilitator timeout or an invalid 2xx
answer from the facilitator (`FacilitatorResponseError`, 502 from
`@x402/hono`), and any other exception in the `@x402/hono` settle block (402
without `PAYMENT-RESPONSE`).

## Goals

1.  The record tells "`success: false` with a transaction" apart from
    "`success: false` without a transaction", also without `chainCheck`.
2.  Without `chainCheck`, the transaction hash still never leaves the
    middleware, in the record or in the log line.
3.  The ingest contract states how a consumer counts these cases, so that a
    consumer following it does not count a settlement as failed when the
    receipt names a transaction.
4.  The change is additive within `v: 1`. The field is read the same way for
    v1 (`X-PAYMENT-RESPONSE`) and v2 (`PAYMENT-RESPONSE`) receipts. Under v1
    the specification expects an empty `transaction` on failure; a v1 receipt
    with `success: false` and a hash lands in "unresolved" as well.

## Non-Goals

*   No grouping by `errorReason`. Spec v2 §9 asks clients to match error
    conditions by `errorReason` code. The module still does not group by
    code, even for codes the specification defines such as
    `settlement_pending`: a seller's abort reason is free text and can collide
    with them, `@x402/evm` rewrites a pending transfer to
    `invalid_exact_evm_transaction_failed`, and facilitator reasons change
    between versions.
*   No new value for `delivery`. The buyer did not get the resource (status
    402), so `failed` stays correct.
*   No reading of `amount`, `errorMessage` or `extra` from the receipt. They do
    not separate the cases (see Alternative D). This leaves a blind spot for
    cancellation receipts (see Risks).
*   No change to `chainCheck` itself, or to how a collector confirms a
    transaction on-chain.
*   No change to a collector or dashboard that applies the grouping. Per
    contract rule 2, a collector accepts the new field before a module release
    sends it; that work is tracked outside this repository.
*   No use of x402 hooks or imports of `@x402/*` in the module.

## Decisions

### x402 PR #3989 does not affect the module

[x402-foundation/x402#3989](https://github.com/x402-foundation/x402/pull/3989)
changes when `afterVerify` hooks run (now also for `isValid: false`).
`@op8x/analytics` has no dependency on `@x402/*` and registers no hooks. It
reads request and response headers, the status, the matched route and the 402
body, and never any state inside the x402 server or its hooks. A failed
verification still ends in a 402 challenge, which the module records as
before. Which hooks a seller's server runs on the way there does not change
what goes over the wire. No change is needed.

## Design

### The field

`ReceiptInfo` in `packages/analytics/src/types.ts` gets:

```ts
/** Receipt names a transaction; the hash itself only with chainCheck. */
hasTransaction?: boolean;
```

In `buildRecord`, inside the existing `if (decoded)` block, with or without
`chainCheck`:

```ts
receipt.hasTransaction = clean(own(decoded, "transaction")) !== undefined;
```

*   `hasTransaction` reports what the receipt asserts: whether its
    `transaction` field is a non-empty string. It says nothing beyond that.
*   Set whenever the receipt header decodes to an object. A decoded receipt
    without `transaction`, or with an empty, whitespace-only,
    control-characters-only or non-string value, gives `false`. The module has
    read the receipt, so this is a known fact about it, not a default. An
    undecodable receipt (`decodable: false`) has no `hasTransaction`, so the
    field means "unknown" there (contract rule 3: a missing field means
    unknown).
*   `own()` reads own properties only, like the other receipt fields. A
    `__proto__` key in the JSON does not count.
*   Set for `success: true` as well, so the rule has no condition.
*   The hash itself is not kept in any variable outside this expression
    unless `chainCheck` is set; the existing `chainCheck` branch stays as it
    is.

### How a consumer reads the receipt

New section in the ingest contract. The table describes what the receipt
asserts, not the payment state:

| `receipt.success` | `receipt.hasTransaction` | Group | Meaning |
|---|---|---|---|
| `true` | any | settled (reported) | A settlement, cancellation or refund reported as successful. |
| `false` | `false` | failed (reported) | Failure reported, no transaction named. A consumer may count it as failed, as reported by the seller, not as proven on-chain: transport errors to the facilitator also give an empty `transaction`, and in flows that settle before the handler it can follow a completed deposit. |
| `false` | `true` | unresolved | A transaction exists but the receipt reports failure. Covers a seller aborting after a successful transfer, a pending settlement and a reverted transaction. Only an on-chain check can resolve it. |
| `false` | missing | unknown | Record from an older module. |
| missing | any | unknown | |

*   A consumer must not count "unresolved" as a failed payment or as a
    successful one. It shows it as its own group or resolves it on-chain (with
    `chainCheck`). `errorReason` may be shown as text but must not decide the
    group.
*   A `payment.received` record without `receipt` is "unknown", not "failed"
    (for example a 502 after a facilitator timeout).
*   `delivery: failed` together with `success: true` can mean a cancellation
    or refund in a flow that settles before the handler.

### Log line and privacy

*   Without `chainCheck`, the log line from `log: true` contains
    `"hasTransaction":true` or `false` and never the hash.
*   The boolean adds no identifier and no on-chain reference beyond the fields
    already present.
*   README, `chainCheck` row in the options table: "Omitted: the transaction
    hash is never read" becomes "Omitted: the transaction hash is never sent;
    the record only says whether there is one".
*   README, bullet in "What is never collected": the first sentence stays,
    and a second sentence follows it: "Without it the record only says
    whether the receipt names a transaction (`receipt.hasTransaction`)." The
    rest of the bullet, starting at "With `chainCheck: true`", stays
    unchanged.

## Compatibility

*   Additive optional field, `v` stays `1` (contract rule 1: optional,
    additive fields do not change `v`).
*   Contract rule 2: a collector accepts a field before any module release
    sends it. Until then, a collector drops it as an unknown field (rule 5:
    unknown fields are dropped, never refused), so the order of deployment
    cannot break ingestion.
*   The definition of `receipt.success` does not change (rule 4). The
    contract gains new guidance; it did not say before how to count
    `success: false`. Older `success: false` records without the flag count
    as "unknown". If they carry `receipt.transaction` (`chainCheck`), a
    consumer can derive the flag from it. The package is not yet published,
    so few such records exist.
*   v1 receipts (`X-PAYMENT-RESPONSE`) use the same `transaction` field name,
    so the flag works for both versions.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| A seller sends a fake or garbage `transaction` with `success: false`. | The record only says "unresolved", which is the honest reading of such a receipt. Nothing is counted as paid on the strength of the flag. |
| Reverted transactions land in "unresolved" instead of "failed". | Accepted. Without the chain the cases cannot be told apart. The `exact` EVM facilitator simulates at verify, but at settle only with `simulateInSettle`, so between verify and settle a transfer can still revert (balance drained, nonce used). With `chainCheck` these cases resolve. |
| A transport error, timeout or pending retry between seller and facilitator after the broadcast gives `hasTransaction: false` or no receipt at all. | The contract labels `false`/`false` "failed (reported)", not proven, and a `payment.received` record without `receipt` is "unknown", not "failed". |
| Cancellation receipts in flows that settle before the handler: a failed cancellation shows `false`/`false` although the deposit moved; a successful refund shows `success: true`. | Stated in the contract table and notes. The module does not read `extra` (where the deposit hash sits), so it cannot tell these receipts from payment receipts; this is a known blind spot. |
| The flag is mistaken for "paid" by a consumer. | The contract table states the meaning; the field name says "has", not "paid". |
| Reading `transaction` without `chainCheck` weakens the data promise. | The value is reduced to a boolean in one expression and is never stored, logged or sent. A test asserts that the hash does not appear in the serialised record. |
| Cost and scalability. | One boolean per record, no extra I/O or memory beyond the receipt that is already decoded. |

## Alternatives Considered

### Alternative A: classify by `errorReason`

Treat known facilitator reasons as "failed" and everything else as "aborted
after payment". Rejected: the abort reason is free text (even `""`), so a
seller who names its reason like a facilitator reason would be miscounted;
`invalid_exact_evm_transaction_failed` already covers pending transfers; and
every new facilitator reason would need a module release. The result could not
be re-derived from the record.

### Alternative B: always send `transaction`

Rejected. The hash links the record to the buyer's address on-chain. That is
why it sits behind `chainCheck`.

### Alternative C: send a hash or prefix of `transaction`

Rejected. One bit answers the question. A keyed hash would add an identifier
without adding meaning.

### Alternative D: use `amount`, `errorMessage` or `extra`

Rejected. `amount` is present only for some schemes and also on facilitator
failures. `errorMessage` is free text. `extra` depends on the scheme. None of
them marks the abort.

### Alternative E: detect `isAfterSettleAborted`

Rejected. The marker is a non-enumerable symbol on an in-process object, it
does not reach the wire, and reading it would need a dependency on
`@x402/core` and a hook in the seller's server.

## Detailed Implementation Plan

### Target Files to Create/Modify

1.  `packages/analytics/src/types.ts` (Modify): `ReceiptInfo.hasTransaction`
    with the doc comment above.
2.  `packages/analytics/src/record.ts` (Modify): one line in the receipt
    block; `RecordOptions.chainCheck` comment becomes "Include
    receipt.transaction; without it only receipt.hasTransaction is derived".
3.  `packages/analytics/test/record.test.ts` (Modify):
    *   receipts M1-M5 from the table above as fixtures: M1, M2, M3 →
        `hasTransaction: true`; M4 → `false`; M5 → `true`;
    *   missing `transaction`, `""`, `"   "`, control characters only, a
        number and `null` → `false`;
    *   `success: true` with `transaction: ""` → `false`;
    *   undecodable receipt → no `hasTransaction`;
    *   `__proto__` with `transaction` → `false`;
    *   `chainCheck: true` → both `transaction` and `hasTransaction: true`;
    *   the existing test "receipt transaction only with chainCheck; never
        read or serialised by default" is renamed to "… never serialised by
        default" and also checks `hasTransaction: true` while the hash stays
        absent from `JSON.stringify(record)`;
    *   the existing test "receipt v2 and v1, failure fields" gets
        `hasTransaction: true` in its `deepEqual` (its `v2Receipt` fixture has
        a `transaction`);
    *   `X-PAYMENT-RESPONSE` with a transaction → `true`.
4.  `packages/analytics/test/hono.test.ts` (Modify):
    *   one end-to-end case in its own small app with a route that answers
        402 with a `PAYMENT-RESPONSE` like M1, checking the log line contains
        `"hasTransaction":true` and not the hash; `buildApp` stays unchanged;
    *   in the existing `chainCheck` loop against the test collector, also
        assert `receipt.hasTransaction`.
5.  `packages/analytics/docs/ingest-contract.md` (Modify): new row
    `receipt.hasTransaction` (boolean, "with a decodable receipt") in the
    field table, and a new `## Reading the receipt` section between
    `## Fields` and `## Compatibility` with the consumer table and notes from
    "How a consumer reads the receipt".
6.  `packages/analytics/README.md` (Modify): the `chainCheck` row and the
    "What is never collected" bullet, with the texts under "Log line and
    privacy".
7.  `docs/specs/2026-10-25-analytics-hono-design.md` (Modify):
    *   in "Never read or recorded", the item "the receipt's `transaction`
        unless `chainCheck` is true" becomes "the receipt's `transaction`
        unless `chainCheck` is true (only `receipt.hasTransaction` is derived
        from it)";
    *   the sentence "Without `chainCheck` the transaction field is never
        read." becomes "Without `chainCheck` the hash is never sent; only
        `receipt.hasTransaction` is derived from it.";
    *   the `ReceiptInfo` block gains
        `hasTransaction?: boolean;   // whenever the receipt decodes`.
8.  `apps/demo-api/vendor/op8x-analytics-0.0.1.tgz`,
    `apps/demo-api/vendor/SOURCE` and `apps/demo-api/package-lock.json`
    (Modify): repack the module.

The package is not yet published, so the version stays `0.0.1`.

### Order of Work

1.  Tests first (they fail), then `types.ts` and `record.ts`.
2.  Docs (contract, README, earlier spec).
3.  Commit the changes to `packages/analytics`: `pack-analytics` refuses a
    dirty package, and `check-vendor` fails on a dirty pack.
4.  In `apps/demo-api`, run `npm run pack-analytics && npm install
    ./vendor/op8x-analytics-0.0.1.tgz` and commit the result separately.

### Verification Plan

In `packages/analytics`:

```bash
npm run typecheck
npm test
npm run build
```

In `apps/demo-api`, after step 4:

```bash
npm run typecheck
npm run check-vendor
```

Then `node scripts/boundary-check.mjs` at the repository root (it needs
boundary rules from `--rules`, `BOUNDARY_TERMS` or a local `.boundary-rules`).
