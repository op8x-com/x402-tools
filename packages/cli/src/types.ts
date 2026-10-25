export type Method = "GET" | "POST";
export type Level = "error" | "warn" | "info" | "pass";

export interface Finding {
  id: string;
  level: Level;
  method: Method | "OPTIONS" | "both";
  title: string;
  detail: string;
  fix?: string;
}

export interface ProbeResult {
  method: Method;
  url: string;
  status?: number;
  /** Response headers, keys lower-cased. */
  headers: Record<string, string>;
  bodyText: string;
  ms: number;
  /** Set when the request failed at network level (DNS, TLS, timeout). */
  error?: string;
  /** Origin header sent, for the browser-like probe that follows a 402. */
  origin?: string;
}

/** The CORS preflight sent after the probes, as a browser would before the paid retry. */
export interface PreflightResult {
  method: "OPTIONS";
  url: string;
  /** Sent as Access-Control-Request-Method. */
  requestMethod: Method;
  /** Sent as Access-Control-Request-Headers (comma-separated, lower-case). */
  requestHeaders: string;
  status?: number;
  /** Response headers, keys lower-cased. */
  headers: Record<string, string>;
  ms: number;
  error?: string;
}

export type Location = "header" | "body" | "both" | "none";

export interface Extracted {
  method: Method;
  status?: number;
  error?: string;
  /** Raw PAYMENT-REQUIRED header value, if present. */
  headerRaw?: string;
  headerError?: "not-base64" | "not-json";
  /** Decoded PAYMENT-REQUIRED header JSON. */
  header?: unknown;
  /** Parsed JSON body, if the body is JSON. */
  body?: unknown;
  /** The body, if it looks like a challenge (has x402Version or accepts[]). */
  bodyChallenge?: unknown;
  /** Where a challenge was found; a present-but-broken header counts as "header". */
  location: Location;
  /** The challenge a client would act on: decoded header, else body challenge. */
  challenge?: unknown;
  version?: 1 | 2;
  cacheControl?: string;
  redirectTo?: string;
  allowOrigin?: string;
  exposeHeaders?: string;
  allowCredentials?: string;
  /** Status of the same request sent with an Origin header, when that probe ran. */
  originStatus?: number;
  originError?: string;
}
