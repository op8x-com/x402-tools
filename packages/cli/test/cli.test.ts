import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { run, type Io } from "../src/cli.ts";
import { startServer } from "./server.ts";
import { VERSION } from "../src/version.ts";
import { X402_CORE_VERSION } from "../src/core-version.ts";

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

const PAYTO = "0x1111111111111111111111111111111111111111";

test("--payer equal to the payTo reports self-payment end to end", async () => {
  const io = capture();
  const code = await run(["check", `${server.url}/v2-good`, "--payer", PAYTO.toUpperCase().replace("0X", "0x")], io);
  assert.equal(code, 0);
  assert.match(io.stdout(), /Payer is the payTo address/);
  const j = capture();
  assert.equal(await run(["check", `${server.url}/v2-good`, "--payer", PAYTO, "--json"], j), 0);
  assert.ok(JSON.parse(j.stdout()).findings.some((f: { id: string }) => f.id === "self-payment"));
  const other = capture();
  await run(["check", `${server.url}/v2-good`, "--payer", "0x2222222222222222222222222222222222222222"], other);
  assert.equal(other.stdout().includes("Payer is the payTo address"), false);
});

test("--payer rejects anything that is not an address, without echoing it", async () => {
  const key = "a".repeat(64);
  for (const bad of ["abc", key, `0x${key}`, "0x123", "", "not an address with spaces"]) {
    const io = capture();
    assert.equal(await run(["check", `${server.url}/v2-good`, "--payer", bad], io), 2, bad);
    assert.match(io.stderr(), /--payer must be a wallet address/);
    if (bad.length > 3) assert.equal((io.stderr() + io.stdout()).includes(bad), false);
  }
  const noValue = capture();
  assert.equal(await run(["check", `${server.url}/v2-good`, "--payer"], noValue), 2);
  assert.match(noValue.stderr(), /payer/);
  const help = capture();
  assert.equal(await run(["--help"], help), 0);
  assert.ok(help.stdout().includes("\n  --payer <address>      your own paying wallet; warns if it is a payTo\n"));
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

test("endpoint whose payTo changes on every request gets one payto-rotates finding per method", async () => {
  const io = capture();
  assert.equal(await run(["check", `${server.url}/payto-rotates`, "--json"], io), 0);
  const report = JSON.parse(io.stdout());
  const rotates = report.findings.filter((f: JsonFinding) => f.id === "payto-rotates");
  assert.deepEqual(rotates.map((f: { method: string }) => f.method).sort(), ["GET", "POST"]);
});

test("endpoint whose price changes on every request gets one amount-changes finding per method", async () => {
  const io = capture();
  assert.equal(await run(["check", `${server.url}/amount-changes`, "--json"], io), 0);
  const report = JSON.parse(io.stdout());
  const changes = report.findings.filter((f: JsonFinding) => f.id === "amount-changes");
  assert.deepEqual(changes.map((f: { method: string }) => f.method).sort(), ["GET", "POST"]);
  const warns = report.findings.filter((f: JsonFinding) => f.level === "warn").map((f: JsonFinding) => f.id);
  assert.deepEqual(warns, ["amount-changes", "amount-changes"]);
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
  assert.match(text, /\nNot checked by op8x check:\n  - MCP payments: npx x402-listing-check@latest /);
  assert.equal(text.includes("Listing and Bazaar checks"), false);
  assert.equal(text.includes("Bazaar indexing"), false);
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

for (const path of ["/empty-header-v1", "/blank-header-v1"]) {
  test(`${path}: the official client falls back to the v1 body`, async () => {
    const io = capture();
    assert.equal(await run(["check", `${server.url}${path}`, "--json"], io), 0);
    const report = JSON.parse(io.stdout());
    const level = (id: string) => report.findings.find((f: { id: string }) => f.id === id)?.level;
    assert.equal(level("header-empty"), "warn");
    assert.equal(level("official-client"), "pass");
    assert.equal(report.x402Core, X402_CORE_VERSION);
  });
}

test("/empty-header-no-body: an empty header without a body challenge exits 1", async () => {
  const io = capture();
  assert.equal(await run(["check", `${server.url}/empty-header-no-body`, "--json"], io), 1);
  const report = JSON.parse(io.stdout());
  const level = (id: string) => report.findings.find((f: { id: string }) => f.id === id)?.level;
  assert.equal(level("header-empty"), "warn");
  assert.equal(level("no-challenge"), "error");
  assert.equal(level("official-client"), "error");
});

function spy(): { io: Io & { stdout: () => string; stderr: () => string }; calls: () => number } {
  let calls = 0;
  const io = capture();
  io.fetchImpl = (async () => {
    calls++;
    throw new Error("no request expected");
  }) as typeof fetch;
  return { io, calls: () => calls };
}

const NO_SECRETS = (io: { stdout: () => string; stderr: () => string }) => {
  const all = io.stdout() + io.stderr();
  assert.equal(all.includes("alice"), false);
  assert.equal(all.includes("s3cr3t"), false);
};

test("URL with a user name and password is refused before any request, without echoing it", async () => {
  const { io, calls } = spy();
  const url = server.url.replace("http://", "http://alice:s3cr3t@") + "/v2-good";
  assert.equal(await run(["check", url], io), 2);
  assert.match(io.stderr(), /URLs with a user name or password are not supported\. Remove them and run again\./);
  NO_SECRETS(io);
  assert.equal(calls(), 0);
});

test("a password is never echoed for other schemes, missing schemes or unparsable URLs", async () => {
  const ftp = spy();
  assert.equal(await run(["check", "ftp://alice:s3cr3t@host/"], ftp.io), 2);
  assert.match(ftp.io.stderr(), /user name or password/);
  NO_SECRETS(ftp.io);

  const noScheme = spy();
  assert.equal(await run(["check", "alice:s3cr3t@api.example.com/paid"], noScheme.io), 2);
  assert.match(noScheme.io.stderr(), /Only http and https URLs are supported\./);
  NO_SECRETS(noScheme.io);

  const bad = spy();
  assert.equal(await run(["check", "http://alice:s3cr3t@"], bad.io), 2);
  assert.match(bad.io.stderr(), /Not a valid URL\./);
  NO_SECRETS(bad.io);

  for (const s of [ftp, noScheme, bad]) assert.equal(s.calls(), 0);
});

test("URLs with ' in the host, path or fragment, or \" in the host, are refused before any request", async () => {
  for (const url of [`${server.url}/a'b`, `${server.url}/x#a'b`, "http://a'b/", 'http://a"b/']) {
    const { io, calls } = spy();
    assert.equal(await run(["check", url], io), 2, url);
    assert.match(io.stderr(), /URLs that contain ' or " are not supported: /);
    assert.equal(io.stderr().includes(url), false, url);
    assert.equal(io.stdout(), "");
    assert.equal(calls(), 0, url);
  }
});

test("a ' in the query is encoded by the URL parser and checked normally", async () => {
  const base = capture();
  const baseCode = await run(["check", `${server.url}/v2-good`], base);
  const io = capture();
  assert.equal(await run(["check", `${server.url}/v2-good?q='x`], io), baseCode);
  const lines = io.stdout().split("\n").filter((l) => l.includes(server.url));
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(line.includes(`${server.url}/v2-good?q=%27x`), line);
    // No raw quote inside the URL: the quotes on the line stay balanced and the URL sits in one segment.
    const segments = [...line.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    assert.equal((line.match(/'/g) ?? []).length, segments.length * 2, line);
    assert.ok(segments.some((seg) => seg.includes(`${server.url}/v2-good?q=%27x`)), line);
  }
});

test("brackets in the URL: every Reproduce line starts with curl -g -i", async () => {
  const io = capture();
  await run(["check", `${server.url}/v2-good?filter[status]=1`], io);
  const lines = io.stdout().split("\n");
  const at = lines.indexOf("Reproduce:");
  assert.ok(at >= 0);
  const repro = lines.slice(at + 1, lines.findIndex((l) => l.startsWith("Summary:"))).map((l) => l.trim()).filter((l) => l !== "");
  assert.ok(repro.length > 0);
  for (const l of repro) assert.ok(l.startsWith("curl -g -i"), l);
});

test("io.curl = curl.exe: Reproduce lines use it, validate line keeps curl, JSON is unchanged", async () => {
  const io = { ...capture(), curl: "curl.exe" };
  await run(["check", `${server.url}/v2-good`], io);
  const lines = io.stdout().split("\n").map((l) => l.trim());
  const at = lines.indexOf("Reproduce:");
  assert.ok(at >= 0);
  const repro = lines.slice(at + 1, lines.findIndex((l) => l.startsWith("Summary:"))).filter((l) => l !== "");
  assert.ok(repro.length > 0);
  for (const l of repro) assert.ok(l.startsWith("curl.exe -g -i"), l);
  const validate = lines.filter((l) => l.includes("/v2/x402/validate"));
  assert.ok(validate.length > 0);
  for (const l of validate) assert.ok(l.startsWith("curl -X POST"), l);

  const strip = (s: string) => {
    const j = JSON.parse(s);
    delete j.checkedAt;
    for (const r of j.requests) delete r.ms;
    return j;
  };
  const a = capture();
  const b = { ...capture(), curl: "curl.exe" };
  await run(["check", `${server.url}/v2-good`, "--json"], a);
  await run(["check", `${server.url}/v2-good`, "--json"], b);
  assert.deepEqual(strip(a.stdout()), strip(b.stdout()));
});
