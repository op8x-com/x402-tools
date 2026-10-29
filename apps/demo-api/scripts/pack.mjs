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

/** Regular files of a gzipped tar archive as a Map from path to contents. */
export function readTarball(gz) {
  const tar = gunzipSync(gz);
  const files = new Map();
  let pos = 0;
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const body = tar.subarray(pos + 512, pos + 512 + size);
    if (body.length !== size) throw new Error(`truncated tar entry ${name}`);
    if (type === "0" || type === "") files.set(name, Buffer.from(body));
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
