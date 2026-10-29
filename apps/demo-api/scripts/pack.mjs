// Shared by pack-analytics.mjs and check-vendor.mjs: builds and packs packages/analytics, and reads
// npm pack tarballs. The package's dev dependencies must be installed first (npm ci in packages/analytics).
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pkgDir = resolve(appDir, "../../packages/analytics");
export const vendorDir = join(appDir, "vendor");

export function run(cmd, args, cwd) {
  // npm is a .cmd file on Windows and needs a shell there. The arguments are fixed strings plus a
  // temp path, quoted here because the shell only concatenates.
  const res =
    process.platform === "win32"
      ? spawnSync([cmd, ...args.map((a) => `"${a}"`)].join(" "), { cwd, encoding: "utf8", shell: true })
      : spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    process.stderr.write(res.stdout ?? "");
    process.stderr.write(res.stderr ?? "");
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${res.status}`);
  }
  return res.stdout;
}

/** Builds packages/analytics and packs it into destDir; returns the package name, version and tarball file name. */
export function packAnalytics(destDir) {
  run("npm", ["run", "build"], pkgDir);
  const out = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", destDir], pkgDir));
  const { filename, name, version } = out[0];
  return { name, version, tarball: filename.replace(/^.*[\\/]/, "") };
}

/**
 * Regular files of a gzipped tar archive as a Map from path to contents. Strict on purpose: it only
 * reads what npm pack writes (ustar headers, regular files and directories, unique paths) and throws
 * on anything else, such as pax or GNU headers, links or data after the end marker. Another tar
 * reader, like the one npm installs with, could otherwise see different files than this one.
 */
export function readTarball(gz) {
  const tar = gunzipSync(gz);
  const files = new Map();
  const seen = new Set();
  let pos = 0;
  for (;;) {
    if (pos + 512 > tar.length) throw new Error("tar archive has no end marker");
    const header = tar.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) {
      if (!tar.subarray(pos).every((b) => b === 0)) throw new Error("tar archive has data after the end marker");
      return files;
    }
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    if (field(257, 6) !== "ustar") throw new Error("tar entry is not in ustar format");
    const sizeField = field(124, 12).trim();
    if (!/^[0-7]+$/.test(sizeField)) throw new Error("tar entry has an invalid size");
    const size = parseInt(sizeField, 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    if (type !== "0" && type !== "" && type !== "5") throw new Error(`tar entry ${name} has unsupported type ${JSON.stringify(type)}`);
    if (seen.has(name)) throw new Error(`tar archive has ${name} twice`);
    seen.add(name);
    const body = tar.subarray(pos + 512, pos + 512 + size);
    if (body.length !== size) throw new Error(`truncated tar entry ${name}`);
    if (type !== "5") files.set(name, Buffer.from(body));
    pos += 512 + Math.ceil(size / 512) * 512;
  }
}
