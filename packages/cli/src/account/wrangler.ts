import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Deps, ExecResult } from "../cli.ts";
import { isKey } from "./keys.ts";
import type { Output } from "./output.ts";

// The seller's own wrangler: found only in the worker folder, started with node itself (no shell,
// no npx), with an allowlisted environment, the server key only on stdin. Its output is never
// shown; only the exit code counts (for whoami also `loggedIn`). The configuration reader reads a
// small subset of wrangler.json / wrangler.jsonc / wrangler.toml and treats the file as hostile.

export const WRANGLER_TIMEOUT_MS = 120_000;
/** The name of the secret in the worker. */
export const WRANGLER_SECRET = "OP8X_KEY";
export const MAX_CONFIG_BYTES = 256 * 1024;
export const MAX_CONFIG_DEPTH = 16;

const MIN_WRANGLER = [4, 152, 0] as const;
const MIN_NODE_MAJOR = 22;
const MAX_PACKAGE_JSON = 1024 * 1024;
/** `^[a-z0-9-]{1,63}$` and not in flag form (no leading dash). */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** True for a worker or environment name wrangler may get in argv. */
export function isWranglerName(v: unknown): v is string {
  return typeof v === "string" && NAME.test(v);
}

// --- finding ------------------------------------------------------------------------------------

export interface WranglerBin {
  /** The worker folder (resolved); cwd of every start. */
  dir: string;
  /** The real path of node_modules/wrangler/bin/wrangler.js, inside the real path of `dir`. */
  script: string;
  version: string;
}

export type FindResult = { ok: true; bin: WranglerBin } | { ok: false; state: "wrangler_missing" | "wrangler_too_old" };

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

/** At most `max` bytes of a regular file; opened without blocking, so a FIFO cannot hang. */
async function readLimited(path: string, max: number): Promise<Buffer | "missing" | "error"> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
  }
  try {
    if (!(await handle.stat()).isFile()) return "error";
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > max) return "error";
      chunks.push(buf.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } catch {
    return "error";
  } finally {
    await handle.close().catch(() => {});
  }
}

function tooOld(version: RegExpExecArray): boolean {
  const parts = [Number(version[1]), Number(version[2]), Number(version[3])];
  for (let i = 0; i < 3; i++) {
    if (parts[i]! > MIN_WRANGLER[i]!) return false;
    if (parts[i]! < MIN_WRANGLER[i]!) return true;
  }
  return version[4] !== undefined; // a pre-release of the minimum comes before it
}

/**
 * The wrangler of the project in `dir`: only `<dir>/node_modules/wrangler/bin/wrangler.js`, whose
 * real path lies inside the real path of `dir`, in a package named `wrangler` (A42). No search in
 * parent folders. Version ≥ 4.152.0 and Node ≥ 22, else wrangler_too_old.
 */
export async function findWrangler(deps: Pick<Deps, "nodeVersion">, dir: string): Promise<FindResult> {
  const missing = { ok: false, state: "wrangler_missing" } as const;
  const root = resolve(dir);
  const pkgDir = join(root, "node_modules", "wrangler");
  let script: string;
  let pkgPath: string;
  try {
    const realRoot = await realpath(root);
    script = await realpath(join(pkgDir, "bin", "wrangler.js"));
    pkgPath = await realpath(join(pkgDir, "package.json"));
    if (!inside(realRoot, script) || !inside(realRoot, pkgPath)) return missing;
    if (!(await stat(script)).isFile()) return missing;
  } catch {
    return missing;
  }
  const raw = await readLimited(pkgPath, MAX_PACKAGE_JSON);
  if (!Buffer.isBuffer(raw)) return missing;
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw.toString("utf8"));
  } catch {
    return missing;
  }
  if (typeof pkg !== "object" || pkg === null) return missing;
  const { name, version } = pkg as { name?: unknown; version?: unknown };
  if (name !== "wrangler" || typeof version !== "string") return missing;
  const v = VERSION.exec(version);
  if (v === null) return missing;
  const node = /^v?(\d+)\./.exec(deps.nodeVersion);
  if (tooOld(v) || node === null || Number(node[1]) < MIN_NODE_MAJOR) return { ok: false, state: "wrangler_too_old" };
  return { ok: true, bin: { dir: root, script, version } };
}

// --- start --------------------------------------------------------------------------------------

const ALLOWED_ENV = [
  "PATH",
  "SystemRoot",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "TEMP",
  "TMP",
] as const;
const ALLOWED_EXACT: ReadonlySet<string> = new Set(ALLOWED_ENV);
const ALLOWED_LOWER: ReadonlySet<string> = new Set(ALLOWED_ENV.map((n) => n.toLowerCase()));

/**
 * Always set for the child. wrangler loads the project's dotenv files itself, but a value already in
 * its process environment wins over them, so a dotenv file cannot switch off log sanitizing (which
 * would put the `secret put` body, the server key, into wrangler's log) or turn the log file on.
 */
const FIXED_ENV = { WRANGLER_LOG_SANITIZE: "true", WRANGLER_WRITE_LOGS: "false" } as const;

/**
 * The child environment: only the allowlist (WRANGLER_LOG, WRANGLER_LOG_PATH, DEBUG, NODE_OPTIONS
 * and everything else stay out), plus the fixed log settings. Under win32 names match without
 * regard to case and keep their spelling (`Path` stays `Path`; the first of two spellings wins);
 * under POSIX exactly.
 */
export function wranglerEnv(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (platform === "win32") {
      const lower = name.toLowerCase();
      if (!ALLOWED_LOWER.has(lower) || seen.has(lower)) continue;
      seen.add(lower);
    } else if (!ALLOWED_EXACT.has(name)) continue;
    out[name] = value;
  }
  // Neither name is on the allowlist, so no other spelling of them is in `out`.
  return { ...out, ...FIXED_ENV };
}

type RunDeps = Pick<Deps, "exec" | "env" | "platform">;

/** One start of wrangler; null if the start itself failed. stdin is always a pipe. */
async function runWrangler(deps: RunDeps, bin: WranglerBin, args: string[], input?: string): Promise<ExecResult | null> {
  try {
    return await deps.exec(process.execPath, [bin.script, ...args], {
      cwd: bin.dir,
      env: wranglerEnv(deps.env, deps.platform),
      ...(input === undefined ? {} : { input }),
      timeoutMs: WRANGLER_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

// --- whoami -------------------------------------------------------------------------------------

/**
 * `loggedIn` of the JSON object at the end of whoami's stdout (wrangler may print an empty line or
 * a banner first; the logged-in answer is pretty-printed). Only lines that start with `{` in the
 * first column are tried, from the end, at most 16. Nothing else of the answer is kept.
 */
function loggedInFrom(stdout: string): boolean {
  let end = stdout.length;
  let tries = 0;
  while (end > 0 && tries < 16) {
    const nl = stdout.lastIndexOf("\n", end - 1);
    const start = nl + 1;
    if (stdout[start] === "{") {
      tries += 1;
      try {
        const v: unknown = JSON.parse(stdout.slice(start));
        if (typeof v === "object" && v !== null && !Array.isArray(v)) return (v as { loggedIn?: unknown }).loggedIn === true;
      } catch {
        // not the whole object; try the line before
      }
    }
    if (nl < 0) break;
    end = nl;
  }
  return false;
}

/**
 * `wrangler whoami --json`: true only for exit 0 and `loggedIn === true`; anything else means
 * cloudflare_login_needed. Address and accounts in the answer are never read, kept or printed.
 */
export async function cloudflareLoggedIn(deps: RunDeps, bin: WranglerBin): Promise<boolean> {
  const r = await runWrangler(deps, bin, ["whoami", "--json"]);
  return r !== null && r.code === 0 && loggedInFrom(r.stdout);
}

// --- configuration reader -----------------------------------------------------------------------

/** A parsed value. Tables have no prototype; `__proto__` and `constructor` are plain keys. */
export type ConfigValue = string | number | boolean | null | ConfigValue[] | ConfigTable;
export interface ConfigTable {
  [key: string]: ConfigValue;
}

/** The fields op8x reads from one level (top level or env.X); absent fields are missing. */
export interface WranglerSection {
  name?: string;
  workers_dev?: boolean;
  route?: ConfigValue;
  routes?: ConfigValue;
}

export interface WranglerConfig extends WranglerSection {
  /** env.X by name, an object without prototype. */
  env: Record<string, WranglerSection>;
}

export type ConfigResult = { ok: true; config: WranglerConfig; file: string | null } | { ok: false; state: "config_unreadable" };

class ConfigError extends Error {}
/** A value outside the TOML subset: its line is skipped. */
class Unsupported extends Error {}

const fail = (): never => {
  throw new ConfigError("unreadable");
};

function newTable(): ConfigTable {
  return Object.create(null) as ConfigTable;
}

function setKey(t: ConfigTable, key: string, value: ConfigValue): void {
  Object.defineProperty(t, key, { value, writable: true, enumerable: true, configurable: true });
}

function isTable(v: unknown): v is ConfigTable {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const JSON_STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** JSON with `//` and block comments and trailing commas; containers nested at most 16 deep. */
function parseJsonc(text: string): ConfigValue {
  let i = 0;
  const ws = (): void => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i += 1;
      else if (c === "/" && text[i + 1] === "/") {
        const nl = text.indexOf("\n", i);
        i = nl < 0 ? text.length : nl + 1;
      } else if (c === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        if (e < 0) fail();
        i = e + 2;
      } else return;
    }
  };
  const str = (): string => {
    JSON_STRING.lastIndex = i;
    const m = JSON_STRING.exec(text);
    if (m === null) return fail();
    i += m[0].length;
    return JSON.parse(m[0]) as string;
  };
  const value = (depth: number): ConfigValue => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      if (depth > MAX_CONFIG_DEPTH) fail();
      const close = c === "{" ? "}" : "]";
      const t: ConfigTable | ConfigValue[] = c === "{" ? newTable() : [];
      i += 1;
      ws();
      if (text[i] === close) {
        i += 1;
        return t;
      }
      for (;;) {
        ws();
        if (Array.isArray(t)) t.push(value(depth + 1));
        else {
          if (text[i] !== '"') fail();
          const key = str();
          ws();
          if (text[i] !== ":") fail();
          i += 1;
          setKey(t, key, value(depth + 1));
        }
        ws();
        if (text[i] === ",") {
          i += 1;
          ws();
          if (text[i] === close) {
            i += 1;
            return t;
          }
          continue;
        }
        if (text[i] === close) {
          i += 1;
          return t;
        }
        fail();
      }
    }
    if (c === '"') return str();
    for (const [word, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    JSON_NUMBER.lastIndex = i;
    const m = JSON_NUMBER.exec(text);
    if (m === null) return fail();
    i += m[0].length;
    return Number(m[0]);
  };
  const v = value(1);
  ws();
  if (i !== text.length) fail();
  return v;
}

const TARGET_KEYS: ReadonlySet<string> = new Set(["name", "workers_dev", "route", "routes"]);

/** True for a key path at or below a field op8x reads (top level or env.X), or env / env.X itself. */
function touchesTarget(path: string[]): boolean {
  if (TARGET_KEYS.has(path[0]!)) return true;
  return path[0] === "env" && (path.length <= 2 || TARGET_KEYS.has(path[2]!));
}

const TOML_BARE = /[A-Za-z0-9_-]+/y;
const TOML_INT = /[+-]?(?:0|[1-9](?:_?\d)*)/y;
const DELIM = new Set([" ", "\t", "\r", "\n", ",", "]", "}", "#", undefined]);

/**
 * The TOML subset: bare or "…" keys, dotted keys, values "…" (TOML escapes), '…', bool, integer,
 * array, inline table; [table] and [[array.table]] headers; # comments outside strings. A line with
 * anything else (multi-line strings, dates, floats, other keys) is skipped as a whole; a header
 * outside the subset, a key defined twice or a type conflict makes the file unreadable.
 */
function parseToml(text: string): ConfigTable {
  const n = text.length;
  let i = 0;
  const root = newTable();
  let current = root;
  let currentDepth = 1;
  let currentPath: string[] = [];

  const spaces = (): void => {
    while (text[i] === " " || text[i] === "\t") i += 1;
  };
  const atLineEnd = (): boolean => {
    spaces();
    if (text[i] === "#") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl;
    }
    if (text[i] === "\r" && text[i + 1] === "\n") i += 1;
    return i >= n || text[i] === "\n";
  };
  /** Gaps inside arrays: spaces, newlines and comments. */
  const gap = (): void => {
    for (;;) {
      spaces();
      if (text[i] === "#") {
        const nl = text.indexOf("\n", i);
        i = nl < 0 ? n : nl;
      } else if (text[i] === "\n" || text[i] === "\r") i += 1;
      else return;
    }
  };

  /** A basic string on one line ("…"), with the TOML escapes. */
  const basic = (): string => {
    i += 1;
    let s = "";
    for (;;) {
      const c = text[i];
      if (c === undefined || c === "\n") return fail();
      if (c === '"') {
        i += 1;
        return s;
      }
      if (c === "\\") {
        const e = text[i + 1];
        const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
        if (e !== undefined && Object.hasOwn(simple, e)) {
          s += simple[e];
          i += 2;
          continue;
        }
        const len = e === "u" ? 4 : e === "U" ? 8 : 0;
        const hex = text.slice(i + 2, i + 2 + len);
        if (len === 0 || !new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) return fail();
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return fail();
        s += String.fromCodePoint(cp);
        i += 2 + len;
        continue;
      }
      if (c !== "\t" && c < " ") return fail();
      s += c;
      i += 1;
    }
  };
  /** A literal string on one line ('…'). */
  const literal = (): string => {
    const start = i + 1;
    for (let j = start; j < n; j++) {
      if (text[j] === "'") {
        i = j + 1;
        return text.slice(start, j);
      }
      if (text[j] === "\n") break;
    }
    return fail();
  };

  /** A key path: bare or "…" segments joined by dots; null if the key is outside the subset. */
  const keyPath = (): string[] | null => {
    const path: string[] = [];
    for (;;) {
      spaces();
      if (text[i] === '"') {
        if (text.startsWith('"""', i)) return null;
        path.push(basic());
      } else if (text[i] === "'") {
        if (text.startsWith("'''", i)) return null;
        path.push(literal());
      } else {
        TOML_BARE.lastIndex = i;
        const m = TOML_BARE.exec(text);
        if (m === null) return null;
        path.push(m[0]);
        i += m[0].length;
      }
      spaces();
      if (text[i] !== ".") return path;
      i += 1;
    }
  };

  const value = (depth: number): ConfigValue => {
    const c = text[i];
    if (c === '"') {
      if (text.startsWith('"""', i)) throw new Unsupported();
      return basic();
    }
    if (c === "'") {
      if (text.startsWith("'''", i)) throw new Unsupported();
      return literal();
    }
    for (const [word, v] of [
      ["true", true],
      ["false", false],
    ] as const) {
      if (text.startsWith(word, i) && DELIM.has(text[i + word.length])) {
        i += word.length;
        return v;
      }
    }
    if (c === "[") {
      if (depth > MAX_CONFIG_DEPTH) fail();
      i += 1;
      const arr: ConfigValue[] = [];
      for (;;) {
        gap();
        if (text[i] === "]") {
          i += 1;
          return arr;
        }
        if (i >= n) fail();
        arr.push(value(depth + 1));
        gap();
        if (text[i] === ",") i += 1;
        else if (text[i] !== "]") throw new Unsupported();
      }
    }
    if (c === "{") {
      if (depth > MAX_CONFIG_DEPTH) fail();
      i += 1;
      const t = newTable();
      spaces();
      if (text[i] === "}") {
        i += 1;
        return t;
      }
      for (;;) {
        const path = keyPath();
        if (path === null || text[i] !== "=") throw new Unsupported();
        i += 1;
        spaces();
        assign(t, depth, path, () => value);
        spaces();
        if (text[i] === ",") {
          i += 1;
          spaces();
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return t;
        }
        throw new Unsupported();
      }
    }
    TOML_INT.lastIndex = i;
    const m = TOML_INT.exec(text);
    if (m !== null && DELIM.has(text[i + m[0].length])) {
      const num = Number(m[0].replaceAll("_", ""));
      if (!Number.isSafeInteger(num)) throw new Unsupported();
      i += m[0].length;
      return num;
    }
    throw new Unsupported();
  };

  /** Sets `path` below table `t` (at `depth`) to the value read next; conflicts are unreadable. */
  function assign(t: ConfigTable, depth: number, path: string[], read: () => (d: number) => ConfigValue): void {
    let table = t;
    let d = depth;
    for (const seg of path.slice(0, -1)) {
      d += 1;
      if (d > MAX_CONFIG_DEPTH) fail();
      if (!Object.hasOwn(table, seg)) setKey(table, seg, newTable());
      const next = table[seg];
      if (!isTable(next)) return fail();
      table = next;
    }
    const last = path[path.length - 1]!;
    const v = read()(d + 1);
    if (Object.hasOwn(table, last)) fail();
    setKey(table, last, v);
  }

  /** Skips a string, a multi-line string or a comment at i; false if there is none. */
  const skipToken = (): boolean => {
    for (const q of ['"""', "'''"]) {
      if (text.startsWith(q, i)) {
        let j = i + 3;
        for (;;) {
          const e = text.indexOf(q, j);
          if (e < 0) return fail();
          // In a basic multi-line string an odd run of backslashes escapes the quote.
          let b = e - 1;
          while (q === '"""' && text[b] === "\\") b -= 1;
          if ((e - 1 - b) % 2 === 1) {
            j = e + 1;
            continue;
          }
          i = e + 3;
          return true;
        }
      }
    }
    if (text[i] === '"') {
      i += 1;
      while (i < n && text[i] !== '"' && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      if (text[i] === '"') i += 1;
      return true;
    }
    if (text[i] === "'") {
      i += 1;
      while (i < n && text[i] !== "'" && text[i] !== "\n") i += 1;
      if (text[i] === "'") i += 1;
      return true;
    }
    if (text[i] === "#") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      return true;
    }
    return false;
  };
  /** Skips the rest of a line outside the subset (multi-line strings and open brackets to their end). */
  const skipLine = (): void => {
    let open = 0;
    while (i < n) {
      if (skipToken()) continue;
      const c = text[i];
      if (c === "\n" && open === 0) return;
      if (c === "[" || c === "{") open += 1;
      else if ((c === "]" || c === "}") && open > 0) open -= 1;
      i += 1;
    }
    if (open > 0) fail();
  };

  while (i < n) {
    gap();
    if (i >= n) break;
    const lineStart = i;
    if (text[i] === "[") {
      const array = text[i + 1] === "[";
      i += array ? 2 : 1;
      const path = keyPath();
      if (path === null) return fail();
      if (!text.startsWith(array ? "]]" : "]", i)) return fail();
      i += array ? 2 : 1;
      if (!atLineEnd()) return fail();
      let table = root;
      let d = 1;
      path.forEach((seg, idx) => {
        d += 1;
        if (d > MAX_CONFIG_DEPTH) fail();
        const lastSeg = idx === path.length - 1;
        if (!Object.hasOwn(table, seg)) setKey(table, seg, lastSeg && array ? [] : newTable());
        let next = table[seg];
        if (lastSeg && array) {
          if (!Array.isArray(next)) return fail();
          d += 1;
          if (d > MAX_CONFIG_DEPTH) fail();
          const t = newTable();
          next.push(t);
          next = t;
        } else if (Array.isArray(next)) {
          // [[a]] then [a.b]: the last table of the array, as in TOML.
          d += 1;
          next = next[next.length - 1];
        }
        if (!isTable(next)) return fail();
        table = next;
      });
      current = table;
      currentDepth = d;
      currentPath = path;
      continue;
    }
    const path = keyPath();
    if (path === null || text[i] !== "=") {
      i = lineStart;
      skipLine();
      continue;
    }
    i += 1;
    spaces();
    const valueStart = i;
    // Read into a scratch table first, so a skipped line leaves nothing behind.
    const scratch = newTable();
    let ok = true;
    try {
      assign(scratch, currentDepth + path.length - 1, ["v"], () => value);
      if (!atLineEnd()) ok = false;
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      ok = false;
    }
    if (!ok) {
      // A skipped value must not silently move the target: wrangler would read it.
      if (touchesTarget([...currentPath, ...path])) fail();
      i = valueStart;
      skipLine();
      continue;
    }
    assign(current, currentDepth, path, () => () => scratch.v!);
  }
  return root;
}

function section(t: ConfigTable): WranglerSection {
  const s = Object.create(null) as WranglerSection;
  if (Object.hasOwn(t, "name")) {
    if (typeof t.name !== "string") fail();
    s.name = t.name as string;
  }
  if (Object.hasOwn(t, "workers_dev")) {
    if (typeof t.workers_dev !== "boolean") fail();
    s.workers_dev = t.workers_dev as boolean;
  }
  if (Object.hasOwn(t, "route")) s.route = t.route;
  if (Object.hasOwn(t, "routes")) s.routes = t.routes;
  return s;
}

const CONFIG_FILES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"] as const;

/**
 * The wrangler configuration in `dir` (wrangler.json, then wrangler.jsonc, then wrangler.toml, as
 * wrangler looks for them; no file → an empty configuration). At most 256 KB, UTF-8, nesting at
 * most 16 deep. Any read or parse error → config_unreadable; nothing of the file is printed.
 */
export async function readWranglerConfig(dir: string): Promise<ConfigResult> {
  const unreadable = { ok: false, state: "config_unreadable" } as const;
  for (const name of CONFIG_FILES) {
    const file = join(resolve(dir), name);
    const raw = await readLimited(file, MAX_CONFIG_BYTES);
    if (raw === "missing") continue;
    if (raw === "error") return unreadable;
    try {
      let text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
      if (text.startsWith("﻿")) text = text.slice(1);
      const tree = name.endsWith(".toml") ? parseToml(text) : parseJsonc(text);
      if (!isTable(tree)) return unreadable;
      const config = section(tree) as WranglerConfig;
      const env = Object.create(null) as Record<string, WranglerSection>;
      if (Object.hasOwn(tree, "env")) {
        const all = tree.env;
        if (!isTable(all)) return unreadable;
        for (const key of Object.keys(all)) {
          const e = all[key];
          if (!isTable(e)) return unreadable;
          Object.defineProperty(env, key, { value: section(e), writable: true, enumerable: true, configurable: true });
        }
      }
      config.env = env;
      return { ok: true, config, file };
    } catch {
      // ConfigError, a decoding error, or anything unexpected: never a crash.
      return unreadable;
    }
  }
  const empty = Object.create(null) as WranglerConfig;
  empty.env = Object.create(null) as Record<string, WranglerSection>;
  return { ok: true, config: empty, file: null };
}

// --- target -------------------------------------------------------------------------------------

export interface WranglerRoute {
  pattern: string;
  custom_domain: boolean;
  zone_name: string | null;
}

export interface WranglerTarget {
  /** The worker folder (resolved). */
  dir: string;
  /** The worker name wrangler will use. */
  name: string;
  env: string | null;
  workers_dev: boolean | null;
  /** The first route with a fixed domain (route before routes), or null. */
  route: WranglerRoute | null;
  /** The test address from that route (wildcard at the end cut off), or null (then --url is needed). */
  url: string | null;
}

export type TargetResult =
  | { ok: true; target: WranglerTarget }
  | { ok: false; state: "config_unreadable" | "env_required" | "usage_error" };

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/** https://host/path of a route pattern with a fixed domain, else null. */
export function routeUrl(pattern: string, customDomain: boolean): string | null {
  if (pattern.length > 2048) return null;
  let host: string;
  let path = "";
  if (customDomain) host = pattern;
  else {
    const p = pattern.replace(/^https?:\/\//i, "");
    const slash = p.indexOf("/");
    host = slash < 0 ? p : p.slice(0, slash);
    path = slash < 0 ? "" : p.slice(slash);
    if (path.endsWith("*")) path = path.slice(0, -1);
  }
  if (host.length > 253 || !HOST.test(host)) return null;
  if (path.includes("*") || /[\s\u0000-\u001f\u007f\\?#%]/.test(path)) return null;
  try {
    const url = new URL(`https://${host.toLowerCase()}${path === "" ? "/" : path}`);
    return url.hostname === host.toLowerCase() ? url.href : null;
  } catch {
    return null;
  }
}

function firstFixedRoute(candidates: ConfigValue[]): { route: WranglerRoute; url: string } | null {
  for (const c of candidates) {
    let route: WranglerRoute | null = null;
    if (typeof c === "string") route = { pattern: c, custom_domain: false, zone_name: null };
    else if (isTable(c) && typeof c.pattern === "string") {
      route = { pattern: c.pattern, custom_domain: c.custom_domain === true, zone_name: typeof c.zone_name === "string" ? c.zone_name : null };
    }
    if (route === null) continue;
    const url = routeUrl(route.pattern, route.custom_domain);
    if (url !== null) return { route, url };
  }
  return null;
}

/**
 * The worker in `dir` that a command sets up: the configuration's name (`--name` replaces the top
 * name), env.X.name first, else <name>-<X>. Several environments without --env → env_required; an
 * --env the configuration lacks, a missing name or an option off the pattern → usage_error; a
 * name from the configuration off the pattern → config_unreadable. An environment uses its own
 * route/routes, else the top-level ones (like wrangler).
 */
export async function resolveTarget(dir: string, o: { env?: string; name?: string }): Promise<TargetResult> {
  if (o.env !== undefined && !isWranglerName(o.env)) return { ok: false, state: "usage_error" };
  if (o.name !== undefined && !isWranglerName(o.name)) return { ok: false, state: "usage_error" };
  const read = await readWranglerConfig(dir);
  if (!read.ok) return { ok: false, state: "config_unreadable" };
  return targetFrom(read.config, dir, o);
}

function targetFrom(c: WranglerConfig, dir: string, o: { env?: string; name?: string }): TargetResult {
  const usage = { ok: false, state: "usage_error" } as const;
  const unreadable = { ok: false, state: "config_unreadable" } as const;
  if (o.env !== undefined && !isWranglerName(o.env)) return usage;
  if (o.name !== undefined && !isWranglerName(o.name)) return usage;
  let s: WranglerSection = c;
  if (o.env === undefined) {
    if (Object.keys(c.env).length >= 2) return { ok: false, state: "env_required" };
  } else {
    if (!Object.hasOwn(c.env, o.env)) return usage;
    s = c.env[o.env]!;
  }
  const base = o.name ?? c.name;
  let name: string;
  if (o.env !== undefined && s.name !== undefined) {
    if (!isWranglerName(s.name)) return unreadable;
    name = s.name;
  } else {
    if (base === undefined) return usage;
    name = o.env === undefined ? base : `${base}-${o.env}`;
    if (!isWranglerName(name)) return o.name === undefined ? unreadable : usage;
  }
  const inherit = o.env !== undefined;
  const route = s.route !== undefined ? s.route : inherit ? c.route : undefined;
  const routes = s.routes !== undefined ? s.routes : inherit ? c.routes : undefined;
  const candidates = [...(route === undefined ? [] : [route]), ...(Array.isArray(routes) ? routes : [])];
  const fixed = firstFixedRoute(candidates);
  const workersDev = s.workers_dev ?? (inherit ? c.workers_dev : undefined) ?? null;
  return {
    ok: true,
    target: { dir: resolve(dir), name, env: o.env ?? null, workers_dev: workersDev, route: fixed?.route ?? null, url: fixed?.url ?? null },
  };
}

// --- secret put / secret delete -----------------------------------------------------------------

/** A wrangler worker as stored in account.json (`dir` + `name` + `env`). */
export interface SecretTarget {
  dir: string;
  name: string;
  env: string | null;
}

/** ok = exit 0; failed = any other exit, a refused target, or no start; stopped = output guard hit. */
export type SecretResult = "ok" | "failed" | "stopped";

export interface Secrets {
  /** `secret put OP8X_KEY` with K on stdin; the notice secret_put_deploys comes before the first put. */
  put: (bin: WranglerBin, target: SecretTarget, key: string) => Promise<SecretResult>;
  /** `secret delete OP8X_KEY` without stdin data (wrangler ≥ 4.152.0 confirms by itself). */
  remove: (bin: WranglerBin, target: SecretTarget) => Promise<SecretResult>;
  /**
   * Read only: `secret list --format json`; is OP8X_KEY among the worker's secret names? Only the
   * names are read; nothing of the answer is kept or shown. failed = exit ≠ 0, a refused target,
   * no start, or an answer that is not a JSON list of {name}.
   */
  holds: (bin: WranglerBin, target: SecretTarget) => Promise<"present" | "absent" | "failed" | "stopped">;
}

/**
 * The secret names in the answer of `secret list --format json` (a JSON array of {name, type},
 * pretty-printed; a line before it is skipped), or null.
 */
export function secretNames(stdout: string): string[] | null {
  const text = stdout.trim();
  const start = text.startsWith("[") ? 0 : text.indexOf("\n[") + 1;
  if (start === 0 && !text.startsWith("[")) return null;
  let v: unknown;
  try {
    v = JSON.parse(text.slice(start));
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const names: string[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) return null;
    const name = (item as { name?: unknown }).name;
    if (typeof name !== "string") return null;
    names.push(name);
  }
  return names;
}

/**
 * argv after wrangler.js. wrangler names the worker `args.name && args.env ? name-env : args.name
 * ?? config.name` (wrangler 4.152.0, getLegacyScriptName), so `--name <name> --env <X>` would give
 * <name>-<X>-<X>. Hence: no env → `--name <name>`; <base>-<X> → `--name <base> --env <X>`; a name
 * from env.X.name → only `--env <X>`, after checking that the configuration still gives this name.
 * wrangler looks for its configuration upwards per file type (wrangler.json in every parent folder
 * before wrangler.jsonc, before wrangler.toml), so it could pick a parent's file over the one op8x
 * read: when the worker folder has a configuration, `--config <its absolute path>` pins exactly
 * that file. Without one, the name is pinned by `--name`. An unreadable configuration refuses the
 * target. null: the target is refused (no start).
 */
async function secretArgs(verb: "put" | "delete" | "list", t: SecretTarget): Promise<string[] | null> {
  if (!isWranglerName(t.name) || (t.env !== null && !isWranglerName(t.env))) return null;
  const read = await readWranglerConfig(t.dir);
  if (!read.ok) return null;
  // list names no key and asks for JSON, the only answer op8x reads.
  const pin = [...(read.file === null ? [] : ["--config", read.file]), ...(verb === "list" ? ["--format", "json"] : [])];
  const head = verb === "list" ? ["secret", "list"] : ["secret", verb, WRANGLER_SECRET];
  if (t.env === null) return [...head, "--name", t.name, ...pin];
  const suffix = `-${t.env}`;
  const base = t.name.slice(0, -suffix.length);
  if (t.name.endsWith(suffix) && isWranglerName(base)) return [...head, "--name", base, "--env", t.env, ...pin];
  const r = targetFrom(read.config, t.dir, { env: t.env });
  if (!r.ok || r.target.name !== t.name || read.file === null) return null;
  return [...head, "--env", t.env, ...pin];
}

/**
 * The secret operations of one run. Only the exit code counts; wrangler's output is dropped. After
 * the output guard stopped the output, nothing starts any more.
 */
export function createSecrets(deps: RunDeps, out: Output): Secrets {
  let noticed = false;
  const sameDir = (bin: WranglerBin, t: SecretTarget) => resolve(t.dir) === bin.dir;
  return {
    async put(bin, target, key) {
      if (out.stopped) return "stopped";
      if (!isKey(key, "w") || !sameDir(bin, target)) return "failed";
      const args = await secretArgs("put", target);
      if (args === null) return "failed";
      if (!noticed) {
        noticed = true;
        out.notice("secret_put_deploys");
      }
      if (out.stopped) return "stopped";
      const r = await runWrangler(deps, bin, args, key);
      return r !== null && r.code === 0 ? "ok" : "failed";
    },
    async remove(bin, target) {
      if (out.stopped) return "stopped";
      if (!sameDir(bin, target)) return "failed";
      const args = await secretArgs("delete", target);
      if (args === null) return "failed";
      if (out.stopped) return "stopped";
      const r = await runWrangler(deps, bin, args);
      return r !== null && r.code === 0 ? "ok" : "failed";
    },
    async holds(bin, target) {
      if (out.stopped) return "stopped";
      if (!sameDir(bin, target)) return "failed";
      const args = await secretArgs("list", target);
      if (args === null) return "failed";
      if (out.stopped) return "stopped";
      const r = await runWrangler(deps, bin, args);
      if (r === null || r.code !== 0) return "failed";
      const names = secretNames(r.stdout);
      if (names === null) return "failed";
      return names.includes(WRANGLER_SECRET) ? "present" : "absent";
    },
  };
}
