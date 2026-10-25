export interface AnalyticsOptions {
  /** https URL (http allowed only for localhost/127.0.0.1); omitted = no network sends. */
  endpoint?: string;
  /** Default false; one console.log line per record. */
  log?: boolean;
  /** Enables payer hashing; omitted = no payer field at all. */
  salt?: string;
  /** Default 2000, clamped to 100..10000. */
  timeoutMs?: number;
}

export type UaClass =
  | "x402-client"
  | "axios"
  | "node"
  | "python"
  | "go"
  | "curl"
  | "browser"
  | "op8x"
  | "none"
  | "other";

export interface ChallengeInfo {
  location: "header" | "body" | "both" | "none";
  version?: 1 | 2;
  /** Both present and the decoded objects differ. */
  drift?: boolean;
  /** The challenge's "error" field. */
  error?: string;
  /** Max 5 entries. */
  accepts?: Array<{ scheme?: string; network?: string; amount?: string; asset?: string }>;
}

export interface PaymentInfo {
  header: "PAYMENT-SIGNATURE" | "X-PAYMENT";
  decodable: boolean;
  version?: 1 | 2;
  scheme?: string;
  network?: string;
  /** v2 accepted.amount */
  amount?: string;
  asset?: string;
  /** Hex HMAC-SHA-256(salt, lowercase address), first 32 hex chars; only with salt. */
  payer?: string;
}

export interface ReceiptInfo {
  header: "PAYMENT-RESPONSE" | "X-PAYMENT-RESPONSE";
  decodable: boolean;
  success?: boolean;
  transaction?: string;
  network?: string;
  errorReason?: string;
}

export interface AnalyticsRecord {
  v: 1;
  /** crypto.randomUUID(), correlates future events of the same request. */
  id: string;
  /** ISO 8601, start of request. */
  ts: string;
  /** Time spent downstream of the middleware. */
  ms: number;
  /** GET, POST, ... */
  method: string;
  /** Matched route pattern, e.g. "/posts/:id"; "" when none matched. */
  route: string;
  /** Final response status. */
  status: number;
  ua: UaClass;
  type: "request.unpaid" | "challenge.issued" | "payment.received";
  /** Present when status is 402. */
  challenge?: ChallengeInfo;
  /** Present when a payment header was sent. */
  payment?: PaymentInfo;
  /** Present when a receipt header was returned. */
  receipt?: ReceiptInfo;
  /** Present with payment: status < 400 -> ok, else failed. */
  delivery?: "ok" | "failed";
}
