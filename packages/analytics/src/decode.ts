/** Unicode Cc (C0, DEL, C1), Cf (format and bidi controls, e.g. U+061C, U+200B, U+202E, U+2060), Cs (lone surrogates), Zl and Zp. */
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
/** A high surrogate left at the end when the length cap splits a pair. */
const SPLIT_PAIR = /[\ud800-\udbff]$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strings only: strips control, format (including bidi), separator and lone surrogate characters, trims, caps length without splitting a surrogate pair. Empty becomes undefined. */
export function clean(value: unknown, max = 128): string | undefined {
  if (typeof value !== "string") return undefined;
  const out = value.replace(CONTROL, "").trim().slice(0, max).replace(SPLIT_PAIR, "").trim();
  return out === "" ? undefined : out;
}

/** JSON.parse that never throws and only returns plain objects. */
export function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Standard base64 (not base64url) of UTF-8 JSON, size-capped before decoding. Never throws. */
export function decodeBase64Json(
  value: string | null | undefined,
  maxBytes = 16384,
): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "string" || value === "") return undefined;
    if (value.length > Math.ceil(maxBytes / 3) * 4) return undefined;
    if (value.length % 4 !== 0 || !BASE64.test(value)) return undefined;
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseJson(text);
  } catch {
    return undefined;
  }
}
