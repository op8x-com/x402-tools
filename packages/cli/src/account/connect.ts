import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Deps } from "../cli.ts";
import { send } from "../probe.ts";
import { VERSION } from "../version.ts";
import type { Api, ApiError } from "./api.ts";
import type { Output } from "./output.ts";
import { StoreError, writeSecureFile } from "./store.ts";
import type { WorkerEntry } from "./store.ts";
import { findWrangler } from "./wrangler.ts";
import type { SecretResult, Secrets } from "./wrangler.ts";

// Connecting a worker: K into the worker (wrangler secret put, or a line in a git-ignored env
// file), then one test request with a nonce from the collector, and polling the collector until it
// saw the nonce. Shared by init and rotate.

// --- the test address -----------------------------------------------------------------------------

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Addresses a test request must not reach unless the human typed the URL (a route in the project
 * could otherwise aim it at the seller's own network): unspecified,
 * loopback, private, CGNAT, link-local, benchmark, IETF, multicast and reserved IPv4; unspecified,
 * loopback, IPv4-mapped and -compatible, ULA, link-local and multicast IPv6.
 */
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_V4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["::ffff:0:0", 96], // IPv4-mapped
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_V6.addSubnet(net, prefix, "ipv6");
}

/** True for an address the test request must not reach without --url; also for anything that is no IP. */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  // Two lists: one BlockList also matches IPv4 addresses against its IPv6 rules (::ffff:0:0/96).
  if (kind === 4) return BLOCKED_V4.check(address, "ipv4");
  if (kind === 6) {
    try {
      return BLOCKED_V6.check(address, "ipv6");
    } catch {
      return true;
    }
  }
  return true;
}

/** The host of a URL without the brackets of an IPv6 literal. */
function bareHost(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

/**
 * May the test request go to `url`? Without `explicit` (the URL came from the wrangler routes):
 * only https, and the host (IP literal, or every address `lookup` gives) must be public. With an
 * explicit --url the human chose the host: https, or http on a loopback host.
 */
export async function testUrlAllowed(deps: Pick<Deps, "lookup">, url: string, explicit: boolean): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "") return false;
  if (explicit) return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_NAMES.has(u.hostname));
  if (u.protocol !== "https:") return false;
  const host = bareHost(u);
  if (isIP(host) !== 0) return !isBlockedAddress(host);
  let addresses: string[];
  try {
    addresses = await deps.lookup(host);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every((a) => !isBlockedAddress(a));
}

// --- the test request and the nonce -----------------------------------------------------------------

export const TEST_TIMEOUT_MS = 10_000;
export const POLL_EVERY_MS = 3_000;
export const POLL_FOR_MS = 60_000;
const MAX_POLLS = POLL_FOR_MS / POLL_EVERY_MS;

/**
 * GET <url> with only the header op8x-test: <nonce> (and the op8x User-Agent): no op8x secret, no
 * redirect followed, 10 s timeout, the answer is not looked at (the body is read up to the shared
 * limit and dropped). Whether it arrived is decided by the collector, not by the answer.
 */
export async function sendTestRequest(deps: Pick<Deps, "fetchImpl">, url: string, nonce: string): Promise<void> {
  await send(url, { method: "GET", headers: { "op8x-test": nonce } }, { timeoutMs: TEST_TIMEOUT_MS, version: VERSION, fetchImpl: deps.fetchImpl });
}

export type VerifyResult =
  | { ok: true; seenAt: string }
  /** host_refused: the address may not be tested (not public); the caller asks for --url. */
  | { ok: false; state: "host_refused" | "deployed_unverified" | "stopped" }
  | { ok: false; state: "api"; error: ApiError };

/**
 * Proves that the worker at `url` holds the account's current K: POST test-nonce (R), notice
 * test_host, one test request, then GET test-nonce/<nonce> one after another, at most one per 3 s,
 * for up to 60 s. The host check comes first, so a refused host costs no nonce. After the output
 * guard stopped the output, nothing more is sent.
 */
export async function verifyWorker(o: {
  deps: Pick<Deps, "lookup" | "fetchImpl" | "now" | "sleep">;
  api: Api;
  out: Output;
  readToken: string;
  url: string;
  explicit: boolean;
}): Promise<VerifyResult> {
  const { deps, api, out } = o;
  if (!(await testUrlAllowed(deps, o.url, o.explicit))) return { ok: false, state: "host_refused" };
  if (out.stopped) return { ok: false, state: "stopped" };
  const made = await api.createTestNonce(o.readToken);
  if (!made.ok) return { ok: false, state: "api", error: made.error };
  out.notice("test_host", { host: new URL(o.url).host });
  if (out.stopped) return { ok: false, state: "stopped" };
  await sendTestRequest(deps, o.url, made.value.nonce);
  const started = deps.now();
  for (let polls = 0; polls < MAX_POLLS; polls++) {
    await deps.sleep(POLL_EVERY_MS);
    if (out.stopped) return { ok: false, state: "stopped" };
    const seen = await api.testNonce(o.readToken, made.value.nonce);
    if (!seen.ok) return { ok: false, state: "api", error: seen.error };
    if (seen.value.seen && seen.value.seen_at !== null) return { ok: true, seenAt: seen.value.seen_at };
    if (deps.now() - started >= POLL_FOR_MS) break;
  }
  return { ok: false, state: "deployed_unverified" };
}

// --- env files ------------------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 10_000;
const MAX_ENV_FILE_BYTES = 1024 * 1024;

/** Environment names git needs (its global ignore file lives under HOME or XDG_CONFIG_HOME). */
const GIT_ENV = ["PATH", "SystemRoot", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "XDG_CONFIG_HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"];

function pick(env: Readonly<Record<string, string | undefined>>, names: readonly string[], platform: NodeJS.Platform): Record<string, string> {
  const out: Record<string, string> = {};
  const wanted = new Set(platform === "win32" ? names.map((n) => n.toLowerCase()) : names);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const key = platform === "win32" ? k.toLowerCase() : k;
    if (!wanted.has(key)) continue;
    if (platform === "win32" && Object.keys(out).some((x) => x.toLowerCase() === key)) continue;
    out[k] = v;
  }
  return out;
}

/** PATH from env, whatever its case on Windows. */
function pathOf(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string {
  if (platform !== "win32") return env.PATH ?? "";
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return key === undefined ? "" : (env[key] ?? "");
}

/**
 * The absolute path of git from PATH, or null. Only absolute PATH entries count: a bare name would
 * let Windows look in the current folder first, which may be the seller's project.
 */
export async function gitOnPath(deps: Pick<Deps, "env" | "platform">): Promise<string | null> {
  const win = deps.platform === "win32";
  const exe = win ? "git.exe" : "git";
  for (const entry of pathOf(deps.env, deps.platform).split(win ? ";" : ":")) {
    const dir = win ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, exe);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * May K go into the env file at `path` (absolute)? Only if git ignores it and does not track it,
 * so the key cannot be committed: `git check-ignore -q -- <path>` must exit 0 and `git ls-files --error-unmatch -- <path>`
 * must exit 1, both run without a shell from the file's folder. No repo, no git, a tracked file,
 * any git error, or a file named .dev.vars (wrangler dev reads it) → false.
 */
export async function envFileAllowed(deps: Pick<Deps, "exec" | "env" | "platform">, path: string): Promise<boolean> {
  const name = basename(path).toLowerCase();
  if (name === ".dev.vars" || name.startsWith(".dev.vars.")) return false;
  if (!isAbsolute(path)) return false;
  const git = await gitOnPath(deps);
  if (git === null) return false;
  const env = pick(deps.env, GIT_ENV, deps.platform);
  const opts = { cwd: dirname(path), env, timeoutMs: GIT_TIMEOUT_MS };
  // core.fsmonitor would start a program named in the repo's config.
  const head = ["-c", "core.fsmonitor=false"];
  try {
    const ignored = await deps.exec(git, [...head, "check-ignore", "-q", "--", path], opts);
    if (ignored.code !== 0) return false;
    // ls-files takes a pathspec: read literally, so * or ? in the name match only that name.
    const tracked = await deps.exec(git, [...head, "ls-files", "--error-unmatch", "--", path], { ...opts, env: { ...env, GIT_LITERAL_PATHSPECS: "1" } });
    return tracked.code === 1;
  } catch {
    return false;
  }
}

/**
 * An env file op8x does not rewrite: it holds a carriage return that does not end a line (a CR
 * not followed by LF). Other tools may read such a CR as a line end, so a line op8x leaves alone
 * could hide OP8X_KEY or OP8X_SALT. Thrown before anything is written.
 */
export class EnvFileFormatError extends Error {
  constructor() {
    super("the env file has a carriage return that does not end a line");
    this.name = "EnvFileFormatError";
  }
}

const LONE_CR = /\r(?!\n)/;

/** The names op8x writes into an env file. */
type EnvName = "OP8X_KEY" | "OP8X_SALT";
const setsName = (name: EnvName) => new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=`);
const SETS: Record<EnvName, RegExp> = { OP8X_KEY: setsName("OP8X_KEY"), OP8X_SALT: setsName("OP8X_SALT") };

/**
 * The env file with a line NAME=<value> for each pair: every line that sets NAME is replaced, else
 * the line is appended (after a line break if the file lacks one at its end), in the given order.
 * Names not given stay as they are. Every other byte stays as it is (the file is handled as bytes,
 * lines end with \n or \r\n). A carriage return that does not end a line → EnvFileFormatError.
 */
export function withEnvValues(existing: Buffer | null, values: readonly (readonly [EnvName, string])[]): Buffer {
  const text = existing === null ? "" : existing.toString("latin1");
  if (LONE_CR.test(text)) throw new EnvFileFormatError();
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const found = new Set<EnvName>();
  const lines =
    text === ""
      ? []
      : text.split("\n").map((part) => {
          const cr = part.endsWith("\r");
          const bare = cr ? part.slice(0, -1) : part;
          const hit = values.find(([name]) => SETS[name].test(bare));
          if (hit === undefined) return part;
          found.add(hit[0]);
          const line = `${hit[0]}=${hit[1]}`;
          return cr ? `${line}\r` : line;
        });
  let result = lines.join("\n");
  for (const [name, value] of values) {
    if (found.has(name)) continue;
    result += `${result === "" || result.endsWith("\n") ? "" : eol}${name}=${value}${eol}`;
  }
  return Buffer.from(result, "latin1");
}

/** The env file with the line OP8X_KEY=<key> (see withEnvValues). */
export function withEnvKey(existing: Buffer | null, key: string): Buffer {
  return withEnvValues(existing, [["OP8X_KEY", key]]);
}

/** The env file's bytes, or null if there is none. Not a regular file, too big, unreadable → throws. */
async function readEnvFile(path: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT") return null;
    throw e;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error("not a regular file");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > MAX_ENV_FILE_BYTES) throw new Error("the env file is too big");
      chunks.push(buf.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Puts OP8X_KEY=<key> (and with `salt` also OP8X_SALT=<salt>, in the same write) into the env
 * file at `path` with the same routine as the op8x file (temp file in the target folder, on
 * Windows SID and ACL set and checked before the content goes in, then renamed). Without `salt`
 * an OP8X_SALT line stays as it is. The folder's own rights are left alone. Any failure →
 * StoreError permissions_failed; the file's other content is never shown.
 */
export async function writeEnvKey(deps: Pick<Deps, "platform" | "env" | "exec" | "sleep">, path: string, key: string, salt?: string): Promise<void> {
  let existing: Buffer | null;
  try {
    existing = await readEnvFile(path);
  } catch (e) {
    throw new StoreError("permissions_failed", "The env file could not be read.", { cause: e });
  }
  const values: [EnvName, string][] = [["OP8X_KEY", key], ...(salt === undefined ? [] : [["OP8X_SALT", salt] as [EnvName, string]])];
  await writeSecureFile(deps, path, withEnvValues(existing, values), { ownDir: false });
}

/**
 * The env file without its OP8X_KEY and OP8X_SALT lines, each with its own line end; null if it
 * has none. Every other byte stays as it is (the file is handled as bytes). A carriage return that
 * does not end a line → EnvFileFormatError.
 */
export function withoutEnvKey(existing: Buffer): Buffer | null {
  if (LONE_CR.test(existing.toString("latin1"))) throw new EnvFileFormatError();
  const lines = existing.toString("latin1").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const kept = lines.filter((line) => {
    const bare = line.replace(/\r?\n$/, "");
    return !SETS.OP8X_KEY.test(bare) && !SETS.OP8X_SALT.test(bare);
  });
  return kept.length === lines.length ? null : Buffer.from(kept.join(""), "latin1");
}

/**
 * Removes the OP8X_KEY and OP8X_SALT lines from the env file at `path` with the same routine as writeEnvKey. A
 * file that is gone, or has no such line, is left as it is. Any failure → StoreError
 * permissions_failed; the file's other content is never shown.
 */
export async function removeEnvKey(deps: Pick<Deps, "platform" | "env" | "exec" | "sleep">, path: string): Promise<void> {
  let existing: Buffer | null;
  try {
    existing = await readEnvFile(path);
  } catch (e) {
    throw new StoreError("permissions_failed", "The env file could not be read.", { cause: e });
  }
  if (existing === null) return;
  const next = withoutEnvKey(existing);
  if (next === null) return;
  await writeSecureFile(deps, path, next, { ownDir: false });
}

// --- worker entries --------------------------------------------------------------------------------

/** A time for the op8x file: ISO 8601 UTC without milliseconds. */
export function isoNow(deps: Pick<Deps, "now">): string {
  return new Date(deps.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `workers` with `entry` in place of the entry for the same target, or appended. */
export function upsertWorker(workers: readonly WorkerEntry[], entry: WorkerEntry): WorkerEntry[] {
  const same = (w: WorkerEntry) =>
    entry.env_file !== null ? w.env_file === entry.env_file : w.env_file === null && w.dir === entry.dir && w.name === entry.name && w.env === entry.env;
  const i = workers.findIndex(same);
  return i < 0 ? [...workers, entry] : workers.map((w, j) => (j === i ? entry : w));
}

export type WorkerStatus = "verified" | "unverified" | "no_url" | "failed";

/** The worker as named in a final line. */
export function workerLine(w: Pick<WorkerEntry, "name" | "env" | "env_file">, status: WorkerStatus) {
  return { name: w.name, env: w.env, env_file: w.env_file, status };
}

/**
 * K into one known worker (for rotate): an env-file target is checked again (git-ignored, not
 * tracked) and rewritten; a wrangler target needs the project's wrangler in its folder (no whoami
 * here: the caller checks the Cloudflare login once per run). "stopped": the output guard hit.
 */
export async function putIntoWorker(
  deps: Pick<Deps, "exec" | "env" | "platform" | "sleep" | "nodeVersion">,
  secrets: Secrets,
  out: Output,
  w: WorkerEntry,
  key: string,
): Promise<SecretResult> {
  if (out.stopped) return "stopped";
  if (w.env_file !== null) {
    if (!(await envFileAllowed(deps, w.env_file))) return "failed";
    if (out.stopped) return "stopped";
    try {
      await writeEnvKey(deps, w.env_file, key);
      return "ok";
    } catch {
      return "failed";
    }
  }
  if (w.name === null) return "failed";
  const found = await findWrangler(deps, w.dir);
  if (!found.ok) return "failed";
  return secrets.put(found.bin, { dir: w.dir, name: w.name, env: w.env }, key);
}
