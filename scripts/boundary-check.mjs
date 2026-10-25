#!/usr/bin/env node
// Boundary check: keeps internal wording and private components out of this public repository.
//
// The rules are deliberately not stored here. They come from, in order:
//   1. --rules <file>
//   2. the BOUNDARY_TERMS environment variable (newline-separated; set as a CI secret)
//   3. .boundary-rules in the repository root (local, git-ignored)
// One rule per line: a term (matched case-insensitively on word boundaries) or "path:<prefix>".
// Lines starting with # are comments.
//
// Usage: node scripts/boundary-check.mjs [--staged | --all] [--redact] [--rules <file>]
// Exit codes: 0 clean, 1 findings, 2 configuration or git error.
// --redact (implied when CI=true) prints rule numbers instead of terms, because CI logs are public.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LOCAL_RULES = ".boundary-rules";

export function parseRules(text) {
  const terms = [];
  const paths = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("path:")) paths.push(line.slice("path:".length).trim());
    else terms.push(line.toLowerCase());
  }
  if (terms.length === 0 && paths.length === 0) throw new Error("No rules found in the boundary rule set.");
  return { terms, paths };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whitespace inside a term matches any whitespace run, including line breaks, so wrapped prose is caught.
// Only letters and digits count as word characters: "plan" matches in "my_plan" and "plan-launch".
function termPattern(term) {
  const body = term.split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

function lineAt(content, index) {
  let line = 1;
  for (let i = content.indexOf("\n"); i !== -1 && i < index; i = content.indexOf("\n", i + 1)) line++;
  return line;
}

export function scanFiles(files, rules) {
  const patterns = rules.terms.map(termPattern);
  const findings = [];
  for (const { path, content } of files) {
    const pathRule = rules.paths.findIndex((p) => path === p || (p.endsWith("/") && path.startsWith(p)));
    if (pathRule !== -1) findings.push({ path, line: 0, rule: pathRule, kind: "path" });
    if (content.includes("\u0000")) continue;
    const termFindings = [];
    patterns.forEach((re, rule) => {
      for (const m of content.matchAll(re)) termFindings.push({ path, line: lineAt(content, m.index), rule, kind: "term" });
    });
    termFindings.sort((a, b) => a.line - b.line || a.rule - b.rule);
    findings.push(...termFindings);
  }
  return findings;
}

export function formatFinding(f, rules, redact) {
  if (f.kind === "path") return `${f.path}: path reserved for the private repository (#${f.rule + 1})`;
  const label = redact ? `#${f.rule + 1}` : `"${rules.terms[f.rule]}"`;
  return `${f.path}:${f.line}: internal term ${label}`;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function gitBuffer(args) {
  return execFileSync("git", args, { maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
}

function loadRules(argv) {
  const i = argv.indexOf("--rules");
  if (i !== -1) {
    const file = argv[i + 1];
    if (!file) throw new Error("--rules needs a file path.");
    return parseRules(readFileSync(file, "utf8"));
  }
  if (process.env.BOUNDARY_TERMS) return parseRules(process.env.BOUNDARY_TERMS);
  if (existsSync(LOCAL_RULES)) return parseRules(readFileSync(LOCAL_RULES, "utf8"));
  throw new Error(`No boundary rules: pass --rules, set BOUNDARY_TERMS, or create ${LOCAL_RULES} in the repository root.`);
}

function collectFiles(staged) {
  if (staged) {
    const names = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).split("\0").filter(Boolean);
    return names.map((path) => ({ path, content: gitBuffer(["show", `:${path}`]) }));
  }
  const names = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  return names.filter((path) => existsSync(path)).map((path) => ({ path, content: readFileSync(path).toString("utf8") }));
}

function main(argv) {
  const redact = argv.includes("--redact") || process.env.CI === "true";
  let rules;
  let files;
  try {
    rules = loadRules(argv);
    files = collectFiles(argv.includes("--staged"));
  } catch (err) {
    console.error(`boundary-check: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const findings = scanFiles(files, rules);
  if (findings.length === 0) {
    console.log(`boundary-check: ${files.length} files clean.`);
    return 0;
  }
  for (const f of findings) console.error(formatFinding(f, rules, redact));
  console.error(`boundary-check: ${findings.length} finding(s). Rephrase or move the content; do not bypass the check.`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
