import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ASSETS as EVM_ASSETS } from "@x402/evm";
import { EVM_NETWORK_CHAIN_ID_MAP } from "@x402/evm/v1";
import { DEFAULT_ASSETS as SVM_ASSETS, V1_TO_V2_NETWORK_MAP } from "@x402/svm";
import { DEFAULT_ASSETS, EURC_ASSETS, SOLANA_NETWORKS, V1_NETWORKS, caip2, findDefaultAsset, findKnownAsset } from "../src/assets.ts";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const rows = (table: Record<string, readonly { asset: string; symbol: string; decimals: number }[]>) =>
  Object.fromEntries(
    Object.entries(table).map(([n, list]) => [n, list.map(({ asset, symbol, decimals }) => ({ asset, symbol, decimals }))]),
  );

test("drift: DEFAULT_ASSETS equals the default assets of the installed @x402/evm and @x402/svm", () => {
  assert.deepEqual(DEFAULT_ASSETS, { ...rows(EVM_ASSETS), ...rows(SVM_ASSETS) });
});

test("drift: V1_NETWORKS equals the v1 network maps of @x402/evm and @x402/svm", () => {
  const evm = Object.fromEntries(Object.entries(EVM_NETWORK_CHAIN_ID_MAP).map(([k, id]) => [k, `eip155:${id}`]));
  assert.deepEqual(V1_NETWORKS, { ...evm, ...V1_TO_V2_NETWORK_MAP });
});

test("EURC is never a default asset", () => {
  for (const [network, list] of Object.entries(EURC_ASSETS)) {
    for (const row of list) assert.equal(findDefaultAsset(row.asset, network), undefined, `${network} ${row.asset}`);
  }
});

test("EVM lookup ignores case, Solana lookup does not", () => {
  assert.equal(findDefaultAsset(BASE_USDC.toLowerCase(), "eip155:8453")?.symbol, "USDC");
  const mint = DEFAULT_ASSETS[SOLANA][0].asset;
  assert.equal(findDefaultAsset(mint, SOLANA)?.symbol, "USDC");
  assert.equal(findDefaultAsset(mint.toLowerCase(), SOLANA), undefined);
});

test("chains without a row have no default asset", () => {
  assert.equal(findDefaultAsset(BASE_USDC, "eip155:10"), undefined);
});

test("known assets include EURC for labels", () => {
  assert.equal(findKnownAsset("0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", "eip155:8453")?.symbol, "EURC");
  assert.equal(findKnownAsset(BASE_USDC, "eip155:8453")?.symbol, "USDC");
});

test("v1 names map to CAIP-2 only in v1", () => {
  assert.equal(caip2("base", 1), "eip155:8453");
  assert.equal(caip2("solana-devnet", 1), "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  assert.equal(caip2("base", 2), "base");
  assert.equal(SOLANA_NETWORKS.length, 3);
});
