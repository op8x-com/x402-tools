import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ASSETS as EVM_ASSETS } from "@x402/evm";
import { EVM_NETWORK_CHAIN_ID_MAP } from "@x402/evm/v1";
import { DEFAULT_ASSETS as SVM_ASSETS, V1_TO_V2_NETWORK_MAP } from "@x402/svm";
import {
  DEFAULT_ASSETS,
  EURC_ASSETS,
  SOLANA_NETWORKS,
  TEST_NETWORKS,
  V1_NETWORKS,
  assetWhere,
  caip2,
  findDefaultAsset,
  findKnownAsset,
  isTestNetwork,
  sameAddress,
} from "../src/assets.ts";

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

test("assetWhere: a known asset by symbol, the network as sent", () => {
  assert.equal(assetWhere(BASE_USDC, "eip155:8453", 2), "USDC on eip155:8453");
});

test("assetWhere: an unknown asset by its cleaned address", () => {
  assert.equal(assetWhere("0xabc[31mevil", "eip155:10", 2), "0xabc[31mevil on eip155:10");
});

test("assetWhere: a v1 network name resolves the label but prints the name as sent", () => {
  assert.equal(assetWhere(BASE_USDC, "base", 1), "USDC on base");
  assert.equal(assetWhere(BASE_USDC, "base", 2), `${BASE_USDC} on base`);
});

test("TEST_NETWORKS: the v1 test networks, pinned so a new SDK network forces a look", () => {
  assert.deepEqual([...TEST_NETWORKS].sort(), [
    "eip155:10143",
    "eip155:11124",
    "eip155:11155111",
    "eip155:1328",
    "eip155:2201",
    "eip155:324705682",
    "eip155:43113",
    "eip155:80002",
    "eip155:84532",
    "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  ]);
});

test("isTestNetwork maps v1 names only in v1", () => {
  assert.equal(isTestNetwork("eip155:84532", 2), true);
  assert.equal(isTestNetwork("base-sepolia", 1), true);
  assert.equal(isTestNetwork("base-sepolia", 2), false);
  assert.equal(isTestNetwork("eip155:8453", 2), false);
  assert.equal(isTestNetwork("base", 1), false);
  assert.equal(isTestNetwork("eip155:421614", 2), false);
  assert.equal(isTestNetwork("__proto__", 1), false);
});

test("sameAddress: EVM ignores case, Solana does not", () => {
  assert.equal(sameAddress(BASE_USDC, BASE_USDC.toLowerCase(), "eip155:8453"), true);
  assert.equal(sameAddress(BASE_USDC, BASE_USDC.toUpperCase(), "eip155:1"), true);
  assert.equal(sameAddress(BASE_USDC, "0x1111111111111111111111111111111111111111", "eip155:8453"), false);
  const mint = DEFAULT_ASSETS[SOLANA][0].asset;
  assert.equal(sameAddress(mint, mint, SOLANA), true);
  assert.equal(sameAddress(mint, mint.toLowerCase(), SOLANA), false);
  assert.equal(sameAddress(BASE_USDC, BASE_USDC.toLowerCase(), "base"), false);
});
