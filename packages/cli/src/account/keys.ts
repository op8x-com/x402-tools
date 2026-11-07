import { createHash, randomBytes } from "node:crypto";

/** w = server (write) key, r = read token, d = device key. */
export type KeyKind = "w" | "r" | "d";

const BODY = /^[A-Za-z0-9_-]{43}$/;

/** `op8x_<kind>_` plus 43 base64url characters from 32 random bytes. */
export function generateKey(kind: KeyKind): string {
  return `op8x_${kind}_${randomBytes(32).toString("base64url")}`;
}

/** True if `value` is a key of this kind: exact prefix, then exactly 43 base64url characters. */
export function isKey(value: unknown, kind: KeyKind): value is string {
  if (typeof value !== "string") return false;
  const prefix = `op8x_${kind}_`;
  return value.startsWith(prefix) && BODY.test(value.slice(prefix.length));
}

/** SHA-256 over the whole key including its prefix (UTF-8), lowercase hex. */
export function keyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** The first 8 hex characters of the hash; safe to print and store next to the key. */
export function keyFingerprint(key: string): string {
  return keyHash(key).slice(0, 8);
}
