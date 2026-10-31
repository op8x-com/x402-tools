import { after, test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, renderText } from "../src/report.ts";
import { runRules } from "../src/rules.ts";
import { extract } from "../src/extract.ts";
import { pr } from "./fixtures.ts";
import type { PreflightResult, ProbeResult } from "../src/types.ts";

// Proves that every command line the CLI prints runs exactly the command shown when it is pasted
// into a real shell. The programs (op8x, curl, npx) are replaced by an argument printer, so nothing
// here touches the network and the base URL is never requested.

const root = mkdtempSync(join(tmpdir(), "op8x-shell-"));
after(() => rmSync(root, { recursive: true, force: true }));
const printer = join(root, "argv.mjs").replace(/\\/g, "/");
writeFileSync(join(root, "argv.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");

const BASE = "http://127.0.0.1:9";
// URLs the CLI accepts but that mean something to a shell.
const URLS = [
  ...["/plain", "/a;id", "/a$(echo x)", "/a&b|c", "/a[1-2]{x,y}", "?q=`x$y"].map((p) => BASE + p),
  "http://a;id/x",
  "http://$(id)/x",
  "http://a`id/x",
  "http://{a,b}/x",
  "http://a&b/x",
  BASE + "/x?b={x,y}",
  BASE + "/x#a$(id);b",
  // Interactive Git Bash would turn this \ into / (MSYS path conversion, switched off below); curl never sends the fragment.
  BASE + "/x#a\\b",
  BASE + "/x?p=C:\\foo",
];

interface Line {
  text: string;
  validate: boolean; // the CDP validate line carries double quotes in JSON, which PowerShell 5.1 cannot pass
}
interface Case {
  name: string;
  href: string;
  lines: Line[];
}

function commandLines(url: string, mcp: boolean): Line[] {
  const probes: (ProbeResult | PreflightResult)[] = mcp
    ? [
        pr("GET", 405, {}, { error: "post only" }),
        pr("POST", 406, {}, { jsonrpc: "2.0", error: { code: -32000, message: "x" }, id: null }),
      ]
    : [
        pr("GET", 402),
        pr("POST", 402),
        { ...pr("GET", 402), origin: "https://example.org" },
        {
          method: "OPTIONS",
          url,
          requestMethod: "POST",
          requestHeaders: "content-type,x-payment",
          status: 204,
          headers: {},
          ms: 1,
        },
      ];
  const findings = runRules(
    probes.filter((p): p is ProbeResult => p.method !== "OPTIONS").map(extract),
    undefined,
    url,
  );
  const report = buildReport(url, "0.0.0", "0.0.0", probes, findings);
  const text = renderText(report, false).split("\n");

  assert.ok(text[0].startsWith("op8x check '"), text[0]);
  const at = text.indexOf("Reproduce:");
  assert.ok(at >= 0, "no Reproduce: section");
  const reproduce: string[] = [];
  for (let i = at + 1; i < text.length && text[i].trim() !== ""; i++) reproduce.push(text[i].trim());
  assert.equal(reproduce.length, probes.length, "Reproduce has one line per request");
  if (!mcp) {
    assert.ok(
      reproduce.some((l) => l.includes("-X OPTIONS") && l.includes("-H 'Access-Control-Request-")),
      "no OPTIONS line",
    );
  }

  const notChecked = report.notChecked.flatMap((n) => (n.where ?? "").split("\n")).filter((l) => /^(curl|npx) /.test(l));
  if (mcp) {
    const fix = findings.find((f) => f.id === "mcp-endpoint")?.fix;
    assert.ok(fix, "no mcp-endpoint finding");
    const m = fix.match(/npx x402-listing-check@latest '[^']*' --mcp-tool YOUR_TOOL/);
    assert.ok(m, "mcp fix command not found");
    notChecked.push(m[0]);
  }
  assert.ok(notChecked.some((l) => l.startsWith("npx ")), "no npx line collected");
  const validate = notChecked.filter((l) => l.includes("/v2/x402/validate"));
  if (mcp) assert.equal(validate.length, 0, "validate line in mcp case");
  else assert.ok(validate.length >= 1, "no validate line in 402 case");

  return [text[0], ...reproduce, ...notChecked].map((t) => ({ text: t, validate: t.includes("/v2/x402/validate") }));
}

function parseOut(shell: string, text: string, stdout: string, stderr: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${shell}: output is not JSON for: ${text}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}

const cases: Case[] = URLS.flatMap((u) => {
  const href = new URL(u).href;
  return [false, true].map((mcp) => ({ name: `${u} (${mcp ? "mcp" : "402"})`, href, lines: commandLines(href, mcp) }));
});

/** Splits on spaces outside '...' and strips the quotes; returns the words after the first. */
function tokenize(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inQuote = false;
  let has = false;
  for (const ch of line) {
    if (ch === "'") {
      inQuote = !inQuote;
      has = true;
    } else if (ch === " " && !inQuote) {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) words.push(cur);
  return words.slice(1);
}

const asNode = (line: string) => `node '${printer}'${line.slice(line.indexOf(" "))}`;

function checkArgv(line: Line, expected: string[], got: unknown, href: string) {
  assert.deepEqual(got, expected, line.text);
  const argv = got as string[];
  const exact = argv.filter((a) => a === href).length === 1;
  const inJson = argv.some((a) => {
    try {
      return JSON.parse(a).resource === href;
    } catch {
      return false;
    }
  });
  assert.ok(line.validate ? inJson : exact, `url is not one argument in: ${line.text}`);
}

function findBash(): string | undefined {
  if (process.platform === "win32") {
    const git = join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "bin", "bash.exe");
    return existsSync(git) ? git : undefined;
  }
  return spawnSync("bash", ["-c", "exit 0"]).status === 0 ? "bash" : undefined;
}
const bash = findBash();
const powershell =
  process.platform === "win32" && spawnSync("powershell", ["-NoProfile", "-Command", "exit 0"]).status === 0
    ? "powershell"
    : undefined;

function skipIf(t: TestContext, shell: string | undefined, why: string): boolean {
  if (shell) return false;
  t.skip(why);
  return true;
}

for (const c of cases) {
  test(`bash runs the printed commands as written: ${c.name}`, (t) => {
    if (skipIf(t, bash, "bash is not available")) return;
    const shellEnv = { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };
    for (const line of c.lines) {
      // The script goes in on stdin: Git Bash on Windows collapses a doubled backslash in a -c argument.
      const r = spawnSync(bash as string, ["-s"], { env: shellEnv, input: asNode(line.text) + "\n", encoding: "utf8" });
      assert.equal(r.status, 0, `${line.text}\n${r.stderr}`);
      assert.equal(r.stderr, "", line.text);
      checkArgv(line, tokenize(line.text), parseOut("bash", line.text, r.stdout, r.stderr), c.href);
    }
  });

  test(`PowerShell runs the printed commands as written: ${c.name}`, (t) => {
    if (skipIf(t, powershell, "Windows PowerShell is not available")) return;
    const lines = c.lines.filter((l) => !l.validate);
    const r = spawnSync("powershell", ["-NoProfile", "-Command", lines.map((l) => asNode(l.text)).join("\n")], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "", r.stderr);
    const out = r.stdout.split(/\r?\n/).filter((l) => l !== "");
    assert.equal(out.length, lines.length, r.stdout);
    lines.forEach((line, i) =>
      checkArgv(line, tokenize(line.text), parseOut("PowerShell", line.text, out[i], r.stderr), c.href),
    );
  });
}
