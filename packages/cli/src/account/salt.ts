import { randomBytes } from "node:crypto";

// The salt of an account: one per account, made by the CLI, stored in the op8x file and put into
// every worker as OP8X_SALT. The analytics module keys its payer pseudonyms with it. The CLI only
// makes and checks salts; it never computes a pseudonym.

/** The name of the salt in the worker and in an env file. */
export const SALT_SECRET = "OP8X_SALT";
const PREFIX = "op8x_s_";
const SALT = /^op8x_s_[A-Za-z0-9_-]{43}$/;

/** `op8x_s_` plus 43 base64url characters from 32 random bytes. */
export function newSalt(): string {
  return `${PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * True for a salt the analytics module accepts: the exact prefix, 43 base64url characters that
 * decode to 32 bytes, and canonical (encoding the bytes again gives the same characters, so the
 * low bits of the last character are 0).
 */
export function isSalt(value: unknown): value is string {
  if (typeof value !== "string" || !SALT.test(value)) return false;
  const body = value.slice(PREFIX.length);
  const bytes = Buffer.from(body, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === body;
}
