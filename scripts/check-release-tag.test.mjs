import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReleaseTag, TAG_PREFIXES } from "./check-release-tag.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "release-tag-"));
  for (const [dir, version] of [["packages/cli", "0.1.0"], ["packages/analytics", "0.0.3"]]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({ version }));
  }
  return root;
}

test("prefix table covers exactly the released packages", () => {
  assert.deepEqual(TAG_PREFIXES, { "packages/cli": "cli-v", "packages/analytics": "analytics-v" });
});

test("cli: only the exact tag matches", () => {
  const root = fixtureRoot();
  try {
    assert.equal(checkReleaseTag({ tag: "cli-v0.1.0", packageDir: "packages/cli", root }).ok, true);
    for (const tag of ["cli-v0.1.0-rc", "cli-v0.0.9", "analytics-v0.1.0"]) {
      const result = checkReleaseTag({ tag, packageDir: "packages/cli", root });
      assert.equal(result.ok, false, tag);
      assert.equal(result.message, `Tag ${tag} does not match package version (cli-v0.1.0)`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("analytics: only the exact tag matches", () => {
  const root = fixtureRoot();
  try {
    assert.equal(checkReleaseTag({ tag: "analytics-v0.0.3", packageDir: "packages/analytics", root }).ok, true);
    for (const tag of ["analytics-v0.0.3-rc", "analytics-v0.0.2", "cli-v0.0.3"]) {
      const result = checkReleaseTag({ tag, packageDir: "packages/analytics", root });
      assert.equal(result.ok, false, tag);
      assert.equal(result.message, `Tag ${tag} does not match package version (analytics-v0.0.3)`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trailing slash and ./ in the package dir are accepted", () => {
  const root = fixtureRoot();
  try {
    assert.equal(checkReleaseTag({ tag: "cli-v0.1.0", packageDir: "./packages/cli/", root }).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown package dir is an error", () => {
  const root = fixtureRoot();
  try {
    const result = checkReleaseTag({ tag: "cli-v0.1.0", packageDir: "packages/other", root });
    assert.equal(result.ok, false);
    assert.match(result.message, /unknown package dir "packages\/other"/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing or empty tag is an error", () => {
  const root = fixtureRoot();
  try {
    for (const tag of [undefined, ""]) {
      const result = checkReleaseTag({ tag, packageDir: "packages/cli", root });
      assert.equal(result.ok, false);
      assert.match(result.message, /GITHUB_REF_NAME is not set/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// End to end against this repository, run from a package folder like the release job does.
const script = fileURLToPath(new URL("./check-release-tag.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliDir = join(repoRoot, "packages", "cli");
const cliVersion = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).version;
const run = (args, env) =>
  spawnSync(process.execPath, [script, ...args], { cwd: cliDir, encoding: "utf8", env: { ...process.env, ...env } });

test("CLI: matching tag exits 0, independent of the working directory", () => {
  const result = run(["packages/cli"], { GITHUB_REF_NAME: `cli-v${cliVersion}` });
  assert.equal(result.status, 0, result.stderr);
});

test("CLI: mismatching tag exits 1 with the message", () => {
  const result = run(["packages/cli"], { GITHUB_REF_NAME: "cli-v999.0.0" });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, new RegExp(`Tag cli-v999\\.0\\.0 does not match package version \\(cli-v${cliVersion.replace(/\./g, "\\.")}\\)`));
});

test("CLI: missing GITHUB_REF_NAME, missing or unknown argument exit 1", () => {
  assert.equal(run(["packages/cli"], { GITHUB_REF_NAME: "" }).status, 1);
  assert.equal(run([], { GITHUB_REF_NAME: `cli-v${cliVersion}` }).status, 1);
  assert.equal(run(["packages/nope"], { GITHUB_REF_NAME: `cli-v${cliVersion}` }).status, 1);
});
