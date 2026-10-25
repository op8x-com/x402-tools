import type { Extracted, ProbeResult } from "./types.ts";

// Same rule as the official decoder in @x402/core: standard base64 only.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeHeader(raw: string): { value?: unknown; error?: "not-base64" | "not-json" } {
  if (!BASE64.test(raw)) return { error: "not-base64" };
  const text = Buffer.from(raw, "base64").toString("utf8");
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "not-json" };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeChallenge(v: unknown): boolean {
  return isObject(v) && ("x402Version" in v || Array.isArray(v.accepts));
}

function versionOf(v: unknown): 1 | 2 | undefined {
  if (!isObject(v)) return undefined;
  return v.x402Version === 1 || v.x402Version === 2 ? v.x402Version : undefined;
}

export function extract(p: ProbeResult): Extracted {
  const out: Extracted = {
    method: p.method,
    status: p.status,
    error: p.error,
    location: "none",
    cacheControl: p.headers["cache-control"],
    redirectTo: p.headers["location"],
    allowOrigin: p.headers["access-control-allow-origin"],
    exposeHeaders: p.headers["access-control-expose-headers"],
    allowCredentials: p.headers["access-control-allow-credentials"],
  };

  const headerRaw = p.headers["payment-required"];
  if (headerRaw !== undefined) {
    out.headerRaw = headerRaw;
    const decoded = decodeHeader(headerRaw);
    if (decoded.error) out.headerError = decoded.error;
    else out.header = decoded.value;
  }

  if (p.bodyText) {
    try {
      out.body = JSON.parse(p.bodyText);
    } catch {
      // Not JSON (e.g. an HTML paywall); not a challenge.
    }
  }
  if (looksLikeChallenge(out.body)) out.bodyChallenge = out.body;

  const inHeader = headerRaw !== undefined;
  const inBody = out.bodyChallenge !== undefined;
  out.location = inHeader && inBody ? "both" : inHeader ? "header" : inBody ? "body" : "none";
  out.challenge = out.header ?? out.bodyChallenge;
  out.version = versionOf(out.challenge);
  return out;
}

/** Takes the CORS headers from the browser-like probe of the same method. */
export function withBrowserView(e: Extracted, browser: ProbeResult): Extracted {
  return {
    ...e,
    allowOrigin: browser.headers["access-control-allow-origin"],
    exposeHeaders: browser.headers["access-control-expose-headers"],
    allowCredentials: browser.headers["access-control-allow-credentials"],
    ...(browser.status !== undefined ? { originStatus: browser.status } : {}),
    ...(browser.error ? { originError: browser.error } : {}),
  };
}

/**
 * Mirrors x402HTTPClient.getPaymentRequiredResponse in @x402/core 2.28:
 * header first; without a header, only a v1 body is accepted.
 */
export function officialClientCanRead(e: Extracted): boolean {
  if (e.headerRaw !== undefined) return e.header !== undefined;
  return isObject(e.bodyChallenge) && e.bodyChallenge.x402Version === 1;
}
