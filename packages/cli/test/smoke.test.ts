import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PaymentRequiredV1Schema, PaymentRequiredV2Schema } from "@x402/core/schemas";
import { v1, v2 } from "./fixtures.ts";
import { VERSION } from "../src/version.ts";
import { X402_CORE_VERSION, findPackageVersion } from "../src/core-version.ts";
import pkg from "../package.json" with { type: "json" };

test("v2 fixture is valid per @x402/core", () => {
  assert.equal(PaymentRequiredV2Schema.safeParse(v2).success, true);
});

test("v1 fixture is valid per @x402/core", () => {
  assert.equal(PaymentRequiredV1Schema.safeParse(v1).success, true);
});

test("VERSION matches package.json", () => {
  assert.equal(VERSION, pkg.version);
});

// Independent of the code under test: walk up to the first node_modules/@x402/core.
function installedCoreVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = join(dir, "node_modules", "@x402", "core", "package.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).version;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("@x402/core is not installed");
    dir = parent;
  }
}

const tempRoots: string[] = [];
after(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

// A temporary directory with `depth` nested subdirectories; returns the deepest one.
function nested(depth: number): { root: string; leaf: string } {
  const root = mkdtempSync(join(tmpdir(), "op8x-core-version-"));
  tempRoots.push(root);
  const leaf = join(root, ...Array.from({ length: depth }, (_, i) => `d${i}`));
  mkdirSync(leaf, { recursive: true });
  return { root, leaf };
}
const core = JSON.stringify({ name: "@x402/core", version: "9.9.9" });

test("X402_CORE_VERSION is the installed @x402/core, within the declared range", () => {
  assert.equal(X402_CORE_VERSION, installedCoreVersion());
  const [major, minor] = pkg.dependencies["@x402/core"].replace(/^~/, "").split(".");
  assert.ok(X402_CORE_VERSION.startsWith(`${major}.${minor}.`));
});

test("findPackageVersion: nothing found gives undefined", () => {
  assert.equal(findPackageVersion(nested(1).leaf, "@x402/core"), undefined);
});

test("findPackageVersion skips invalid JSON and other names", () => {
  const { root, leaf } = nested(2);
  writeFileSync(join(root, "package.json"), core);
  writeFileSync(join(leaf, "package.json"), "{ not json");
  writeFileSync(join(dirname(leaf), "package.json"), JSON.stringify({ name: "other", version: "1.0.0" }));
  assert.equal(findPackageVersion(leaf, "@x402/core"), "9.9.9");
});

test("findPackageVersion checks startDir and at most 8 parents", () => {
  const eight = nested(8);
  writeFileSync(join(eight.root, "package.json"), core);
  assert.equal(findPackageVersion(eight.leaf, "@x402/core"), "9.9.9");
  const nine = nested(9);
  writeFileSync(join(nine.root, "package.json"), core);
  assert.equal(findPackageVersion(nine.leaf, "@x402/core"), undefined);
});
