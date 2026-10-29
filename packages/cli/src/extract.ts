import { x402HTTPClient } from "@x402/core/http";
import type { Extracted, OfficialRead, ProbeResult } from "./types.ts";

// Same regex and decoding steps as decodePaymentRequiredHeader in @x402/core:
// Base64EncodedRegex, then atob and TextDecoder (which drops a leading BOM).
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeHeader(raw: string): { value?: unknown; error?: "not-base64" | "not-json" } {
  if (!BASE64.test(raw)) return { error: "not-base64" };
  let text: string;
  try {
    const binary = atob(raw);
    text = new TextDecoder("utf-8").decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch {
    return { error: "not-base64" };
  }
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
  const out: Omit<Extracted, "official"> = {
    method: p.method,
    status: p.status,
    error: p.error,
    headers: { ...p.headers },
    location: "none",
    cacheControl: p.headers["cache-control"],
    redirectTo: p.headers["location"],
    allowOrigin: p.headers["access-control-allow-origin"],
    exposeHeaders: p.headers["access-control-expose-headers"],
    allowCredentials: p.headers["access-control-allow-credentials"],
  };

  const headerRaw = p.headers["payment-required"];
  if (headerRaw === "") {
    out.headerEmpty = true;
  } else if (headerRaw !== undefined) {
    out.headerRaw = headerRaw;
    const decoded = decodeHeader(headerRaw);
    if (decoded.error) out.headerError = decoded.error;
    else out.header = decoded.value;
  }

  // A cut-off body is not valid JSON for the official client either (it reads up to 1 MiB, we read less).
  if (p.bodyText && !p.bodyTruncated) {
    try {
      // Like fetch().json(), ignore a leading UTF-8 byte order mark.
      out.body = JSON.parse(p.bodyText.replace(/^\uFEFF/, ""));
    } catch {
      // Not JSON (e.g. an HTML paywall); not a challenge.
    }
  }
  if (looksLikeChallenge(out.body)) out.bodyChallenge = out.body;

  const inHeader = out.headerRaw !== undefined;
  const inBody = out.bodyChallenge !== undefined;
  out.location = inHeader && inBody ? "both" : inHeader ? "header" : inBody ? "body" : "none";
  out.challenge = out.header ?? out.bodyChallenge;
  out.version = versionOf(out.challenge);
  return { ...out, official: officialClientRead(out) };
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

const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** Report-safe text of a thrown value: no control, format or line-separator characters, at most 200 characters. */
export function cleanReason(thrown: unknown): string {
  const message = thrown instanceof Error ? thrown.message : "";
  const clean = Array.from(message.replace(UNSAFE, "").trim().replace(/\.$/, "")).slice(0, 200).join("");
  return clean || "unknown error";
}

// Created on first use, inside the try below, so a changed constructor cannot crash the CLI at load time.
let client: x402HTTPClient | undefined;

/**
 * Asks x402HTTPClient.getPaymentRequiredResponse of the installed @x402/core whether it can read
 * the challenge. The own decoder above only explains failures; this call decides them.
 */
export function officialClientRead(e: Pick<Extracted, "headers" | "body">): OfficialRead {
  try {
    client ??= new x402HTTPClient({} as never);
    const result: unknown = client.getPaymentRequiredResponse((name) => e.headers[name.toLowerCase()], e.body);
    return isObject(result) ? { readable: true } : { readable: false, reason: "challenge is not a JSON object" };
  } catch (err) {
    return { readable: false, reason: cleanReason(err) };
  }
}
