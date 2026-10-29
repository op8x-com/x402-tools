import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { diffTarballs, parseSource } from "./check-vendor.mjs";
import { readTarball } from "./pack.mjs";

const commit = "6f6166cf74548bdf35b50757c4d73b362c9da77b";
const sha = "b46962762c9f5af131eced72b18910ddd180cefe214de5eff4c2345343034e5a";
const lines = ({ source = `packages/analytics at commit ${commit}`, tarball = "op8x-analytics-0.0.1.tgz" } = {}) =>
  [`package: @op8x/analytics@0.0.1`, `source: ${source}`, `tarball: ${tarball}`, `sha256: ${sha}`, ""].join("\n");

// A minimal ustar archive: one 512-byte header per file, contents padded to 512 bytes, two zero blocks.
function tgz(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write(body.length.toString(8).padStart(11, "0"), 124);
    header.write("0", 156);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("parseSource reads the format pack-analytics writes", () => {
  assert.deepEqual(parseSource(lines()), {
    name: "@op8x/analytics",
    version: "0.0.1",
    commit,
    dirty: false,
    tarball: "op8x-analytics-0.0.1.tgz",
    sha256: sha,
  });
});

test("parseSource accepts CRLF line endings", () => {
  assert.equal(parseSource(lines().replace(/\n/g, "\r\n")).commit, commit);
});

test("parseSource flags a tarball packed with uncommitted changes", () => {
  assert.equal(parseSource(lines({ source: `packages/analytics at commit ${commit} (with uncommitted changes)` })).dirty, true);
});

test("parseSource rejects a short commit, a tarball path outside vendor/ and a missing field", () => {
  assert.throws(() => parseSource(lines({ source: "packages/analytics at commit 6f6166c" })), /format/);
  assert.throws(() => parseSource(lines({ tarball: "../../package.json" })), /format/);
  assert.throws(() => parseSource(`package: @op8x/analytics@0.0.1\n`), /format/);
});

test("readTarball returns the files of an archive, including one larger than a block", () => {
  const big = "x".repeat(700);
  const files = readTarball(tgz({ "package/a.js": "a", "package/big.txt": big }));
  assert.deepEqual([...files.keys()], ["package/a.js", "package/big.txt"]);
  assert.equal(files.get("package/big.txt").toString(), big);
});

test("diffTarballs reports changed, added and removed files", () => {
  const vendored = readTarball(tgz({ "package/a.js": "a", "package/b.js": "b" }));
  const fresh = readTarball(tgz({ "package/a.js": "A", "package/c.js": "c" }));
  assert.deepEqual(diffTarballs(vendored, fresh), [
    "package/a.js",
    "package/b.js (only in vendor)",
    "package/c.js (missing from vendor)",
  ]);
});

test("diffTarballs ignores devDependencies in package.json, but not dependencies or scripts", () => {
  const manifest = (extra) => JSON.stringify({ name: "@op8x/analytics", ...extra });
  const pack = (extra) => readTarball(tgz({ "package/package.json": manifest(extra) }));
  const base = { scripts: { build: "tsc" }, devDependencies: { typescript: "5.9.2" } };
  assert.deepEqual(diffTarballs(pack(base), pack({ ...base, devDependencies: { typescript: "5.9.3" } })), []);
  assert.deepEqual(diffTarballs(pack(base), pack({ ...base, scripts: { postinstall: "x" } })), ["package/package.json"]);
  assert.deepEqual(diffTarballs(pack(base), pack({ ...base, dependencies: { hono: "4" } })), ["package/package.json"]);
});
