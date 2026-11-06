import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename as fsRename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, win32 } from "node:path";
import type { Deps } from "../cli.ts";
import { isKey } from "./keys.ts";

// The op8x file (account.json, schema op8x.account/1) and the one routine that writes secret files.
// Error messages never repeat file content: the file holds keys.

export type StoreErrorCode = "permissions_failed" | "schema_invalid" | "read_failed";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
    this.code = code;
  }
}

export const ACCOUNT_SCHEMA = "op8x.account/1";

export interface PendingStepUp {
  purpose: "rotate_now" | "replace_current" | "delete";
  command: "rotate" | "delete";
  case: "a" | "b" | "c" | "e" | null;
  phase: "replace" | "stop" | "delete";
  force_stop: boolean;
  t_check: string | null;
  expires_at: string;
}

/**
 * A wrangler target is identified by dir + name + env (env_file null); an env-file target by
 * env_file alone (an absolute path; name and env null).
 */
export interface WorkerEntry {
  dir: string;
  name: string | null;
  env: string | null;
  env_file: string | null;
  url: string | null;
  deployed_at: string;
  verified_at: string | null;
  key_fingerprint: string;
}

export interface ActiveAccount {
  schema: typeof ACCOUNT_SCHEMA;
  collector: string;
  account: string;
  contact_hint: string | null;
  read_token: string;
  write_key: string | null;
  write_key_next: string | null;
  pending_step_up: PendingStepUp | null;
  deleted: null;
  workers: WorkerEntry[];
}

/** What is left after deleted_partial: the account is gone, these workers still hold OP8X_KEY. */
export interface DeletedRemainder {
  schema: typeof ACCOUNT_SCHEMA;
  collector: string;
  account: null;
  contact_hint: null;
  read_token: null;
  write_key: null;
  write_key_next: null;
  pending_step_up: null;
  deleted: { action_id: string };
  workers: WorkerEntry[];
}

export type AccountFile = ActiveAccount | DeletedRemainder;

const ACCOUNT_FIELDS = [
  "schema",
  "collector",
  "account",
  "contact_hint",
  "read_token",
  "write_key",
  "write_key_next",
  "pending_step_up",
  "deleted",
  "workers",
];
const PENDING_FIELDS = ["purpose", "command", "case", "phase", "force_stop", "t_check", "expires_at"];
const WORKER_FIELDS = ["dir", "name", "env", "env_file", "url", "deployed_at", "verified_at", "key_fingerprint"];

const ACCOUNT_NAME = /^(t-[a-z2-7]{10}|e2e-[a-z2-7]{8})$/;
const ENV_NAME = /^[a-z0-9-]{1,63}$/;
const FINGERPRINT = /^[0-9a-f]{8}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

type Obj = Record<string, unknown>;

function invalid(what: string): never {
  throw new StoreError("schema_invalid", `The op8x file is not a valid ${ACCOUNT_SCHEMA} file (${what}).`);
}

function object(v: unknown, fields: string[], what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) invalid(what);
  const keys = Object.keys(v);
  if (keys.length !== fields.length || !fields.every((f) => Object.hasOwn(v, f))) invalid(`${what} fields`);
  return v as Obj;
}

const isString = (v: unknown): v is string => typeof v === "string" && v !== "";
const isTime = (v: unknown): v is string => typeof v === "string" && TIME.test(v) && !Number.isNaN(Date.parse(v));
const orNull = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v);

function isHttpUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function checkPending(v: unknown): void {
  if (v === null) return;
  const p = object(v, PENDING_FIELDS, "pending_step_up");
  const ok =
    (p.command === "rotate" &&
      ((p.purpose === "replace_current" && p.phase === "replace" && (p.case === "c" || p.case === "e")) ||
        (p.purpose === "rotate_now" && p.phase === "stop" && ["a", "b", "c", "e"].includes(p.case as string)))) ||
    (p.command === "delete" && p.purpose === "delete" && p.phase === "delete" && p.case === null);
  if (!ok) invalid("pending_step_up purpose, command, case or phase");
  if (typeof p.force_stop !== "boolean") invalid("pending_step_up.force_stop");
  if (!orNull(isTime)(p.t_check)) invalid("pending_step_up.t_check");
  if (!isTime(p.expires_at)) invalid("pending_step_up.expires_at");
}

function checkWorkers(v: unknown): void {
  if (!Array.isArray(v)) invalid("workers");
  const seen = new Set<string>();
  for (const item of v) {
    const w = object(item, WORKER_FIELDS, "worker");
    if (!isString(w.dir)) invalid("worker.dir");
    if (w.env_file === null) {
      if (!isString(w.name) || !orNull((e) => typeof e === "string" && ENV_NAME.test(e))(w.env)) invalid("worker name or env");
    } else if (!isString(w.env_file) || w.name !== null || w.env !== null) {
      invalid("worker env_file");
    }
    if (!orNull(isHttpUrl)(w.url)) invalid("worker.url");
    if (!isTime(w.deployed_at) || !orNull(isTime)(w.verified_at)) invalid("worker times");
    if (typeof w.key_fingerprint !== "string" || !FINGERPRINT.test(w.key_fingerprint)) invalid("worker.key_fingerprint");
    const id = workerId(w as unknown as WorkerEntry);
    if (seen.has(id)) invalid("two workers with the same target");
    seen.add(id);
  }
}

/** The identity of a worker entry; a second init for the same target updates that entry. */
export function workerId(w: WorkerEntry): string {
  return w.env_file !== null ? JSON.stringify(["env_file", w.env_file]) : JSON.stringify(["wrangler", w.dir, w.name, w.env]);
}

/** Parses and checks an op8x file; throws StoreError("schema_invalid"). */
export function parseAccount(text: string): AccountFile {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    invalid("not JSON");
  }
  const a = object(v, ACCOUNT_FIELDS, "top level");
  if (a.schema !== ACCOUNT_SCHEMA) invalid("schema");
  if (!isHttpUrl(a.collector)) invalid("collector");
  checkWorkers(a.workers);
  if (a.deleted === null) {
    if (typeof a.account !== "string" || !ACCOUNT_NAME.test(a.account)) invalid("account");
    if (!orNull(isString)(a.contact_hint)) invalid("contact_hint");
    if (!isKey(a.read_token, "r")) invalid("read_token");
    if (!orNull((k) => isKey(k, "w"))(a.write_key)) invalid("write_key");
    if (!orNull((k) => isKey(k, "w"))(a.write_key_next)) invalid("write_key_next");
    checkPending(a.pending_step_up);
  } else {
    const d = object(a.deleted, ["action_id"], "deleted");
    if (!isString(d.action_id)) invalid("deleted.action_id");
    for (const f of ["account", "contact_hint", "read_token", "write_key", "write_key_next", "pending_step_up"]) {
      if (a[f] !== null) invalid(`${f} after deletion`);
    }
  }
  return a as unknown as AccountFile;
}

export function accountPath(deps: Pick<Deps, "configDir">): string {
  return join(deps.configDir, "account.json");
}

/** The op8x file, or null if there is none. */
export async function readAccount(deps: Pick<Deps, "configDir">): Promise<AccountFile | null> {
  let text: string;
  try {
    text = await readFile(accountPath(deps), "utf8");
  } catch (e) {
    if (errno(e) === "ENOENT") return null;
    throw new StoreError("read_failed", "The op8x file could not be read.", { cause: e });
  }
  return parseAccount(text);
}

/** Removes the op8x file; false if there was none. */
export async function deleteAccount(deps: Pick<Deps, "configDir">): Promise<boolean> {
  try {
    await unlink(accountPath(deps));
    return true;
  } catch (e) {
    if (errno(e) === "ENOENT") return false;
    throw new StoreError("permissions_failed", "The op8x file could not be removed.", { cause: e });
  }
}

export interface WriteOptions {
  /** Replaces fs.rename; for tests of the retry. */
  rename?: (from: string, to: string) => Promise<void>;
}

/** Checks the account against the schema, then writes it with writeSecureFile into the op8x folder. */
export async function writeAccount(
  deps: Pick<Deps, "configDir" | "platform" | "env" | "exec" | "sleep">,
  file: AccountFile,
  options: WriteOptions = {},
): Promise<void> {
  const text = `${JSON.stringify(file, null, 2)}\n`;
  parseAccount(text);
  await writeSecureFile(deps, accountPath(deps), text, { ...options, ownDir: true });
}

/**
 * SystemRoot from env, whatever its case; undefined unless it is an absolute path with a drive
 * letter (C:\Windows). Helpers run by absolute path: Windows looks for a bare program name in the
 * current folder first, which is the seller's project.
 */
export function systemRootOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "SYSTEMROOT");
  const value = key === undefined ? undefined : env[key];
  return value !== undefined && /^[A-Za-z]:\\/.test(value) && win32.isAbsolute(value) ? value : undefined;
}

const HELPER_TIMEOUT_MS = 10_000;
const RENAME_RETRIES = 3;
const RENAME_PAUSE_MS = 200;

/**
 * Writes a secret file atomically: a temp file in the target folder, protected before any content
 * goes in, then renamed over the target. POSIX: the temp file is created 0600; with `ownDir` (the
 * op8x folder) the folder is created and always set to 0700, also when it existed; other folders
 * (an env file's) are left alone. Windows: the temp file is created empty, its ACL set to the
 * current user only and checked, then filled and renamed (EPERM/EBUSY retried three times).
 * Any failure is StoreError("permissions_failed"); the target is then unchanged and no temp file stays.
 */
export async function writeSecureFile(
  deps: Pick<Deps, "platform" | "env" | "exec" | "sleep">,
  target: string,
  content: string,
  options: WriteOptions & { ownDir: boolean },
): Promise<void> {
  const dir = dirname(target);
  const tmp = join(dir, `.${basename(target)}.${randomBytes(8).toString("hex")}.tmp`);
  const windows = deps.platform === "win32";
  const rename = options.rename ?? fsRename;
  let created = false;
  try {
    if (options.ownDir) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (!windows) await chmod(dir, 0o700);
    }
    if (windows) {
      const root = systemRootOf(deps.env);
      if (root === undefined) throw new Error("SystemRoot is missing or not absolute");
      const helper = (name: string) => win32.join(root, "System32", name);
      const run = (file: string, args: string[]) =>
        deps.exec(file, args, { cwd: dir, env: { SystemRoot: root }, timeoutMs: HELPER_TIMEOUT_MS });

      const who = await run(helper("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
      const sid = who.code === 0 ? /"([^"]*)"\s*$/.exec(who.stdout)?.[1] : undefined;
      if (sid === undefined || !/^S-1-[0-9-]+$/.test(sid)) throw new Error("no SID from whoami");

      await (await open(tmp, "wx")).close();
      created = true;
      const set = await run(helper("icacls.exe"), [tmp, "/inheritance:r", "/grant:r", `*${sid}:F`]);
      if (set.code !== 0) throw new Error("icacls could not set the ACL");
      await checkAcl(run, helper("icacls.exe"), tmp, dir, sid);

      await writeFile(tmp, content, { flag: "r+" });
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(tmp, target);
          break;
        } catch (e) {
          const code = errno(e);
          if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY")) throw e;
          await deps.sleep(RENAME_PAUSE_MS);
        }
      }
    } else {
      const handle = await open(tmp, "wx", 0o600);
      created = true;
      try {
        await handle.chmod(0o600);
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, target);
    }
    created = false;
  } catch (e) {
    if (created) await unlink(tmp).catch(() => {});
    throw new StoreError("permissions_failed", "The op8x file could not be protected; nothing was written.", { cause: e });
  }
}

/**
 * The DACL must be protected (no inherited entries) and hold exactly one entry: full access for
 * `sid`. Checked through the SID in SDDL form, so it does not depend on language or account names.
 */
async function checkAcl(
  run: (file: string, args: string[]) => ReturnType<Deps["exec"]>,
  icacls: string,
  file: string,
  dir: string,
  sid: string,
): Promise<void> {
  const saved = join(dir, `.${basename(file)}.${randomBytes(8).toString("hex")}.acl`);
  let text: string;
  try {
    const save = await run(icacls, [file, "/save", saved]);
    if (save.code !== 0) throw new Error("icacls could not save the ACL");
    text = (await readFile(saved)).toString("utf16le");
  } finally {
    await unlink(saved).catch(() => {});
  }
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l !== "");
  if (lines.length !== 2 || !new RegExp(`^D:P[A-Z]*\\(A;;FA;;;${sid}\\)$`).test(lines[1])) {
    throw new Error("the ACL is not limited to the current user");
  }
}

function errno(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : undefined;
}
