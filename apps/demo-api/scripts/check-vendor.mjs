// Fails when vendor/ no longer matches packages/analytics, so a forgotten repack or a hand-edited
// tarball shows up in CI.
// Usage (from apps/demo-api): node scripts/check-vendor.mjs
// The package's dev dependencies must be installed first (npm ci in packages/analytics).
// Packs packages/analytics afresh and compares the files with the vendored tarball, file by file.
// Also checks that vendor/SOURCE was written from a clean tree, that the tarball's SHA-256 matches
// SOURCE and that package.json installs that tarball.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appDir, packAnalytics, readTarball, vendorDir } from "./pack.mjs";

export function parseSource(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z0-9]+): (.+)$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  const pkg = /^(@?[^@\s]+)@(\S+)$/.exec(fields.package ?? "");
  const src = /^packages\/analytics at commit ([0-9a-f]{40})( \(with uncommitted changes\))?$/.exec(fields.source ?? "");
  const tarball = /^[a-z0-9][a-z0-9.-]*\.tgz$/.test(fields.tarball ?? "") ? fields.tarball : undefined;
  if (!pkg || !src || !tarball || !/^[0-9a-f]{64}$/.test(fields.sha256 ?? "")) {
    throw new Error("vendor/SOURCE is not in the format written by scripts/pack-analytics.mjs");
  }
  return { name: pkg[1], version: pkg[2], commit: src[1], dirty: Boolean(src[2]), tarball, sha256: fields.sha256 };
}

// devDependencies never reach a project that installs the package, so a dev-only update in
// packages/analytics does not require a repack.
function installedManifest(buf) {
  const manifest = JSON.parse(buf.toString("utf8"));
  delete manifest.devDependencies;
  return JSON.stringify(manifest);
}

/** Paths that differ between two tarballs (Maps from readTarball), sorted. */
export function diffTarballs(vendored, fresh) {
  const differ = [];
  for (const path of new Set([...vendored.keys(), ...fresh.keys()])) {
    const a = vendored.get(path);
    const b = fresh.get(path);
    if (!a || !b) differ.push(`${path} (${a ? "only in vendor" : "missing from vendor"})`);
    else if (path === "package/package.json" ? installedManifest(a) !== installedManifest(b) : !a.equals(b)) {
      differ.push(path);
    }
  }
  return differ.sort();
}

function main() {
  const source = parseSource(readFileSync(join(vendorDir, "SOURCE"), "utf8"));
  const vendored = readFileSync(join(vendorDir, source.tarball));
  const problems = [];

  if (source.dirty) problems.push("vendor/SOURCE says the tarball was packed with uncommitted changes.");

  const sha256 = createHash("sha256").update(vendored).digest("hex");
  if (sha256 !== source.sha256) problems.push(`vendor/${source.tarball} does not match the SHA-256 in vendor/SOURCE.`);

  const manifest = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  const expected = `file:vendor/${source.tarball}`;
  if (manifest.dependencies?.[source.name] !== expected) {
    problems.push(`package.json must install "${source.name}": "${expected}".`);
  }

  const tmp = mkdtempSync(join(tmpdir(), "op8x-check-"));
  try {
    const fresh = packAnalytics(tmp);
    if (fresh.tarball !== source.tarball) {
      problems.push(`packages/analytics now packs as ${fresh.tarball}, vendor/ has ${source.tarball}.`);
    } else {
      const differ = diffTarballs(readTarball(vendored), readTarball(readFileSync(join(tmp, fresh.tarball))));
      if (differ.length > 0) {
        problems.push(`vendor/${source.tarball} differs from a fresh pack of packages/analytics:\n${differ.map((p) => `  ${p}`).join("\n")}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(
      "Repack: commit your changes, then run in apps/demo-api: npm run pack-analytics && npm install ./vendor/" +
        source.tarball,
    );
    process.exit(1);
  }
  console.log(`vendor/${source.tarball} matches a fresh pack of packages/analytics.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
