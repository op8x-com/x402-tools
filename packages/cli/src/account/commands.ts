import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";
import type { Deps, Io } from "../cli.ts";
import { collectorBase, collectorMismatch, createApi } from "./api.ts";
import type { Api } from "./api.ts";
import { fileSecrets, loadFile, resumeNextKey, signedIn, storeState, workerName, writeSlot } from "./common.ts";
import type { Save } from "./common.ts";
import { envFileAllowed, isoNow, upsertWorker, verifyWorker, workerLine, writeEnvKey } from "./connect.ts";
import { deviceKeys, deviceLogin } from "./device.ts";
import type { DeviceFailure, DeviceKeys } from "./device.ts";
import { keyFingerprint } from "./keys.ts";
import { createOutput, finalLine } from "./output.ts";
import { ROTATE_USAGE, rotate } from "./rotate.ts";
import type { AccountCommand, FinalState, Output } from "./output.ts";
import { ACCOUNT_SCHEMA, accountPath, deleteAccount, parseAccount, writeAccount } from "./store.ts";
import type { AccountFile, ActiveAccount, WorkerEntry } from "./store.ts";
import { cloudflareLoggedIn, createSecrets, findWrangler, isWranglerName, resolveTarget } from "./wrangler.ts";
import type { SecretResult, WranglerBin, WranglerTarget } from "./wrangler.ts";

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

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The pattern of the options table without a leading hyphen, which wrangler would read as a flag. */
function wranglerWord(v: Value): boolean {
  return v === undefined || isWranglerName(v);
}

const str = (v: Value): string | undefined => (typeof v === "string" ? v : undefined);

/** https:, or http: on a loopback host only; no user name or password in the URL. */
function testUrl(v: Value): boolean {
  if (v === undefined) return true;
  if (typeof v !== "string") return false;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
}

const INIT_USAGE = `Usage: op8x init [--env <name> | --env-file <path>] [--name <worker>] [--url <url>] [--json]

Options:
  --env <name>         the wrangler environment to set up
  --name <worker>      the worker name, in place of the name in the wrangler configuration
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

// Registered are only the commands that exist.
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
      wranglerWord(v.env) &&
      wranglerWord(v.name) &&
      testUrl(v.url) &&
      (v["env-file"] === undefined || (typeof v["env-file"] === "string" && v["env-file"] !== "")) &&
      !(v["env-file"] !== undefined && (v.env !== undefined || v.name !== undefined)),
    run: (values, deps) =>
      init(values.json === true, deps, {
        env: str(values.env),
        name: str(values.name),
        url: str(values.url),
        envFile: str(values["env-file"]),
      }),
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
  rotate: {
    usage: ROTATE_USAGE,
    options: {
      json: { type: "boolean" },
      now: { type: "boolean" },
      "force-stop": { type: "boolean" },
      "code-stdin": { type: "boolean" },
    },
    positionals: 0,
    // --force-stop and --code-stdin only with --now.
    valid: (v) => v.now === true || (v["force-stop"] === undefined && v["code-stdin"] === undefined),
    run: (v, deps) =>
      rotate(v.json === true, deps, { now: v.now === true, forceStop: v["force-stop"] === true, codeStdin: v["code-stdin"] === true }),
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


// --- shared steps -----------------------------------------------------------------------------

/** The final line of a failed device login or API call, with the fields its state carries. */
function failWith(out: Output, failure: DeviceFailure): number {
  const { state, ...fields } = failure;
  return out.final(state, { extra: fields });
}

// --- init -------------------------------------------------------------------------------------

interface InitOptions {
  env?: string;
  name?: string;
  url?: string;
  envFile?: string;
}

/** Where K goes: a wrangler worker in the current folder, or a git-ignored env file. */
type Place =
  | { kind: "wrangler"; bin: WranglerBin; target: WranglerTarget }
  | { kind: "env_file"; path: string };

/**
 * op8x init (data flow 1-9). Without an op8x file (a remainder file counts as none): step
 * cloudflare (the project's wrangler, the Cloudflare login, the worker), step browser (device login
 * with mode init and write_sha256), the op8x file is written right after granted and before
 * wrangler; server_key ignored ends with server_key_missing (E1). On a signed-in computer (CUJ 2)
 * only key and test: write_key_next is resumed first, then K must be the account's current key.
 * Step key puts K (wrangler secret put, or the line OP8X_KEY=… in the --env-file); step test sends
 * one test request with a nonce and waits for the collector to see it (connected, A1).
 */
async function init(json: boolean, deps: Deps, o: InitOptions): Promise<number> {
  let keys: DeviceKeys | null = null;
  let held: AccountFile | null = null;
  const loaded = await loadFile(deps);
  if (loaded.ok) held = loaded.file;
  const signed = held !== null && held.deleted === null ? held : null;
  const envFile = o.envFile === undefined ? null : resolve(deps.cwd, o.envFile);
  const steps = envFile !== null ? (signed === null ? 3 : 2) : signed === null ? 4 : 2;
  const out = createOutput({
    command: "init",
    json,
    deps,
    steps,
    secrets: () => [keys?.device, keys?.read, keys?.write, ...fileSecrets(held)],
  });
  const stopped = () => out.final("internal_error");

  const base = collectorBase(deps.env);
  if (base === null) return out.final("collector_url_not_allowed");
  if (!loaded.ok) return out.final(loaded.state);
  if (signed !== null && collectorMismatch(signed, base)) return out.final("collector_mismatch");
  if (envFile !== null && !(await envFileAllowed(deps, envFile))) return out.final("env_file_not_ignored");
  const api = createApi(deps, base);

  let file: ActiveAccount | null = null;
  let key: string;
  let place: Place | null = envFile === null ? null : { kind: "env_file", path: envFile };
  const save = async (next: ActiveAccount): Promise<FinalState | null> => {
    if (out.stopped) return "internal_error";
    try {
      await writeAccount(deps, next);
    } catch (e) {
      return storeState(e);
    }
    file = next;
    held = next;
    return null;
  };

  if (signed === null) {
    // First time: the worker is checked before an account is made for it.
    if (place === null) {
      out.start("cloudflare");
      if (out.stopped) return stopped();
      const found = await findPlace(deps, o);
      if (!found.ok) {
        out.end("failed");
        if (found.state === "usage_error") deps.err(INIT_USAGE);
        return out.final(found.state);
      }
      out.end("ok");
      place = found.place;
    }
    out.start("browser");
    if (out.stopped) return stopped();
    keys = deviceKeys(true);
    const r = await deviceLogin({ deps, api, out, mode: "init", keys });
    if (!r.ok) {
      out.end("failed");
      return failWith(out, r.fail);
    }
    const accepted = r.serverKey === "accepted" && keys.write !== null;
    const failed = await save({
      schema: ACCOUNT_SCHEMA,
      collector: base,
      account: r.account,
      contact_hint: r.contactHint,
      read_token: keys.read,
      write_key: accepted ? keys.write : null,
      write_key_next: null,
      pending_step_up: null,
      deleted: null,
      workers: [],
    });
    if (failed !== null) {
      out.end("failed");
      return out.final(failed);
    }
    out.end("ok");
    if (!accepted || keys.write === null) return out.final("server_key_missing", { extra: { path: accountPath(deps) } });
    key = keys.write;
    out.start("key");
    if (out.stopped) return stopped();
  } else {
    file = signed;
    out.start("key");
    if (out.stopped) return stopped();
    const current = await currentKey(deps, api, out, signed, save);
    if (!current.ok) {
      out.end("failed");
      return current.exit;
    }
    key = current.key;
    if (place === null) {
      const found = await findPlace(deps, o);
      if (!found.ok) {
        out.end("failed");
        if (found.state === "usage_error") deps.err(INIT_USAGE);
        return out.final(found.state);
      }
      place = found.place;
    }
  }

  // Step key: K into the worker.
  const entry: WorkerEntry =
    place.kind === "env_file"
      ? { dir: dirname(place.path), name: null, env: null, env_file: place.path, url: o.url ?? null, deployed_at: "", verified_at: null, key_fingerprint: "" }
      : { dir: place.target.dir, name: place.target.name, env: place.target.env, env_file: null, url: o.url ?? place.target.url, deployed_at: "", verified_at: null, key_fingerprint: "" };
  const put = await putKey(deps, out, place, key);
  if (put === "stopped") return stopped();
  if (put === "failed") {
    out.end("failed");
    return place.kind === "env_file"
      ? out.final("permissions_failed")
      : out.final("partial", { extra: { workers: [workerLine(entry, "failed")] }, hint: { names: [workerName(entry)] } });
  }
  const stored: WorkerEntry = { ...entry, deployed_at: isoNow(deps), key_fingerprint: keyFingerprint(key) };
  const savedPut = await save({ ...file!, workers: upsertWorker(file!.workers, stored) });
  if (savedPut !== null) {
    out.end("failed");
    return out.final(savedPut);
  }
  out.end("ok");

  // Step test: one test request with a nonce, then the collector must have seen it.
  if (stored.url === null) {
    out.skip("test");
    return out.final("url_required", { extra: { workers: [workerLine(stored, "no_url")] } });
  }
  out.start("test");
  if (out.stopped) return stopped();
  const v = await verifyWorker({ deps, api, out, readToken: file!.read_token, url: stored.url, explicit: o.url !== undefined });
  if (!v.ok) {
    if (v.state === "stopped") return stopped();
    out.end("failed");
    const workers = [workerLine(stored, "unverified")];
    if (v.state === "api") {
      // 409 no_write_key keeps the catalog sentence of server_key_missing.
      return out.error(v.error, v.error.state === "server_key_missing" ? { extra: { path: accountPath(deps) } } : {});
    }
    return out.final(v.state === "host_refused" ? "url_required" : "deployed_unverified", { extra: { workers } });
  }
  const verified: WorkerEntry = { ...stored, verified_at: v.seenAt };
  const savedTest = await save({ ...file!, workers: upsertWorker(file!.workers, verified) });
  if (savedTest !== null) {
    out.end("failed");
    return out.final(savedTest);
  }
  out.end("ok");
  return out.final("connected", {
    extra: { account: file!.account, contact_hint: file!.contact_hint, workers: [workerLine(verified, "verified")] },
  });
}

type FoundPlace =
  | { ok: true; place: Place }
  | { ok: false; state: "wrangler_missing" | "wrangler_too_old" | "cloudflare_login_needed" | "config_unreadable" | "env_required" | "usage_error" };

/** The project's wrangler, the Cloudflare login and the worker of the current folder (data flow 1). */
async function findPlace(deps: Deps, o: InitOptions): Promise<FoundPlace> {
  const found = await findWrangler(deps, deps.cwd);
  if (!found.ok) return found;
  if (!(await cloudflareLoggedIn(deps, found.bin))) return { ok: false, state: "cloudflare_login_needed" };
  const target = await resolveTarget(deps.cwd, { env: o.env, name: o.name });
  if (!target.ok) return target;
  return { ok: true, place: { kind: "wrangler", bin: found.bin, target: target.target } };
}

/** K into the place: wrangler secret put (notice secret_put_deploys first), or the env file. */
async function putKey(deps: Deps, out: Output, place: Place, key: string): Promise<SecretResult> {
  if (out.stopped) return "stopped";
  if (place.kind === "wrangler") return createSecrets(deps, out).put(place.bin, place.target, key);
  try {
    await writeEnvKey(deps, place.path, key);
    return "ok";
  } catch {
    return "failed";
  }
}

type CurrentKey = { ok: true; key: string } | { ok: false; exit: number };

/**
 * K of a signed-in computer, checked against the account (E1), after the resumption of
 * write_key_next. No K → server_key_missing (a running rotation gives the rotate --now variant);
 * K not the current key → key_mismatch.
 */
async function currentKey(deps: Deps, api: Api, out: Output, file: ActiveAccount, save: Save): Promise<CurrentKey> {
  const fail = (exit: number): CurrentKey => ({ ok: false, exit });
  const resumed = await resumeNextKey(api, out, file, save);
  if (!resumed.ok) return fail(resumed.exit);
  const { file: now, view } = resumed;
  if (now.write_key === null) {
    const rotating = writeSlot(view, "previous") !== undefined;
    return fail(out.final("server_key_missing", { extra: { path: accountPath(deps) }, hint: { rotation_running: rotating } }));
  }
  if (writeSlot(view, "current")?.fingerprint !== keyFingerprint(now.write_key)) return fail(out.final("key_mismatch"));
  return { ok: true, key: now.write_key };
}

// --- login ------------------------------------------------------------------------------------

/**
 * op8x login: the device login with mode login (no write_sha256). On a computer with an op8x file
 * of the same account R and the contact are replaced and a waiting step is cleared; K, the next K
 * and the workers stay. Granted for another account, the file is replaced as if there was none.
 * A remainder file (deleted) counts as no file and is replaced, without the
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
  // Same account: K, the next K and the workers stay; a waiting step goes (its codes are bound to
  // the old R). Another account: the old K is not this account's, so the file starts over.
  const same = kept !== null && kept.account === r.account;
  const next: ActiveAccount =
    same && kept !== null
      ? { ...kept, contact_hint: r.contactHint, read_token: keys.read, pending_step_up: null }
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
