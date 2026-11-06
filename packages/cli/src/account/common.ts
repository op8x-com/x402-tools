import type { Deps } from "../cli.ts";
import { collectorBase, collectorMismatch } from "./api.ts";
import type { Api, TenantKey, TenantView } from "./api.ts";
import { keyFingerprint, keyHash } from "./keys.ts";
import type { FinalState, Output } from "./output.ts";
import { StoreError, readAccount } from "./store.ts";
import type { AccountFile, ActiveAccount, WorkerEntry } from "./store.ts";

// Steps shared by the account commands: reading the op8x file, the signed-in checks, and the
// resumption of write_key_next (init, rotate).

/** The secrets of an op8x file, for the output guard. */
export function fileSecrets(file: AccountFile | null): (string | null)[] {
  return file === null ? [] : [file.read_token, file.write_key, file.write_key_next];
}

type Loaded = { ok: true; file: AccountFile | null } | { ok: false; state: FinalState };

/**
 * The op8x file of this computer. A file that cannot be read or parsed stops the command with
 * import_failed (the fixed sentence "could not be read as an op8x file"); its content and the
 * parser's message are never shown (A16), and it is left as it is.
 */
export async function loadFile(deps: Deps): Promise<Loaded> {
  try {
    return { ok: true, file: await readAccount(deps) };
  } catch (e) {
    return { ok: false, state: e instanceof StoreError && e.code === "permissions_failed" ? "permissions_failed" : "import_failed" };
  }
}

export type SignedIn = { ok: true; base: string; file: ActiveAccount } | { ok: false; exit: number };

/**
 * For commands that need a signed-in computer: the collector base, then the file. No file or a
 * remainder file → not_logged_in; a file made for another base → collector_mismatch. Nothing is sent.
 */
export async function signedIn(deps: Deps, out: Output, hold: (f: AccountFile | null) => void): Promise<SignedIn> {
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
export function storeState(e: unknown): FinalState {
  if (e instanceof StoreError) return e.code === "permissions_failed" ? "permissions_failed" : "internal_error";
  return "permissions_failed";
}

/** The name of a worker in a hint: wrangler name (with env), or the env file. */
export function workerName(w: Pick<WorkerEntry, "name" | "env" | "env_file">): string {
  return w.env_file ?? `${w.name ?? ""}${w.env === null ? "" : ` (env ${w.env})`}`;
}

/** Writes the op8x file and keeps the new state; a FinalState if that failed (or the guard stopped). */
export type Save = (next: ActiveAccount) => Promise<FinalState | null>;

/** The account's write key in `slot`, if any. */
export function writeSlot(view: TenantView, slot: "current" | "previous"): TenantKey | undefined {
  return view.keys.find((k) => k.kind === "write" && k.slot === slot);
}

/**
 * A waiting step replace_current ends without its code being redeemed: its next K is settled.
 * Is it the account's current key (the swap happened, the answer was lost), it becomes write_key;
 * else it is discarded, never sent again as a plain rotation. The step goes in both cases. Null if
 * GET /tenant failed: then nothing changes, and a later run settles it.
 */
export async function settleReplacedNext(api: Api, file: ActiveAccount): Promise<ActiveAccount | null> {
  const next = file.write_key_next;
  if (next === null) return { ...file, pending_step_up: null };
  const view = await api.tenant(file.read_token);
  if (!view.ok) return null;
  const current = writeSlot(view.value, "current")?.fingerprint === keyFingerprint(next);
  return { ...file, write_key: current ? next : file.write_key, write_key_next: null, pending_step_up: null };
}

export type Resumed = { ok: true; file: ActiveAccount; view: TenantView } | { ok: false; exit: number };

/**
 * GET /tenant, with the resumption of write_key_next first: is it the
 * account's current key, it becomes write_key (a waiting step replace_current is then done and
 * goes too); else the exact same POST rotate again (idempotent at the collector). 409 key_conflict
 * drops it and ends the command with key_conflict; rotation_pending (the collector never took it)
 * drops it and the command goes on.
 * A next K of a waiting step replace_current is left for the continuation (it was never sent
 * without its code).
 */
export async function resumeNextKey(api: Api, out: Output, file: ActiveAccount, save: Save): Promise<Resumed> {
  const fail = (exit: number): Resumed => ({ ok: false, exit });
  const view = await api.tenant(file.read_token);
  if (!view.ok) return fail(out.error(view.error));
  const next = file.write_key_next;
  if (next === null) return { ok: true, file, view: view.value };
  const isCurrent = writeSlot(view.value, "current")?.fingerprint === keyFingerprint(next);
  const waitingReplace = file.pending_step_up?.purpose === "replace_current";
  if (!isCurrent) {
    if (waitingReplace) return { ok: true, file, view: view.value };
    const rotated = await api.rotate(file.read_token, { newHash: keyHash(next) });
    if (!rotated.ok) {
      const e = rotated.error;
      if (e.state !== "key_conflict" && e.state !== "rotation_pending") return fail(out.error(e));
      const dropped = await save({ ...file, write_key_next: null });
      if (dropped !== null) return fail(out.final(dropped));
      if (e.state === "key_conflict") return fail(out.error(e));
      // rotation_pending: the collector never took this K; the command goes on without it.
      return { ok: true, file: { ...file, write_key_next: null }, view: view.value };
    }
  }
  const promoted: ActiveAccount = { ...file, write_key: next, write_key_next: null, pending_step_up: waitingReplace ? null : file.pending_step_up };
  const failed = await save(promoted);
  if (failed !== null) return fail(out.final(failed));
  const again = await api.tenant(promoted.read_token);
  if (!again.ok) return fail(out.error(again.error));
  return { ok: true, file: promoted, view: again.value };
}
