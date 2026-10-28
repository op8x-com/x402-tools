/** The only origin for which the key is read from the environment and the prefix is required. */
export const OP8X_ORIGIN = "https://ingest.op8x.com";
export const KEY_PREFIX = "op8x_w_";
const MAX_KEY_LENGTH = 256;

export const KEY_MISSING = "op8x.analytics: OP8X_KEY missing, sending disabled";
export const KEY_INVALID = "op8x.analytics: invalid key, sending disabled";

/** True when `endpoint` (an already validated URL) has exactly the op8x collector origin. */
export function isOp8xEndpoint(endpoint: string | undefined): boolean {
  if (endpoint === undefined) return false;
  try {
    return new URL(endpoint).origin === OP8X_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * The trimmed key, or undefined when it is unusable: not a string, empty after trimming,
 * longer than 256 characters, outside printable ASCII, or (op8x only) without the prefix.
 * Never throws and never includes the value in anything it returns besides the key itself.
 */
export function checkKey(value: unknown, op8x: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  if (key === "" || key.length > MAX_KEY_LENGTH) return undefined;
  if (!/^[\x20-\x7e]+$/.test(key)) return undefined;
  if (op8x && !key.startsWith(KEY_PREFIX)) return undefined;
  return key;
}

/** OP8X_KEY from a Hono-style environment; undefined when absent or unreadable. */
export function envKey(env: unknown): unknown {
  try {
    if (env === null || typeof env !== "object") return undefined;
    return (env as Record<string, unknown>)["OP8X_KEY"];
  } catch {
    return undefined;
  }
}

export type KeyResolution = { ok: true; key: string | undefined } | { ok: false; warning: string };

/**
 * Which key a send to `endpoint` uses. An explicit key (anything but undefined) wins and is
 * never replaced by the environment. Without one, the environment is consulted only for the
 * op8x collector; other endpoints then send without a key.
 */
export function resolveKey(explicit: unknown, op8x: boolean, env: () => unknown): KeyResolution {
  if (explicit !== undefined) {
    const key = checkKey(explicit, op8x);
    return key === undefined ? { ok: false, warning: KEY_INVALID } : { ok: true, key };
  }
  if (!op8x) return { ok: true, key: undefined };
  const raw = env();
  if (raw === undefined) return { ok: false, warning: KEY_MISSING };
  const key = checkKey(raw, true);
  return key === undefined ? { ok: false, warning: KEY_INVALID } : { ok: true, key };
}
