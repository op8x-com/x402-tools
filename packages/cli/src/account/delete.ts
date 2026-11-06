import type { Deps } from "../cli.ts";
import { collectorBase, collectorMismatch, createApi } from "./api.ts";
import { fileSecrets, loadFile, settledNext, storeState, workerName } from "./common.ts";
import { removeEnvKey, workerLine } from "./connect.ts";
import { createOutput } from "./output.ts";
import type { FinalState, Output } from "./output.ts";
import { clearsPending, matchPending, readCode, startStepUp } from "./stepup.ts";
import { ACCOUNT_SCHEMA, deleteAccount as removeAccountFile, writeAccount } from "./store.ts";
import type { AccountFile, ActiveAccount, DeletedRemainder, PendingStepUp, WorkerEntry } from "./store.ts";
import { createSecrets, findWrangler } from "./wrangler.ts";
import type { SecretResult, Secrets } from "./wrangler.ts";

// op8x delete [--code-stdin]. Deletes the account with a code from the mail (POST delete {code}),
// then removes OP8X_KEY from every known worker (wrangler secret delete, or the line in the env
// file), then the op8x file. Workers whose secret could not be removed stay listed in a remainder
// file (deleted_partial); delete on that file only retries them, without asking the collector.

export const DELETE_USAGE = `Usage: op8x delete [--code-stdin] [--json]

Deletes the op8x account (asks for the code from a mail), removes OP8X_KEY from every worker this
computer knows, then removes the op8x file.

Options:
  --code-stdin         read the code from the mail on stdin
  --json               print JSON Lines
`;

/** code, delete_account, remove_secrets, remove_file. */
const STEPS = 4;

interface Receipt {
  action_id: string;
  tenant: string | null;
  ended_at: string | null;
}

export async function deleteCommand(json: boolean, deps: Deps, o: { codeStdin: boolean }): Promise<number> {
  let held: AccountFile | null = null;
  const codes: string[] = [];
  const out = createOutput({ command: "delete", json, deps, steps: STEPS, secrets: () => [...fileSecrets(held), ...codes] });
  const guarded = () => out.final("internal_error");

  const base = collectorBase(deps.env);
  if (base === null) return out.final("collector_url_not_allowed");
  const loaded = await loadFile(deps);
  if (!loaded.ok) return out.final(loaded.state);
  // `held` keeps the file as loaded: its R and K stay known to the output guard for the whole run.
  held = loaded.file;
  const found = loaded.file;
  if (found === null) return out.final("not_logged_in");
  if (collectorMismatch(found, base)) return out.final("collector_mismatch");
  if (found.deleted !== null) {
    // The remainder file: the account is gone already; only the secrets left are retried.
    out.skip("code");
    out.skip("delete_account");
    return removeStage(deps, out, found.collector, found.workers, { action_id: found.deleted.action_id, tenant: null, ended_at: null });
  }

  let file: ActiveAccount = found;
  const save = async (next: ActiveAccount): Promise<FinalState | null> => {
    if (out.stopped) return "internal_error";
    try {
      await writeAccount(deps, next);
    } catch (e) {
      return storeState(e);
    }
    file = next;
    return null;
  };
  const api = createApi(deps, base);

  // Step code: the code from the waiting step (--code-stdin), or a new step-up.
  let code: string;
  if (o.codeStdin) {
    const m = matchPending(file, { command: "delete", forceStop: false }, deps.now());
    if (!m.ok) {
      // code_expired only comes for a step of delete, which then ends.
      if (clearsPending(m.state)) {
        const failed = await save({ ...file, pending_step_up: null });
        if (failed !== null) return out.final(failed);
      }
      return out.final(m.state, { hint: m.hint });
    }
    out.start("code");
    if (out.stopped) return guarded();
    const read = await readCode(deps, "stdin", codes);
    if (read === null) {
      out.end("failed");
      return out.final("invalid_input");
    }
    out.end("ok");
    code = read;
  } else {
    // A run without --code-stdin starts over: a waiting step of delete goes (a step of rotate
    // stays until the new step-up replaces it). `stored` is kept for the notice code_already_sent.
    const stored = file.pending_step_up;
    if (stored !== null && stored.command === "delete") {
      const failed = await save({ ...file, pending_step_up: null });
      if (failed !== null) return out.final(failed);
    }
    out.start("code");
    if (out.stopped) return guarded();
    if (file.pending_step_up?.purpose === "replace_current") {
      // The new step replaces a waiting replace_current: its next K is settled first (current →
      // write_key, else discarded), so it is never sent again as a plain rotation.
      const view = await api.tenant(file.read_token);
      if (!view.ok) {
        out.end("failed");
        return out.error(view.error);
      }
      const failed = await save(settledNext(file, view.value));
      if (failed !== null) {
        out.end("failed");
        return out.final(failed);
      }
    }
    const r = await startStepUp(api, out, file.read_token, "delete", stored);
    if (!r.ok) {
      out.end("failed");
      return out.error(r.error);
    }
    if (out.stopped) return guarded();
    const pending: PendingStepUp = {
      purpose: "delete",
      command: "delete",
      case: null,
      phase: "delete",
      force_stop: false,
      t_check: null,
      expires_at: r.value.expires_at,
    };
    const failed = await save({ ...file, pending_step_up: pending });
    if (failed !== null) {
      out.end("failed");
      return out.final(failed);
    }
    if (!deps.stdinIsTTY) {
      out.end("ok");
      return out.final("step_up_needed");
    }
    const typed = await readCode(deps, "tty", codes);
    if (typed === null) {
      out.end("failed");
      return out.final("invalid_input");
    }
    out.end("ok");
    code = typed;
  }

  // Step delete_account: POST delete {code}; 503 busy is retried with the same code by the API.
  out.start("delete_account");
  if (out.stopped) return guarded();
  const d = await api.deleteAccount(file.read_token, code);
  if (!d.ok) {
    out.end("failed");
    if (clearsPending(d.error.state)) {
      const failed = await save({ ...file, pending_step_up: null });
      if (failed !== null) return out.final(failed);
    }
    return out.error(d.error);
  }
  const receipt: Receipt = { action_id: d.value.action_id, tenant: d.value.tenant, ended_at: d.value.ended_at };
  // The account is gone: R and K leave the op8x file at once, every worker stays listed until its
  // secret is removed, so a run that breaks off is finished by the next delete. If this write
  // fails, step remove_file writes or removes the file again and reports a failure there.
  await writeAccount(deps, remainder(file.collector, receipt.action_id, file.workers)).catch(() => {});
  out.end("ok");
  return removeStage(deps, out, file.collector, file.workers, receipt);
}

function remainder(collector: string, actionId: string, workers: WorkerEntry[]): DeletedRemainder {
  return {
    schema: ACCOUNT_SCHEMA,
    collector,
    account: null,
    contact_hint: null,
    read_token: null,
    write_key: null,
    write_key_next: null,
    pending_step_up: null,
    deleted: { action_id: actionId },
    workers,
  };
}

/**
 * Steps remove_secrets and remove_file: OP8X_KEY out of every worker, then the op8x file goes, or
 * (some worker failed) the remainder file names only those workers: deleted_partial.
 */
async function removeStage(deps: Deps, out: Output, collector: string, workers: readonly WorkerEntry[], receipt: Receipt): Promise<number> {
  out.start("remove_secrets");
  if (out.stopped) return out.final("internal_error");
  const secrets = createSecrets(deps, out);
  const left: WorkerEntry[] = [];
  for (const w of workers) {
    const r = await removeFromWorker(deps, secrets, out, w);
    if (r === "stopped") return out.final("internal_error");
    if (r === "failed") left.push(w);
  }
  out.end(left.length > 0 ? "failed" : "ok");

  out.start("remove_file");
  if (out.stopped) return out.final("internal_error");
  try {
    if (left.length === 0) await removeAccountFile(deps);
    else await writeAccount(deps, remainder(collector, receipt.action_id, left));
  } catch (e) {
    out.end("failed");
    return out.final(storeState(e), { extra: { receipt } });
  }
  out.end("ok");
  if (left.length === 0) return out.final("deleted", { extra: { receipt } });
  return out.final("deleted_partial", {
    extra: { receipt, workers: left.map((w) => workerLine(w, "failed")) },
    hint: { names: left.map(workerName) },
  });
}

/**
 * OP8X_KEY out of one known worker: the line in an env file (a file that is gone counts as done),
 * or wrangler secret delete with the project's wrangler in the worker's folder. "stopped": the
 * output guard hit.
 */
async function removeFromWorker(deps: Deps, secrets: Secrets, out: Output, w: WorkerEntry): Promise<SecretResult> {
  if (out.stopped) return "stopped";
  if (w.env_file !== null) {
    try {
      await removeEnvKey(deps, w.env_file);
      return "ok";
    } catch {
      return "failed";
    }
  }
  if (w.name === null) return "failed";
  const found = await findWrangler(deps, w.dir);
  if (!found.ok) return "failed";
  return secrets.remove(found.bin, { dir: w.dir, name: w.name, env: w.env });
}
