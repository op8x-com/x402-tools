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

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeChallenge(v: unknown): boolean {
  return isObject(v) && ("x402Version" in v || Array.isArray(v.accepts));
}

/** The header is present, not empty, and decodes to JSON of any type. */
export function headerDecoded(e: Pick<Extracted, "headerRaw" | "headerError">): boolean {
  return e.headerRaw !== undefined && e.headerError === undefined;
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
    ...(p.bodyError !== undefined ? { bodyError: p.bodyError } : {}),
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

  // On a body error bodyText is empty, so nothing is parsed.
  if (p.bodyText) {
    try {
      // The decoder in readLimitedText already dropped one BOM, as it does for @x402/fetch; strip nothing more.
      out.body = JSON.parse(p.bodyText);
    } catch {
      // Not JSON (e.g. an HTML paywall); not a challenge.
    }
  }
  if (looksLikeChallenge(out.body)) out.bodyChallenge = out.body;

  const inHeader = out.headerRaw !== undefined;
  const inBody = out.bodyChallenge !== undefined;
  out.location = inHeader && inBody ? "both" : inHeader ? "header" : inBody ? "body" : "none";
  // A decoded header wins even when it is not an object (or null), as in the official client.
  out.challenge = headerDecoded(out) ? out.header : out.bodyChallenge;
  out.version = versionOf(out.challenge);
  return { ...out, official: officialClientRead(out) };
}

/** Takes the CORS headers, the challenge and the version from the browser-like probe of the same method. */
export function withBrowserView(e: Extracted, browser: ProbeResult): Extracted {
  const repeat = extract(browser);
  return {
    ...e,
    allowOrigin: browser.headers["access-control-allow-origin"],
    exposeHeaders: browser.headers["access-control-expose-headers"],
    allowCredentials: browser.headers["access-control-allow-credentials"],
    ...(browser.status !== undefined ? { originStatus: browser.status } : {}),
    ...(browser.error ? { originError: browser.error } : {}),
    ...(repeat.challenge !== undefined ? { originChallenge: repeat.challenge } : {}),
    ...(repeat.version !== undefined ? { originVersion: repeat.version } : {}),
  };
}

const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** Report-safe text: no control, format or line-separator characters, at most `max` code points. */
export function cleanText(text: string, max: number): string {
  return Array.from(text.replace(UNSAFE, "").trim()).slice(0, max).join("");
}

/** Every control, format, surrogate and line-separator character as \u{XXXX}; everything else, the backslash too, as is. */
export function neutralize(text: string): string {
  return text.replace(UNSAFE, (c) => escapeChar(c));
}

const MAX_PRINTED = 100;

/** One code point as printed: printable ASCII except the backslash as is, everything else as \u{XXXX}. */
export function escapeChar(c: string): string {
  const cp = c.codePointAt(0) ?? 0;
  return cp >= 0x20 && cp <= 0x7e && cp !== 0x5c ? c : `\\u{${cp.toString(16).toUpperCase().padStart(4, "0")}}`;
}

/**
 * One code point of a server value inside double quotes: as escapeChar, and also both quote characters and
 * a space after a space, so the value cannot close its quotes, imitate the CLI's single quotes or pad a line.
 */
export function escapeInQuotes(c: string, previous: string | undefined): string {
  if (c === '"') return "\\u{0022}";
  if (c === "'") return "\\u{0027}";
  if (c === " " && previous === " ") return "\\u{0020}";
  return escapeChar(c);
}

/**
 * A server value printed in full for comparison (see docs/solutions/2026-10-31-printed-server-values-look-alike.md):
 * cleaned, then in double quotes, escaped with escapeInQuotes, at most `max` printed characters, a cut marked
 * with an ellipsis. A value empty after cleaning prints as (empty) without quotes.
 */
export function printFull(value: string, max = MAX_PRINTED): string {
  const chars = Array.from(cleanText(value, max));
  if (chars.length === 0) return "(empty)";
  // cleanText stops at max characters; asking for one more shows whether it cut anything.
  return escapeCapped(chars, Array.from(cleanText(value, max + 1)).length > max, max);
}

/**
 * A server value printed next to a value the CLI prints itself, or reported as wrong: like printFull, but
 * nothing is removed or trimmed, so characters that cleanText drops (U+00A0, U+200B, U+2060) show as
 * \u{XXXX} and the two cannot look the same. An empty value prints as "".
 */
export function printEscaped(value: string, max = MAX_PRINTED): string {
  const chars = Array.from(value);
  return escapeCapped(chars.slice(0, max), chars.length > max, max);
}

// Escapes chars with escapeInQuotes up to max printed characters (an escape is never split) and puts them in
// double quotes; a cut is marked with an ellipsis before the closing quote.
function escapeCapped(chars: string[], cutBefore: boolean, max: number): string {
  let cut = cutBefore;
  let text = "";
  let used = 0;
  let previous: string | undefined;
  for (const c of chars) {
    const e = escapeInQuotes(c, previous);
    const n = Array.from(e).length;
    if (used + n > max) {
      cut = true;
      break;
    }
    text += e;
    used += n;
    previous = c;
  }
  return cut ? `"${text}\u2026"` : `"${text}"`;
}

/** Report-safe text of a thrown value, at most 200 characters. */
export function cleanReason(thrown: unknown): string {
  const message = thrown instanceof Error ? thrown.message : "";
  return cleanText(message.replace(UNSAFE, "").trim().replace(/\.$/, ""), 200) || "unknown error";
}

// Created on first use, inside the try below, so a changed constructor cannot crash the CLI at load time.
let client: x402HTTPClient | undefined;

/**
 * Asks x402HTTPClient.getPaymentRequiredResponse of the installed @x402/core whether it can read
 * the challenge. The own decoder above only explains failures; this call decides them.
 */
export function officialClientRead(e: Pick<Extracted, "headers" | "body" | "bodyError">): OfficialRead {
  // @x402/fetch reads the body (readLimitedText) before it looks at the header, outside any try.
  if (e.bodyError !== undefined) return { readable: false, reason: cleanReason(new Error(e.bodyError)) };
  try {
    client ??= new x402HTTPClient({} as never);
    const result: unknown = client.getPaymentRequiredResponse((name) => e.headers[name.toLowerCase()], e.body);
    return isObject(result) ? { readable: true } : { readable: false, reason: "challenge is not a JSON object" };
  } catch (err) {
    // The JSON.parse message quotes the decoded header text, which the server controls.
    if (err instanceof SyntaxError) return { readable: false, reason: "the decoded PAYMENT-REQUIRED header is not JSON" };
    return { readable: false, reason: cleanReason(err) };
  }
}
