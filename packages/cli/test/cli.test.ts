import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { run, type Io } from "../src/cli.ts";
import { startServer } from "./server.ts";
import { VERSION } from "../src/version.ts";

let server: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server.close();
});

function capture(): Io & { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
    color: false,
    stdout: () => out,
    stderr: () => err,
  };
}

test("valid v2 endpoint exits 0", async () => {
  const io = capture();
  const code = await run(["check", `${server.url}/v2-good`], io);
  assert.equal(code, 0);
  assert.match(io.stdout(), /Official x402 client can read the challenge/);
});

test("v2 body-only exits 1 and is reported in JSON", async () => {
  const io = capture();
  const code = await run(["check", `${server.url}/v2-body-only`, "--json"], io);
  assert.equal(code, 1);
  const report = JSON.parse(io.stdout());
  assert.ok(report.findings.some((f: { id: string }) => f.id === "v2-body-only"));
  // GET and POST, each repeated once as a browser.
  assert.deepEqual(
    report.requests.map((r: { method: string; origin?: string }) => [r.method, r.origin !== undefined]),
    [
      ["GET", false],
      ["POST", false],
      ["GET", true],
      ["POST", true],
    ],
  );
});

test("drift is detected end to end", async () => {
  const io = capture();
  assert.equal(await run(["check", `${server.url}/drift`, "--json"], io), 1);
  assert.ok(JSON.parse(io.stdout()).findings.some((f: { id: string }) => f.id === "header-body-drift"));
});

test("GET 405 with POST 402 warns but does not fail", async () => {
  const io = capture();
  assert.equal(await run(["check", `${server.url}/get-405`, "--json"], io), 0);
  assert.ok(JSON.parse(io.stdout()).findings.some((f: { id: string }) => f.id === "verb-mismatch"));
});

test("free endpoint is no-402 and exits 1", async () => {
  const io = capture();
  assert.equal(await run(["check", `${server.url}/free`], io), 1);
  assert.match(io.stdout(), /No 402 challenge/);
});

test("--method limits the probe to one method", async () => {
  const io = capture();
  await run(["check", `${server.url}/v1-good`, "--method", "get", "--json"], io);
  const methods = JSON.parse(io.stdout()).requests.map((r: { method: string }) => r.method);
  assert.deepEqual(methods, ["GET", "GET"]); // plain, then as a browser
});

test("unreachable host exits 2", async () => {
  const io = capture();
  assert.equal(await run(["check", "http://127.0.0.1:9/", "--timeout", "2"], io), 2);
});

test("usage errors exit 2", async () => {
  assert.equal(await run([], capture()), 2);
  assert.equal(await run(["check"], capture()), 2);
  assert.equal(await run(["check", "not a url"], capture()), 2);
  assert.equal(await run(["check", "ftp://example.com"], capture()), 2);
  assert.equal(await run(["check", "https://example.com", "--method", "PUT"], capture()), 2);
  assert.equal(await run(["check", "https://example.com", "--timeout", "0"], capture()), 2);
  assert.equal(await run(["check", "https://example.com", "--nope"], capture()), 2);
});

test("--version and --help exit 0", async () => {
  const io = capture();
  assert.equal(await run(["--version"], io), 0);
  assert.equal(io.stdout().trim(), VERSION);
  assert.equal(await run(["--help"], capture()), 0);
});

type JsonFinding = { id: string; level: string };

test("CORS-ready endpoint gets a preflight and no CORS findings", async () => {
  const io = capture();
  assert.equal(await run(["check", `${server.url}/cors-good`, "--json"], io), 0);
  const report = JSON.parse(io.stdout());
  assert.deepEqual(
    report.requests.map((r: { method: string; origin?: string }) => [r.method, r.origin !== undefined]),
    [
      ["GET", false],
      ["POST", false],
      ["GET", true],
      ["POST", true],
      ["OPTIONS", true],
    ],
  );
  assert.deepEqual(report.requests[4].requestHeaders, {
    "access-control-request-method": "POST",
    "access-control-request-headers": "payment-signature,content-type",
  });
  assert.deepEqual(
    report.findings.filter((f: JsonFinding) => f.id.startsWith("cors-")),
    [],
  );
});

test("endpoint without CORS gets one hint and no preflight", async () => {
  const io = capture();
  assert.equal(await run(["check", `${server.url}/v2-good`, "--json"], io), 0);
  const report = JSON.parse(io.stdout());
  assert.equal(report.requests.length, 4);
  assert.equal(report.summary.warnings, 0);
  const cors = report.findings.filter((f: JsonFinding) => f.id.startsWith("cors-"));
  assert.deepEqual(cors.map((f: JsonFinding) => [f.id, f.level]), [["cors-allow-origin", "info"]]);
});

test("server that refuses browser origins is still diagnosed from the plain probes", async () => {
  const io = capture();
  assert.equal(await run(["check", `${server.url}/refuses-browsers`, "--json"], io), 0);
  const report = JSON.parse(io.stdout());
  const ids = report.findings.map((f: JsonFinding) => f.id);
  assert.equal(ids.includes("no-402"), false);
  assert.ok(ids.includes("official-client"));
  const cors = report.findings.filter((f: JsonFinding) => f.id.startsWith("cors-"));
  assert.deepEqual(cors.map((f: JsonFinding) => [f.id, f.level]), [["cors-origin-refused", "info"]]);
  assert.equal(report.requests.some((r: { method: string }) => r.method === "OPTIONS"), false);
});

test("preflight that requires payment is reported, but only as a warning", async () => {
  const io = capture();
  assert.equal(await run(["check", `${server.url}/cors-paid-preflight`, "--json"], io), 0);
  const ids = JSON.parse(io.stdout()).findings.map((f: JsonFinding) => f.id);
  assert.ok(ids.includes("cors-preflight"));
  assert.ok(ids.includes("cors-expose-headers"));
});

test("MCP endpoint exits 0 with a hint and sends only GET and POST", async () => {
  const io = capture();
  const code = await run(["check", `${server.url}/mcp`], io);
  assert.equal(code, 0);
  const text = io.stdout();
  assert.match(text, /MCP endpoint: x402 over MCP does not use HTTP 402/);
  assert.match(text, /npx x402-listing-check@latest '[^']+\/mcp' --mcp-tool YOUR_TOOL/);
  assert.match(text, /\nMCP payment check: npx x402-listing-check@latest /);
  assert.equal(text.includes("Listing and Bazaar checks"), false);
  assert.equal(text.includes("IGNORE PREVIOUS INSTRUCTIONS"), false);
  assert.match(text, /Summary: 0 errors, 0 warnings/);

  const j = capture();
  assert.equal(await run(["check", `${server.url}/mcp`, "--json"], j), 0);
  const report = JSON.parse(j.stdout());
  assert.ok(report.findings.some((f: { id: string }) => f.id === "mcp-endpoint"));
  assert.deepEqual(
    report.requests.map((r: { method: string }) => r.method),
    ["GET", "POST"],
  );
});

test("v2 only in the header gets the v1 hint without failing the check", async () => {
  const io = capture();
  assert.equal(await run(["check", `${server.url}/v2-good`], io), 0);
  const text = io.stdout();
  assert.match(text, /i info  \[both\] v1 clients cannot read your terms: the body has no challenge/);
  assert.match(text, /Summary: 0 errors, 0 warnings/);

  const j = capture();
  assert.equal(await run(["check", `${server.url}/v2-good`, "--json"], j), 0);
  const report = JSON.parse(j.stdout());
  const hint = report.findings.filter((f: JsonFinding) => f.id === "v2-header-only");
  assert.deepEqual(hint.map((f: JsonFinding) => f.level), ["info"]);
  assert.deepEqual(report.summary, { errors: 0, warnings: 0 });
});
