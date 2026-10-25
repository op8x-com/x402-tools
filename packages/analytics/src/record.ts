import { clean, decodeBase64Json, parseJson } from "./decode.ts";
import { uaClass } from "./ua.ts";
import type { AnalyticsRecord, ChallengeInfo, PaymentInfo, ReceiptInfo } from "./types.ts";

export interface RecordInput {
  id: string;
  ts: string;
  ms: number;
  method: string;
  route: string;
  status: number;
  requestHeaders: Headers;
  responseHeaders: Headers;
  /** 402 body copy, already capped at 64 KB. */
  body?: string;
}

type Obj = Record<string, unknown>;

const MAX_ACCEPTS = 5;
const LONG = 256;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(obj: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function version(value: unknown): 1 | 2 | undefined {
  return value === 1 || value === 2 ? value : undefined;
}

/** Structural equality for decoded JSON; key order does not matter. */
const MAX_DEPTH = 32;

/** Beyond MAX_DEPTH the values are treated as different (hostile nesting). */
function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i], depth + 1));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k], depth + 1));
  }
  return false;
}

function buildChallenge(headers: Headers, body: string | undefined): ChallengeInfo {
  const fromHeader = decodeBase64Json(headers.get("payment-required"));
  let fromBody: Obj | undefined;
  if (typeof body === "string") {
    const parsed = parseJson(body);
    if (parsed !== undefined && typeof own(parsed, "x402Version") === "number") fromBody = parsed;
  }
  const used = fromHeader ?? fromBody;
  if (used === undefined) return { location: "none" };

  const info: ChallengeInfo = {
    location: fromHeader && fromBody ? "both" : fromHeader ? "header" : "body",
  };
  const v = version(own(used, "x402Version"));
  if (v !== undefined) info.version = v;
  if (fromHeader && fromBody) {
    try {
      info.drift = !deepEqual(fromHeader, fromBody);
    } catch {
      // omit drift
    }
  }
  const error = clean(own(used, "error"), LONG);
  if (error !== undefined) info.error = error;

  const list = own(used, "accepts");
  if (Array.isArray(list)) {
    const accepts: NonNullable<ChallengeInfo["accepts"]> = [];
    for (const entry of list) {
      if (accepts.length >= MAX_ACCEPTS) break;
      if (!isObj(entry)) continue;
      const item: NonNullable<ChallengeInfo["accepts"]>[number] = {};
      const scheme = clean(own(entry, "scheme"));
      const network = clean(own(entry, "network"));
      const amount = clean(own(entry, "amount") ?? own(entry, "maxAmountRequired"));
      const asset = clean(own(entry, "asset"));
      if (scheme !== undefined) item.scheme = scheme;
      if (network !== undefined) item.network = network;
      if (amount !== undefined) item.amount = amount;
      if (asset !== undefined) item.asset = asset;
      if (Object.keys(item).length > 0) accepts.push(item);
    }
    if (accepts.length > 0) info.accepts = accepts;
  }
  return info;
}

function authorizationFrom(payload: Obj | undefined): string | undefined {
  if (!payload) return undefined;
  const inner = own(payload, "payload");
  if (!isObj(inner)) return undefined;
  const auth = own(inner, "authorization");
  if (!isObj(auth)) return undefined;
  const from = own(auth, "from");
  return typeof from === "string" ? from : undefined;
}

export async function buildRecord(
  input: RecordInput,
  hashPayer?: (address: string) => Promise<string>,
): Promise<AnalyticsRecord> {
  const { requestHeaders: req, responseHeaders: res, status } = input;

  const sig = req.get("payment-signature");
  const legacy = req.get("x-payment");
  const paymentHeader: PaymentInfo["header"] | undefined =
    sig !== null ? "PAYMENT-SIGNATURE" : legacy !== null ? "X-PAYMENT" : undefined;

  const record: AnalyticsRecord = {
    v: 1,
    id: input.id,
    ts: input.ts,
    ms: input.ms,
    method: clean(input.method) ?? "",
    route: clean(input.route) ?? "",
    status,
    ua: uaClass(req.get("user-agent")),
    type:
      paymentHeader !== undefined
        ? "payment.received"
        : status === 402
          ? "challenge.issued"
          : "request.unpaid",
  };

  if (status === 402) record.challenge = buildChallenge(res, input.body);

  // Receipt first: its payer takes precedence for hashing.
  const receiptRaw = res.get("payment-response");
  const legacyReceiptRaw = res.get("x-payment-response");
  let receiptPayer: string | undefined;
  const receiptHeader: ReceiptInfo["header"] | undefined =
    receiptRaw !== null ? "PAYMENT-RESPONSE" : legacyReceiptRaw !== null ? "X-PAYMENT-RESPONSE" : undefined;
  const receiptValue = receiptRaw ?? legacyReceiptRaw;
  if (receiptHeader !== undefined) {
    const decoded = decodeBase64Json(receiptValue);
    const receipt: ReceiptInfo = { header: receiptHeader, decodable: decoded !== undefined };
    if (decoded) {
      const success = own(decoded, "success");
      if (typeof success === "boolean") receipt.success = success;
      const transaction = clean(own(decoded, "transaction"));
      if (transaction !== undefined) receipt.transaction = transaction;
      const network = clean(own(decoded, "network"));
      if (network !== undefined) receipt.network = network;
      const errorReason = clean(own(decoded, "errorReason"), LONG);
      if (errorReason !== undefined) receipt.errorReason = errorReason;
      const p = own(decoded, "payer");
      if (typeof p === "string" && p.trim() !== "") receiptPayer = p.trim();
    }
    record.receipt = receipt;
  }

  if (paymentHeader !== undefined) {
    const decoded = decodeBase64Json(paymentHeader === "PAYMENT-SIGNATURE" ? sig : legacy);
    const payment: PaymentInfo = { header: paymentHeader, decodable: decoded !== undefined };
    if (decoded) {
      const v = version(own(decoded, "x402Version"));
      if (v !== undefined) payment.version = v;
      const accepted = own(decoded, "accepted");
      const src = isObj(accepted) ? accepted : decoded;
      const scheme = clean(own(src, "scheme"));
      const network = clean(own(src, "network"));
      const amount = isObj(accepted) ? clean(own(accepted, "amount")) : undefined;
      const asset = clean(own(src, "asset"));
      if (scheme !== undefined) payment.scheme = scheme;
      if (network !== undefined) payment.network = network;
      if (amount !== undefined) payment.amount = amount;
      if (asset !== undefined) payment.asset = asset;

      const fromAuth = authorizationFrom(decoded);
      const payer = receiptPayer ?? (fromAuth !== undefined && fromAuth.trim() !== "" ? fromAuth.trim() : undefined);
      if (hashPayer !== undefined && payer !== undefined) {
        try {
          const hashed = await hashPayer(payer.toLowerCase());
          if (typeof hashed === "string" && hashed !== "") payment.payer = hashed;
        } catch {
          // omit payer; never fail the record
        }
      }
    }
    record.payment = payment;
    record.delivery = status < 400 ? "ok" : "failed";
  }

  return record;
}
