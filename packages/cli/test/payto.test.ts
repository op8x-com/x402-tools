import { test } from "node:test";
import assert from "node:assert/strict";
import { findRotation, paytoRule, shorten } from "../src/payto.ts";
import type { Extracted } from "../src/types.ts";
import { v1, v2 } from "./fixtures.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const USDC = v2.accepts[0].asset;
const NET = v2.accepts[0].network;
const OTHER = { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "eip155:8453" };

const opt = (payTo: unknown, over: Record<string, unknown> = {}) => ({ ...v2.accepts[0], payTo, ...over });
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

test("1: same payTo in both challenges: no finding", () => {
  assert.equal(findRotation(ex(ch2(opt(A)), ch2(opt(A)))), undefined);
  assert.equal(paytoRule(ex(ch2(opt(A)), ch2(opt(A)))), undefined);
});

test("2: different payTo on accepts[0]: one group with index and both addresses", () => {
  const r = findRotation(ex(ch2(opt(A)), ch2(opt(B))));
  assert.ok(r);
  assert.equal(r.method, "GET");
  assert.equal(r.x402Version, 2);
  assert.deepEqual(r.groups, [{ index: 0, scheme: "exact", network: NET, asset: USDC, plainOnly: [A], repeatOnly: [B] }]);
});

test("paytoRule yields id, level, method and title", () => {
  const f = paytoRule(ex(ch2(opt(A)), ch2(opt(B)), { method: "POST" }));
  assert.ok(f);
  assert.equal(f.id, "payto-rotates");
  assert.equal(f.level, "warn");
  assert.equal(f.method, "POST");
  assert.equal(f.title, "payTo changes between two requests");
});

test("3: letter case difference counts", () => {
  const lower = "0xabcdef0000000000000000000000000000000001";
  const mixed = "0xAbCdEf0000000000000000000000000000000001";
  const r = findRotation(ex(ch2(opt(lower)), ch2(opt(mixed))));
  assert.deepEqual(r?.groups[0].plainOnly, [lower]);
  assert.deepEqual(r?.groups[0].repeatOnly, [mixed]);
});

test("4: reordered accepts[] with the same addresses: no finding", () => {
  const second = opt(B, OTHER);
  assert.equal(findRotation(ex(ch2(opt(A), second), ch2(second, opt(A)))), undefined);
});

test("5: same triple with fixed different addresses, order swapped: no finding", () => {
  assert.equal(findRotation(ex(ch2(opt(A), opt(B)), ch2(opt(B), opt(A)))), undefined);
});

test("6: a group that gains, loses or repeats an address: no finding", () => {
  assert.equal(findRotation(ex(ch2(opt(A), opt(B)), ch2(opt(A)))), undefined);
  assert.equal(findRotation(ex(ch2(opt(A)), ch2(opt(A), opt(B)))), undefined);
  assert.equal(findRotation(ex(ch2(opt(A), opt(A)), ch2(opt(A)))), undefined);
  assert.equal(findRotation(ex(ch2(opt(A)), ch2(opt(A), opt(A)))), undefined);
});

test("7: two groups, only the second rotates: names that group only", () => {
  const r = findRotation(ex(ch2(opt(A), opt(B, OTHER)), ch2(opt(A), opt(C, OTHER))));
  assert.equal(r?.groups.length, 1);
  assert.equal(r?.groups[0].index, 1);
  assert.equal(r?.groups[0].network, OTHER.network);
  assert.deepEqual(r?.groups[0].plainOnly, [B]);
  assert.deepEqual(r?.groups[0].repeatOnly, [C]);
});

test("8: repeat missing, not 402 (including 412), or without a readable challenge: no finding", () => {
  const p = ch2(opt(A));
  const q = ch2(opt(B));
  const none = { originStatus: undefined, originChallenge: undefined, originVersion: undefined };
  assert.equal(findRotation(ex(p, undefined, none)), undefined);
  assert.equal(findRotation(ex(p, q, { originStatus: 200 })), undefined);
  assert.equal(findRotation(ex(p, q, { originStatus: 412 })), undefined);
  assert.equal(findRotation(ex(p, q, { status: 412 })), undefined);
  assert.equal(findRotation(ex(p, undefined)), undefined);
  assert.equal(findRotation(ex(p, "not a challenge", { originVersion: 2 })), undefined);
  assert.equal(findRotation(ex(p, { x402Version: 2, accepts: [] })), undefined);
});

test("9: plain v2, repeat v1: no finding", () => {
  assert.equal(findRotation(ex(ch2(opt(A)), ch1({ ...v1.accepts[0], payTo: B }))), undefined);
});

test("10: a group present on one side only: skipped", () => {
  assert.equal(findRotation(ex(ch2(opt(A)), ch2(opt(B, OTHER)))), undefined);
});

test("11: non-string or missing payTo: entry skipped, no crash", () => {
  const noPayTo: Record<string, unknown> = { ...v2.accepts[0] };
  delete noPayTo.payTo;
  assert.equal(findRotation(ex(ch2(opt(42), noPayTo, null, "x", opt(null), opt(A)), ch2(opt(A), opt({}), noPayTo))), undefined);
  const r = findRotation(ex(ch2(opt(42), noPayTo, null, opt(A)), ch2(opt(B))));
  assert.equal(r?.groups[0].index, 3);
});

test("12: v1 challenge with a different payTo is found", () => {
  const r = findRotation(ex(ch1({ ...v1.accepts[0], payTo: A }), ch1({ ...v1.accepts[0], payTo: B })));
  assert.ok(r);
  assert.equal(r.x402Version, 1);
  assert.deepEqual(r.groups[0].plainOnly, [A]);
  assert.deepEqual(r.groups[0].repeatOnly, [B]);
});

test("18: a large accepts[] returns and reports every rotating group (cap applied later)", () => {
  const n = 1000;
  const plain = ch2(...Array.from({ length: n }, (_, i) => opt(`a${i}`, { asset: `asset-${i}` })));
  const repeat = ch2(...Array.from({ length: n }, (_, i) => opt(`b${i}`, { asset: `asset-${i}` })));
  const r = findRotation(ex(plain, repeat));
  assert.equal(r?.groups.length, n);
  assert.equal(r?.groups[n - 1].index, n - 1);
});

test("19: prototype-like names and colliding triples are grouped correctly", () => {
  for (const name of ["__proto__", "constructor", "toString"]) {
    const o = (payTo: string) => opt(payTo, { scheme: name, network: name, asset: name });
    const r = findRotation(ex(ch2(o(A)), ch2(o(B))));
    assert.deepEqual(r?.groups, [{ index: 0, scheme: name, network: name, asset: name, plainOnly: [A], repeatOnly: [B] }]);
    assert.equal(findRotation(ex(ch2(o(A)), ch2(o(A)))), undefined);
  }
  // These two triples would collide if joined with a separator; they are different groups.
  const x = (payTo: string) => opt(payTo, { scheme: "a|b", network: "c", asset: "d" });
  const y = (payTo: string) => opt(payTo, { scheme: "a", network: "b|c", asset: "d" });
  assert.equal(findRotation(ex(ch2(x(A)), ch2(y(B)))), undefined);
  const r = findRotation(ex(ch2(x(A), y(B)), ch2(x(C), y(B))));
  assert.equal(r?.groups.length, 1);
  assert.equal(r?.groups[0].scheme, "a|b");
});

const detailOf = (plain: unknown, repeat: unknown, over: Partial<Extracted> = {}) => paytoRule(ex(plain, repeat, over))?.detail ?? "";

test("2 (text): shortened addresses, where and the v2 sentence", () => {
  const d = detailOf(ch2(opt(A)), ch2(opt(B)));
  assert.equal(
    d,
    `Two unpaid GET requests sent a moment apart, the second with an Origin header as a browser sends it, got different payTo addresses: accepts[0] (USDC on "eip155:84532") "0x1111\u20261111", then "0x2222\u20262222". A client signs its payment to the address in the challenge it read. A server built on @x402/core 2.x builds payTo again for the paid request and accepts the payment only if your payTo function returns, for that request, an address it issued to this buyer. Buyer-side spend tools that approve or pin recipients per host see a new recipient on every call and may hold or refuse the payment.`,
  );
  assert.equal(
    paytoRule(ex(ch2(opt(A)), ch2(opt(B))))?.fix,
    "Return one stable payTo for the resource on every request. If you must issue one address per payment, decode the payment header for the paid retry (context.paymentHeader, the base64 PAYMENT-SIGNATURE) and return its accepted.payTo only if it is an address you issued and have not used yet; never return it unchecked. Tell buyers which addresses are yours.",
  );
});

test("12 (text): v1 sentence", () => {
  const d = detailOf(ch1({ ...v1.accepts[0], payTo: A }), ch1({ ...v1.accepts[0], payTo: B }));
  assert.match(d, /The facilitator rejects a payment signed to a different payTo than the one your server checks it against\. Buyer-side/);
  assert.doesNotMatch(d, /@x402\/core/);
  assert.match(d, /\(USDC on "base-sepolia"\)/);
});

test("13: control characters and very long payTo are cleaned and capped", () => {
  const evil = "0xAAAA\u001b[31m\u202e" + "x".repeat(500);
  const d = detailOf(ch2(opt(evil)), ch2(opt(B)));
  assert.doesNotMatch(d, /[\u0000-\u001f\u202e]/);
  assert.match(d, /"0xAAAA\u2026xxxx", then/);
  assert.ok(d.includes('accepts[0] (USDC on "eip155:84532") "0xAAAA\u2026xxxx", then "0x2222\u20262222". A client'));
  const net = "ne\u001bt" + "n".repeat(100);
  assert.doesNotMatch(detailOf(ch2(opt(A, { network: net })), ch2(opt(B, { network: net }))), /\u001b/);
});

test("14: values of 12 characters or fewer are printed unshortened", () => {
  assert.match(detailOf(ch2(opt("abcdefghijkl")), ch2(opt("short"))), /\) "abcdefghijkl", then "short"\./);
  assert.match(detailOf(ch2(opt("abcdefghijklm")), ch2(opt("short"))), /\) "abcdef\u2026jklm", then "short"\./);
});

test("15: addresses equal in first 6 and last 4 characters: the group is printed in full", () => {
  const x = "0xabcd" + "1".repeat(30) + "wxyz";
  const y = "0xabcd" + "2".repeat(30) + "wxyz";
  const d = detailOf(ch2(opt(x)), ch2(opt(y)));
  assert.ok(d.includes(`"${x}", then "${y}"`));
  assert.doesNotMatch(d, /look the same/);
});

test("16: addresses differing only in removed characters: look-alike note", () => {
  const x = "0xabcd" + "1".repeat(30) + "wxyz";
  const y = "0xabcd" + "1".repeat(15) + "\u202e" + "1".repeat(15) + "wxyz";
  const d = detailOf(ch2(opt(x)), ch2(opt(y)));
  assert.ok(d.includes(`"${x}", then "${x}" (these look the same here but differ)`));
  assert.match(detailOf(ch2(opt("\u202e")), ch2(opt("\u001b"))), /\(these look the same here but differ\)/);
});

test("17: more than three rotating groups: three listed, then and <n> more", () => {
  const mk = (p: string) => ch2(...[0, 1, 2, 3, 4].map((i) => opt(`${p}${i}`, { asset: `asset-${i}` })));
  const d = detailOf(mk("a"), mk("b"));
  assert.equal(d.match(/accepts\[\d\]/g)?.length, 3);
  assert.match(d, /accepts\[2\] \("asset-2" on "eip155:84532"\) "a2", then "b2"; and 2 more\. A client/);
  const three = detailOf(ch2(...[0, 1, 2].map((i) => opt(`a${i}`, { asset: `s${i}` }))), ch2(...[0, 1, 2].map((i) => opt(`b${i}`, { asset: `s${i}` }))));
  assert.doesNotMatch(three, /more/);
  const five = (p: string) => [0, 1, 2, 3, 4].map((i) => opt(`${p}${i}`));
  const d5 = detailOf(ch2(...five("a")), ch2(...five("b")));
  assert.ok(d5.includes('(USDC on "eip155:84532") "a0" and "a1" and "a2" and 2 more, then "b0" and "b1" and "b2" and 2 more. A client'));
});

test("17 (cap): 1000 addresses per side keep the detail short", () => {
  const many = (p: string) => ch2(...Array.from({ length: 1000 }, (_, i) => opt(`${p}${i}`)));
  const d = detailOf(many("a"), many("b"));
  assert.ok(d.length < 2000, `detail has ${d.length} characters`);
  assert.ok(d.includes('"a0" and "a1" and "a2" and 997 more, then "b0" and "b1" and "b2" and 997 more'));
});

test("several addresses on one side are joined with and", () => {
  const d = detailOf(ch2(opt(A), opt(B)), ch2(opt(C)));
  assert.match(d, /"0x1111\u20261111" and "0x2222\u20262222", then "0x3333\u20263333"/);
});

test("18 (text): a large accepts[] lists at most three groups", () => {
  const n = 1000;
  const plain = ch2(...Array.from({ length: n }, (_, i) => opt(`a${i}`, { asset: `asset-${i}` })));
  const repeat = ch2(...Array.from({ length: n }, (_, i) => opt(`b${i}`, { asset: `asset-${i}` })));
  const d = detailOf(plain, repeat);
  assert.equal(d.match(/accepts\[\d+\]/g)?.length, 3);
  assert.match(d, /; and 997 more\./);
});

test("hostile plain side: no finding, no throw", () => {
  const rep = ch2(opt(B));
  assert.equal(paytoRule(ex({ ...v2, accepts: [] }, rep)), undefined);
  assert.equal(paytoRule(ex({ ...v2, accepts: "nope" }, rep)), undefined);
  assert.equal(paytoRule(ex({ ...v2, accepts: { 0: opt(A) } }, rep)), undefined);
  assert.equal(paytoRule(ex([opt(A)], rep, { version: 2 })), undefined);
  assert.equal(paytoRule(ex(null, rep, { version: 2 })), undefined);
});

test("16 (look-alikes): U+3164 and Cyrillic a are printed as escapes", () => {
  const base = (mid: string) => "0xabcd" + "1".repeat(15) + mid + "1".repeat(15) + "wxyz";
  const d1 = detailOf(ch2(opt(base("1"))), ch2(opt(base("\u3164"))));
  assert.ok(d1.includes("\\u{3164}"));
  assert.doesNotMatch(d1, /look the same/);
  const d2 = detailOf(ch2(opt(base("a"))), ch2(opt(base("\u0430"))));
  assert.ok(d2.includes("\\u{0430}"));
  assert.doesNotMatch(d2, /look the same/);
});

test("16 (cut): values differing only after character 100", () => {
  const d = detailOf(ch2(opt("0x" + "a".repeat(120) + "1")), ch2(opt("0x" + "a".repeat(120) + "2")));
  assert.ok(d.includes(" (these look the same here but differ). A client"));
  assert.ok(d.includes(`"0x${"a".repeat(98)}\u2026"`));
});

test("16 (empty): a value empty after cleaning prints (empty)", () => {
  assert.match(detailOf(ch2(opt("\u200b")), ch2(opt(B))), /\) \(empty\), then "0x2222\u20262222"\./);
  assert.match(detailOf(ch2(opt("\u200b")), ch2(opt("\u200b\u200b"))), /\) \(empty\), then \(empty\) \(these look the same here but differ\)\./);
});

test("16 (limit): 100 non-ASCII characters in full mode print at most 100 characters before the ellipsis", () => {
  const x = "\u00e9".repeat(100);
  const d = detailOf(ch2(opt(x + "1")), ch2(opt(x + "2")));
  const m = /\) "(.*?)\u2026", then/.exec(d);
  assert.ok(m);
  assert.ok(Array.from(m[1]!).length <= 100);
  assert.ok(m[1]!.endsWith("\\u{00E9}"));
  assert.match(d, /\(these look the same here but differ\)/);
});

test("16 (backslash): literal \\u{3164} text against real U+3164 prints differently, no note", () => {
  const lit = "0xabcd" + "1".repeat(15) + "\\u{3164}" + "1".repeat(15) + "wxyz";
  const real = "0xabcd" + "1".repeat(15) + "\u3164" + "1".repeat(15) + "wxyz";
  const d = detailOf(ch2(opt(lit)), ch2(opt(real)));
  assert.ok(d.includes("\\u{005C}u{3164}"));
  assert.ok(d.includes("1\\u{3164}1"));
  assert.doesNotMatch(d, /look the same/);
});

test("16 (literal marker): literal (empty) against only U+200B prints differently, no note", () => {
  const d = detailOf(ch2(opt("(empty)")), ch2(opt("\u200b")));
  assert.ok(d.includes(') "(empty)", then (empty). A client'));
  assert.doesNotMatch(d, /look the same/);
});

test("shorten: quotes, escapes and the cut in the middle", () => {
  assert.equal(shorten(A), '"0x1111\u20261111"');
  assert.equal(shorten("short"), '"short"');
  assert.equal(shorten("\u200b"), "(empty)");
});

test("16 (quotes and spaces): quotes are escaped and a run of spaces across the cut stays escaped", () => {
  const d = detailOf(ch2(opt(`0x"'abccc   yz`)), ch2(opt(B)));
  assert.ok(d.includes(') "0x\\u{0022}\\u{0027}ab\u2026\\u{0020}\\u{0020}yz", then "0x2222\u20262222". A client'));
  assert.doesNotMatch(d, /look the same/);
});

test("16 (non-ASCII cut): values differing only past the printed limit end with the look-alike note", () => {
  const e = "\u00e9".repeat(20);
  const d = detailOf(ch2(opt(e + "1" + e)), ch2(opt(e + "2" + e)));
  assert.match(d, /\(these look the same here but differ\)\. A client/);
  assert.doesNotMatch(d, /character 100/);
});

test("16 (removed in the middle): a removed character against the plain value ends with the note", () => {
  const d = detailOf(ch2(opt("x".repeat(60) + "\u200b" + "x".repeat(60))), ch2(opt("x".repeat(120))));
  assert.match(d, /\(these look the same here but differ\)\. A client/);
});
