const HEX = "0123456789abcdef";

/**
 * Pseudonymize a payer address: HMAC-SHA-256 keyed with the seller's salt over the
 * trimmed, lowercased address; hex, first 32 characters.
 */
export async function hashPayer(salt: string, address: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(address.trim().toLowerCase())));
  let out = "";
  for (let i = 0; i < 16; i++) {
    const b = mac[i] as number;
    out += HEX[b >> 4]! + HEX[b & 15]!;
  }
  return out;
}
