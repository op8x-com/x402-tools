import { test } from "node:test";
import assert from "node:assert/strict";
import { diffPaths, preflightPlan, runRules } from "../src/rules.ts";
import { extract } from "../src/extract.ts";
import { b64, pr, v1, v2 } from "./fixtures.ts";
import type { Finding, PreflightResult } from "../src/types.ts";

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

// CORS (x402 v2 HTTP transport, "Browser clients")

const ORIGIN_OK = { "access-control-allow-origin": "https://op8x.com" };
const EXPOSE_OK = { "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE" };
const corsV2 = (method: "GET" | "POST", headers: Record<string, string> = { ...ORIGIN_OK, ...EXPOSE_OK }) =>
  extract(pr(method, 402, { ...NS, "payment-required": b64(v2), ...headers }, {}));
const pf = (status: number | undefined, headers: Record<string, string> = {}, error?: string): PreflightResult => ({
  method: "OPTIONS",
  url: "https://api.example.com/weather",
  requestMethod: "POST",
  requestHeaders: "payment-signature,content-type",
  headers,
  ms: 1,
  ...(status !== undefined ? { status } : {}),
  ...(error ? { error } : {}),
});
const PF_OK = {
  "access-control-allow-origin": "https://op8x.com",
  "access-control-allow-headers": "PAYMENT-SIGNATURE, Content-Type, Access-Control-Expose-Headers",
};

test("fully configured CORS produces no CORS findings", () => {
  const fs = runRules([corsV2("GET"), corsV2("POST")], pf(204, PF_OK));
  assert.deepEqual(ids(fs).filter((i) => i.startsWith("cors-")), []);
});

test("402 without Access-Control-Allow-Origin warns once and skips the other CORS checks", () => {
  const fs = runRules([v2ok("GET"), v2ok("POST")]);
  const f = fs.filter((x) => x.id.startsWith("cors-"));
  assert.deepEqual(ids(f), ["cors-allow-origin"]);
  assert.equal(f[0].level, "warn");
  assert.equal(f[0].method, "both");
  assert.match(f[0].detail, /browser/i);
});

test("missing expose headers lists the v2 names", () => {
  const fs = runRules([corsV2("GET", ORIGIN_OK)], pf(204, PF_OK));
  const f = fs.find((x) => x.id === "cors-expose-headers");
  assert.equal(f?.level, "warn");
  assert.match(f?.detail ?? "", /PAYMENT-REQUIRED, PAYMENT-RESPONSE/);
});

test("expose * counts without credentials but not with credentials", () => {
  const star = { ...ORIGIN_OK, "access-control-expose-headers": "*" };
  assert.equal(ids(runRules([corsV2("GET", star)], pf(204, PF_OK))).includes("cors-expose-headers"), false);
  const cred = { ...star, "access-control-allow-credentials": "true" };
  const f = runRules([corsV2("GET", cred)], pf(204, PF_OK)).find((x) => x.id === "cors-expose-headers");
  assert.ok(f);
  assert.match(f.detail, /credentialed/);
});

test("dual-version endpoint must expose X-PAYMENT-RESPONSE too", () => {
  const e = extract(pr("GET", 402, { ...NS, ...ORIGIN_OK, ...EXPOSE_OK, "payment-required": b64(v2) }, v1));
  const f = runRules([e], pf(204, PF_OK)).find((x) => x.id === "cors-expose-headers");
  assert.ok(f);
  assert.match(f.detail, /X-PAYMENT-RESPONSE/);
  assert.doesNotMatch(f.detail, /missing: PAYMENT-REQUIRED/);
});

test("preflight that requires payment warns", () => {
  const f = runRules([corsV2("POST")], pf(402, ORIGIN_OK)).find((x) => x.id === "cors-preflight");
  assert.equal(f?.level, "warn");
  assert.equal(f?.method, "OPTIONS");
  assert.match(f?.title ?? "", /requires payment/);
});

test("rejected, failed and origin-less preflights warn", () => {
  assert.ok(ids(runRules([corsV2("POST")], pf(405))).includes("cors-preflight"));
  assert.ok(ids(runRules([corsV2("POST")], pf(undefined, {}, "fetch failed"))).includes("cors-preflight"));
  assert.ok(ids(runRules([corsV2("POST")], pf(204, { "access-control-allow-headers": "*" }))).includes("cors-preflight"));
});

test("allow headers missing PAYMENT-SIGNATURE and Content-Type warns", () => {
  const f = runRules([corsV2("POST")], pf(204, { ...ORIGIN_OK, "access-control-allow-headers": "authorization" })).find(
    (x) => x.id === "cors-allow-headers",
  );
  assert.equal(f?.level, "warn");
  assert.match(f?.detail ?? "", /PAYMENT-SIGNATURE, Content-Type/);
});

test("allow headers * does not count with credentials", () => {
  const star = { ...ORIGIN_OK, "access-control-allow-headers": "*" };
  assert.equal(ids(runRules([corsV2("POST")], pf(204, star))).includes("cors-allow-headers"), false);
  const cred = { ...star, "access-control-allow-credentials": "true" };
  assert.ok(ids(runRules([corsV2("POST")], pf(204, cred))).includes("cors-allow-headers"));
});

test("v1 spelling X-PAYMENT is required when it was asked for", () => {
  const asked = { ...pf(204, PF_OK), requestHeaders: "payment-signature,content-type,x-payment" };
  const f = runRules([corsV2("POST")], asked).find((x) => x.id === "cors-allow-headers");
  assert.match(f?.detail ?? "", /X-PAYMENT/);
});

test("allow list without Access-Control-Expose-Headers gets the SDK retry advisory", () => {
  const exact = { ...ORIGIN_OK, "access-control-allow-headers": "payment-signature, content-type" };
  const f = runRules([corsV2("POST")], pf(204, exact)).find((x) => x.id === "cors-client-retry");
  assert.equal(f?.level, "info");
  assert.match(f?.detail ?? "", /2\.28\.0/);
  assert.match(f?.detail ?? "", /3478/);
});

test("preflightPlan asks for what a paying client sends", () => {
  assert.equal(preflightPlan([v2ok("GET")]), undefined);
  assert.deepEqual(preflightPlan([corsV2("GET"), corsV2("POST")]), {
    method: "POST",
    headers: "payment-signature,content-type",
  });
  assert.deepEqual(preflightPlan([corsV2("GET")]), { method: "GET", headers: "payment-signature" });
  const v1cors = extract(pr("POST", 402, { ...NS, ...ORIGIN_OK }, v1));
  assert.deepEqual(preflightPlan([v1cors]), { method: "POST", headers: "content-type,x-payment" });
});

// paymentFlow (core spec v2, section 6.1)

const withAccept = (a: Record<string, unknown>) =>
  extract(pr("GET", 402, { ...NS, "payment-required": b64({ ...v2, accepts: [{ ...v2.accepts[0], ...a }] }) }, {}));

test("known payment flows and authorization defaults pass", () => {
  for (const flow of ["authorization", "upfront", "escrow"]) {
    const fs = runRules([withAccept({ extra: { ...v2.accepts[0].extra, paymentFlow: flow } })]);
    assert.equal(ids(fs).includes("payment-flow"), false, flow);
  }
  assert.equal(ids(runRules([v2ok("GET")])).includes("payment-flow"), false);
});

test("unknown payment flow is an error", () => {
  const f = runRules([withAccept({ extra: { paymentFlow: "deferred" } })]).find((x) => x.id === "payment-flow");
  assert.equal(f?.level, "error");
  assert.match(f?.detail ?? "", /accepts\[0\]/);
  assert.match(f?.detail ?? "", /skip/);
});

test("scheme with a non-authorization default must declare paymentFlow", () => {
  const cases: Record<string, unknown>[] = [
    { scheme: "auth-capture" },
    { scheme: "upto", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
    { scheme: "exact", network: "lnbtc:000000000019d6689c085ae165831e93" },
  ];
  for (const c of cases) {
    const f = runRules([withAccept(c)]).find((x) => x.id === "payment-flow");
    assert.equal(f?.level, "warn", JSON.stringify(c));
  }
  assert.match(runRules([withAccept(cases[0])]).find((x) => x.id === "payment-flow")?.fix ?? "", /"escrow"/);
  assert.equal(ids(runRules([withAccept({ scheme: "upto" })])).includes("payment-flow"), false);
});
