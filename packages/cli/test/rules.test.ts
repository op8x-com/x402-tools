import { test } from "node:test";
import assert from "node:assert/strict";
import { diffPaths, runRules } from "../src/rules.ts";
import { extract } from "../src/extract.ts";
import { b64, pr, v1, v2 } from "./fixtures.ts";
import type { Finding } from "../src/types.ts";

const NS = { "cache-control": "no-store" };
const ids = (fs: Finding[]) => fs.map((f) => f.id);
const errors = (fs: Finding[]) => fs.filter((f) => f.level === "error").map((f) => f.id);
const v2ok = (method: "GET" | "POST") => extract(pr(method, 402, { ...NS, "payment-required": b64(v2) }, {}));

test("valid v2 on both methods: no errors, merged official-client pass", () => {
  const fs = runRules([v2ok("GET"), v2ok("POST")]);
  assert.deepEqual(errors(fs), []);
  const pass = fs.filter((f) => f.id === "official-client");
  assert.equal(pass.length, 1);
  assert.equal(pass[0].level, "pass");
  assert.equal(pass[0].method, "both");
});

test("v2 only in body", () => {
  const fs = runRules([extract(pr("GET", 402, NS, v2))]);
  assert.ok(ids(fs).includes("v2-body-only"));
  assert.equal(fs.find((f) => f.id === "official-client")?.level, "error");
});

test("header and body drift lists differing paths", () => {
  const body = { ...v2, accepts: [{ ...v2.accepts[0], amount: "20000" }] };
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(v2) }, body))]);
  const drift = fs.find((f) => f.id === "header-body-drift");
  assert.ok(drift);
  assert.match(drift.detail, /accepts\.0\.amount/);
});

test("header not base64", () => {
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": "a-b_c" }, {}))]);
  assert.ok(ids(fs).includes("header-not-base64"));
});

test("header not JSON", () => {
  const raw = Buffer.from("hello").toString("base64");
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": raw }, {}))]);
  assert.ok(ids(fs).includes("header-not-json"));
});

test("402 without any challenge", () => {
  const fs = runRules([extract(pr("GET", 402, NS, {}))]);
  assert.ok(ids(fs).includes("no-challenge"));
});

test("string version", () => {
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64({ ...v2, x402Version: "2" }) }, {}))]);
  const f = fs.find((x) => x.id === "version-missing");
  assert.ok(f);
  assert.match(f.detail, /"2" \(string\)/);
});

test("v2 with legacy network name gets a CAIP-2 hint and no duplicate schema finding", () => {
  const bad = { ...v2, accepts: [{ ...v2.accepts[0], network: "base" }] };
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(bad) }, {}))]);
  const f = fs.find((x) => x.id === "v2-legacy-network");
  assert.ok(f);
  assert.match(f.fix ?? "", /eip155:8453/);
  assert.equal(fs.some((x) => x.id === "schema" && x.title.includes("accepts.0.network")), false);
});

test("v2 using maxAmountRequired is mixed dialect, without duplicate schema finding", () => {
  const { amount: _amount, ...rest } = v2.accepts[0];
  const bad = { ...v2, accepts: [{ ...rest, maxAmountRequired: "10000" }] };
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(bad) }, {}))]);
  assert.ok(ids(fs).includes("mixed-dialect"));
  assert.equal(fs.some((x) => x.id === "schema" && x.title.includes("accepts.0.amount")), false);
});

test("schema errors are reported per field", () => {
  const bad = { ...v2, accepts: [{ ...v2.accepts[0], maxTimeoutSeconds: -1 }] };
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(bad) }, {}))]);
  assert.ok(fs.some((x) => x.id === "schema" && x.title.includes("accepts.0.maxTimeoutSeconds")));
});

test("v1 with CAIP-2 network warns", () => {
  const bad = { ...v1, accepts: [{ ...v1.accepts[0], network: "eip155:84532" }] };
  const fs = runRules([extract(pr("GET", 402, NS, bad))]);
  assert.equal(fs.find((x) => x.id === "v1-caip2-network")?.level, "warn");
});

test("valid v1 is info, not error", () => {
  const fs = runRules([extract(pr("GET", 402, NS, v1))]);
  assert.deepEqual(errors(fs), []);
  assert.equal(fs.find((x) => x.id === "v1-legacy")?.level, "info");
});

test("missing no-store warns", () => {
  const fs = runRules([extract(pr("GET", 402, { "payment-required": b64(v2) }, {}))]);
  assert.equal(fs.find((x) => x.id === "cache-control")?.level, "warn");
});

test("no 402 on any method", () => {
  const fs = runRules([extract(pr("GET", 200, {}, { ok: true })), extract(pr("POST", 200, {}, { ok: true }))]);
  const f = fs.find((x) => x.id === "no-402");
  assert.ok(f);
  assert.equal(f.method, "both");
  assert.match(f.fix ?? "", /without payment/);
});

test("GET 405 but POST 402 is a verb mismatch", () => {
  const fs = runRules([extract(pr("GET", 405)), v2ok("POST")]);
  assert.equal(fs.find((x) => x.id === "verb-mismatch")?.level, "warn");
  assert.equal(ids(fs).includes("no-402"), false);
});

test("redirect warns", () => {
  const fs = runRules([extract(pr("GET", 302, { location: "https://elsewhere.example/" }))]);
  assert.equal(fs.find((x) => x.id === "redirect")?.level, "warn");
});

test("network failure is a request-failed error", () => {
  const fs = runRules([extract({ method: "GET", url: "u", headers: {}, bodyText: "", ms: 1, error: "fetch failed (ECONNREFUSED)" })]);
  assert.equal(fs.find((x) => x.id === "request-failed")?.level, "error");
});

test("412 with permit2_allowance_required counts as a challenge", () => {
  const c = { ...v2, error: "permit2_allowance_required" };
  const fs = runRules([extract(pr("GET", 412, { ...NS, "payment-required": b64(c) }, {}))]);
  assert.equal(ids(fs).includes("no-402"), false);
});

test("diffPaths", () => {
  assert.deepEqual(diffPaths({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } }), ["b.c"]);
  assert.deepEqual(diffPaths([1, 2], [1, 2]), []);
  assert.deepEqual(diffPaths({ a: 1 }, { a: 1, x: 2 }), ["x"]);
});
