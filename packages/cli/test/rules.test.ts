import { test } from "node:test";
import assert from "node:assert/strict";
import { diffPaths, driftDetail, jsonKind, preflightPlan, runRules } from "../src/rules.ts";
import { extract } from "../src/extract.ts";
import { b64, b64raw, pf, pr, v1, v2 } from "./fixtures.ts";
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

test("v2 legacy network hint covers every v1 name default clients know", () => {
  const hint = (network: string) => {
    const bad = { ...v2, accepts: [{ ...v2.accepts[0], network }] };
    return runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(bad) }, {}))]).find((x) => x.id === "v2-legacy-network")?.fix;
  };
  assert.equal(hint("solana"), "Use 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'.");
  assert.equal(hint("sei"), "Use 'eip155:1329'.");
});

test("v2 legacy network hint ignores prototype keys", () => {
  for (const network of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const bad = { ...v2, accepts: [{ ...v2.accepts[0], network }] };
    const f = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(bad) }, {}))]).find((x) => x.id === "v2-legacy-network");
    assert.equal(f?.fix, "Use the CAIP-2 identifier, e.g. 'eip155:8453' for Base.", network);
  }
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
  assert.deepEqual(diffPaths({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } }), [["b", "c"]]);
  assert.deepEqual(diffPaths([1, 2], [1, 2]), []);
  assert.deepEqual(diffPaths({ a: 1 }, { a: 1, x: 2 }), [["x"]]);
  assert.deepEqual(diffPaths({ "a.b": 1 }, { "a.b": 2 }), [["a.b"]]);
  assert.deepEqual(diffPaths(1, 2), [[]]);
});

// JSON.parse creates "__proto__" as an own key; a literal { __proto__: {} } would set the prototype instead.
const withProto = () => JSON.parse(JSON.stringify(v2).replace(/^\{/, '{"__proto__":{},'));

test("diffPaths reads own properties only, so __proto__ on one side differs", () => {
  assert.deepEqual(diffPaths({}, JSON.parse('{"__proto__":{}}')), [["__proto__"]]);
  assert.deepEqual(diffPaths(JSON.parse('{"__proto__":{}}'), {}), [["__proto__"]]);
});

test("header-body-drift reports __proto__ present on one side only", () => {
  const bodyOnly = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(v2) }, withProto()))]);
  assert.equal(bodyOnly.find((f) => f.id === "header-body-drift")?.detail, "Differing fields: __proto__");
  const headerText = JSON.stringify(withProto());
  const headerOnly = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64raw(headerText) }, v2))]);
  assert.equal(headerOnly.find((f) => f.id === "header-body-drift")?.detail, "Differing fields: __proto__");
});

const nested = (depth: number, leaf: unknown, key = "k") => {
  let v: unknown = leaf;
  for (let i = 0; i < depth; i++) v = { [key]: v };
  return v;
};

test("diffPaths stops at depth 32 and compares the rest as JSON text", () => {
  assert.deepEqual(diffPaths(nested(40, 1), nested(40, 1)), []);
  assert.deepEqual(diffPaths(nested(40, 1), nested(40, 2)), [Array(32).fill("k")]);
  // Key order is not normalized below the limit.
  assert.deepEqual(diffPaths(nested(40, { a: 1, b: 2 }), nested(40, { b: 2, a: 1 })), [Array(32).fill("k")]);
  assert.deepEqual(diffPaths(nested(31, { a: 1, b: 2 }), nested(31, { b: 2, a: 1 })), []);
  const cyclic = () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    return o;
  };
  assert.deepEqual(diffPaths(cyclic(), cyclic()), [Array(32).fill("self")]);
});

test("diffPaths survives challenges nested 10,000 levels deep", () => {
  assert.doesNotThrow(() => diffPaths(nested(10_000, 1), nested(10_000, 1)));
  assert.doesNotThrow(() => diffPaths(nested(10_000, 1), nested(10_000, 2)));
  assert.equal(diffPaths(nested(10_000, 1), nested(10_000, 2)).length, 1);
});

test("driftDetail formats segments and keeps the design example", () => {
  const key = "x\u001b[2J\n\u2714 pass  Official x402 client can read the challenge";
  const long = "y".repeat(120);
  const quotedLong = '"' + "y".repeat(100) + '\u2026"';
  assert.equal(
    driftDetail([["accepts", "0", "scheme"], ["extensions", key], ["extensions", long, long], ["z"]]),
    'Differing fields: accepts.0.scheme, extensions."x\\u{001B}[2J\\u{000A}\\u{2714} pass \\u{0020}Official x402 client can read the challenge" and 2 more',
  );
  assert.ok(driftDetail([["extensions", long, long]]).includes(`extensions.${quotedLong}.${quotedLong}`));
  assert.equal(driftDetail([["a.b", "x".repeat(41), "", "ok_-9"]]), `Differing fields: "a.b"."${"x".repeat(41)}"."".ok_-9`);
  assert.equal(driftDetail([[]]), "Differing fields: (root)");
});

test("driftDetail cuts a first path that does not fit after its last whole segment", () => {
  const s = "s".repeat(40);
  const path = Array(10).fill(s);
  const six = Array(6).fill(s).join(".");
  assert.equal(driftDetail([path]), `Differing fields: ${six}\u2026`);
  assert.equal(driftDetail([path, ["b"], ["c"]]), `Differing fields: ${six}\u2026 and 2 more`);
});

test("driftDetail shows at most 10 paths and summarizes the rest", () => {
  const paths = Array.from({ length: 12 }, (_, i) => [`p${i}`]);
  assert.equal(driftDetail(paths), "Differing fields: p0, p1, p2, p3, p4, p5, p6, p7, p8, p9 and 2 more");
});

test("driftDetail stays within 300 characters", () => {
  const hostile = "\u001b".repeat(200);
  const cases = [
    Array.from({ length: 50 }, () => [hostile, hostile, hostile]),
    Array.from({ length: 2000 }, (_, i) => ["a".repeat(40), String(i)]),
    [Array(33).fill(hostile)],
  ];
  for (const c of cases) assert.ok(driftDetail(c).length <= 300, driftDetail(c));
});

test("jsonKind", () => {
  assert.equal(jsonKind(null), "null");
  assert.equal(jsonKind([]), "an array");
  assert.equal(jsonKind({}), "an object");
  assert.equal(jsonKind(1), "a number");
});

// CORS (x402 v2 HTTP transport, "Browser clients")

const ORIGIN_OK = { "access-control-allow-origin": "https://op8x.com" };
const EXPOSE_OK = { "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE" };
const corsV2 = (method: "GET" | "POST", headers: Record<string, string> = { ...ORIGIN_OK, ...EXPOSE_OK }) =>
  extract(pr(method, 402, { ...NS, "payment-required": b64(v2), ...headers }, {}));
const PF_OK = {
  "access-control-allow-origin": "https://op8x.com",
  "access-control-allow-headers": "PAYMENT-SIGNATURE, Content-Type, Access-Control-Expose-Headers",
};

test("fully configured CORS produces no CORS findings", () => {
  const fs = runRules([corsV2("GET"), corsV2("POST")], pf(204, PF_OK));
  assert.deepEqual(ids(fs).filter((i) => i.startsWith("cors-")), []);
});

test("browser probe without 402 is a hint and skips the other CORS checks", () => {
  const refused = (m: "GET" | "POST") => ({ ...corsV2(m), originStatus: 403 });
  const fs = runRules([refused("GET"), refused("POST")], pf(204, PF_OK));
  const f = fs.filter((x) => x.id.startsWith("cors-"));
  assert.deepEqual(ids(f), ["cors-origin-refused"]);
  assert.equal(f[0].level, "info");
  assert.match(f[0].detail, /returned 403/);
  assert.equal(preflightPlan([refused("GET")]), undefined);
});

test("402 without Access-Control-Allow-Origin is a hint once and skips the other CORS checks", () => {
  const fs = runRules([v2ok("GET"), v2ok("POST")]);
  const f = fs.filter((x) => x.id.startsWith("cors-"));
  assert.deepEqual(ids(f), ["cors-allow-origin"]);
  assert.equal(f[0].level, "info");
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
  assert.match(f?.detail ?? "", /2\.29\.0/);
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

test("unknown payment flow is an error in v1 too", () => {
  const bad = { ...v1, accepts: [{ ...v1.accepts[0], extra: { paymentFlow: "deferred" } }] };
  const f = runRules([extract(pr("GET", 402, NS, bad))]).find((x) => x.id === "payment-flow");
  assert.equal(f?.level, "error");
  assert.match(f?.detail ?? "", /accepts\[0\]/);
});

test("v1 without paymentFlow is not asked to declare one", () => {
  const bad = { ...v1, accepts: [{ ...v1.accepts[0], scheme: "auth-capture" }] };
  assert.equal(ids(runRules([extract(pr("GET", 402, NS, bad))])).includes("payment-flow"), false);
});

test("null payment flow counts as omitted, as in the official client", () => {
  assert.equal(ids(runRules([withAccept({ extra: { paymentFlow: null } })])).includes("payment-flow"), false);
  const f = runRules([withAccept({ scheme: "auth-capture", extra: { paymentFlow: null } })]).find((x) => x.id === "payment-flow");
  assert.equal(f?.level, "warn");
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
  assert.equal(runRules([withAccept(cases[0])]).find((x) => x.id === "payment-flow")?.fix, "Set extra.paymentFlow to 'escrow'.");
  assert.equal(ids(runRules([withAccept({ scheme: "upto" })])).includes("payment-flow"), false);
});

// MCP endpoints (docs/specs/2026-10-27-cli-mcp-endpoint-design.md)

const rpcError = (message = "Not Acceptable", id: unknown = null) => ({
  jsonrpc: "2.0",
  error: { code: -32000, message },
  id,
});
const get405 = () => extract(pr("GET", 405, {}, { error: "post only" }));
const post406 = (body: unknown = rpcError()) => extract(pr("POST", 406, {}, body));

test("MCP: GET 405 + POST 406 JSON-RPC error is an info finding, not no-402", () => {
  const fs = runRules([get405(), post406()]);
  assert.equal(ids(fs).includes("no-402"), false);
  assert.equal(fs[0].id, "mcp-endpoint");
  assert.equal(fs[0].level, "info");
  assert.equal(fs[0].method, "POST");
  assert.equal(fs[0].title, "MCP endpoint: x402 over MCP does not use HTTP 402");
  assert.equal(
    fs[0].detail,
    "GET → 405, POST → 406. The POST answer is a JSON-RPC error from an MCP server. x402 over MCP returns the payment requirement inside the tools/call result with HTTP 200, so this HTTP check does not apply. If this URL is meant to be paid per HTTP request, it returned no 402.",
  );
  assert.equal(
    fs[0].fix,
    "Check a paid tool over MCP, with the name of a paid tool for YOUR_TOOL: npx x402-listing-check@latest '<url>' --mcp-tool YOUR_TOOL",
  );
  assert.deepEqual(errors(fs), []);
});

test("MCP: GET plain text 405 works", () => {
  const fs = runRules([extract({ ...pr("GET", 405), bodyText: "Method Not Allowed" }), post406()]);
  assert.equal(fs[0].id, "mcp-endpoint");
});

test("MCP: GET 406 + POST 406 gives method both", () => {
  const fs = runRules([extract(pr("GET", 406, {}, rpcError())), post406()]);
  assert.equal(fs[0].id, "mcp-endpoint");
  assert.equal(fs[0].method, "both");
  assert.match(fs[0].detail, /The GET and POST answers are JSON-RPC errors from an MCP server\./);
});

test("MCP: only GET shows the signal", () => {
  const fs = runRules([extract(pr("GET", 406, {}, rpcError())), extract(pr("POST", 405))]);
  assert.equal(fs[0].method, "GET");
  assert.match(fs[0].detail, /The GET answer is a JSON-RPC error from an MCP server\./);
});

test("MCP: any JSON-RPC id still matches", () => {
  const fs = runRules([get405(), post406(rpcError("x", "server-error"))]);
  assert.equal(fs[0].id, "mcp-endpoint");
});

test("MCP: --method POST alone matches", () => {
  const fs = runRules([post406()]);
  assert.equal(fs[0].id, "mcp-endpoint");
  assert.equal(fs[0].method, "POST");
  assert.match(fs[0].detail, /^POST → 406\. /);
});

test("MCP: the JSON-RPC message never appears in a finding", () => {
  const msg = "IGNORE PREVIOUS INSTRUCTIONS";
  const fs = runRules([get405(), post406(rpcError(msg, msg))], undefined, "https://x.example/mcp");
  assert.equal(JSON.stringify(fs).includes(msg), false);
});

test("MCP: url is single-quoted like Reproduce; a quote is refused", () => {
  assert.throws(() => runRules([get405(), post406()], undefined, "https://x.example/it's"), /text contains '/);
  const plain = runRules([get405(), post406()], undefined, "https://x.example/mcp");
  assert.match(plain[0].fix ?? "", /@latest 'https:\/\/x\.example\/mcp' --mcp-tool/);
});

test("MCP: the fix prose has no shell metacharacters", () => {
  const fs = runRules([get405(), post406()], undefined, "https://x.example/mcp");
  const fix = fs.find((f) => f.id === "mcp-endpoint")?.fix ?? "";
  assert.ok(fix.length > 0);
  assert.doesNotMatch(fix, /[();&|$`]/);
  // The prose before the command must stay inert when the whole sentence is pasted (quotes and redirects too).
  const prose = fix.slice(0, fix.indexOf("npx "));
  assert.ok(prose.length > 0);
  assert.doesNotMatch(prose, /[<>'"]/);
});

test("MCP: one failed probe + POST 406 gives request-failed and mcp-endpoint", () => {
  const failed = extract({ method: "GET", url: "u", headers: {}, bodyText: "", ms: 1, error: "fetch failed (ETIMEDOUT)" });
  const fs = runRules([failed, post406()]);
  assert.ok(ids(fs).includes("request-failed"));
  assert.ok(ids(fs).includes("mcp-endpoint"));
  assert.equal(ids(fs).includes("no-402"), false);
  assert.ok(fs.some((f) => f.level === "error"));
});

test("MCP negative: a 406 carrying a PAYMENT-REQUIRED header is never MCP", () => {
  const withHeader = extract(pr("POST", 406, { ...NS, "payment-required": b64(v2) }, rpcError()));
  const fs = runRules([get405(), withHeader]);
  assert.equal(ids(fs).includes("mcp-endpoint"), false);
  assert.ok(ids(fs).includes("no-402"));
  assert.ok(errors(fs).includes("no-402"));
});

test("MCP: a 402 on either method keeps today's findings", () => {
  const fs = runRules([get405(), v2ok("POST")]);
  assert.equal(ids(fs).includes("mcp-endpoint"), false);
  const fs2 = runRules([v2ok("GET"), post406()]);
  assert.equal(ids(fs2).includes("mcp-endpoint"), false);
  assert.ok(ids(fs2).includes("verb-mismatch"));
});

const stays = (label: string, probes: () => ReturnType<typeof extract>[]) =>
  test(`MCP negative: ${label} stays no-402`, () => {
    const fs = runRules(probes());
    assert.ok(ids(fs).includes("no-402"));
    assert.equal(ids(fs).includes("mcp-endpoint"), false);
  });

stays("POST 400 JSON-RPC error", () => [get405(), extract(pr("POST", 400, {}, rpcError()))]);
stays("POST 200 JSON-RPC error", () => [get405(), extract(pr("POST", 200, {}, rpcError()))]);
stays("POST 200 JSON-RPC result", () => [get405(), extract(pr("POST", 200, {}, { jsonrpc: "2.0", result: {}, id: 1 }))]);
stays("GET 200 + POST 406 JSON-RPC", () => [extract(pr("GET", 200, {}, { ok: true })), post406()]);
stays("jsonrpc 1.0", () => [get405(), post406({ jsonrpc: "1.0", error: { code: -32000, message: "m" }, id: null })]);
stays("jsonrpc number 2", () => [get405(), post406({ jsonrpc: 2, error: { code: -32000, message: "m" }, id: null })]);
stays("array body", () => [get405(), post406([rpcError()])]);
stays("error without integer code", () => [get405(), post406({ jsonrpc: "2.0", error: { code: "x", message: "m" }, id: null })]);
stays("error with float code", () => [get405(), post406({ jsonrpc: "2.0", error: { code: 1.5, message: "m" }, id: null })]);
stays("result key present", () => [get405(), post406({ jsonrpc: "2.0", error: { code: -32000 }, result: {}, id: null })]);
stays("non-JSON body", () => [get405(), extract({ ...pr("POST", 406), bodyText: "Not Acceptable" })]);
stays("3xx on the other probe", () => [extract(pr("GET", 302, { location: "/x" })), post406()]);

const HEADER_ONLY_TITLE = "v1 clients cannot read your terms: the body has no challenge";
const headerOnly = (fs: Finding[]) => fs.filter((f) => f.id === "v2-header-only");
const withBodyText = (bodyText: string) =>
  extract({ ...pr("GET", 402, { ...NS, "payment-required": b64(v2) }), bodyText });

test("v2 only in the header is an info hint for v1 clients, merged across methods", () => {
  const fs = runRules([v2ok("GET"), v2ok("POST")]);
  const f = headerOnly(fs);
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "info");
  assert.equal(f[0].method, "both");
  assert.equal(f[0].title, HEADER_ONLY_TITLE);
  assert.match(f[0].detail, /x402-fetch, x402-axios/);
  assert.match(f[0].fix ?? "", /generated from the same object as the header/);
  assert.deepEqual(errors(fs), []);
  assert.equal(fs.find((x) => x.id === "official-client")?.level, "pass");
});

test("v2 header-only hint covers empty, non-JSON and non-challenge bodies", () => {
  for (const body of ["", "<html>Payment required</html>", '{"error":"payment required"}', "[]"]) {
    assert.equal(headerOnly(runRules([withBodyText(body)])).length, 1, body);
  }
});

test("no v2 header-only hint when the body carries a challenge or the header is not v2", () => {
  const cases = [
    extract(pr("GET", 402, { ...NS, "payment-required": b64(v2) }, v2)), // mirrored
    extract(pr("GET", 402, { ...NS, "payment-required": b64(v2) }, { ...v2, accepts: [{ ...v2.accepts[0], amount: "1" }] })), // drift
    extract(pr("GET", 402, NS, v2)), // v2 body only
    extract(pr("GET", 402, NS, v1)), // v1 body only
    extract(pr("GET", 402, { ...NS, "payment-required": "a-b_c" }, {})), // not base64
    extract(pr("GET", 402, { ...NS, "payment-required": Buffer.from("not json").toString("base64") }, {})),
    extract(pr("GET", 402, { ...NS, "payment-required": b64(v1) }, {})), // v1 in header
    extract(pr("GET", 402, { ...NS, "payment-required": b64({ ...v2, x402Version: "2" }) }, {})),
    extract(pr("GET", 200, { ...NS, "payment-required": b64(v2) }, {})), // not a 402
  ];
  cases.forEach((e, i) => assert.equal(ids(runRules([e])).includes("v2-header-only"), false, `case ${i}`));
});

test("drift still reports an error and no header-only hint", () => {
  const body = { ...v2, accepts: [{ ...v2.accepts[0], amount: "20000" }] };
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(v2) }, body))]);
  assert.ok(errors(fs).includes("header-body-drift"));
  assert.equal(ids(fs).includes("v2-header-only"), false);
});

test("a body text that still starts with a BOM (double BOM on the wire) is not parsed: header-only hint, no drift", () => {
  const fs = runRules([withBodyText("\uFEFF" + JSON.stringify(v2))]);
  assert.equal(headerOnly(fs).length, 1);
  assert.equal(ids(fs).includes("header-body-drift"), false);
});

test("no v2 header-only hint when the header challenge fails the v2 schema", () => {
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64({ x402Version: 2 }) }, {}))]);
  assert.ok(errors(fs).includes("schema"));
  assert.equal(ids(fs).includes("v2-header-only"), false);
});

test("no v2 header-only hint for a v2 header with a legacy network name", () => {
  const bad = { ...v2, accepts: [{ ...v2.accepts[0], network: "base" }] };
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(bad) }, {}))]);
  assert.ok(errors(fs).includes("v2-legacy-network"));
  assert.equal(ids(fs).includes("v2-header-only"), false);
});

test("v2 header-only hint also applies to a 412 permit2_allowance_required", () => {
  const h = b64({ ...v2, error: "permit2_allowance_required" });
  const f = headerOnly(runRules([extract(pr("GET", 412, { ...NS, "payment-required": h }, {}))]));
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "info");
});

test("v2 header-only fix names the official clients to move to", () => {
  const f = headerOnly(runRules([v2ok("GET")]));
  assert.match(f[0].fix ?? "", /@x402\/fetch or @x402\/axios/);
});

const nonCors = (fs: Finding[]) => ids(fs).filter((id) => !id.startsWith("cors-")).sort();
const find = (fs: Finding[], id: string) => fs.find((f) => f.id === id);

test("empty header with v1 body: header-empty warn, official pass, no errors", () => {
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": "" }, v1))], undefined, "<url>", "9.9.9");
  assert.deepEqual(nonCors(fs), ["header-empty", "official-client", "testnet-only", "v1-legacy"]);
  assert.equal(find(fs, "header-empty")?.level, "warn");
  assert.equal(find(fs, "official-client")?.level, "pass");
  assert.equal(find(fs, "official-client")?.detail, "@x402/core 9.9.9 reads the challenge where the official client looks for it.");
  assert.deepEqual(errors(fs), []);
});

test("empty header without body challenge: header-empty, no-challenge, official error", () => {
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": "" }, {}))], undefined, "<url>", "9.9.9");
  assert.deepEqual(nonCors(fs), ["header-empty", "no-challenge", "official-client"]);
  const official = find(fs, "official-client");
  assert.equal(official?.level, "error");
  assert.match(official?.detail ?? "", /^@x402\/core 9\.9\.9: Invalid payment required response\. The official client would fail before signing; see the other findings\.$/);
});

test("header-empty only for an empty header on a 402", () => {
  assert.equal(find(runRules([extract(pr("GET", 402, NS, v1))]), "header-empty"), undefined);
  assert.equal(find(runRules([extract(pr("GET", 200, { "payment-required": "" }))]), "header-empty"), undefined);
});

test("official client reads a header the own decoder rejects: header-not-base64 is only a warning", () => {
  const e = { ...extract(pr("GET", 402, { ...NS, "payment-required": "eyJh-_" }, {})), official: { readable: true } as const };
  const fs = runRules([e], undefined, "<url>", "9.9.9");
  const decoder = find(fs, "header-not-base64");
  assert.equal(decoder?.level, "warn");
  assert.match(decoder?.detail ?? "", /@x402\/core 9\.9\.9 reads this header; clients with a stricter decoder may not\.$/);
  assert.equal(find(fs, "official-client")?.level, "pass");
});

test("official client reads a header the own decoder rejects as not JSON: header-not-json is only a warning", () => {
  const raw = Buffer.from("hello").toString("base64");
  const e = { ...extract(pr("GET", 402, { ...NS, "payment-required": raw }, {})), official: { readable: true } as const };
  const fs = runRules([e], undefined, "<url>", "9.9.9");
  const decoder = find(fs, "header-not-json");
  assert.equal(decoder?.level, "warn");
  assert.match(decoder?.detail ?? "", /@x402\/core 9\.9\.9 reads this header; clients with a stricter decoder may not\.$/);
  assert.equal(find(fs, "official-client")?.level, "pass");
});

test("a valid v2 header with a body error: official-client is an error, not a pass", () => {
  const p = { ...pr("GET", 402, { ...NS, "payment-required": b64(v2) }), bodyError: "http response body too large: limit 1048576 bytes" };
  const fs = runRules([extract(p)], undefined, "<url>", "9.9.9");
  const official = find(fs, "official-client");
  assert.equal(official?.level, "error");
  assert.match(official?.detail ?? "", /http response body too large: limit 1048576 bytes/);
});

test("a valid v1 JSON challenge body of about 600 KiB is readable: no false error", () => {
  const big = { ...v1, padding: "x".repeat(600 * 1024) };
  const fs = runRules([extract(pr("GET", 402, NS, big))], undefined, "<url>", "9.9.9");
  assert.equal(find(fs, "official-client")?.level, "pass");
});

test("official client and own decoder both reject: header-not-base64 stays an error", () => {
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": "eyJh-_" }, {}))]);
  assert.equal(find(fs, "header-not-base64")?.level, "error");
});

test("header that decodes to JSON but not an object: header-not-object names the type", () => {
  for (const [value, kind] of [[[], "an array"], ["x", "a string"], [42, "a number"], [true, "a boolean"], [null, "null"]] as const) {
    const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(value) }, {}))], undefined, "<url>", "9.9.9");
    assert.deepEqual(nonCors(fs), ["header-not-object", "official-client"], kind);
    const f = find(fs, "header-not-object");
    assert.equal(f?.level, "error");
    assert.equal(f?.detail, `The header is valid base64 JSON, but it decodes to ${kind}, not to the challenge object.`);
    assert.equal(find(fs, "official-client")?.level, "error");
  }
});

test("non-object header with a v1 body: the body is ignored, as in the official client, and no drift is reported", () => {
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64([]) }, v1))]);
  assert.deepEqual(nonCors(fs), ["header-not-object", "official-client"]);
});

test("non-object header with a v2 body: no v2-body-only, the header is present", () => {
  const fs = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64("x") }, v2))]);
  assert.deepEqual(nonCors(fs), ["header-not-object", "official-client"]);
});

test("412 with a non-object header is not a 402: no header-not-object", () => {
  const fs = runRules([extract(pr("GET", 412, { ...NS, "payment-required": b64([]) }, {}))]);
  assert.equal(find(fs, "header-not-object"), undefined);
  assert.ok(ids(fs).includes("no-402"));
});

// payTo rotation: runRules wiring
const PA = "0x1111111111111111111111111111111111111111";
const PB = "0x2222222222222222222222222222222222222222";
const rotEx = (method: "GET" | "POST", payTo: string, originPayTo: string) => ({
  ...extract(pr(method, 402, { ...NS, "payment-required": b64({ ...v2, accepts: [{ ...v2.accepts[0], payTo }] }) }, {})),
  originStatus: 402,
  originChallenge: { ...v2, accepts: [{ ...v2.accepts[0], payTo: originPayTo }] },
  originVersion: 2 as const,
});

test("runRules returns payto-rotates for a rotating pair", () => {
  const f = runRules([rotEx("GET", PA, PB)]).filter((x) => x.id === "payto-rotates");
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "warn");
  assert.equal(f[0].method, "GET");
  assert.equal(ids(runRules([rotEx("GET", PA, PA)])).includes("payto-rotates"), false);
});

test("payto-rotates on GET and POST gives two findings, not both", () => {
  const f = runRules([rotEx("GET", PA, PB), rotEx("POST", PA, PB)]).filter((x) => x.id === "payto-rotates");
  assert.deepEqual(f.map((x) => x.method).sort(), ["GET", "POST"]);
});

test("spend findings survive when paytoRule throws on a hostile repeat challenge", () => {
  const big = { ...v2, accepts: [{ ...v2.accepts[0], network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "2000000" }] };
  const e = extract(pr("GET", 402, { ...NS, "payment-required": b64(big) }, {}));
  const hostile = { ...v2 };
  Object.defineProperty(hostile, "accepts", {
    get() {
      throw new Error("boom");
    },
    enumerable: true,
  });
  const fs = runRules([{ ...e, originStatus: 402, originChallenge: hostile, originVersion: 2 as const }]);
  assert.ok(ids(fs).includes("default-cap"));
  assert.equal(ids(fs).includes("payto-rotates"), false);
});

// amount-changes: runRules wiring
const ampEx = (method: "GET" | "POST", amount: string, originAmount: string) => ({
  ...extract(pr(method, 402, { ...NS, "payment-required": b64({ ...v2, accepts: [{ ...v2.accepts[0], amount }] }) }, {})),
  originStatus: 402,
  originChallenge: { ...v2, accepts: [{ ...v2.accepts[0], amount: originAmount }] },
  originVersion: 2 as const,
});

test("runRules returns amount-changes for a changing pair", () => {
  const f = runRules([ampEx("GET", "1000", "1200")]).filter((x) => x.id === "amount-changes");
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "warn");
  assert.equal(f[0].method, "GET");
  assert.equal(ids(runRules([ampEx("GET", "1000", "1000")])).includes("amount-changes"), false);
});

test("amount-changes on GET and POST gives two findings, not both", () => {
  const f = runRules([ampEx("GET", "1000", "1200"), ampEx("POST", "1000", "1200")]).filter((x) => x.id === "amount-changes");
  assert.deepEqual(f.map((x) => x.method).sort(), ["GET", "POST"]);
});

test("payto-rotates and spend findings survive when amountRule throws on a hostile repeat entry", () => {
  const big = { ...v2, accepts: [{ ...v2.accepts[0], network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "2000000" }] };
  const e = extract(pr("GET", 402, { ...NS, "payment-required": b64(big) }, {}));
  const hostile = { ...big.accepts[0], payTo: PB };
  Object.defineProperty(hostile, "amount", {
    get() {
      throw new Error("boom");
    },
    enumerable: true,
  });
  const fs = runRules([{ ...e, originStatus: 402, originChallenge: { ...big, accepts: [hostile] }, originVersion: 2 as const }]);
  assert.ok(ids(fs).includes("default-cap"));
  assert.ok(ids(fs).includes("payto-rotates"));
  assert.equal(ids(fs).includes("amount-changes"), false);
});

test("amount-changes survives when paytoRule throws on a hostile repeat entry", () => {
  const hostile = { ...v2.accepts[0], amount: "1200" };
  Object.defineProperty(hostile, "payTo", {
    get() {
      throw new Error("boom");
    },
    enumerable: true,
  });
  const e = ampEx("GET", "1000", "1200");
  const fs = runRules([{ ...e, originChallenge: { ...v2, accepts: [hostile] } }]);
  assert.ok(ids(fs).includes("amount-changes"));
  assert.equal(ids(fs).includes("payto-rotates"), false);
});

// Challenge hints: runRules wiring
const SEE_BODY = "See post-needs-body: the POST answer looks like body validation before payment.";
const post422 = () => extract(pr("POST", 422, {}, { error: "query is required" }));

test("post-needs-body: GET 405 + POST 422 adds the hint and points the no-402 fix to it", () => {
  const fs = runRules([extract(pr("GET", 405)), post422()]);
  assert.equal(find(fs, "post-needs-body")?.level, "info");
  assert.equal(find(fs, "post-needs-body")?.method, "POST");
  assert.equal(find(fs, "no-402")?.fix, `Return 402 with a challenge for unpaid requests. ${SEE_BODY}`);
});

test("post-needs-body: GET 402 + POST 422 points the verb-mismatch fix to it", () => {
  const fs = runRules([v2ok("GET"), post422()]);
  assert.ok(ids(fs).includes("post-needs-body"));
  assert.equal(
    find(fs, "verb-mismatch")?.fix,
    `Clients often probe with GET first. Issue the challenge on POST too, or document the supported method. ${SEE_BODY}`,
  );
});

test("post-needs-body: no pointer in no-402 or verb-mismatch when it does not fire", () => {
  const same = runRules([extract(pr("GET", 422, {}, { error: "x" })), post422()]);
  assert.equal(ids(same).includes("post-needs-body"), false);
  assert.equal(find(same, "no-402")?.fix?.includes(SEE_BODY), false);
  const mismatch = runRules([v2ok("GET"), extract(pr("POST", 405))]);
  assert.equal(ids(mismatch).includes("post-needs-body"), false);
  assert.equal(find(mismatch, "verb-mismatch")?.fix?.includes(SEE_BODY), false);
});

test("post-needs-body: GET 405 + POST 400 JSON-RPC error stays no-402 without the hint", () => {
  const fs = runRules([get405(), extract(pr("POST", 400, {}, rpcError()))]);
  assert.ok(ids(fs).includes("no-402"));
  assert.equal(ids(fs).includes("post-needs-body"), false);
  assert.equal(find(fs, "no-402")?.fix?.includes(SEE_BODY), false);
});

test("post-needs-body: GET 406 JSON-RPC + POST 422 is an MCP endpoint, not post-needs-body", () => {
  const fs = runRules([extract(pr("GET", 406, {}, rpcError())), post422()]);
  assert.equal(fs[0].id, "mcp-endpoint");
  assert.equal(ids(fs).includes("post-needs-body"), false);
});

test("hint findings on GET and POST merge into one with method both", () => {
  const fs = runRules([v2ok("GET"), v2ok("POST")]).filter((f) => f.id === "testnet-only");
  assert.equal(fs.length, 1);
  assert.equal(fs[0].method, "both");
});

test("runRules passes the payer to the hints", () => {
  const payTo = v2.accepts[0].payTo;
  assert.equal(find(runRules([v2ok("GET")], undefined, "<url>", "unknown", { payer: payTo }), "self-payment")?.level, "warn");
  assert.equal(find(runRules([v2ok("GET")]), "self-payment"), undefined);
});

test("runRules passes the checked URL to the hints", () => {
  const fs = runRules([v2ok("GET")], undefined, "https://api.example.com/other");
  assert.match(find(fs, "resource-url-mismatch")?.detail ?? "", /Differs in: path\./);
});

test("other findings and hints survive when one hint rule throws on a hostile challenge", () => {
  const c = { ...v2, accepts: [{ ...v2.accepts[0], extensions: {} }] };
  const e = extract(pr("GET", 402, { ...NS, "payment-required": b64(c) }, {}));
  // Only the top-level extensions check asks for this property descriptor.
  const hostile = new Proxy(e.challenge as object, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "extensions") throw new Error("boom");
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const fs = runRules([{ ...e, challenge: hostile }]);
  assert.equal(find(fs, "official-client")?.level, "pass");
  assert.ok(ids(fs).includes("v2-header-only"));
  // Only the rule that threw is skipped; the other hints still report.
  assert.equal(ids(fs).includes("testnet-only"), true);
  assert.equal(ids(fs).includes("extensions-placement"), false);
});

// Server values in quotes and escaped, the CLI's own words in single quotes

const v2With = (a: Record<string, unknown>, headers: Record<string, string> = NS) =>
  runRules([extract(pr("GET", 402, { ...headers, "payment-required": b64({ ...v2, accepts: [{ ...v2.accepts[0], ...a }] }) }, {}))]);

test("redirect quotes the Location header and marks a missing one", () => {
  const to = find(runRules([extract(pr("GET", 302, { location: "https://elsewhere.example/\u00a0x" }))]), "redirect");
  assert.equal(to?.detail, 'Location: "https://elsewhere.example/\\u{00A0}x"');
  assert.equal(find(runRules([extract(pr("GET", 302))]), "redirect")?.detail, "Location: (none)");
});

test("header-not-base64 quotes the escaped start of the header, up to 100 characters", () => {
  const f = find(runRules([extract(pr("GET", 402, { ...NS, "payment-required": "a-b_c\t\"" }, {}))]), "header-not-base64");
  assert.match(f?.detail ?? "", /^Value starts with: "a-b_c\\u\{0009\}\\u\{0022\}"/);
  const long = find(runRules([extract(pr("GET", 402, { ...NS, "payment-required": "-".repeat(150) }, {}))]), "header-not-base64");
  assert.ok((long?.detail ?? "").startsWith('Value starts with: "' + "-".repeat(100) + '\u2026"'), long?.detail);
});

test("v2-legacy-network quotes the network and uses single quotes for its fix", () => {
  const f = find(v2With({ network: "base" }), "v2-legacy-network");
  assert.equal(f?.title, 'v2 uses legacy network name "base"');
  assert.equal(f?.detail, 'accepts[0].network is "base"; v2 requires CAIP-2.');
  assert.equal(f?.fix, "Use 'eip155:8453'.");
  assert.equal(find(v2With({ network: 'ba"se' }), "v2-legacy-network")?.title, 'v2 uses legacy network name "ba\\u{0022}se"');
});

test("v1-caip2-network quotes the network and uses single quotes for its fix", () => {
  const bad = { ...v1, accepts: [{ ...v1.accepts[0], network: "eip155:84532" }] };
  const f = find(runRules([extract(pr("GET", 402, NS, bad))]), "v1-caip2-network");
  assert.equal(f?.title, 'v1 uses CAIP-2 network "eip155:84532"');
  assert.equal(f?.detail, 'accepts[0].network is "eip155:84532"; v1 clients expect legacy names.');
  assert.equal(f?.fix, "Use a legacy name such as 'base-sepolia', or move to v2.");
});

test("mixed-dialect and payment-flow use single quotes for the CLI's own words", () => {
  const { amount: _amount, ...rest } = v2.accepts[0];
  const v2bad = { ...v2, accepts: [{ ...rest, maxAmountRequired: "10000" }] };
  const v2mixed = find(runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(v2bad) }, {}))]), "mixed-dialect");
  assert.equal(v2mixed?.fix, "In v2, the price field is 'amount' and 'resource' is a top-level object.");
  const { maxAmountRequired: _max, ...v1rest } = v1.accepts[0];
  const v1bad = { ...v1, accepts: [{ ...v1rest, amount: "10000" }] };
  const v1mixed = find(runRules([extract(pr("GET", 402, NS, v1bad))]), "mixed-dialect");
  assert.equal(v1mixed?.detail, "accepts[0] has 'amount' instead of 'maxAmountRequired'.");
  assert.equal(v1mixed?.fix, "In v1, the price field is 'maxAmountRequired'.");
  const unknown = find(v2With({ extra: { paymentFlow: "deferred" } }), "payment-flow");
  assert.equal(unknown?.fix, "Use 'authorization', 'upfront' or 'escrow', or omit it for the scheme default.");
  const undeclared = find(v2With({ scheme: "auth-capture" }), "payment-flow");
  assert.match(undeclared?.detail ?? "", /defaults to the 'escrow' flow,/);
  assert.match(undeclared?.detail ?? "", /whenever the flow is not 'authorization', so/);
});

test("cache-control: not set for a missing header, an empty one as \"\", the value quoted otherwise", () => {
  const detail = (headers: Record<string, string>) => find(v2With({}, headers), "cache-control")?.detail;
  assert.equal(detail({}), "Cache-Control is not set.");
  assert.equal(detail({ "cache-control": "" }), 'Cache-Control is "".');
  assert.equal(detail({ "cache-control": "no-\u200bstore" }), 'Cache-Control is "no-\\u{200B}store".');
  assert.equal(find(v2With({}, {}), "cache-control")?.fix, "Send 'Cache-Control: no-store' with 402 responses.");
});

test("CORS header values: not set for a missing header, an empty one as \"\", own '*' in single quotes", () => {
  const expose = (headers: Record<string, string>) =>
    runRules([corsV2("GET", headers)], pf(204, PF_OK)).find((x) => x.id === "cors-expose-headers")?.detail ?? "";
  assert.match(expose(ORIGIN_OK), /^Access-Control-Expose-Headers is not set; missing:/);
  assert.match(expose({ ...ORIGIN_OK, "access-control-expose-headers": "" }), /^Access-Control-Expose-Headers is ""; missing:/);
  const cred = expose({ ...ORIGIN_OK, "access-control-expose-headers": "*", "access-control-allow-credentials": "true" });
  assert.match(cred, /^Access-Control-Expose-Headers is "\*"; missing: PAYMENT-REQUIRED, PAYMENT-RESPONSE\. '\*' does not cover credentialed requests\. The browser/);
  const allow = (headers: Record<string, string>) =>
    runRules([corsV2("POST")], pf(204, { ...ORIGIN_OK, ...headers })).find((x) => x.id === "cors-allow-headers")?.detail ?? "";
  assert.match(allow({ "access-control-allow-headers": "authorization" }), /^Access-Control-Allow-Headers is "authorization"; missing:/);
  assert.match(allow({ "access-control-allow-headers": "" }), /^Access-Control-Allow-Headers is ""; missing:/);
});

// Type rule for x402Version, extra.paymentFlow and the network of an undeclared flow

test("version-missing names the value by the type rule", () => {
  const detail = (c: Record<string, unknown>) =>
    find(runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64(c) }, {}))]), "version-missing")?.detail;
  const { x402Version: _version, ...rest } = v2;
  const cases: [unknown, string][] = [
    ["s", 'x402Version is "s" (string).'],
    ['2"\u001b', 'x402Version is "2\\u{0022}\\u{001B}" (string).'],
    [3, "x402Version is 3 (number)."],
    [true, "x402Version is true (boolean)."],
    [{ a: 1 }, "x402Version is an object."],
    [[2], "x402Version is an array."],
    [null, "x402Version is null."],
  ];
  for (const [v, expected] of cases) assert.equal(detail({ ...rest, x402Version: v }), expected, JSON.stringify(v));
  assert.equal(detail(rest), "x402Version is not set.");
});

test("payment-flow error names an unknown flow by the type rule", () => {
  const tail = ". Clients must not pay for a flow they do not recognize and skip this entry.";
  const cases: [unknown, string, string][] = [
    ["s", 'Unknown payment flow "s"', '"s"'],
    [3, "Unknown payment flow 3 (number)", "3 (number)"],
    [true, "Unknown payment flow true (boolean)", "true (boolean)"],
    [{ a: 1 }, "Unknown payment flow (an object)", "an object"],
    [["escrow"], "Unknown payment flow (an array)", "an array"],
  ];
  for (const [flow, title, value] of cases) {
    const f = find(v2With({ extra: { paymentFlow: flow } }), "payment-flow");
    assert.equal(f?.level, "error", JSON.stringify(flow));
    assert.equal(f?.title, title);
    assert.equal(f?.detail, `accepts[0].extra.paymentFlow is ${value}${tail}`);
  }
  const long = find(v2With({ extra: { paymentFlow: "d".repeat(5000) } }), "payment-flow");
  assert.equal(long?.title, `Unknown payment flow "${"d".repeat(100)}\u2026"`);
});

test("payment-flow warning names the network by the type rule, the scheme as an own word", () => {
  const rest = " defaults to the 'escrow' flow, which settles before the resource runs.";
  const cases: [unknown, string][] = [
    ["s", `('auth-capture' on "s")`],
    ['ba"se\u001b', `('auth-capture' on "ba\\u{0022}se\\u{001B}")`],
    [3, "('auth-capture' on a network that is 3 (number))"],
    [true, "('auth-capture' on a network that is true (boolean))"],
    [{ a: 1 }, "('auth-capture' on a network that is an object)"],
    [["\u001b"], "('auth-capture' on a network that is an array)"],
    [null, "('auth-capture' on a network that is null)"],
  ];
  for (const [network, part] of cases) {
    const f = find(v2With({ scheme: "auth-capture", network }), "payment-flow");
    assert.equal(f?.level, "warn", JSON.stringify(network));
    assert.ok(f?.detail.startsWith(`accepts[0] ${part}${rest}`), f?.detail);
  }
  const { network: _network, ...noNetwork } = v2.accepts[0];
  const missing = runRules([extract(pr("GET", 402, { ...NS, "payment-required": b64({ ...v2, accepts: [{ ...noNetwork, scheme: "auth-capture" }] }) }, {}))]);
  assert.ok(find(missing, "payment-flow")?.detail.startsWith(`accepts[0] ('auth-capture' on a network that is not set)${rest}`));
  const solana = find(v2With({ scheme: "upto", network: "solana:abc" }), "payment-flow");
  assert.ok(solana?.detail.startsWith(`accepts[0] ('upto' on "solana:abc") defaults to the 'escrow' flow`), solana?.detail);
});
