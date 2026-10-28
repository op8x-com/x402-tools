import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRules, scanFiles, formatFinding, checkTopLevel, readableNames, ALLOWED_TOP_LEVEL } from "./boundary-check.mjs";

const rules = parseRules(`
# comment lines and blanks are ignored

Secret Plan
umlaut-wörd
path:private/
path:NOTES.local.md
`);

test("parseRules splits terms and path rules", () => {
  assert.deepEqual(rules.terms, ["secret plan", "umlaut-wörd"]);
  assert.deepEqual(rules.paths, ["private/", "NOTES.local.md"]);
});

test("parseRules rejects an empty rule set", () => {
  assert.throws(() => parseRules("# only comments\n\n"), /no rules/i);
});

test("terms match case-insensitively with line numbers", () => {
  const findings = scanFiles([{ path: "a.md", content: "ok\nThe SECRET PLAN is here\n" }], rules);
  assert.deepEqual(findings, [{ path: "a.md", line: 2, rule: 0, kind: "term" }]);
});

test("terms only match on letter and digit boundaries, including non-ASCII letters", () => {
  const files = [
    { path: "b.md", content: "topsecret planning\nsecret planner\n" },
    { path: "c.md", content: "umlaut-wördchen\nxumlaut-wörd\n" },
    { path: "d.md", content: "(umlaut-wörd)\n" },
  ];
  const findings = scanFiles(files, rules);
  assert.deepEqual(findings, [{ path: "d.md", line: 1, rule: 1, kind: "term" }]);
});

test("hyphens and underscores count as boundaries, so identifiers and slugs are caught", () => {
  const files = [{ path: "e.ts", content: "const my_secret-plan_id = 1;\n/blog/secret-plan-launch\n" }];
  const single = parseRules("plan\n");
  assert.deepEqual(scanFiles(files, single), [
    { path: "e.ts", line: 1, rule: 0, kind: "term" },
    { path: "e.ts", line: 2, rule: 0, kind: "term" },
  ]);
});

test("multi-word terms match across line breaks and any whitespace", () => {
  const files = [
    { path: "f.md", content: "intro\nthe secret\nplan follows\n" },
    { path: "g.md", content: "secret  \t plan\n" },
    { path: "h.md", content: "secret plan\r\n" },
  ];
  assert.deepEqual(scanFiles(files, rules), [
    { path: "f.md", line: 2, rule: 0, kind: "term" },
    { path: "g.md", line: 1, rule: 0, kind: "term" },
    { path: "h.md", line: 1, rule: 0, kind: "term" },
  ]);
});

test("every occurrence is reported", () => {
  const findings = scanFiles([{ path: "i.md", content: "secret plan\nok\nsecret plan\n" }], rules);
  assert.deepEqual(findings, [
    { path: "i.md", line: 1, rule: 0, kind: "term" },
    { path: "i.md", line: 3, rule: 0, kind: "term" },
  ]);
});

test("path rules match by prefix or exact file", () => {
  const files = [
    { path: "private/x.ts", content: "" },
    { path: "NOTES.local.md", content: "" },
    { path: "src/private/y.ts", content: "" },
  ];
  const findings = scanFiles(files, rules);
  assert.deepEqual(findings, [
    { path: "private/x.ts", line: 0, rule: 0, kind: "path" },
    { path: "NOTES.local.md", line: 0, rule: 1, kind: "path" },
  ]);
});

test("binary files are skipped", () => {
  const findings = scanFiles([{ path: "img.png", content: "secret plan\u0000\u0001" }], rules);
  assert.deepEqual(findings, []);
});

test("formatFinding names the term locally and hides it when redacted", () => {
  const finding = { path: "a.md", line: 2, rule: 0, kind: "term" };
  assert.equal(formatFinding(finding, rules, false), 'a.md:2: internal term "secret plan"');
  assert.equal(formatFinding(finding, rules, true), "a.md:2: internal term #1");
  const pathFinding = { path: "private/x.ts", line: 0, rule: 0, kind: "path" };
  assert.equal(formatFinding(pathFinding, rules, true), "private/x.ts: path reserved for the private repository (#1)");
});

test("ALLOWED_TOP_LEVEL lists exactly the intended entries", () => {
  assert.deepEqual(
    [...ALLOWED_TOP_LEVEL].sort(),
    [".gitattributes", ".github/", ".gitignore", "CONTRIBUTING.md", "README.md", "apps/", "docs/", "packages/", "scripts/"],
  );
});

test("files under allowed top-level entries produce no finding", () => {
  assert.deepEqual(checkTopLevel(["apps/site/x", "README.md", ".github/workflows/ci.yml", "scripts/a.mjs"]), []);
});

test("unlisted folders and root files each produce one top-level finding", () => {
  const findings = checkTopLevel(["brand/x.svg", "notes.md", "brand/y.svg"]);
  assert.deepEqual(findings, [
    { path: "brand/x.svg", line: 0, entry: "brand", kind: "top-level" },
    { path: "notes.md", line: 0, entry: "notes.md", kind: "top-level" },
    { path: "brand/y.svg", line: 0, entry: "brand", kind: "top-level" },
  ]);
});

test("top-level comparison is case-sensitive", () => {
  assert.deepEqual(checkTopLevel(["Docs/x"]), [{ path: "Docs/x", line: 0, entry: "Docs", kind: "top-level" }]);
});

test("checkTopLevel accepts a custom allow list", () => {
  assert.deepEqual(checkTopLevel(["a/x", "b/y"], ["a/"]), [{ path: "b/y", line: 0, entry: "b", kind: "top-level" }]);
});

test("formatFinding names path, entry and the allow list, with and without redact", () => {
  const finding = { path: "brand/x.svg", line: 0, entry: "brand", kind: "top-level" };
  for (const redact of [false, true]) {
    const text = formatFinding(finding, rules, redact);
    assert.match(text, /brand\/x\.svg/);
    assert.match(text, /"brand"/);
    assert.match(text, /ALLOWED_TOP_LEVEL in scripts\/boundary-check\.mjs/);
  }
  assert.equal(formatFinding(finding, rules, true), formatFinding(finding, rules, false));
});

test("a path below an allowed file entry is a finding", () => {
  assert.deepEqual(checkTopLevel(["README.md/payload.txt"]), [
    { path: "README.md/payload.txt", line: 0, entry: "README.md", kind: "top-level" },
  ]);
});

test("a root file named like an allowed directory is a finding", () => {
  assert.deepEqual(checkTopLevel(["apps"]), [{ path: "apps", line: 0, entry: "apps", kind: "top-level" }]);
});

test("readableNames filters only for reading; the layout check sees every name", () => {
  const names = ["apps/a.txt", "link-to-nowhere"];
  const exists = (p) => p !== "link-to-nowhere";
  assert.deepEqual(readableNames(names, exists), ["apps/a.txt"]);
  assert.equal(checkTopLevel(names).length, 1);
});

test("top-level message is a single line without raw control characters", () => {
  for (const path of ["x/\n::error x::y", "\u001b[2J/y", "::error x::y", `a\u007fb\u0085c${String.fromCharCode(0x2028)}d/z`]) {
    const [finding] = checkTopLevel([path]);
    const text = formatFinding(finding, undefined, false);
    assert.doesNotMatch(text, /[\p{Cc}\p{Zl}\p{Zp}]/u);
    assert.ok(!text.startsWith("::"));
  }
});

function runCheck(files, rulesArg, { rulesText = "zzterm\n", remove = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bc-"));
  try {
    const run = (cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: "utf8", env: { ...process.env, CI: "" } });
    run("git", ["init", "-q"]);
    run("git", ["config", "user.name", "t"]);
    run("git", ["config", "user.email", "t@example.com"]);
    for (const f of files) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), "hello\n");
    }
    writeFileSync(join(dir, ".git", "rules.txt"), rulesText);
    run("git", ["add", "--", ...files]);
    for (const f of remove) rmSync(join(dir, f));
    const script = fileURLToPath(new URL("./boundary-check.mjs", import.meta.url));
    return run(process.execPath, [script, "--all", "--rules", rulesArg ?? join(dir, ".git", "rules.txt")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("main exits 1 for a top-level finding with valid rules", () => {
  const r = runCheck(["README.md", "brand/x.txt"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /top-level entry "brand"/);
});

test("main prints top-level findings before a config error and exits 2", () => {
  const r = runCheck(["README.md", "brand/x.txt"], "missing-rules-file.txt");
  assert.equal(r.status, 2);
  const topLevel = r.stderr.indexOf("top-level entry");
  assert.ok(topLevel !== -1 && topLevel < r.stderr.lastIndexOf("boundary-check: "));
});

test("main exits 0 when clean", () => {
  const r = runCheck(["README.md", "docs/a.md"]);
  assert.equal(r.status, 0, r.stderr);
});

test("a path rule still applies to a listed entry that cannot be read", () => {
  const r = runCheck(["README.md", "docs/private/a.md"], undefined, { rulesText: "path:docs/private/\n", remove: ["docs/private/a.md"] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /docs\/private\/a\.md: path reserved for the private repository \(#1\)/);
});
