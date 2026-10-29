import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSource, PACKED_PATHS } from "./check-vendor.mjs";

const commit = "6f6166cf74548bdf35b50757c4d73b362c9da77b";
const sha = "b46962762c9f5af131eced72b18910ddd180cefe214de5eff4c2345343034e5a";
const lines = (source) =>
  [`package: @op8x/analytics@0.0.1`, `source: ${source}`, `tarball: op8x-analytics-0.0.1.tgz`, `sha256: ${sha}`, ""].join("\n");

test("parseSource reads the format pack-analytics writes", () => {
  assert.deepEqual(parseSource(lines(`packages/analytics at commit ${commit}`)), {
    name: "@op8x/analytics",
    version: "0.0.1",
    commit,
    dirty: false,
    tarball: "op8x-analytics-0.0.1.tgz",
    sha256: sha,
  });
});

test("parseSource accepts CRLF line endings", () => {
  assert.equal(parseSource(lines(`packages/analytics at commit ${commit}`).replace(/\n/g, "\r\n")).commit, commit);
});

test("parseSource flags a tarball packed with uncommitted changes", () => {
  assert.equal(parseSource(lines(`packages/analytics at commit ${commit} (with uncommitted changes)`)).dirty, true);
});

test("parseSource rejects a short commit or a missing field", () => {
  assert.throws(() => parseSource(lines("packages/analytics at commit 6f6166c")), /format/);
  assert.throws(() => parseSource(`package: @op8x/analytics@0.0.1\n`), /format/);
});

test("PACKED_PATHS covers every entry of files in the analytics package", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../../packages/analytics/package.json", import.meta.url), "utf8"));
  // dist is built from src and tsconfig.json, which PACKED_PATHS lists instead.
  for (const entry of pkg.files.filter((f) => f !== "dist")) assert.ok(PACKED_PATHS.includes(entry), entry);
});
