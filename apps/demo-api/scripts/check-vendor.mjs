// Fails when vendor/ no longer matches packages/analytics, so a forgotten repack shows up in CI.
// Usage (from apps/demo-api): node scripts/check-vendor.mjs
// Needs the full git history (actions/checkout with fetch-depth: 0) to find the commit in vendor/SOURCE.
// Checks that vendor/SOURCE names a clean commit, that the tarball's SHA-256 matches SOURCE, that
// package.json installs that tarball, and that no packed file in packages/analytics changed since.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Everything npm pack puts into the tarball, plus what the build reads. Keep in step with "files"
// in packages/analytics/package.json.
export const PACKED_PATHS = ["src", "docs", "README.md", "LICENSE", "package.json", "tsconfig.json"];

export function parseSource(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z0-9]+): (.+)$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  const pkg = /^(@?[^@\s]+)@(\S+)$/.exec(fields.package ?? "");
  const src = /^packages\/analytics at commit ([0-9a-f]{40})( \(with uncommitted changes\))?$/.exec(fields.source ?? "");
  if (!pkg || !src || !fields.tarball || !/^[0-9a-f]{64}$/.test(fields.sha256 ?? "")) {
    throw new Error("vendor/SOURCE is not in the format written by scripts/pack-analytics.mjs");
  }
  return { name: pkg[1], version: pkg[2], commit: src[1], dirty: Boolean(src[2]), tarball: fields.tarball, sha256: fields.sha256 };
}

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.error) throw res.error;
  return res;
}

function main() {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoDir = resolve(appDir, "../..");
  const source = parseSource(readFileSync(join(appDir, "vendor", "SOURCE"), "utf8"));
  const problems = [];

  if (source.dirty) problems.push("vendor/SOURCE says the tarball was packed with uncommitted changes.");

  const sha256 = createHash("sha256").update(readFileSync(join(appDir, "vendor", source.tarball))).digest("hex");
  if (sha256 !== source.sha256) problems.push(`vendor/${source.tarball} does not match the SHA-256 in vendor/SOURCE.`);

  const manifest = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  const expected = `file:vendor/${source.tarball}`;
  if (manifest.dependencies?.[source.name] !== expected) {
    problems.push(`package.json must install "${source.name}": "${expected}".`);
  }

  if (git(["cat-file", "-e", `${source.commit}^{commit}`], repoDir).status !== 0) {
    problems.push(`commit ${source.commit} from vendor/SOURCE is not in this clone (shallow checkout?).`);
  } else {
    const paths = PACKED_PATHS.map((p) => `packages/analytics/${p}`);
    const diff = git(["diff", "--name-only", source.commit, "HEAD", "--", ...paths], repoDir);
    if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
    const changed = diff.stdout.trim();
    if (changed) {
      problems.push(`packages/analytics changed since the tarball was packed:\n${changed.replace(/^/gm, "  ")}`);
    }
  }

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(
      "Repack: commit your changes, then run in apps/demo-api: npm run pack-analytics && npm install ./vendor/" +
        source.tarball,
    );
    process.exit(1);
  }
  console.log(`vendor/${source.tarball} matches packages/analytics at ${source.commit.slice(0, 7)}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
