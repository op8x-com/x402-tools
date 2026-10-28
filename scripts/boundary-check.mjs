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

// Top-level entries (folders or root files) that may exist in this repository. Anything else is
// reported, so the repository layout stays intentional. Add an entry here deliberately, in review.
// A trailing slash marks a directory; an entry without one is a root file.
export const ALLOWED_TOP_LEVEL = [
  ".github/",
  "apps/",
  "docs/",
  "packages/",
  "scripts/",
  ".gitattributes",
  ".gitignore",
  "README.md",
  "CONTRIBUTING.md",
];

// Case-sensitive on purpose: git on Linux and in CI compares names that way.
export function checkTopLevel(paths, allowed = ALLOWED_TOP_LEVEL) {
  const findings = [];
  for (const path of paths) {
    const slash = path.indexOf("/");
    const entry = slash === -1 ? path : path.slice(0, slash);
    const ok = allowed.includes(slash === -1 ? entry : `${entry}/`);
    if (!ok) findings.push({ path, line: 0, entry, kind: "top-level" });
  }
  return findings;
}

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

// File names are untrusted: quote them and escape control characters, so nothing reaches the terminal
// or a CI log as a raw control sequence or workflow command.
function printable(s) {
  return JSON.stringify(s).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function formatFinding(f, rules, redact) {
  if (f.kind === "top-level") {
    return `${printable(f.path)}: top-level entry ${printable(f.entry)} is not allowed; if it belongs in this repository, add it to ALLOWED_TOP_LEVEL in scripts/boundary-check.mjs`;
  }
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

// Every name git reports, including entries that cannot be read (for example a dangling symlink).
function listFiles(staged) {
  if (staged) return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).split("\0").filter(Boolean);
  return git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
}

// Only the content scan needs readable files; the layout check uses the full list.
export function readableNames(names, exists = existsSync) {
  return names.filter((path) => exists(path));
}

// Unreadable names keep an entry with empty content: path rules still apply, no content is scanned.
function readFiles(names, staged) {
  const readable = new Set(staged ? names : readableNames(names));
  return names.map((path) => {
    if (!readable.has(path)) return { path, content: "" };
    return { path, content: staged ? gitBuffer(["show", `:${path}`]) : readFileSync(path).toString("utf8") };
  });
}

function main(argv) {
  const redact = argv.includes("--redact") || process.env.CI === "true";
  const staged = argv.includes("--staged");
  const fail = (err) => console.error(`boundary-check: ${err instanceof Error ? err.message : String(err)}`);
  let names;
  try {
    names = listFiles(staged);
  } catch (err) {
    fail(err);
    return 2;
  }
  // The top-level check needs no rules, so it runs (and reports) first.
  const topLevel = checkTopLevel(names);
  let rules;
  let files;
  try {
    rules = loadRules(argv);
    files = readFiles(names, staged);
  } catch (err) {
    for (const f of topLevel) console.error(formatFinding(f, undefined, redact));
    fail(err);
    return 2;
  }
  const findings = [...topLevel, ...scanFiles(files, rules)];
  if (findings.length === 0) {
    console.log(`boundary-check: ${files.length} files clean.`);
    return 0;
  }
  for (const f of findings) console.error(formatFinding(f, rules, redact));
  console.error(`boundary-check: ${findings.length} finding(s). Rephrase or move the content, or add an allowed top-level entry deliberately; do not bypass the check.`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
