import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";
import type { Deps, Io } from "../cli.ts";
import { collectorBase, collectorMismatch, createApi } from "./api.ts";
import { deviceKeys, deviceLogin } from "./device.ts";
import type { DeviceFailure } from "./device.ts";
import { keyFingerprint } from "./keys.ts";
import { createOutput, finalLine } from "./output.ts";
import type { AccountCommand, FinalState, Output } from "./output.ts";
import { ACCOUNT_SCHEMA, StoreError, deleteAccount, parseAccount, readAccount, writeAccount } from "./store.ts";
import type { AccountFile, ActiveAccount } from "./store.ts";

type Value = string | boolean | (string | boolean)[] | undefined;
type Values = Record<string, Value>;

interface CommandSpec {
  usage: string;
  options: ParseArgsOptionsConfig;
  /** Positionals after the command word (only import-key takes one). */
  positionals: number;
  /** False if a value breaks a pattern, an exclusion or a condition of the options table. */
  valid: (values: Values) => boolean;
  run: (values: Values, deps: Deps, args: string[]) => Promise<number>;
}

const WORD = /^[a-z0-9-]{1,63}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function word(v: Value): boolean {
  return v === undefined || (typeof v === "string" && WORD.test(v));
}

/** https:, or http: on a loopback host only. */
function testUrl(v: Value): boolean {
  if (v === undefined) return true;
  if (typeof v !== "string") return false;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
}

const INIT_USAGE = `Usage: op8x init [--env <name> | --env-file <path>] [--name <worker>] [--url <url>] [--json]

Options:
  --env <name>         the wrangler environment to set up
  --name <worker>      the worker name, if the wrangler configuration has none
  --url <url>          an https address the op8x module handles, for the test request
  --env-file <path>    write the server key to this git-ignored file instead of wrangler
  --json               print JSON Lines
`;

const LOGIN_USAGE = `Usage: op8x login [--json]

Signs this computer in to an existing op8x account. Your human opens a link and allows it.

Options:
  --json               print JSON Lines
`;

const LOGOUT_USAGE = `Usage: op8x logout [--json]

Signs this computer out: revokes its access at op8x, then removes the op8x file.

Options:
  --json               print JSON Lines
`;

const IMPORT_USAGE = `Usage: op8x import-key <path> [--json]

Takes the server key from the op8x file of your other computer, after checking that it is the
account's current key.

Options:
  --json               print JSON Lines
`;

const JSON_ONLY: ParseArgsOptionsConfig = { json: { type: "boolean" } };

// Registered are only the commands that exist. `init` is a placeholder for now: it checks its
// options and ends with not_available_yet.
const COMMANDS: Record<AccountCommand, CommandSpec> = {
  init: {
    usage: INIT_USAGE,
    options: {
      json: { type: "boolean" },
      env: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      "env-file": { type: "string" },
    },
    positionals: 0,
    valid: (v) =>
      word(v.env) &&
      word(v.name) &&
      testUrl(v.url) &&
      (v["env-file"] === undefined || (typeof v["env-file"] === "string" && v["env-file"] !== "")) &&
      !(v["env-file"] !== undefined && (v.env !== undefined || v.name !== undefined)),
    run: async (values, deps) => notAvailableYet("init", values.json === true, deps),
  },
  login: { usage: LOGIN_USAGE, options: JSON_ONLY, positionals: 0, valid: () => true, run: (v, deps) => login(v.json === true, deps) },
  logout: { usage: LOGOUT_USAGE, options: JSON_ONLY, positionals: 0, valid: () => true, run: (v, deps) => logout(v.json === true, deps) },
  "import-key": {
    usage: IMPORT_USAGE,
    options: JSON_ONLY,
    positionals: 1,
    valid: () => true,
    run: (v, deps, args) => importKey(v.json === true, deps, args[0] ?? ""),
  },
};

export function accountCommand(word: string): AccountCommand | undefined {
  return Object.hasOwn(COMMANDS, word) ? (word as AccountCommand) : undefined;
}

/**
 * Runs an account command: strict parse of the whole argv with exactly this command's options
 * (so options may stand before the command word), then the checks of the options table.
 * `deps` is null when the caller passed a plain Io; that is a programming error.
 */
export async function runAccount(command: AccountCommand, argv: string[], io: Io, deps: Deps | null): Promise<number> {
  const spec = COMMANDS[command];
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true, options: spec.options }));
  } catch {
    // The parser message names the rejected input, so it is not shown.
    return usageError(command, io, argv.includes("--json"));
  }
  const json = values.json === true;
  if (positionals.length !== 1 + spec.positionals || !spec.valid(values)) return usageError(command, io, json);
  if (!deps) {
    io.out(json ? finalLine(command, "internal_error", 2) : "op8x stopped because of an internal error. Please report this.\n");
    return 2;
  }
  return spec.run(values, deps, positionals.slice(1));
}

function usageError(command: AccountCommand, io: Io, json: boolean): number {
  io.err(COMMANDS[command].usage);
  if (json) io.out(finalLine(command, "usage_error", 4));
  return 4;
}

function notAvailableYet(command: AccountCommand, json: boolean, deps: Deps): number {
  deps.out(json ? finalLine(command, "not_available_yet", 1) : `op8x ${command} is not available in this version yet.\n`);
  return 1;
}

// --- shared steps -----------------------------------------------------------------------------

/** The final line of a failed device login or API call, with the fields its state carries. */
function failWith(out: Output, failure: DeviceFailure): number {
  const { state, ...fields } = failure;
  return out.final(state, { extra: fields });
}

/** The secrets of an op8x file, for the output guard. */
function fileSecrets(file: AccountFile | null): (string | null)[] {
  return file === null ? [] : [file.read_token, file.write_key, file.write_key_next];
}

type Loaded = { ok: true; file: AccountFile | null } | { ok: false; state: FinalState };

/**
 * The op8x file of this computer. A file that cannot be read or parsed stops the command with
 * import_failed (the fixed sentence "could not be read as an op8x file"); its content and the
 * parser's message are never shown (A16), and it is left as it is.
 */
async function loadFile(deps: Deps): Promise<Loaded> {
  try {
    return { ok: true, file: await readAccount(deps) };
  } catch (e) {
    return { ok: false, state: e instanceof StoreError && e.code === "permissions_failed" ? "permissions_failed" : "import_failed" };
  }
}

type SignedIn = { ok: true; base: string; file: ActiveAccount } | { ok: false; exit: number };

/**
 * For commands that need a signed-in computer: the collector base, then the file. No file or a
 * remainder file → not_logged_in; a file made for another base → collector_mismatch. Nothing is sent.
 */
async function signedIn(deps: Deps, out: Output, hold: (f: AccountFile | null) => void): Promise<SignedIn> {
  const base = collectorBase(deps.env);
  if (base === null) return { ok: false, exit: out.final("collector_url_not_allowed") };
  const loaded = await loadFile(deps);
  if (!loaded.ok) return { ok: false, exit: out.final(loaded.state) };
  hold(loaded.file);
  const file = loaded.file;
  if (file === null || file.deleted !== null) return { ok: false, exit: out.final("not_logged_in") };
  if (collectorMismatch(file, base)) return { ok: false, exit: out.final("collector_mismatch") };
  return { ok: true, base, file };
}

/** A StoreError while writing or removing the op8x file. */
function storeState(e: unknown): FinalState {
  if (e instanceof StoreError) return e.code === "permissions_failed" ? "permissions_failed" : "internal_error";
  return "permissions_failed";
}

// --- login ------------------------------------------------------------------------------------

/**
 * op8x login: the device login with mode login (no write_sha256). On a computer with an op8x file
 * only R (and the account and contact it belongs to) is replaced; K, the next K, a waiting step and
 * the workers stay. A remainder file (deleted) counts as no file and is replaced, without the
 * collector check. Ends with connected, which names the account's address (A1).
 */
async function login(json: boolean, deps: Deps): Promise<number> {
  const keys = deviceKeys(false);
  let held: AccountFile | null = null;
  const out = createOutput({ command: "login", json, deps, steps: 1, secrets: () => [keys.device, keys.read, ...fileSecrets(held)] });
  const base = collectorBase(deps.env);
  if (base === null) return out.final("collector_url_not_allowed");
  const loaded = await loadFile(deps);
  if (!loaded.ok) return out.final(loaded.state);
  held = loaded.file;
  const kept = held !== null && held.deleted === null ? held : null;
  if (kept !== null && collectorMismatch(kept, base)) return out.final("collector_mismatch");

  out.start("browser");
  const r = await deviceLogin({ deps, api: createApi(deps, base), out, mode: "login", keys });
  if (!r.ok) {
    out.end("failed");
    return failWith(out, r.fail);
  }
  if (out.stopped) return out.final("internal_error");
  const next: ActiveAccount =
    kept !== null
      ? { ...kept, account: r.account, contact_hint: r.contactHint, read_token: keys.read }
      : {
          schema: ACCOUNT_SCHEMA,
          collector: base,
          account: r.account,
          contact_hint: r.contactHint,
          read_token: keys.read,
          write_key: null,
          write_key_next: null,
          pending_step_up: null,
          deleted: null,
          workers: [],
        };
  try {
    await writeAccount(deps, next);
  } catch (e) {
    out.end("failed");
    return out.final(storeState(e));
  }
  out.end("ok");
  return out.final("connected", { extra: { account: r.account, contact_hint: r.contactHint } });
}

// --- logout -----------------------------------------------------------------------------------

/**
 * op8x logout: POST sign-out {} with R, then the op8x file is removed (A11). Offline, on a 5xx,
 * busy or any other unexpected answer the file stays, so a later logout can still revoke R; a 401
 * (R already invalid) removes it. With a local K the notice logout_removes_key comes first.
 */
async function logout(json: boolean, deps: Deps): Promise<number> {
  let held: AccountFile | null = null;
  const out = createOutput({ command: "logout", json, deps, steps: 1, secrets: () => fileSecrets(held) });
  const s = await signedIn(deps, out, (f) => {
    held = f;
  });
  if (!s.ok) return s.exit;

  out.start("sign_out");
  const r = await createApi(deps, s.base).signOut(s.file.read_token);
  if (!r.ok && r.error.state !== "key_auth") {
    out.end("failed");
    return out.error(r.error);
  }
  out.end("ok");
  const withKey = s.file.write_key !== null || s.file.write_key_next !== null;
  if (withKey) out.notice("logout_removes_key");
  if (out.stopped) return out.final("internal_error");
  try {
    await deleteAccount(deps);
  } catch (e) {
    return out.final(storeState(e));
  }
  return out.final("logged_out", { hint: { with_key: withKey } });
}

// --- import-key -------------------------------------------------------------------------------

const MAX_IMPORT_BYTES = 1024 * 1024;

/**
 * K from the op8x file at `path`, or null if the file is missing, not a regular file, too big,
 * not a valid op8x file, or has no K. Nothing about the file (content, parser message) leaves
 * this function (A16). Opened without blocking, so a FIFO cannot hang the command.
 */
async function readKeyFile(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > MAX_IMPORT_BYTES) return null;
      chunks.push(buf.subarray(0, bytesRead));
    }
    const file = parseAccount(Buffer.concat(chunks).toString("utf8"));
    return file.deleted === null ? file.write_key : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * op8x import-key <path>: takes only K from the op8x file of another computer (E1). K never leaves
 * this computer: GET /tenant with R, then K's fingerprint is compared with the account's keys.
 * Current → stored (imported); previous → key_previous; else key_mismatch.
 */
async function importKey(json: boolean, deps: Deps, path: string): Promise<number> {
  let held: AccountFile | null = null;
  let imported: string | null = null;
  const out = createOutput({ command: "import-key", json, deps, steps: 1, secrets: () => [...fileSecrets(held), imported] });
  const s = await signedIn(deps, out, (f) => {
    held = f;
  });
  if (!s.ok) return s.exit;

  imported = await readKeyFile(resolve(deps.cwd, path));
  if (imported === null) return out.final("import_failed");

  out.start("check_key");
  const r = await createApi(deps, s.base).tenant(s.file.read_token);
  if (!r.ok) {
    out.end("failed");
    return out.error(r.error);
  }
  const fp = keyFingerprint(imported);
  const slot = r.value.keys.find((k) => k.kind === "write" && k.fingerprint === fp)?.slot;
  if (slot !== "current") {
    out.end("failed");
    return out.final(slot === "previous" ? "key_previous" : "key_mismatch");
  }
  if (out.stopped) return out.final("internal_error");
  try {
    await writeAccount(deps, { ...s.file, write_key: imported });
  } catch (e) {
    out.end("failed");
    return out.final(storeState(e));
  }
  out.end("ok");
  return out.final("imported");
}
