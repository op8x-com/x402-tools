# Ingest contract

> **Pre-release.** This contract may still change until the first npm release of `@op8x/analytics`.

This is the single description of what `@op8x/analytics` sends to a collector, and of what a collector that accepts these records has to do. It applies to the op8x collector at `https://ingest.op8x.com/v1/events` and to any collector you run yourself.

## Request

One record per request, as one JSON object in the body of a `POST`. No batching, no retries.

```
POST /v1/events
content-type: application/json
user-agent: op8x-analytics/<version>
authorization: Bearer <key>
```

| Header | When |
| --- | --- |
| `content-type` | Always, `application/json`. |
| `user-agent` | Always, `op8x-analytics/<version>`. |
| `authorization` | `Bearer <key>` when the module has a key: the `key` option, or for the endpoint origin `https://ingest.op8x.com` only, `OP8X_KEY` from the Worker environment. Surrounding whitespace in the key is trimmed. Other endpoints without the `key` option get no `authorization` header. |

The Workers runtime itself may add a `cf-worker` header. Redirects are not followed, so the request and its `authorization` header reach exactly the configured URL. The body is at most 16 KB (16384 bytes); a collector may refuse larger bodies with `413`.

For the op8x collector a key starts with `op8x_w_`. The module checks only the shape (a string of printable ASCII, at most 256 characters, the prefix for the op8x endpoint) and sends nothing for a missing or malformed key. The collector checks the rest.

## Response

| Status | Meaning |
| --- | --- |
| `202` | Accepted (also for a record whose `id` was already received). |
| `400` | Not a JSON object, or an unusable record: `v` is not `1`, `type` is not one of the three types, `id` is not a UUID, or a field has the wrong JSON type. Over-long strings and unknown values are not refused. |
| `401` | Missing or unknown key. |
| `413` | Body too large. |
| `429` | The collector does not accept records right now. |
| `503` | The collector is temporarily unavailable. |

Every response has an empty body. The module ignores the status: it never changes the seller's response and writes at most one warning per minute per kind of failure, such as `op8x.analytics: send failed (status 401)`. The warning never contains the key or record data.

## Fields

Record format version `1`. Strings are trimmed, stripped of the Unicode categories Cc, Cf, Cs, Zl and Zp (control characters, format characters such as bidi controls, U+200B and U+2060, lone surrogates, line and paragraph separators) and capped at 128 UTF-16 code units (256 for `challenge.error` and `receipt.errorReason`) without splitting a surrogate pair before they are sent. A field the module cannot determine is omitted, never guessed.

A collector may store a `scheme`, `network` or `asset` value that does not have the usual shape (a scheme name, a CAIP-2 or v1 network name, a token address) as `other`, and may drop an `amount` that is not an integer in the asset's smallest unit.

| JSON path | Type | Sent | Meaning |
| --- | --- | --- | --- |
| `v` | number | always | Record format version, `1`. |
| `id` | string | always | Random UUID per request. |
| `ts` | string | always | ISO 8601 time the request started, UTC, with milliseconds. |
| `ms` | number | always | Time spent downstream of the middleware, in milliseconds. |
| `method` | string | always | HTTP method, such as `GET`. |
| `route` | string | always | Pattern of the matched route, such as `/posts/:id`; `""` when none matched. Never the concrete path. |
| `status` | number | always | Final response status. |
| `ua` | string | always | User-Agent class: `x402-client`, `axios`, `node`, `python`, `go`, `curl`, `browser`, `op8x`, `none` or `other`. The raw header is never sent. |
| `type` | string | always | `payment.received` when the request carried a payment header, else `challenge.issued` for a 402, else `request.unpaid`. |
| `challenge` | object | status 402 | The 402 challenge. |
| `challenge.location` | string | with `challenge` | `header`, `body`, `both` or `none`. |
| `challenge.version` | number | when known | `1` or `2`. |
| `challenge.drift` | boolean | when known | Header and body challenges both present and different. |
| `challenge.error` | string | when present | The challenge's `error` field. |
| `challenge.accepts` | array | when present | At most 5 objects with the string keys `scheme`, `network`, `amount`, `asset`, each only when present. |
| `payment` | object | with a payment header | The payment the buyer sent. |
| `payment.header` | string | with `payment` | `PAYMENT-SIGNATURE` or `X-PAYMENT`. |
| `payment.decodable` | boolean | with `payment` | Whether the header could be decoded. |
| `payment.version` | number | when known | `1` or `2`. |
| `payment.scheme` | string | when known | Payment scheme, such as `exact`. |
| `payment.network` | string | when known | Network of the payment. |
| `payment.amount` | string | when known | Amount of the payment (v2). |
| `payment.asset` | string | when known | Asset of the payment. |
| `payment.payer` | string | with a valid `salt` option | First 32 hex characters (lowercase) of HMAC-SHA-256 keyed with the seller's salt. See "Payer pseudonym". |
| `payment.payer_alg` | string | with `payment.payer` | `op8x.payer.v1`, the construction of `payment.payer`. Sent by the module from the next version on. |
| `payment.payer_salt_id` | string | with `payment.payer` | 8 lowercase hex characters identifying the salt, so series made with different salts are not mixed. Sent by the module from the next version on. |
| `receipt` | object | with a receipt header | The receipt the seller returned. |
| `receipt.header` | string | with `receipt` | `PAYMENT-RESPONSE` or `X-PAYMENT-RESPONSE`. |
| `receipt.decodable` | boolean | with `receipt` | Whether the header could be decoded. |
| `receipt.success` | boolean | when known | The receipt's `success` field. |
| `receipt.hasTransaction` | boolean | with a decodable receipt | Whether the receipt's `transaction` is a non-empty string after trimming and removing control characters. The hash itself is sent only with `chainCheck`. See "Reading the receipt". |
| `receipt.network` | string | when known | Network of the settlement. |
| `receipt.errorReason` | string | when present | The receipt's `errorReason` field. |
| `receipt.transaction` | string | with the `chainCheck` option | Public transaction hash, so the collector can confirm settlement on-chain. A collector uses it only for that check and does not keep it. |
| `delivery` | string | with `payment` | `ok` when the final status is below 400, else `failed`. |
| `test_nonce` | string | with a valid `op8x-test` header | Value of the request header `op8x-test`, sent only when it is exactly 43 base64url characters. See "Connection test nonce". |

## Payer pseudonym

- `payment.payer`, `payment.payer_alg` and `payment.payer_salt_id` belong together. A consumer counts a pseudonym only when all three are present.
- The salt is a string of the form `op8x_s_` followed by 43 base64url characters (`A-Z`, `a-z`, `0-9`, `-`, `_`), which decode to exactly 32 bytes. The encoding must be canonical: encoding the 32 bytes again gives the same string. Any other value is not a salt and disables payer hashing.
- Key: the 32 decoded bytes. `payment.payer` is the first 32 lowercase hex characters of HMAC-SHA-256 over the UTF-8 bytes of `op8x.payer.v1`, one `0x00` byte, and the payer address. The address is trimmed; it is lowercased only when it matches `0x` plus 40 hex digits (EVM). Other addresses, such as Solana, keep their case, because their case is significant.
- `payment.payer_salt_id` is the first 8 lowercase hex characters of HMAC-SHA-256 over the UTF-8 bytes of `op8x.salt-id.v1`, keyed with the same 32 bytes. It tells salts apart and reveals nothing usable about the salt.
- Test vectors (salts, salt ids, addresses, pseudonyms, and invalid salts) are in [`payer-hash-vectors.json`](payer-hash-vectors.json). An implementation must reproduce every one.
- The salt never leaves the seller's server. Only the pseudonym, the algorithm name and the salt id are sent.
- Changing the salt starts a new pseudonym series: the same payer then gets a different `payment.payer` and a different `payment.payer_salt_id`.

## Connection test nonce

- The module sends `test_nonce` only when the request header `op8x-test` consists of exactly 43 characters from `A-Z`, `a-z`, `0-9`, `_` and `-`. Padding (`=`), `+`, `/`, other lengths and repeated headers are never sent. The value is sent as the Fetch `Headers` API returns it (without surrounding whitespace) and is not shortened or otherwise changed.
- A valid nonce lets the collector take the event out of the count once. The field is only valid when the collector issued the nonce; otherwise it is ignored.
- The field is always a string. A collector rejects any other type with `400 bad_field_type`.
- The name is snake_case, unlike the camelCase names of the other fields. It is fixed by this format.
- Compatibility: new in 0.0.2. Older module versions do not send the field and count the request normally.
- It is unrelated to a collector-side `purchase_class` of `test` or `probe`.

## Reading the receipt

The table describes what the receipt asserts, not the payment state.

| `receipt.success` | `receipt.hasTransaction` | Group | Meaning |
|---|---|---|---|
| `true` | any | settled (reported) | A settlement, cancellation or refund reported as successful. |
| `false` | `false` | failed (reported) | Failure reported, no transaction named. A consumer may count it as failed, as reported by the seller, not as proven on-chain: transport errors to the facilitator also give an empty `transaction`, and in flows that settle before the handler it can follow a completed deposit. |
| `false` | `true` | unresolved | A transaction exists but the receipt reports failure. Covers a seller aborting after a successful transfer, a pending settlement and a reverted transaction. Only an on-chain check can resolve it. |
| `false` | missing | unknown | Record from an older module. |
| missing | any | unknown | No `success` field in the receipt, or the receipt did not decode. |

- A consumer must not count "unresolved" as a failed payment or as a successful one. It shows it as its own group or resolves it on-chain (with `chainCheck`). `errorReason` may be shown as text but must not decide the group.
- A `payment.received` record without `receipt` is "unknown", not "failed" (for example a 502 after a facilitator timeout).
- `delivery: failed` together with `success: true` can mean a cancellation or refund in a flow that settles before the handler.

## Compatibility

1. Optional, additive fields do not change `v`.
2. A collector accepts a field before any module release sends it; until it does, the collector drops that field.
3. A missing field means "unknown". A collector never reads it as false or as a default.
4. The meaning of an existing field never changes within `v: 1`. A new meaning needs a new field name.
5. Unknown fields are dropped, never refused.
