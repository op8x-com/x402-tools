import { assetWhere } from "./assets.ts";
import { cleanText, escapeChar, printFull } from "./extract.ts";
import { changedGroups, type ChangedGroup, type ChangedPair } from "./pairs.ts";
import type { Extracted, Finding } from "./types.ts";

// payTo rotation (docs/designs/2026-10-31-cli-payto-rotation-design.md): the plain challenge and the
// challenge of the browser-like repeat are compared per group of payment options. Server strings
// are only compared and stored, never used as object keys.

/** The rotating groups of a method's plain challenge against its browser-like repeat, if any. */
export function findRotation(e: Extracted): ChangedPair | undefined {
  return changedGroups(e, (entry) => (typeof entry.payTo === "string" ? entry.payTo : undefined));
}

const MAX_GROUPS = 3;

const SERVER: Record<1 | 2, string> = {
  2: "A server built on @x402/core 2.x builds payTo again for the paid request and accepts the payment only if your payTo function returns, for that request, an address it issued to this buyer.",
  1: "The facilitator rejects a payment signed to a different payTo than the one your server checks it against.",
};

const FIX =
  "Return one stable payTo for the resource on every request. If you must issue one address per payment, decode the payment header for the paid retry (context.paymentHeader, the base64 PAYMENT-SIGNATURE) and return its accepted.payTo only if it is an address you issued and have not used yet; never return it unchecked. Tell buyers which addresses are yours.";

const escapeAll = (chars: string[]) => chars.map(escapeChar).join("");

function shorten(value: string): string {
  const chars = Array.from(cleanText(value, 100));
  if (chars.length === 0) return "(empty)";
  return chars.length > 12 ? `${escapeAll(chars.slice(0, 6))}\u2026${escapeAll(chars.slice(-4))}` : escapeAll(chars);
}

const hasDuplicate = (values: string[]) => new Set(values).size < values.length;

const MAX_ADDRESSES = 3;

function groupItem(g: ChangedGroup, version: 1 | 2): string {
  // Only the printed (capped) addresses take part in the look-alike check.
  const shown = [g.plainOnly, g.repeatOnly].map((values) => values.slice(0, MAX_ADDRESSES));
  const raw = shown.flat();
  let print = shorten;
  let note = "";
  // Raw values of one group are all different, so an equal printed pair is a look-alike.
  if (hasDuplicate(raw.map((v) => shorten(v)))) {
    print = printFull;
    const printed = raw.map(printFull);
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
