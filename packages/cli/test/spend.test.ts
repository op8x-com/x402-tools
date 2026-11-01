import { test } from "node:test";
import assert from "node:assert/strict";
import { runRules } from "../src/rules.ts";
import { extract } from "../src/extract.ts";
import { b64, pr, v1, v2 } from "./fixtures.ts";
import type { Finding } from "../src/types.ts";

const NS = { "cache-control": "no-store" };
const BASE = "eip155:8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_EURC = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
const MEZO = "eip155:31612";
const MEZO_MUSD = "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPEND = ["default-asset", "default-cap", "eurc-same-amount"];

const e2 = (over: Record<string, unknown>) => ({ ...v2.accepts[0], ...over });
const e1 = (over: Record<string, unknown>) => ({ ...v1.accepts[0], ...over });
const usdc = (amount: string) => e2({ network: BASE, asset: BASE_USDC, amount });
const eurc = (amount: string) => e2({ network: BASE, asset: BASE_EURC, amount, extra: { name: "EURC", version: "2" } });

// v2 lives in the header, v1 in the body.
function check(accepts: unknown[], version: 1 | 2 = 2, status = 402): Finding[] {
  const c = version === 2 ? { ...v2, accepts } : { ...v1, accepts };
  const res = version === 2 ? pr("GET", status, { ...NS, "payment-required": b64(c) }, {}) : pr("GET", status, NS, c);
  return runRules([extract(res)]).filter((f) => SPEND.includes(f.id));
}
const ids = (fs: Finding[]) => fs.map((f) => f.id);

test("EURC only: default-asset with the EURC opt-in sentence", () => {
  const fs = check([eurc("10000")]);
  assert.deepEqual(ids(fs), ["default-asset"]);
  assert.equal(fs[0].level, "warn");
  assert.match(fs[0].detail, /Offered: EURC on "eip155:8453"/);
  assert.match(fs[0].fix ?? "", /spendControls\.allowedAssets .*, for example '1000000' for 1 EURC\./);
});

test("USDC on a chain without a default asset: default-asset without the EURC sentence", () => {
  const fs = check([e2({ network: "eip155:10", asset: BASE_USDC })]);
  assert.deepEqual(ids(fs), ["default-asset"]);
  assert.doesNotMatch(fs[0].fix ?? "", /EURC/);
});

test("existing fixtures report none of the new findings", () => {
  assert.deepEqual(check(v2.accepts), []);
  assert.deepEqual(check(v1.accepts, 1), []);
});

test("default-cap: exactly 1 USD passes, one base unit more does not", () => {
  assert.deepEqual(check([usdc("1000000")]), []);
  const fs = check([usdc("1000001")]);
  assert.deepEqual(ids(fs), ["default-cap"]);
  assert.equal(fs[0].title, "Price above the default client cap of 1 USD");
  assert.match(fs[0].detail, /offered: 1\.000001 USDC on "eip155:8453"/);
});

test("default-cap uses the asset's decimals (18 for mUSD)", () => {
  assert.deepEqual(check([e2({ network: MEZO, asset: MEZO_MUSD, amount: "1000000000000000000" })]), []);
  assert.deepEqual(ids(check([e2({ network: MEZO, asset: MEZO_MUSD, amount: "1000000000000000001" })])), ["default-cap"]);
});

test("a mixed offer with one entry within the cap is paid", () => {
  assert.deepEqual(check([usdc("5000000"), e2({ network: SOLANA, asset: SOLANA_USDC, amount: "500000" })]), []);
});

test("v1: maxAmountRequired above the cap on a legacy name", () => {
  assert.deepEqual(ids(check([e1({ network: "base", asset: BASE_USDC, maxAmountRequired: "2000000" })], 1)), ["default-cap"]);
});

test("v1: the offered text names the network as the server sent it", () => {
  const fs = check([e1({ network: "base", asset: BASE_USDC, maxAmountRequired: "2000000" })], 1);
  assert.match(fs[0].detail, /offered: 2 USDC on "base"\)/);
});

test("silent where default clients never reach spend controls", () => {
  const cases: [string, unknown[], 1 | 2][] = [
    ["v1 on a CAIP-2 network", [e1({ network: BASE, asset: BASE_USDC, maxAmountRequired: "2000000" })], 1],
    ["v2 on a legacy name", [e2({ network: "base", asset: BASE_USDC, amount: "2000000" })], 2],
    ["only upto", [e2({ scheme: "upto", network: BASE, asset: BASE_USDC, amount: "2000000" })], 2],
    ["unknown flow", [e2({ network: BASE, asset: BASE_EURC, extra: { paymentFlow: "later" } })], 2],
  ];
  for (const [name, accepts, version] of cases) assert.deepEqual(check(accepts, version), [], name);
});

test("an under-cap entry the client cannot pay does not hide default-cap", () => {
  const fs = check([e2({ scheme: "upto", network: BASE, asset: BASE_USDC, amount: "10" }), usdc("2000000")]);
  assert.deepEqual(ids(fs), ["default-cap"]);
});

test("silent when the real client would throw inside findDefaultAsset", () => {
  assert.deepEqual(check([e2({ network: "solana:unknown", asset: SOLANA_USDC }), eurc("10000")]), []);
  assert.deepEqual(check([e2({ network: BASE, asset: 7 }), eurc("10000")]), []);
});

test("a non-digit amount is left to core: 0.5 on a default asset is within the cap", () => {
  assert.deepEqual(check([usdc("0.5")]), []);
});

test("only 402 counts, not 412", () => {
  const c = { ...v2, accepts: [eurc("10000")], error: "permit2_allowance_required" };
  const fs = runRules([extract(pr("GET", 412, { ...NS, "payment-required": b64(c) }, {}))]);
  assert.deepEqual(fs.filter((f) => SPEND.includes(f.id)), []);
});

test("EVM address case does not matter, Solana mint case does", () => {
  assert.deepEqual(check([e2({ network: BASE, asset: BASE_USDC.toLowerCase(), amount: "10000" })]), []);
  assert.deepEqual(ids(check([e2({ network: SOLANA, asset: SOLANA_USDC.toLowerCase(), amount: "10000" })])), ["default-asset"]);
});

test("prototype keys as network names do not crash the report", () => {
  for (const network of ["__proto__", "constructor", "toString"]) {
    assert.deepEqual(check([e2({ network, asset: BASE_USDC, amount: "1" })]), [], `v2 ${network}`);
    assert.deepEqual(check([e1({ network, asset: BASE_USDC, maxAmountRequired: "1" })], 1), [], `v1 ${network}`);
  }
});

test("silent when a price is not an atomic amount (core would throw, not cap)", () => {
  const cases: [string, unknown[], 1 | 2][] = [
    ["dollar string", [usdc("$0.01")], 2],
    ["exponent", [usdc("1e4")], 2],
    ["invalid next to a valid entry", [usdc("abc"), usdc("500000")], 2],
    ["missing amount", [e2({ network: BASE, asset: BASE_USDC, amount: undefined })], 2],
    ["v1 with amount instead of maxAmountRequired", [e1({ network: "base", asset: BASE_USDC, maxAmountRequired: undefined, amount: "10000" })], 1],
    ["79 digits", [usdc("1".repeat(79))], 2],
  ];
  for (const [name, accepts, version] of cases) assert.deepEqual(check(accepts, version), [], name);
});

test("thousands of entries stay fast", () => {
  const many = Array.from({ length: 9000 }, (_, i) => (i % 2 ? eurc(String(i)) : usdc(String(i + 1_000_000_000))));
  const start = performance.now();
  check(many);
  assert.ok(performance.now() - start < 2000);
});

test("labels of unknown assets are cleaned", () => {
  const fs = check([e2({ network: "eip155:10", asset: "0xabc" + String.fromCharCode(0x202e, 0x1b) + "[31mevil" })]);
  assert.match(fs[0].detail, /Offered: "0xabc\[31mevil" on "eip155:10"/);
});

test("eurc-same-amount: same human amount, one finding for two pairs", () => {
  const fs = check([usdc("10000"), eurc("10000"), usdc("20000"), eurc("20000")]);
  assert.deepEqual(ids(fs), ["eurc-same-amount"]);
  assert.equal(fs[0].level, "info");
  assert.match(fs[0].detail, /accepts\[0\] asks 0\.01 USDC and accepts\[1\] asks 0\.01 EURC/);
});

test("eurc-same-amount: different amounts or USDC.e do not count", () => {
  assert.deepEqual(check([usdc("10000"), eurc("9200")]), []);
  const usdce = e2({ network: "eip155:36900", asset: "0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2", amount: "10000" });
  assert.deepEqual(check([usdce, eurc("10000")]), []);
});

test("identical GET and POST findings merge into both", () => {
  const c = { ...v2, accepts: [eurc("10000")] };
  const res = (m: "GET" | "POST") => extract(pr(m, 402, { ...NS, "payment-required": b64(c) }, {}));
  const fs = runRules([res("GET"), res("POST")]).filter((f) => f.id === "default-asset");
  assert.equal(fs.length, 1);
  assert.equal(fs[0].method, "both");
});
