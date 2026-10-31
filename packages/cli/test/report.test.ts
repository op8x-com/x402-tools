import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, renderJson, renderText } from "../src/report.ts";
import type { Finding, PreflightResult, ProbeResult } from "../src/types.ts";

const probes: (ProbeResult | PreflightResult)[] = [
  { method: "GET", url: "https://api.example.com/x", status: 402, headers: {}, bodyText: "", ms: 12 },
  { method: "POST", url: "https://api.example.com/x", status: 405, headers: {}, bodyText: "", ms: 8 },
  { method: "GET", url: "https://api.example.com/x", status: 402, headers: {}, bodyText: "", ms: 9, origin: "https://op8x.com" },
  {
    method: "OPTIONS",
    url: "https://api.example.com/x",
    requestMethod: "GET",
    requestHeaders: "payment-signature",
    status: 204,
    headers: {},
    ms: 3,
  },
];
const findings: Finding[] = [
  { id: "official-client", level: "pass", method: "GET", title: "Official x402 client can read the challenge", detail: "ok" },
  { id: "v2-body-only", level: "error", method: "GET", title: "v2 challenge only in the response body", detail: "d", fix: "f" },
  { id: "cache-control", level: "warn", method: "GET", title: "Challenge may be cached", detail: "d" },
];
const report = buildReport("https://api.example.com/x", "0.0.1", "2.29.0", probes, findings, new Date("2026-10-24T18:00:00.000Z"));

test("buildReport counts errors and warnings", () => {
  assert.deepEqual(report.summary, { errors: 1, warnings: 1 });
  assert.equal(report.tool, "op8x");
  assert.equal(report.checkedAt, "2026-10-24T18:00:00.000Z");
  assert.deepEqual(report.requests[1], { method: "POST", status: 405, ms: 8 });
  assert.deepEqual(report.requests[2], { method: "GET", status: 402, ms: 9, origin: "https://op8x.com" });
  assert.deepEqual(report.requests[3], {
    method: "OPTIONS",
    status: 204,
    ms: 3,
    origin: "https://op8x.com",
    requestHeaders: {
      "access-control-request-method": "GET",
      "access-control-request-headers": "payment-signature",
    },
  });
});

test("renderJson is the report as JSON", () => {
  assert.deepEqual(JSON.parse(renderJson(report)), report);
});

test("renderText orders by severity and includes fix, repro and pointers", () => {
  const text = renderText(report, false);
  assert.ok(text.indexOf("✖ error") < text.indexOf("! warn"));
  assert.ok(text.indexOf("! warn") < text.indexOf("✓ pass"));
  assert.match(text, /Fix: f/);
  assert.match(text, /GET {2}402 {2}9 ms {2}\(with Origin\)/);
  assert.match(text, /GET {2}402 {2}12 ms\n/);
  assert.match(text, /curl -i -X GET 'https:\/\/api\.example\.com\/x'/);
  assert.match(text, /curl -i -X GET -H 'Origin: https:\/\/op8x\.com' 'https:\/\/api\.example\.com\/x'/);
  assert.match(text, /curl -i -X POST -H 'Content-Type: application\/json' -d '\{\}' 'https:\/\/api\.example\.com\/x'/);
  assert.match(
    text,
    /curl -i -X OPTIONS -H 'Origin: https:\/\/op8x\.com' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: payment-signature' 'https:\/\/api\.example\.com\/x'/,
  );
  assert.ok(text.includes("\n      npx x402-listing-check 'https://api.example.com/x'\n"));
  assert.match(text, /Summary: 1 error, 1 warning\n/);
  assert.equal(text.includes("\x1b["), false);
});

test("renderText pluralises the summary", () => {
  const none = buildReport("https://api.example.com/x", "0.0.1", "2.29.0", probes, []);
  assert.match(renderText(none, false), /Summary: 0 errors, 0 warnings\n/);
  const two = buildReport("https://api.example.com/x", "0.0.1", "2.29.0", probes, [findings[1], findings[1]]);
  assert.match(renderText(two, false), /Summary: 2 errors, 0 warnings\n/);
});

test("renderText adds ANSI colours when asked", () => {
  assert.equal(renderText(report, true).includes("\x1b[31m"), true);
});

const BAZAAR = "curl -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate -H 'Content-Type: application/json' -d";

test("renderText: not-checked block, normal case, one validation command per 402 method", () => {
  const text = renderText(report, false);
  const tail = [
    "Not checked by op8x check:",
    "  - Bazaar indexing and metadata:",
    `      ${BAZAAR} '{"resource":"https://api.example.com/x","method":"GET"}'`,
    "      npx x402-listing-check 'https://api.example.com/x'",
    "      Indexing also needs one settled payment through the CDP facilitator.",
    "  - Delivery after a real payment: a tool that pays the endpoint once and checks the response.",
    "  - Facilitator limits such as minimum prices: your facilitator's documentation.",
    "op8x · https://op8x.com",
    "",
  ].join("\n");
  assert.ok(text.endsWith(`\n${tail}`), text);
  assert.equal(text.includes("Listing and Bazaar checks"), false);
  assert.equal(text.includes("MCP payment check"), false);
});

test("notChecked: methods come from plain probes with 402, else every probed method", () => {
  const mk = (method: "GET" | "POST", status: number, origin?: string): ProbeResult => ({
    method, url: "https://a.example/x", status, headers: {}, bodyText: "", ms: 1, ...(origin ? { origin } : {}),
  });
  const bazaar = (r: ReturnType<typeof buildReport>) => r.notChecked[0].where ?? "";
  const both = buildReport("https://a.example/x", "0", "2", [mk("GET", 402), mk("POST", 402)], []);
  assert.equal(bazaar(both).match(/"method":"(\w+)"/g)?.join(","), '"method":"GET","method":"POST"');
  // a POST that only answers 402 with an Origin does not count as a plain 402
  const originOnly = buildReport("https://a.example/x", "0", "2", [mk("GET", 402), mk("POST", 405), mk("POST", 402, "https://op8x.com")], []);
  assert.equal(bazaar(originOnly).match(/"method":"(\w+)"/g)?.join(","), '"method":"GET"');
  // none returned 402: one per probed method; POST only stays POST
  const none = buildReport("https://a.example/x", "0", "2", [mk("POST", 422)], []);
  assert.match(bazaar(none), /"method":"POST"/);
  assert.equal(bazaar(none).includes('"method":"GET"'), false);
  const noneBoth = buildReport("https://a.example/x", "0", "2", [mk("GET", 405), mk("POST", 405)], []);
  assert.equal(bazaar(noneBoth).match(/"method":"(\w+)"/g)?.length, 2);
});

test("renderText: MCP case lists MCP payments first and leaves out the Bazaar entry", () => {
  const mcp: Finding = {
    id: "mcp-endpoint",
    level: "info",
    method: "POST",
    title: "MCP endpoint: x402 over MCP does not use HTTP 402",
    detail: "d",
    fix: "f",
  };
  const r = buildReport("https://api.example.com/x", "0.0.1", "2.29.0", probes, [mcp]);
  const text = renderText(r, false);
  assert.ok(
    text.endsWith(
      [
        "\nNot checked by op8x check:",
        "  - MCP payments: npx x402-listing-check@latest 'https://api.example.com/x' --mcp-tool YOUR_TOOL",
        "  - Delivery after a real payment: a tool that pays the endpoint once and checks the response.",
        "  - Facilitator limits such as minimum prices: your facilitator's documentation.",
        "op8x · https://op8x.com",
        "",
      ].join("\n"),
    ),
    text,
  );
  assert.equal(text.includes("Bazaar indexing"), false);
  assert.equal(text.includes("Listing and Bazaar checks"), false);
  assert.equal(r.notChecked.length, 3);
  const quoted = renderText(buildReport("https://api.example.com/it's", "0.0.1", "2.29.0", probes, [mcp]), false);
  assert.match(quoted, /@latest 'https:\/\/api\.example\.com\/it'\\''s' --mcp-tool YOUR_TOOL\n/);
});

test("notChecked: user name and password are left out of the copyable commands", () => {
  const url = "http://user:pw@api.example.com:8080/x?q=1";
  const r = buildReport(url, "0", "2", [{ method: "GET", url, status: 402, headers: {}, bodyText: "", ms: 1 }], []);
  const where = r.notChecked[0].where ?? "";
  assert.equal(/user|pw@/.test(where), false, where);
  assert.ok(where.includes(JSON.stringify({ resource: "http://api.example.com:8080/x?q=1", method: "GET" })), where);
  assert.ok(where.includes("npx x402-listing-check 'http://api.example.com:8080/x?q=1'"), where);
  const mcp: Finding = { id: "mcp-endpoint", level: "info", method: "POST", title: "t", detail: "d" };
  const m = buildReport(url, "0", "2", [{ method: "POST", url, status: 406, headers: {}, bodyText: "", ms: 1 }], [mcp]);
  assert.equal(m.notChecked[0].where, "npx x402-listing-check@latest 'http://api.example.com:8080/x?q=1' --mcp-tool YOUR_TOOL");
});

test("notChecked: the Bazaar entry is left out when every probe failed at network level", () => {
  const failed = (method: "GET" | "POST"): ProbeResult => ({
    method, url: "https://a.example/x", headers: {}, bodyText: "", ms: 1, error: "fetch failed",
  });
  const r = buildReport("https://a.example/x", "0", "2", [failed("GET"), failed("POST")], []);
  assert.deepEqual(r.notChecked.map((n) => n.topic), ["Delivery after a real payment", "Facilitator limits such as minimum prices"]);
  const answered: ProbeResult = { method: "POST", url: "https://a.example/x", status: 405, headers: {}, bodyText: "", ms: 1 };
  const one = buildReport("https://a.example/x", "0", "2", [failed("GET"), answered], []);
  assert.equal(one.notChecked[0].topic, "Bazaar indexing and metadata");
});

test("notChecked: URL with quotes is shell-quoted in the validation payload", () => {
  const url = `https://api.example.com/a"b'c`;
  const r = buildReport(url, "0", "2", [{ method: "GET", url, status: 402, headers: {}, bodyText: "", ms: 1 }], []);
  const where = r.notChecked[0].where ?? "";
  const payload = JSON.stringify({ resource: url, method: "GET" });
  assert.ok(where.includes(`-d '${payload.replace(/'/g, "'\\''")}'`), where);
  assert.ok(where.includes(`npx x402-listing-check '${url.replace(/'/g, "'\\''")}'`), where);
});

test("notChecked is in the JSON, round-trips, and where is omitted when empty", () => {
  const parsed = JSON.parse(renderJson(report));
  assert.deepEqual(parsed, report);
  assert.deepEqual(parsed.notChecked.map((n: { topic: string }) => n.topic), [
    "Bazaar indexing and metadata",
    "Delivery after a real payment",
    "Facilitator limits such as minimum prices",
  ]);
  assert.equal(parsed.notChecked[0].where!.split("\n").length, 3);
  assert.equal(parsed.notChecked[1].where, "a tool that pays the endpoint once and checks the response.");
  const noWhere = { ...report, notChecked: [{ topic: "T" }] };
  assert.equal(renderText(noWhere, false).includes("  - T\n"), true);
  assert.equal("where" in JSON.parse(renderJson(noWhere)).notChecked[0], false);
});

test("JSON report names the @x402/core version right after the CLI version", () => {
  assert.equal(report.x402Core, "2.29.0");
  assert.deepEqual(Object.keys(JSON.parse(renderJson(report))).slice(0, 3), ["tool", "version", "x402Core"]);
});
