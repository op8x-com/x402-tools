import { DEFAULT_MAX_AMOUNT_PER_PAYMENT, x402Client } from "@x402/core/client";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { SOLANA_NETWORKS, V1_NETWORKS, assetWhere, atomicAmount, caip2, findDefaultAsset, findEurc, human } from "./assets.ts";
import type { Level } from "./types.ts";

// Spend-control findings (docs/designs/2026-10-30-cli-spend-controls-design.md): the installed
// @x402/core decides, with stub scheme clients registered as the stock helpers register them.

export interface SpendFinding {
  id: string;
  level: Level;
  title: string;
  detail: string;
  fix: string;
}

type Obj = Record<string, unknown>;
type Controls = Parameters<x402Client["setSpendControls"]>[0];
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const CAP = typeof DEFAULT_MAX_AMOUNT_PER_PAYMENT === "string" ? DEFAULT_MAX_AMOUNT_PER_PAYMENT.replace(/^\$/, "") : String(DEFAULT_MAX_AMOUNT_PER_PAYMENT);
const CLIENTS = "Clients built on @x402/core 2.23.0 or later (for example @x402/fetch, @x402/axios) without spendControls";
const EURC_OPT_IN =
  "EURC: add it to spendControls.allowedAssets (network and EURC token address) with its own maxAmountPerPayment in atomic units, for example '1000000' for 1 EURC.";

function stub(version: 1 | 2): SchemeNetworkClient {
  return {
    scheme: "exact",
    findDefaultAsset: (asset, network) => findDefaultAsset(asset, caip2(network, version)),
    createPaymentPayload: () => Promise.reject(new Error("never pays")),
  };
}

/**
 * Whether a default client with these spend controls keeps any entry. createPaymentPayload runs the
 * whole selection before its first await and calls the selector only when entries survive; the
 * selector stops the payment there. If core ever selects after an await, this reports "refused"
 * for every run and the rules stay silent.
 */
function survives(challenge: Obj, controls: Controls): boolean {
  let reached = false;
  const client = new x402Client(() => {
    reached = true;
    throw new Error("stop");
  });
  client.register("eip155:*", stub(2)).register("solana:*", stub(2));
  for (const name of Object.keys(V1_NETWORKS)) client.registerV1(name, stub(1));
  client.setSpendControls(controls);
  client.createPaymentPayload(challenge as unknown as PaymentRequired).catch(() => {});
  return reached;
}

interface Entry {
  index: number;
  asset: string;
  network: string;
  version: 1 | 2;
  /** CAIP-2 network as the client resolves it. */
  key: string;
  /** Atomic price (amount in v2, maxAmountRequired in v1), if it is a string of digits. */
  amount?: string;
}

function entries(accepts: unknown[], version: 1 | 2): (Entry | undefined)[] {
  return accepts.map((a, index) => {
    if (!isObj(a) || typeof a.scheme !== "string" || typeof a.network !== "string" || typeof a.asset !== "string") return undefined;
    return { index, asset: a.asset, network: a.network, version, key: caip2(a.network, version), amount: atomicAmount(a, version) };
  });
}

const where = (e: Entry) => assetWhere(e.asset, e.network, e.version);
const isEurc = (e: Entry) => findEurc(e.asset, e.key) !== undefined;

function capFindings(challenge: Obj, list: (Entry | undefined)[]): SpendFinding[] {
  // Eligible: every entry readable with an atomic price (core throws on other amounts, which would
  // read as a refusal), and no Solana network on which @x402/svm would throw.
  const unfit = (e: Entry | undefined) => e?.amount === undefined || (e.key.startsWith("solana:") && !SOLANA_NETWORKS.includes(e.key));
  if (list.some(unfit)) return [];
  const all = list as Entry[];
  if (!survives(challenge, false)) return [];
  if (!survives(challenge, { maxAmountPerPayment: false })) {
    return [
      {
        id: "default-asset",
        level: "warn",
        title: "Default x402 clients refuse every asset you offer",
        detail: `No accepts[] entry pays in an asset that default clients recognise (USD stablecoins such as USDC, on the networks their SDK lists). ${CLIENTS} drop other assets and pay nothing. Offered: ${all.slice(0, 5).map(where).join(", ")} (default asset list of @x402/evm and @x402/svm 2.29)`,
        fix: `Add a USDC entry on a listed network. Buyers who want another asset must opt in.${all.some(isEurc) ? ` ${EURC_OPT_IN}` : ""}`,
      },
    ];
  }
  if (!survives(challenge, {})) {
    const offered = all.flatMap((e) => {
      const info = findDefaultAsset(e.asset, e.key);
      return info && e.amount !== undefined ? [`${human(e.amount, info.decimals)} ${where(e)}`] : [];
    });
    return [
      {
        id: "default-cap",
        level: "warn",
        title: `Price above the default client cap of ${CAP} USD`,
        detail: `Every accepts[] entry in a default asset asks for more than ${CAP} USD (offered: ${offered.slice(0, 5).join(", ")}). ${CLIENTS} refuse payments above ${CAP} USD and pay nothing.`,
        fix: `Either lower the price (default clients accept an entry in a default asset at or below ${CAP} USD, so they will pay that entry rather than a higher one), or tell buyers to raise spendControls.maxAmountPerPayment.`,
      },
    ];
  }
  return [];
}

function eurcFinding(list: (Entry | undefined)[]): SpendFinding[] {
  // One pass: the first entry that completes a USDC/EURC pair with the same amount. All USDC and
  // EURC rows have 6 decimals, so equal atomic amounts are equal human amounts.
  const usdc = new Map<string, Entry>();
  const eurc = new Map<string, Entry>();
  let pair: [Entry, Entry] | undefined;
  for (const e of list) {
    if (e?.amount === undefined) continue;
    const value = BigInt(e.amount).toString();
    if (findDefaultAsset(e.asset, e.key)?.symbol === "USDC") {
      const x = eurc.get(value);
      if (x) pair = [e, x];
      else if (!usdc.has(value)) usdc.set(value, e);
    } else if (isEurc(e)) {
      const u = usdc.get(value);
      if (u) pair = [u, e];
      else if (!eurc.has(value)) eurc.set(value, e);
    }
    if (pair) break;
  }
  if (!pair) return [];
  const [u, x] = pair;
  const amount = human(u.amount ?? "0", 6);
  return [
    {
      id: "eurc-same-amount",
      level: "info",
      title: "Same amount in USDC and EURC",
      detail: `accepts[${u.index}] asks ${amount} USDC and accepts[${x.index}] asks ${amount} EURC. EURC tracks the euro and USDC the US dollar, so the same number means a different price.`,
      fix: "If the price is meant in euros, say so in the resource description. Otherwise convert one of the two amounts at challenge time and round to base units. Clients that opted into EURC pay the first entry they may pay among entries with the same payment flow, so list EURC first if EURC buyers should pay in EURC.",
    },
  ];
}

/** Findings for a 402 challenge with x402Version 1 or 2 and a non-empty accepts[]. */
export function spendRules(challenge: Obj, version: 1 | 2): SpendFinding[] {
  const accepts = challenge.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return [];
  const list = entries(accepts, version);
  return [...capFindings(challenge, list), ...eurcFinding(list)];
}
