// Builds and packs packages/analytics, copies the tarball into vendor/ and records where it came from.
// Usage (from apps/demo-api): node scripts/pack-analytics.mjs
// The package's dev dependencies must be installed first (npm ci in packages/analytics).
// Refuses to run when packages/analytics has uncommitted changes, so vendor/SOURCE always names
// a commit that reproduces the tarball. Pass --allow-dirty to pack anyway (SOURCE then says so).
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDir, packAnalytics, pkgDir, run, vendorDir } from "./pack.mjs";

const allowDirty = process.argv.includes("--allow-dirty");

const commit = run("git", ["rev-parse", "HEAD"], pkgDir).trim();
const dirty = run("git", ["status", "--porcelain", "--", "."], pkgDir).trim() !== "";
if (dirty && !allowDirty) {
  console.error("packages/analytics has uncommitted changes; commit them first or pass --allow-dirty.");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "op8x-pack-"));
try {
  const { name, version, tarball } = packAnalytics(tmp);

  for (const f of readdirSync(vendorDir)) {
    if (f.endsWith(".tgz")) rmSync(join(vendorDir, f));
  }
  copyFileSync(join(tmp, tarball), join(vendorDir, tarball));

  const sha256 = createHash("sha256").update(readFileSync(join(vendorDir, tarball))).digest("hex");
  const source = [
    `package: ${name}@${version}`,
    `source: packages/analytics at commit ${commit}${dirty ? " (with uncommitted changes)" : ""}`,
    `tarball: ${tarball}`,
    `sha256: ${sha256}`,
    "",
  ].join("\n");
  writeFileSync(join(vendorDir, "SOURCE"), source);
  process.stdout.write(source);

  const manifest = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  const expected = `file:vendor/${tarball}`;
  if (manifest.dependencies?.[name] !== expected) {
    console.log(`Update package.json: "${name}": "${expected}", then run: npm install ./vendor/${tarball}`);
  } else {
    // A plain `npm install` may keep the old integrity from package-lock.json; naming the file refreshes it.
    console.log(`Refresh the lockfile: npm install ./vendor/${tarball}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
