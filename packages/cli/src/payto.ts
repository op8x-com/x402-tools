import { assetWhere } from "./assets.ts";
import { cleanText } from "./extract.ts";
import type { Extracted, Finding } from "./types.ts";

// payTo rotation (docs/designs/2026-10-31-cli-payto-rotation-design.md): the plain challenge and the
// challenge of the browser-like repeat are compared per group of payment options. Server strings
// are only compared and stored, never used as object keys.

export interface RotatingGroup {
  /** Index of the group's first option in the plain challenge's accepts[]. */
  index: number;
  scheme: string;
  network: string;
  asset: string;
  /** payTo values (raw, first-seen order, deduplicated) only in the plain challenge. */
  plainOnly: string[];
  /** payTo values only in the repeat. */
  repeatOnly: string[];
}

export interface Rotation {
  method: Extracted["method"];
  x402Version: 1 | 2;
  /** All rotating groups, ordered by first option index in the plain challenge. */
  groups: RotatingGroup[];
}

interface Group {
  index: number;
  scheme: string;
  network: string;
  asset: string;
  payTo: Set<string>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function groupsOf(challenge: unknown): Map<string, Group> | undefined {
  if (!isObj(challenge) || !Array.isArray(challenge.accepts) || challenge.accepts.length === 0) return undefined;
  const groups = new Map<string, Group>();
  challenge.accepts.forEach((a: unknown, index: number) => {
    if (!isObj(a)) return;
    const { scheme, network, asset, payTo } = a;
    if (typeof scheme !== "string" || typeof network !== "string" || typeof asset !== "string" || typeof payTo !== "string") return;
    const key = JSON.stringify([scheme, network, asset]);
    const group = groups.get(key);
    if (group) group.payTo.add(payTo);
    else groups.set(key, { index, scheme, network, asset, payTo: new Set([payTo]) });
  });
  return groups;
}

/** The rotating groups of a method's plain challenge against its browser-like repeat, if any. */
export function findRotation(e: Extracted): Rotation | undefined {
  if (e.status !== 402 || e.originStatus !== 402) return undefined;
  // Relies on extract.ts deriving version and originVersion from the same challenges compared below.
  if (e.version === undefined || e.originVersion !== e.version) return undefined;
  const plain = groupsOf(e.challenge);
  const repeat = groupsOf(e.originChallenge);
  if (!plain || !repeat) return undefined;
  const groups: RotatingGroup[] = [];
  for (const [key, p] of plain) {
    const r = repeat.get(key);
    if (!r) continue;
    const plainOnly = [...p.payTo].filter((v) => !r.payTo.has(v));
    const repeatOnly = [...r.payTo].filter((v) => !p.payTo.has(v));
    if (plainOnly.length > 0 && repeatOnly.length > 0) {
      groups.push({ index: p.index, scheme: p.scheme, network: p.network, asset: p.asset, plainOnly, repeatOnly });
    }
  }
  if (groups.length === 0) return undefined;
  return { method: e.method, x402Version: e.version, groups };
}

const MAX_GROUPS = 3;

const SERVER: Record<1 | 2, string> = {
  2: "A server built on @x402/core 2.x builds payTo again for the paid request and accepts the payment only if your payTo function returns, for that request, an address it issued to this buyer.",
  1: "The facilitator rejects a payment signed to a different payTo than the one your server checks it against.",
};

const FIX =
  "Return one stable payTo for the resource on every request. If you must issue one address per payment, decode the payment header for the paid retry (context.paymentHeader, the base64 PAYMENT-SIGNATURE) and return its accepted.payTo only if it is an address you issued and have not used yet; never return it unchecked. Tell buyers which addresses are yours.";

const MAX_PRINTED = 100;

/** One code point as printed: printable ASCII except the backslash as is, everything else as \u{XXXX}. */
function escapeChar(c: string): string {
  const cp = c.codePointAt(0) ?? 0;
  return cp >= 0x20 && cp <= 0x7e && cp !== 0x5c ? c : `\\u{${cp.toString(16).toUpperCase().padStart(4, "0")}}`;
}

const escapeAll = (chars: string[]) => chars.map(escapeChar).join("");

function shorten(value: string): string {
  const chars = Array.from(cleanText(value, 100));
  if (chars.length === 0) return "(empty)";
  return chars.length > 12 ? `${escapeAll(chars.slice(0, 6))}\u2026${escapeAll(chars.slice(-4))}` : escapeAll(chars);
}

function full(value: string): string {
  const chars = Array.from(cleanText(value, 100));
  if (chars.length === 0) return "(empty)";
  // cleanText stops at 100 characters; asking for 101 shows whether it cut anything.
  let cut = Array.from(cleanText(value, 101)).length > MAX_PRINTED;
  let text = "";
  let used = 0;
  for (const c of chars) {
    const e = escapeChar(c);
    const n = Array.from(e).length;
    if (used + n > MAX_PRINTED) {
      cut = true;
      break;
    }
    text += e;
    used += n;
  }
  return cut ? `${text}\u2026` : text;
}

const hasDuplicate = (values: string[]) => new Set(values).size < values.length;

const MAX_ADDRESSES = 3;

function groupItem(g: RotatingGroup, version: 1 | 2): string {
  // Only the printed (capped) addresses take part in the look-alike check.
  const shown = [g.plainOnly, g.repeatOnly].map((values) => values.slice(0, MAX_ADDRESSES));
  const raw = shown.flat();
  let print = shorten;
  let note = "";
  // Raw values of one group are all different, so an equal printed pair is a look-alike.
  if (hasDuplicate(raw.map((v) => shorten(v)))) {
    print = full;
    const printed = raw.map(full);
    if (hasDuplicate(printed)) note = " (these look the same here but differ)";
  }
  const side = (values: string[], printed: string[]) => {
    const more = values.length - printed.length;
    return printed.map((v) => print(v)).join(" and ") + (more > 0 ? ` and ${more} more` : "");
  };
  return `accepts[${g.index}] (${assetWhere(g.asset, g.network, version)}) ${side(g.plainOnly, shown[0])}, then ${side(g.repeatOnly, shown[1])}${note}`;
}

export function paytoRule(e: Extracted): Finding | undefined {
  const rotation = findRotation(e);
  if (!rotation) return undefined;
  const { groups, x402Version } = rotation;
  let list = groups.slice(0, MAX_GROUPS).map((g) => groupItem(g, x402Version)).join("; ");
  if (groups.length > MAX_GROUPS) list += `; and ${groups.length - MAX_GROUPS} more`;
  return {
    id: "payto-rotates",
    level: "warn",
    method: e.method,
    title: "payTo changes between two requests",
    detail: `Two unpaid ${e.method} requests sent a moment apart, the second with an Origin header as a browser sends it, got different payTo addresses: ${list}. A client signs its payment to the address in the challenge it read. ${SERVER[x402Version]} Buyer-side spend tools that approve or pin recipients per host see a new recipient on every call and may hold or refuse the payment.`,
    fix: FIX,
  };
}
