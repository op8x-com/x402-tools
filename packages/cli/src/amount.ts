import { assetWhere, atomicAmount, caip2, findKnownAsset, human } from "./assets.ts";
import { changedGroups, type ChangedGroup, type ChangedPair } from "./pairs.ts";
import type { Extracted, Finding } from "./types.ts";

// Amount that changes between two challenges (docs/designs/2026-10-31-cli-amount-change-design.md):
// the plain challenge and the challenge of the browser-like repeat are compared per group of
// payment options. Values are digits only (at most 78), so they need no escaping.

/** The changing groups of a method's plain challenge against its browser-like repeat, if any. */
export function findAmountChange(e: Extracted): ChangedPair | undefined {
  return changedGroups(e, (entry, version) => {
    const amount = atomicAmount(entry, version);
    // v1 facilitators compare integers, v2 matching compares the strings exactly.
    return amount !== undefined && version === 1 ? BigInt(amount).toString() : amount;
  });
}

const MAX_GROUPS = 3;
const MAX_AMOUNTS = 3;

const SERVER: Record<1 | 2, string> = {
  2: "A server built on @x402/core 2.x runs your price function again for the paid request and accepts the payment only if the result equals the signed amount; otherwise the paid retry gets another 402.",
  1: "The facilitator rejects a payment whose signed amount differs from the maxAmountRequired your server checks it against.",
};

const FIX: Record<1 | 2, string> = {
  2: "Keep one price per resource for as long as a payment takes, for example from a price table. If the price must vary, keep a record of each quote: return an AssetAmount from your price function ({ amount, asset, extra } with a quote id in extra; a plain number is read as money, by default US dollars), and store amount, asset and extra under that id together with the request inputs it was quoted for. Unpaid requests create quotes, so let them expire after the payment timeout and cap how many you keep. For the paid retry, decode context.paymentHeader with decodePaymentSignatureHeader from @x402/core/http, treat a header that does not decode as no quote, and return the stored AssetAmount only if the quote id in its accepted entry is recent, unused and was quoted for the same inputs. Never copy the amount or extra from the payment header. For prices by usage, the upto scheme with a fixed maximum, settling the actual amount, fits better. If your paid retry accepts quoted amounts this way, this warning stays and can be ignored.",
  1: "Keep one price per resource for as long as a payment takes. If the price must vary, keep a record of each quote and pass verify the maxAmountRequired you quoted to this buyer for this request, not a newly computed price. If your server does this, this warning stays and can be ignored.",
};

function groupItem(g: ChangedGroup, version: 1 | 2): string {
  const known = findKnownAsset(g.asset, caip2(g.network, version));
  const print = (amount: string) => (known ? `${amount} (${human(amount, known.decimals)} ${known.symbol})` : amount);
  const side = (values: string[]) => {
    const more = values.length - MAX_AMOUNTS;
    return values.slice(0, MAX_AMOUNTS).map(print).join(" and ") + (more > 0 ? ` and ${more} more` : "");
  };
  return `accepts[${g.index}] (${assetWhere(g.asset, g.network, version)}) ${side(g.plainOnly)}, then ${side(g.repeatOnly)}`;
}

export function amountRule(e: Extracted): Finding | undefined {
  const change = findAmountChange(e);
  if (!change) return undefined;
  const { groups, x402Version } = change;
  let list = groups.slice(0, MAX_GROUPS).map((g) => groupItem(g, x402Version)).join("; ");
  if (groups.length > MAX_GROUPS) list += `; and ${groups.length - MAX_GROUPS} more`;
  return {
    id: "amount-changes",
    level: "warn",
    method: e.method,
    title: "Price changes between two requests",
    detail: `Two unpaid ${e.method} requests sent a moment apart, the second with an Origin header as a browser sends it, asked different amounts: ${list}. A client signs the amount in the challenge it read. ${SERVER[x402Version]} A price that follows time or load works only if the paid request accepts the amount the client signed.`,
    fix: FIX[x402Version],
  };
}
