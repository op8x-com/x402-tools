import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks startDir and at most 8 parent directories, stopping early at the filesystem root. */
export function findPackageVersion(startDir: string, name: string): string | undefined {
  let dir = startDir;
  for (let level = 0; level <= 8; level++) {
    try {
      const pkg: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (isObj(pkg) && pkg.name === name && typeof pkg.version === "string") return pkg.version;
    } catch {
      // Missing, unreadable or invalid package.json: keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

// @x402/core/package.json is not in the package's exports, so start from the ./http entry.
// The CJS path only locates the package root; the ESM entry that extract.ts loads is in the same package.
function installedVersion(): string {
  try {
    const entry = createRequire(import.meta.url).resolve("@x402/core/http");
    return findPackageVersion(dirname(entry), "@x402/core") ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const X402_CORE_VERSION: string = installedVersion();
