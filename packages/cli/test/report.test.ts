import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, renderJson, renderText } from "../src/report.ts";
import type { Finding, ProbeResult } from "../src/types.ts";

const probes: ProbeResult[] = [
  { method: "GET", url: "https://api.example.com/x", status: 402, headers: {}, bodyText: "", ms: 12 },
  { method: "POST", url: "https://api.example.com/x", status: 405, headers: {}, bodyText: "", ms: 8 },
];
const findings: Finding[] = [
  { id: "official-client", level: "pass", method: "GET", title: "Official x402 client can read the challenge", detail: "ok" },
  { id: "v2-body-only", level: "error", method: "GET", title: "v2 challenge only in the response body", detail: "d", fix: "f" },
  { id: "cache-control", level: "warn", method: "GET", title: "Challenge may be cached", detail: "d" },
];
const report = buildReport("https://api.example.com/x", "0.0.1", probes, findings, new Date("2026-10-24T18:00:00.000Z"));

test("buildReport counts errors and warnings", () => {
  assert.deepEqual(report.summary, { errors: 1, warnings: 1 });
  assert.equal(report.tool, "op8x");
  assert.equal(report.checkedAt, "2026-10-24T18:00:00.000Z");
  assert.deepEqual(report.requests[1], { method: "POST", status: 405, ms: 8 });
});

test("renderJson is the report as JSON", () => {
  assert.deepEqual(JSON.parse(renderJson(report)), report);
});

test("renderText orders by severity and includes fix, repro and pointers", () => {
  const text = renderText(report, false);
  assert.ok(text.indexOf("✖ error") < text.indexOf("! warn"));
  assert.ok(text.indexOf("! warn") < text.indexOf("✓ pass"));
  assert.match(text, /Fix: f/);
  assert.match(text, /curl -i -X GET 'https:\/\/api\.example\.com\/x'/);
  assert.match(text, /curl -i -X POST -H 'Content-Type: application\/json' -d '\{\}' 'https:\/\/api\.example\.com\/x'/);
  assert.match(text, /npx x402-listing-check https:\/\/api\.example\.com\/x/);
  assert.match(text, /Summary: 1 error\(s\), 1 warning\(s\)/);
  assert.equal(text.includes("\x1b["), false);
});

test("renderText adds ANSI colours when asked", () => {
  assert.equal(renderText(report, true).includes("\x1b[31m"), true);
});
