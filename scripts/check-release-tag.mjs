#!/usr/bin/env node
// Release tag check: the pushed tag (GITHUB_REF_NAME) must equal <prefix><version> of the package.
//
// Usage: node scripts/check-release-tag.mjs <package dir>   e.g. packages/cli
// The package dir is resolved against the repository root (the parent of this script's folder),
// never against the working directory, so the call works from any folder.
// Exit codes: 0 tag matches, 1 mismatch or usage error.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Fixed on purpose: a new released package gets its prefix here, in review.
export const TAG_PREFIXES = {
  "packages/cli": "cli-v",
  "packages/analytics": "analytics-v",
};

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function checkReleaseTag({ tag, packageDir, root = REPO_ROOT }) {
  const dir = String(packageDir ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!Object.hasOwn(TAG_PREFIXES, dir)) {
    const known = Object.keys(TAG_PREFIXES).join(", ");
    return { ok: false, message: `Unknown package dir "${packageDir ?? ""}" (known: ${known})` };
  }
  if (!tag) return { ok: false, message: "GITHUB_REF_NAME is not set; run this on a tag push" };
  let version;
  try {
    version = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).version;
  } catch (err) {
    return { ok: false, message: `Cannot read ${dir}/package.json: ${err.message}` };
  }
  if (typeof version !== "string" || version === "") {
    return { ok: false, message: `${dir}/package.json has no version` };
  }
  const expected = `${TAG_PREFIXES[dir]}${version}`;
  if (tag !== expected) return { ok: false, message: `Tag ${tag} does not match package version (${expected})` };
  return { ok: true, message: `Tag ${tag} matches ${dir}/package.json` };
}

export function main(argv, env = process.env) {
  if (argv.length !== 1) {
    console.error("Usage: node scripts/check-release-tag.mjs <package dir>");
    return 1;
  }
  const result = checkReleaseTag({ tag: env.GITHUB_REF_NAME, packageDir: argv[0] });
  if (!result.ok) {
    console.error(result.message);
    return 1;
  }
  console.log(result.message);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
