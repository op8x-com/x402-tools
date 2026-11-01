import assert from "node:assert/strict";
import { printEscaped, printFull } from "../src/extract.ts";
import { shorten } from "../src/payto.ts";
import type { Finding, Method, PreflightResult, ProbeResult } from "../src/types.ts";

export const v2 = {
  x402Version: 2,
  resource: {
    url: "https://api.example.com/weather",
    description: "Weather data",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
};

export const v1 = {
  x402Version: 1,
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "10000",
      resource: "https://api.example.com/weather",
      description: "Weather data",
      mimeType: "application/json",
      payTo: "0x1111111111111111111111111111111111111111",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      maxTimeoutSeconds: 60,
    },
  ],
};

// The same challenges on Base mainnet with Base USDC, so the testnet and spend findings stay silent.
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const v2main = { ...v2, accepts: [{ ...v2.accepts[0], network: "eip155:8453", asset: BASE_USDC }] };

export const v1main = { ...v1, accepts: [{ ...v1.accepts[0], network: "base", asset: BASE_USDC }] };

export function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function pr(
  method: Method,
  status: number,
  headers: Record<string, string> = {},
  body?: unknown,
): ProbeResult {
  return {
    method,
    url: "https://api.example.com/weather",
    status,
    headers,
    bodyText: body === undefined ? "" : JSON.stringify(body),
    ms: 1,
  };
}

/** Base64 of raw text, for headers that must not decode to JSON (b64 always JSON-encodes its input). */
export function b64raw(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export const pf = (status: number | undefined, headers: Record<string, string> = {}, error?: string): PreflightResult => ({
  method: "OPTIONS",
  url: "https://api.example.com/weather",
  requestMethod: "POST",
  requestHeaders: "payment-signature,content-type",
  headers,
  ms: 1,
  ...(status !== undefined ? { status } : {}),
  ...(error ? { error } : {}),
});

function parsed(text: string): unknown[] {
  try {
    return [JSON.parse(text)];
  } catch {
    // Not JSON: no strings to collect from it; the raw text is collected as a header value or not at all.
    return [];
  }
}

/**
 * Every string the server sent: each header value, and each string value and object key in the parsed
 * PAYMENT-REQUIRED header (base64 JSON) and body of each source. Iterative, so deeply nested values work.
 */
export function sentStrings(...sources: (ProbeResult | PreflightResult)[]): Set<string> {
  const out = new Set<string>();
  const stack: unknown[] = [];
  for (const s of sources) {
    for (const value of Object.values(s.headers)) out.add(value);
    const header = s.headers["payment-required"];
    if (header !== undefined) stack.push(...parsed(Buffer.from(header, "base64").toString("utf8")));
    if (s.method !== "OPTIONS" && s.bodyText) stack.push(...parsed(s.bodyText));
  }
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") {
      out.add(v);
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (typeof v === "object" && v !== null) {
      for (const [key, item] of Object.entries(v)) {
        out.add(key);
        stack.push(item);
      }
    }
  }
  return out;
}

/** A server value as the output helpers print it: double quotes around printable ASCII without quotes or backslash, escapes, the cut mark. */
export const QUOTED = /"(?:[\x20\x21\x23-\x26\x28-\x5B\x5D-\x7E]|\\u\{[0-9A-F]{4,6}\}|\u2026)*"/g;

/**
 * The quoting rule for server values in findings: (i) every quoted span is printEscaped, printFull, printEscaped
 * with 48 (asset and network labels) or the payTo short form of a value the server sent; (ii) no other double quote; (iii) at most 100
 * characters between the quotes, not counting the cut mark; (iv) no two spaces in a row inside quotes;
 * (v) no fix contains a double quote.
 */
export function assertQuoting(findings: Finding[], sent: Set<string>): void {
  const accepted = new Set<string>();
  for (const v of sent) {
    accepted.add(printEscaped(v));
    accepted.add(printFull(v));
    accepted.add(printEscaped(v, 48));
    const short = shorten(v);
    if (short.startsWith('"')) accepted.add(short);
  }
  for (const f of findings) {
    for (const [field, value] of Object.entries(f)) {
      if (typeof value !== "string") continue;
      const where = `${f.id} ${field}`;
      for (const span of value.match(QUOTED) ?? []) {
        assert.ok(accepted.has(span), `${where}: quoted span is not a printed server value: ${span}`);
        assert.ok(span.slice(1, -1).replaceAll("\u2026", "").length <= 100, `${where}: quoted span too long: ${span}`);
        assert.ok(!span.includes("  "), `${where}: two spaces in a row: ${span}`);
      }
      assert.ok(!value.replace(QUOTED, "").includes('"'), `${where}: double quote outside a quoted server value: ${value}`);
    }
    assert.ok(!(f.fix ?? "").includes('"'), `${f.id}: fix contains a double quote: ${f.fix}`);
  }
}
