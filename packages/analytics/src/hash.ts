const HEX = "0123456789abcdef";

/** Algorithm identifier of the payer pseudonym; also the domain separator of its HMAC input. */
export const PAYER_ALG = "op8x.payer.v1";
/** Prefix of a salt string: `op8x_s_` followed by 43 base64url characters (32 bytes). */
export const SALT_PREFIX = "op8x_s_";

const SALT_ID_LABEL = "op8x.salt-id.v1";
const SALT_RE = /^op8x_s_[A-Za-z0-9_-]{43}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const EDGE_WS_RE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url of bytes, used only to check that a decoded salt is canonical. */
function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL[b0 >> 2]!;
    out += B64URL[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 !== undefined) out += B64URL[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 !== undefined) out += B64URL[b2 & 63]!;
  }
  return out;
}

/**
 * Parse a salt string (`op8x_s_` + 43 base64url characters) into its 32 bytes. The encoding must
 * be canonical (re-encoding gives the same string). Anything else gives undefined. Never throws.
 */
export function parseSalt(value: unknown): Uint8Array | undefined {
  try {
    if (typeof value !== "string" || !SALT_RE.test(value)) return undefined;
    const body = value.slice(SALT_PREFIX.length);
    const binary = atob(body.replace(/-/g, "+").replace(/_/g, "/") + "=");
    if (binary.length !== 32) return undefined;
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = binary.charCodeAt(i);
    return encodeBase64Url(bytes) === body ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function mac(salt: Uint8Array, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}

function hex(bytes: Uint8Array, chars: number): string {
  let out = "";
  for (let i = 0; i < chars / 2; i++) {
    const b = bytes[i] as number;
    out += HEX[b >> 4]! + HEX[b & 15]!;
  }
  return out;
}

/** Identifier of a salt (first 8 hex of HMAC-SHA-256 over a fixed label); reveals nothing about the salt. */
export async function saltId(salt: Uint8Array): Promise<string> {
  return hex(await mac(salt, new TextEncoder().encode(SALT_ID_LABEL)), 8);
}

/** Removes ASCII whitespace (space, tab, LF, CR, FF, VT) at both ends; nothing else, unlike String.prototype.trim. */
export function trimAscii(value: string): string {
  return value.replace(EDGE_WS_RE, "");
}

/**
 * Pseudonymize a payer address: first 32 hex of HMAC-SHA-256 keyed with the salt bytes over
 * "op8x.payer.v1" + 0x00 + address'. address' is the address without ASCII whitespace (space,
 * tab, LF, CR, FF, VT) at both ends, lowercased only when it is an EVM address (0x + 40 hex);
 * other addresses, such as Solana, are case-sensitive. This is the only place that normalizes.
 */
export async function hashPayer(salt: Uint8Array, address: string): Promise<string> {
  const trimmed = trimAscii(address);
  const normalized = EVM_RE.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  const message = new TextEncoder().encode(`${PAYER_ALG}\u0000${normalized}`);
  return hex(await mac(salt, message), 32);
}
