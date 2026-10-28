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

Record format version `1`. Strings are trimmed, stripped of control characters (including Unicode bidi controls) and capped at 128 characters (256 for `challenge.error` and `receipt.errorReason`) before they are sent. A field the module cannot determine is omitted, never guessed.

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
| `payment.payer` | string | with the `salt` option | First 32 hex characters (lowercase) of HMAC-SHA-256 over the lowercase payer address, keyed with the seller's salt. |
| `receipt` | object | with a receipt header | The receipt the seller returned. |
| `receipt.header` | string | with `receipt` | `PAYMENT-RESPONSE` or `X-PAYMENT-RESPONSE`. |
| `receipt.decodable` | boolean | with `receipt` | Whether the header could be decoded. |
| `receipt.success` | boolean | when known | The receipt's `success` field. |
| `receipt.network` | string | when known | Network of the settlement. |
| `receipt.errorReason` | string | when present | The receipt's `errorReason` field. |
| `receipt.transaction` | string | with the `chainCheck` option | Public transaction hash, so the collector can confirm settlement on-chain. A collector uses it only for that check and does not keep it. |
| `delivery` | string | with `payment` | `ok` when the final status is below 400, else `failed`. |

## Compatibility

1. Optional, additive fields do not change `v`.
2. A collector accepts a field before any module release sends it; until it does, the collector drops that field.
3. A missing field means "unknown". A collector never reads it as false or as a default.
4. The meaning of an existing field never changes within `v: 1`. A new meaning needs a new field name.
5. Unknown fields are dropped, never refused.
