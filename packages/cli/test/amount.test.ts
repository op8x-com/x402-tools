import { test } from "node:test";
import assert from "node:assert/strict";
import { amountRule, findAmountChange } from "../src/amount.ts";
import { paytoRule } from "../src/payto.ts";
import type { Extracted } from "../src/types.ts";
import { v1, v1main, v2 } from "./fixtures.ts";

const USDC = v2.accepts[0].asset;
const NET = v2.accepts[0].network;
const OTHER = { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "eip155:8453" };
const SERVER_V2 =
  "A server built on @x402/core 2.x runs your price function again for the paid request and accepts the payment only if the result equals the signed amount; otherwise the paid retry gets another 402.";
const SERVER_V1 = "The facilitator rejects a payment whose signed amount differs from the maxAmountRequired your server checks it against.";
const TAIL = "A price that follows time or load works only if the paid request accepts the amount the client signed.";

const opt = (amount: unknown, over: Record<string, unknown> = {}) => ({ ...v2.accepts[0], amount, ...over });
const opt1 = (amount: unknown, over: Record<string, unknown> = {}) => ({ ...v1.accepts[0], maxAmountRequired: amount, ...over });
const ch2 = (...accepts: unknown[]) => ({ ...v2, accepts });
const ch1 = (...accepts: unknown[]) => ({ ...v1, accepts });

function isVersion(c: unknown): 1 | 2 | undefined {
  const v = (c as { x402Version?: unknown } | undefined)?.x402Version;
  return v === 1 || v === 2 ? v : undefined;
}

function ex(plain: unknown, repeat: unknown, over: Partial<Extracted> = {}): Extracted {
  const version = isVersion(plain) ?? 2;
  return {
    method: "GET",
    status: 402,
    headers: {},
    location: "header",
    challenge: plain,
    version,
    originStatus: 402,
    originChallenge: repeat,
    originVersion: isVersion(repeat),
    official: { readable: true },
    ...over,
  };
}

const detailOf = (plain: unknown, repeat: unknown, over: Partial<Extracted> = {}) => amountRule(ex(plain, repeat, over))?.detail ?? "";

test("1: v2, same amount in both challenges: no finding", () => {
  assert.equal(findAmountChange(ex(ch2(opt("1000")), ch2(opt("1000")))), undefined);
  assert.equal(amountRule(ex(ch2(opt("1000")), ch2(opt("1000")))), undefined);
});

test("2: v2, different amount on accepts[0]: one warn finding with both amounts, server sentence and fix", () => {
  const r = findAmountChange(ex(ch2(opt("1000")), ch2(opt("1200"))));
  assert.deepEqual(r?.groups, [{ index: 0, scheme: "exact", network: NET, asset: USDC, plainOnly: ["1000"], repeatOnly: ["1200"] }]);
  const f = amountRule(ex(ch2(opt("1000")), ch2(opt("1200")), { method: "POST" }));
  assert.ok(f);
  assert.equal(f.id, "amount-changes");
  assert.equal(f.level, "warn");
  assert.equal(f.method, "POST");
  assert.equal(f.title, "Price changes between two requests");
  assert.equal(
    detailOf(ch2(opt("1000")), ch2(opt("1200"))),
    `Two unpaid GET requests sent a moment apart, the second with an Origin header as a browser sends it, asked different amounts: accepts[0] (USDC on eip155:84532) 1000 (0.001 USDC), then 1200 (0.0012 USDC). A client signs the amount in the challenge it read. ${SERVER_V2} ${TAIL}`,
  );
  assert.equal(
    f.fix,
    "Keep one price per resource for as long as a payment takes, for example from a price table. If the price must vary, keep a record of each quote: return an AssetAmount from your price function ({ amount, asset, extra } with a quote id in extra; a plain number is read as money, by default US dollars), and store amount, asset and extra under that id together with the request inputs it was quoted for. Unpaid requests create quotes, so let them expire after the payment timeout and cap how many you keep. For the paid retry, decode context.paymentHeader with decodePaymentSignatureHeader from @x402/core/http, treat a header that does not decode as no quote, and return the stored AssetAmount only if the quote id in its accepted entry is recent, unused and was quoted for the same inputs. Never copy the amount or extra from the payment header. For prices by usage, the upto scheme with a fixed maximum, settling the actual amount, fits better. If your paid retry accepts quoted amounts this way, this warning stays and can be ignored.",
  );
});

test("3: v2, 1000 against 01000: finding, both printed as sent", () => {
  const r = findAmountChange(ex(ch2(opt("1000")), ch2(opt("01000"))));
  assert.deepEqual(r?.groups[0].plainOnly, ["1000"]);
  assert.deepEqual(r?.groups[0].repeatOnly, ["01000"]);
  assert.match(detailOf(ch2(opt("1000")), ch2(opt("01000"))), /\) 1000 \(0\.001 USDC\), then 01000 \(0\.001 USDC\)\. A client/);
});

test("4: v1, 1000 against 01000: no finding; 1000 against 02000: finding with v1 texts", () => {
  const o = (amount: string) => opt1(amount, { network: "base", asset: OTHER.asset });
  assert.equal(findAmountChange(ex(ch1(o("1000")), ch1(o("01000")))), undefined);
  assert.equal(amountRule(ex(ch1(o("1000")), ch1(o("01000")))), undefined);
  assert.equal(findAmountChange(ex(v1main, v1main)), undefined);
  const r = findAmountChange(ex(ch1(o("1000")), ch1(o("02000"))));
  assert.deepEqual(r?.groups[0].repeatOnly, ["2000"]);
  const f = amountRule(ex(ch1(o("1000")), ch1(o("02000"))));
  assert.equal(
    f?.detail,
    `Two unpaid GET requests sent a moment apart, the second with an Origin header as a browser sends it, asked different amounts: accepts[0] (USDC on base) 1000 (0.001 USDC), then 2000 (0.002 USDC). A client signs the amount in the challenge it read. ${SERVER_V1} ${TAIL}`,
  );
  assert.equal(
    f?.fix,
    "Keep one price per resource for as long as a payment takes. If the price must vary, keep a record of each quote and pass verify the maxAmountRequired you quoted to this buyer for this request, not a newly computed price. If your server does this, this warning stays and can be ignored.",
  );
});

test("5: unknown asset: atomic amounts only, no human value", () => {
  const d = detailOf(ch2(opt("1000", { asset: "0xdead" })), ch2(opt("1200", { asset: "0xdead" })));
  assert.match(d, /accepts\[0\] \(0xdead on eip155:84532\) 1000, then 1200\. A client/);
  assert.doesNotMatch(d, /\(0\.0/);
});

test("6: reordered accepts[] with the same amounts: no finding", () => {
  const second = opt("2000", OTHER);
  assert.equal(findAmountChange(ex(ch2(opt("1000"), second), ch2(second, opt("1000")))), undefined);
});

test("7: a group that only gains, loses or repeats an amount: no finding", () => {
  assert.equal(findAmountChange(ex(ch2(opt("1000"), opt("2000")), ch2(opt("1000")))), undefined);
  assert.equal(findAmountChange(ex(ch2(opt("1000")), ch2(opt("1000"), opt("2000")))), undefined);
  assert.equal(findAmountChange(ex(ch2(opt("1000"), opt("1000")), ch2(opt("1000")))), undefined);
  assert.equal(findAmountChange(ex(ch2(opt("1000")), ch2(opt("1000"), opt("1000")))), undefined);
});

test("8: two groups, only the second changes: names that group only", () => {
  const r = findAmountChange(ex(ch2(opt("1000"), opt("2000", OTHER)), ch2(opt("1000"), opt("3000", OTHER))));
  assert.equal(r?.groups.length, 1);
  assert.equal(r?.groups[0].index, 1);
  assert.equal(r?.groups[0].network, OTHER.network);
  assert.deepEqual(r?.groups[0].plainOnly, ["2000"]);
  assert.deepEqual(r?.groups[0].repeatOnly, ["3000"]);
});

test("9: repeat missing, not 402, without a readable challenge, or with another version: no finding", () => {
  const p = ch2(opt("1000"));
  const q = ch2(opt("1200"));
  const none = { originStatus: undefined, originChallenge: undefined, originVersion: undefined };
  assert.equal(findAmountChange(ex(p, undefined, none)), undefined);
  assert.equal(findAmountChange(ex(p, q, { originStatus: 200 })), undefined);
  assert.equal(findAmountChange(ex(p, q, { originStatus: 412 })), undefined);
  assert.equal(findAmountChange(ex(p, q, { status: 412 })), undefined);
  assert.equal(findAmountChange(ex(p, undefined)), undefined);
  assert.equal(findAmountChange(ex(p, "not a challenge", { originVersion: 2 })), undefined);
  assert.equal(findAmountChange(ex(p, { x402Version: 2, accepts: [] })), undefined);
  assert.equal(findAmountChange(ex(p, ch1(opt1("1200")))), undefined);
});

test("10: amount missing, not a string, decimal, negative or too long: entry skipped, no crash", () => {
  const missing: Record<string, unknown> = { ...v2.accepts[0] };
  delete missing.amount;
  const bad = [missing, opt(1000), opt("0.001"), opt("-5"), opt("1".repeat(79)), opt(null), opt({}), null, "x"];
  assert.equal(findAmountChange(ex(ch2(...bad, opt("1000")), ch2(...bad, opt("1000")))), undefined);
  const r = findAmountChange(ex(ch2(...bad, opt("1000")), ch2(...bad, opt("1200"))));
  assert.equal(r?.groups[0].index, bad.length);
  assert.deepEqual(r?.groups[0].plainOnly, ["1000"]);
  assert.equal(findAmountChange(ex(ch2(opt("1".repeat(79))), ch2(opt("2".repeat(79))))), undefined);
  assert.ok(findAmountChange(ex(ch2(opt("1".repeat(78))), ch2(opt("2".repeat(78))))));
});

test("11: more than three groups: three listed then 'and n more'; five amounts a side: three, then 'and 2 more'", () => {
  const plain = ch2(...Array.from({ length: 5 }, (_, i) => opt("1000", { asset: `asset-${i}` })));
  const repeat = ch2(...Array.from({ length: 5 }, (_, i) => opt("1200", { asset: `asset-${i}` })));
  const d = detailOf(plain, repeat);
  assert.match(d, /accepts\[2\] \(asset-2 on eip155:84532\) 1000, then 1200; and 2 more\. A client/);
  assert.doesNotMatch(d, /accepts\[3\]/);
  const many = (base: number) => ch2(...Array.from({ length: 5 }, (_, i) => opt(String(base + i))));
  const d2 = detailOf(many(100), many(200));
  assert.match(
    d2,
    /\) 100 \(0\.0001 USDC\) and 101 \(0\.000101 USDC\) and 102 \(0\.000102 USDC\) and 2 more, then 200 \(0\.0002 USDC\) and 201 \(0\.000201 USDC\) and 202 \(0\.000202 USDC\) and 2 more\. A client/,
  );
});

test("12: prototype-like names as scheme, network and asset are grouped correctly", () => {
  for (const name of ["__proto__", "constructor", "toString"]) {
    const o = (amount: string) => opt(amount, { scheme: name, network: name, asset: name });
    const r = findAmountChange(ex(ch2(o("1000")), ch2(o("1200"))));
    assert.deepEqual(r?.groups, [{ index: 0, scheme: name, network: name, asset: name, plainOnly: ["1000"], repeatOnly: ["1200"] }]);
    assert.equal(findAmountChange(ex(ch2(o("1000")), ch2(o("1000")))), undefined);
    assert.ok(amountRule(ex(ch2(o("1000")), ch2(o("1200")))));
  }
});

test("13: payTo and amount change on the same option: both rules report", () => {
  const A = "0x1111111111111111111111111111111111111111";
  const B = "0x2222222222222222222222222222222222222222";
  const e = ex(ch2(opt("1000", { payTo: A })), ch2(opt("1200", { payTo: B })));
  assert.equal(paytoRule(e)?.id, "payto-rotates");
  assert.equal(amountRule(e)?.id, "amount-changes");
  assert.ok(findAmountChange(e));
});

test("14: a group present on one side only (other asset in the repeat): skipped", () => {
  assert.equal(findAmountChange(ex(ch2(opt("1000")), ch2(opt("1200", OTHER)))), undefined);
});

test("15: a large accepts[] returns every changing group in order; the text lists three", () => {
  const n = 1000;
  const plain = ch2(...Array.from({ length: n }, (_, i) => opt("1000", { asset: `asset-${i}` })));
  const repeat = ch2(...Array.from({ length: n }, (_, i) => opt("1200", { asset: `asset-${i}` })));
  const r = findAmountChange(ex(plain, repeat));
  assert.equal(r?.groups.length, n);
  assert.equal(r?.groups[n - 1].index, n - 1);
  assert.deepEqual(
    r?.groups.slice(0, 3).map((g) => g.index),
    [0, 1, 2],
  );
  const d = detailOf(plain, repeat);
  assert.match(d, /; and 997 more\. A client/);
  assert.doesNotMatch(d, /accepts\[3\]/);
});
