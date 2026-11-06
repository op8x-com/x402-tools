import type { Deps } from "../cli.ts";
import { createApi } from "./api.ts";
import type { Api, ApiError, Rotated, TenantView } from "./api.ts";
import { fileSecrets, resumeNextKey, settleReplacedNext, signedIn, storeState, workerName, writeSlot } from "./common.ts";
import type { Save } from "./common.ts";
import { isoNow, putIntoWorker, upsertWorker, verifyWorker, workerLine } from "./connect.ts";
import type { WorkerStatus } from "./connect.ts";
import { generateKey, keyFingerprint, keyHash } from "./keys.ts";
import { createOutput } from "./output.ts";
import type { FinalState, HintVars, Output } from "./output.ts";
import { clearsPending, matchPending, readCode, startStepUp } from "./stepup.ts";
import { accountPath, workerId, writeAccount } from "./store.ts";
import type { AccountFile, ActiveAccount, PendingStepUp, WorkerEntry } from "./store.ts";
import { cloudflareLoggedIn, createSecrets, findWrangler } from "./wrangler.ts";
import type { Secrets } from "./wrangler.ts";

// op8x rotate [--now [--force-stop] [--code-stdin]]. Plain rotate swaps K with 24 hours of overlap and
// puts the new K into every known worker; --now then stops the old key with a code from the mail,
// but only once every known worker is proven to hold the new K and the old one went quiet.

export const ROTATE_USAGE = `Usage: op8x rotate [--now [--force-stop] [--code-stdin]] [--json]

Replaces the server key and puts the new one into every worker this computer knows. Without
--now the old key keeps working for 24 hours.

Options:
  --now                stop the old key right away (asks for the code from a mail)
  --force-stop         with --now: stop the old key even if a worker may still use it
  --code-stdin         with --now: read the code from the mail on stdin
  --json               print JSON Lines
`;

export interface RotateOptions {
  now: boolean;
  forceStop: boolean;
  codeStdin: boolean;
}

/** One run: the newest state of the op8x file, and the secrets the output guard must know. */
interface Ctx {
  deps: Deps;
  out: Output;
  api: Api;
  /** The newest saved op8x file. */
  file: ActiveAccount;
  save: Save;
  /** Server keys made in this run. */
  made: string[];
  /** Codes read in this run. */
  codes: string[];
  /** N of "Step n of N", fixed before the first step. */
  plan: (steps: number) => void;
}

/** Workers of this run that did not get K, or got it without a test event. */
interface Outcome {
  failed: Set<string>;
  unverified: Set<string>;
}

const newOutcome = (): Outcome => ({ failed: new Set(), unverified: new Set() });

export async function rotate(json: boolean, deps: Deps, o: RotateOptions): Promise<number> {
  let held: AccountFile | null = null;
  const made: string[] = [];
  const codes: string[] = [];
  let planned = 0;
  const out = createOutput({
    command: "rotate",
    json,
    deps,
    // Read at every step line: the run knows its steps only after GET /tenant, before the first one.
    get steps() {
      return planned;
    },
    secrets: () => [...fileSecrets(held), ...made, ...codes],
  });
  const s = await signedIn(deps, out, (f) => {
    held = f;
  });
  if (!s.ok) return s.exit;
  const ctx: Ctx = {
    deps,
    out,
    api: createApi(deps, s.base),
    file: s.file,
    made,
    codes,
    plan: (n) => {
      planned = n;
    },
    save: async (next) => {
      if (out.stopped) return "internal_error";
      try {
        await writeAccount(deps, next);
      } catch (e) {
        return storeState(e);
      }
      ctx.file = next;
      held = next;
      return null;
    },
  };
  if (o.codeStdin) return continueStep(ctx, o.forceStop);
  const start = await freshStart(ctx);
  if (!start.ok) return start.exit;
  if (o.now) return rotateNow(ctx, start.view, start.stored, o.forceStop);
  return plainRotate(ctx, start.view);
}

// --- shared pieces ------------------------------------------------------------------------------

/**
 * The end of the run: a running step ends as failed, an end state of the list clears a waiting
 * step of rotate (a step of delete is never touched; `keep` leaves the step when the run ended
 * before its code could be sent), then the final line. A cleared replace_current step settles
 * its next K first.
 */
async function finish(ctx: Ctx, state: FinalState, o: { extra?: Record<string, unknown>; hint?: HintVars; keep?: boolean } = {}): Promise<number> {
  ctx.out.end("failed");
  const p = ctx.file.pending_step_up;
  if (o.keep !== true && clearsPending(state) && p !== null && p.command === "rotate") {
    const next = p.purpose === "replace_current" ? await settleReplacedNext(ctx.api, ctx.file) : { ...ctx.file, pending_step_up: null };
    if (next !== null) {
      const failed = await ctx.save(next);
      if (failed !== null) return ctx.out.final(failed);
    }
  }
  return ctx.out.final(state, { extra: o.extra, hint: o.hint });
}

/** The final line of an API error (409 no_write_key keeps the path of server_key_missing). */
function finishApi(ctx: Ctx, e: ApiError): Promise<number> {
  const { state, ...fields } = e;
  return finish(ctx, state, { extra: state === "server_key_missing" ? { ...fields, path: accountPath(ctx.deps) } : fields });
}

/** The output guard hit: nothing more happens. */
const guarded = (ctx: Ctx) => ctx.out.final("internal_error");

type Started = { ok: true; view: TenantView; stored: PendingStepUp | null } | { ok: false; exit: number };

/**
 * A run without --code-stdin starts over: write_key_next is resumed (GET /tenant first; a next K
 * of a waiting replace_current that is already current becomes write_key). Then every waiting
 * step of rotate goes, a replace_current with its next K (never sent without its code); a step of
 * delete stays. `stored` is the step as found, for the notice code_already_sent.
 */
async function freshStart(ctx: Ctx): Promise<Started> {
  const stored = ctx.file.pending_step_up;
  const resumed = await resumeNextKey(ctx.api, ctx.out, ctx.file, ctx.save, { resend: true });
  if (!resumed.ok) return resumed;
  const p = ctx.file.pending_step_up;
  if (p !== null && p.command === "rotate") {
    // A replace_current still waiting: resumeNextKey just saw that its next K is not the current
    // key, so it is discarded. A rotate_now simply goes. A step of delete stays.
    const failed = await ctx.save({
      ...ctx.file,
      pending_step_up: null,
      write_key_next: p.purpose === "replace_current" ? null : ctx.file.write_key_next,
    });
    if (failed !== null) return { ok: false, exit: ctx.out.final(failed) };
  }
  return { ok: true, view: resumed.view, stored };
}

/**
 * The Cloudflare login, once per run and before anything changes, if K goes into a wrangler
 * worker: whoami with the project's wrangler of the first such worker that has one. A worker
 * without wrangler fails later on its own (partial). One Secrets per run (one notice).
 */
async function prepareSecrets(ctx: Ctx, targets: readonly WorkerEntry[]): Promise<{ ok: true; secrets: Secrets } | { ok: false; exit: number }> {
  for (const w of targets) {
    if (w.env_file !== null) continue;
    const found = await findWrangler(ctx.deps, w.dir);
    if (!found.ok) continue;
    if (!(await cloudflareLoggedIn(ctx.deps, found.bin))) return { ok: false, exit: ctx.out.final("cloudflare_login_needed") };
    break;
  }
  return { ok: true, secrets: createSecrets(ctx.deps, ctx.out) };
}

type NewKey = { ok: true; key: string; rotated: Rotated } | { ok: false; exit: number };

/**
 * A new K with overlap: stored as write_key_next before POST rotate {kind, new_sha256}, and
 * write_key after the answer. 409 key_conflict once gives a new K; key_conflict again or
 * rotation_pending drop write_key_next. Any other failure keeps it for the next run.
 */
async function rotateToNewKey(ctx: Ctx): Promise<NewKey> {
  for (let attempt = 0; ; attempt++) {
    const key = generateKey("w");
    ctx.made.push(key);
    const stored = await ctx.save({ ...ctx.file, write_key_next: key });
    if (stored !== null) return { ok: false, exit: await finish(ctx, stored) };
    const r = await ctx.api.rotate(ctx.file.read_token, { newHash: keyHash(key) });
    if (r.ok) {
      const promoted = await ctx.save({ ...ctx.file, write_key: key, write_key_next: null });
      if (promoted !== null) return { ok: false, exit: await finish(ctx, promoted) };
      return { ok: true, key, rotated: r.value };
    }
    if (r.error.state === "key_conflict" && attempt === 0) continue;
    if (r.error.state === "key_conflict" || r.error.state === "rotation_pending") {
      const dropped = await ctx.save({ ...ctx.file, write_key_next: null });
      if (dropped !== null) return { ok: false, exit: await finish(ctx, dropped) };
    }
    return { ok: false, exit: await finishApi(ctx, r.error) };
  }
}

/**
 * Step key: K into each target (wrangler secret put, or the OP8X_KEY line of an env file); each
 * success is stored at once (deployed_at, key_fingerprint, verified_at null). No target → skipped.
 * Returns an exit code if the run ends here.
 */
async function keyStep(ctx: Ctx, secrets: Secrets, key: string, targets: readonly WorkerEntry[], outcome: Outcome): Promise<number | null> {
  if (targets.length === 0) {
    ctx.out.skip("key");
    return null;
  }
  ctx.out.start("key");
  if (ctx.out.stopped) return guarded(ctx);
  for (const w of targets) {
    const r = await putIntoWorker(ctx.deps, secrets, ctx.out, w, key);
    if (r === "stopped") return guarded(ctx);
    if (r === "failed") {
      outcome.failed.add(workerId(w));
      continue;
    }
    const stored: WorkerEntry = { ...w, deployed_at: isoNow(ctx.deps), key_fingerprint: keyFingerprint(key), verified_at: null };
    const failed = await ctx.save({ ...ctx.file, workers: upsertWorker(ctx.file.workers, stored) });
    if (failed !== null) return finish(ctx, failed);
  }
  ctx.out.end(outcome.failed.size > 0 ? "failed" : "ok");
  return null;
}

type Tested = { ok: true; tCheck: string | null } | { ok: false; exit: number };

/**
 * Step test: one nonce and test request per target with a url (stored URLs count as typed by the
 * human: they came from --url or from a route checked at init). seen → verified_at = seen_at;
 * T_check is the latest seen_at (server time). No target → skipped.
 */
async function testStep(ctx: Ctx, targets: readonly WorkerEntry[], outcome: Outcome): Promise<Tested> {
  const withUrl = targets.filter((w) => w.url !== null);
  if (withUrl.length === 0) {
    ctx.out.skip("test");
    return { ok: true, tCheck: null };
  }
  ctx.out.start("test");
  if (ctx.out.stopped) return { ok: false, exit: guarded(ctx) };
  let tCheck: string | null = null;
  for (const w of withUrl) {
    const v = await verifyWorker({ deps: ctx.deps, api: ctx.api, out: ctx.out, readToken: ctx.file.read_token, url: w.url ?? "", explicit: true });
    if (!v.ok) {
      if (v.state === "stopped") return { ok: false, exit: guarded(ctx) };
      if (v.state === "api") return { ok: false, exit: await finishApi(ctx, v.error) };
      outcome.unverified.add(workerId(w));
      continue;
    }
    const now = ctx.file.workers.find((x) => workerId(x) === workerId(w)) ?? w;
    const failed = await ctx.save({ ...ctx.file, workers: upsertWorker(ctx.file.workers, { ...now, verified_at: v.seenAt }) });
    if (failed !== null) return { ok: false, exit: await finish(ctx, failed) };
    if (tCheck === null || Date.parse(v.seenAt) > Date.parse(tCheck)) tCheck = v.seenAt;
  }
  ctx.out.end(outcome.unverified.size > 0 ? "failed" : "ok");
  return { ok: true, tCheck };
}

/** Every known worker with its status for the final line; `bad` names the failed and unverified ones. */
function report(ctx: Ctx, key: string, outcome: Outcome): { workers: ReturnType<typeof workerLine>[]; bad: string[] } {
  const fp = keyFingerprint(key);
  const workers: ReturnType<typeof workerLine>[] = [];
  const bad: string[] = [];
  for (const w of ctx.file.workers) {
    const id = workerId(w);
    let status: WorkerStatus;
    if (outcome.failed.has(id) || w.key_fingerprint !== fp) status = "failed";
    else if (outcome.unverified.has(id)) status = "unverified";
    else if (w.url === null) status = "no_url";
    else status = w.verified_at === null ? "unverified" : "verified";
    if (status === "failed" || status === "unverified") bad.push(workerName(w));
    workers.push(workerLine(w, status));
  }
  return { workers, bad };
}

// --- plain rotate --------------------------------------------------------------------------------

/**
 * op8x rotate: steps new_key, key, test. A new K with overlap goes into every known worker, each
 * worker with a url is proven by a nonce. Is a rotation already open and the local K the current
 * key (a run after partial or deployed_unverified), there is no new POST rotate: K goes only into
 * workers with another key_fingerprint, and only workers not yet verified are tested.
 */
async function plainRotate(ctx: Ctx, view: TenantView): Promise<number> {
  const { out } = ctx;
  ctx.plan(3);
  const local = ctx.file.write_key;
  const previous = writeSlot(view, "previous");
  const rerun = previous !== undefined && local !== null && writeSlot(view, "current")?.fingerprint === keyFingerprint(local);
  const targets = rerun && local !== null ? ctx.file.workers.filter((w) => w.key_fingerprint !== keyFingerprint(local)) : ctx.file.workers;
  const prepared = await prepareSecrets(ctx, targets);
  if (!prepared.ok) return prepared.exit;

  let key: string;
  let until: string | null;
  if (rerun && local !== null) {
    out.skip("new_key");
    key = local;
    until = previous?.valid_until ?? null;
  } else {
    out.start("new_key");
    if (out.stopped) return guarded(ctx);
    const r = await rotateToNewKey(ctx);
    if (!r.ok) return r.exit;
    out.end("ok");
    key = r.key;
    until = r.rotated.previous_valid_until;
  }

  const outcome = newOutcome();
  const putExit = await keyStep(ctx, prepared.secrets, key, targets, outcome);
  if (putExit !== null) return putExit;
  const fp = keyFingerprint(key);
  const toTest = ctx.file.workers.filter((w) => w.verified_at === null && w.key_fingerprint === fp && !outcome.failed.has(workerId(w)));
  const tested = await testStep(ctx, toTest, outcome);
  if (!tested.ok) return tested.exit;

  const { workers, bad } = report(ctx, key, outcome);
  if (bad.length > 0) return finish(ctx, "partial", { extra: { workers }, hint: { names: bad } });
  return finish(ctx, "key_rotated", { extra: { workers }, hint: { n: workers.length, time: until } });
}

// --- rotate --now --------------------------------------------------------------------------------

type Case = "a" | "b" | "c" | "e";

/** How a code of this run arrives: typed on the TTY now, or the run ends with step_up_needed. */
type Ask = "tty" | "end";

/** What every stage of --now needs to know about the run. */
interface NowRun {
  kase: Case;
  forceStop: boolean;
  ask: Ask;
  /** The waiting step as the run found it, for the notice code_already_sent. */
  stored: PendingStepUp | null;
}

const WAIT_EVERY_MS = 10_000;
const WAIT_FOR_MS = 90_000;
/** A second bound besides the clock: at most this many GET /tenant while waiting. */
const WAIT_POLLS = WAIT_FOR_MS / WAIT_EVERY_MS + 1;
/** The old key must have been quiet this long after T_check (covers the collector's one-minute throttle). */
const QUIET_MS = 60_000;

/** test and wait run unless force_stop. */
const checks = (forceStop: boolean) => (forceStop ? 0 : 2);

/**
 * op8x rotate --now (fresh run). The case comes from GET /tenant and the local K: (a) no previous
 * key: a new K with overlap, then the stop; (b) a previous key is open and the local K is current:
 * only the stop (K first into workers with another fingerprint); (c) the local K is the previous
 * key: a code to replace the current key, then as (b); (d) no local K: server_key_missing; (e) the
 * local K is neither: as (c) with K into all workers if a previous key is open, else as (a).
 */
async function rotateNow(ctx: Ctx, view: TenantView, stored: PendingStepUp | null, forceStop: boolean): Promise<number> {
  const local = ctx.file.write_key;
  const previous = writeSlot(view, "previous");
  if (local === null) return finish(ctx, "server_key_missing", { extra: { path: accountPath(ctx.deps) }, hint: { rotation_running: previous !== undefined } });
  const fp = keyFingerprint(local);
  let kase: Case;
  if (writeSlot(view, "current")?.fingerprint === fp) kase = previous === undefined ? "a" : "b";
  else kase = previous !== undefined && previous.fingerprint === fp ? "c" : "e";
  const replace = kase === "c" || (kase === "e" && previous !== undefined);
  const ask: Ask = ctx.deps.stdinIsTTY ? "tty" : "end";
  const run: NowRun = { kase, forceStop, ask, stored };

  // What would stop the run later stops it now, before anything changes.
  if (!forceStop) {
    const early = await unprovable(ctx, view);
    if (early !== null) return early;
  }
  const targets = kase === "b" ? ctx.file.workers.filter((w) => w.key_fingerprint !== fp) : ctx.file.workers;
  const prepared = await prepareSecrets(ctx, targets);
  if (!prepared.ok) return prepared.exit;
  const stop = ask === "tty" ? 1 : 0;

  if (replace) {
    // code, new_key, key, [test, wait], code, stop; without a TTY the run ends after the first code.
    ctx.plan(ask === "tty" ? 5 + checks(forceStop) : 1);
    const code = await codeStep(ctx, run, "replace_current", null);
    if (!code.ok) return code.exit;
    return afterReplace(ctx, prepared.secrets, code.code, run);
  }
  if (kase === "b") {
    ctx.plan((targets.length > 0 ? 1 : 0) + checks(forceStop) + 1 + stop);
    const outcome = newOutcome();
    if (targets.length > 0) {
      const putExit = await keyStep(ctx, prepared.secrets, local, targets, outcome);
      if (putExit !== null) return putExit;
      if (outcome.failed.size > 0) return partialEnd(ctx, local, outcome);
    }
    return stopStage(ctx, local, run, outcome);
  }
  // (a), or (e) without a previous key.
  ctx.plan(3 + checks(forceStop) + stop);
  ctx.out.start("new_key");
  if (ctx.out.stopped) return guarded(ctx);
  const r = await rotateToNewKey(ctx);
  if (!r.ok) return r.exit;
  ctx.out.end("ok");
  const outcome = newOutcome();
  const putExit = await keyStep(ctx, prepared.secrets, r.key, ctx.file.workers, outcome);
  if (putExit !== null) return putExit;
  if (outcome.failed.size > 0) return partialEnd(ctx, r.key, outcome);
  return stopStage(ctx, r.key, run, outcome);
}

/**
 * op8x rotate --now --code-stdin: redeems the waiting step. It must exist, fit this command and
 * --force-stop, and not be expired; the stored force_stop holds for the run. rotate_now: steps
 * code, stop. replace_current: code, new_key, key, [test, wait], code; the run then starts exactly
 * the next step-up (rotate_now) and ends with step_up_needed.
 */
async function continueStep(ctx: Ctx, forceStop: boolean): Promise<number> {
  const m = matchPending(ctx.file, { command: "rotate", forceStop }, ctx.deps.now());
  if (!m.ok) return finish(ctx, m.state, { hint: m.hint });
  const p = m.pending;
  const run: NowRun = { kase: p.case ?? "a", forceStop: p.force_stop, ask: "end", stored: p };
  if (p.purpose === "rotate_now") {
    ctx.plan(2);
    const code = await stdinCode(ctx);
    if (!code.ok) return code.exit;
    return stopStep(ctx, code.code, run, p.t_check, ctx.file.write_key ?? "");
  }
  ctx.plan(4 + checks(run.forceStop));
  const code = await stdinCode(ctx);
  if (!code.ok) return code.exit;
  if (!run.forceStop) {
    const view = await ctx.api.tenant(ctx.file.read_token);
    if (!view.ok) return finishApi(ctx, view.error);
    const early = await unprovable(ctx, view.value);
    if (early !== null) return early;
  }
  const prepared = await prepareSecrets(ctx, ctx.file.workers);
  if (!prepared.ok) return prepared.exit;
  return afterReplace(ctx, prepared.secrets, code.code, run);
}

/**
 * Without force_stop every known worker must be provable: no known worker gives no T_check
 * (old_key_still_used, variant without a worker), a worker without url cannot be tested
 * (url_required, naming them). No code was sent, so a waiting step stays.
 */
async function unprovable(ctx: Ctx, view: TenantView): Promise<number | null> {
  if (ctx.file.workers.length === 0) {
    return finish(ctx, "old_key_still_used", { extra: { last_seen: view.write_key_prev_last_seen_at }, hint: { no_workers: true }, keep: true });
  }
  const noUrl = ctx.file.workers.filter((w) => w.url === null);
  if (noUrl.length === 0) return null;
  return finish(ctx, "url_required", {
    extra: { workers: noUrl.map((w) => workerLine(w, "no_url")) },
    hint: { rotate_now: true, names: noUrl.map(workerName) },
    keep: true,
  });
}

function partialEnd(ctx: Ctx, key: string, outcome: Outcome): Promise<number> {
  const { workers, bad } = report(ctx, key, outcome);
  return finish(ctx, "partial", { extra: { workers }, hint: { names: bad } });
}

type Code = { ok: true; code: string } | { ok: false; exit: number };

/** Step code of a --code-stdin run: the code from stdin; a malformed one ends with invalid_input. */
async function stdinCode(ctx: Ctx): Promise<Code> {
  ctx.out.start("code");
  if (ctx.out.stopped) return { ok: false, exit: guarded(ctx) };
  const code = await readCode(ctx.deps, "stdin", ctx.codes);
  if (code === null) return { ok: false, exit: await finish(ctx, "invalid_input") };
  ctx.out.end("ok");
  return { ok: true, code };
}

/**
 * Step code: POST step-up {purpose}, the step is stored (pending_step_up), then the code is typed
 * on the TTY, or the run ends with step_up_needed.
 */
async function codeStep(ctx: Ctx, run: NowRun, purpose: "rotate_now" | "replace_current", tCheck: string | null): Promise<Code> {
  ctx.out.start("code");
  if (ctx.out.stopped) return { ok: false, exit: guarded(ctx) };
  const r = await startStepUp(ctx.api, ctx.out, ctx.file.read_token, purpose, run.stored);
  if (!r.ok) return { ok: false, exit: await finishApi(ctx, r.error) };
  if (ctx.out.stopped) return { ok: false, exit: guarded(ctx) };
  const pending: PendingStepUp = {
    purpose,
    command: "rotate",
    case: run.kase,
    phase: purpose === "replace_current" ? "replace" : "stop",
    force_stop: run.forceStop,
    t_check: tCheck,
    expires_at: r.value.expires_at,
  };
  const failed = await ctx.save({ ...ctx.file, pending_step_up: pending });
  if (failed !== null) return { ok: false, exit: await finish(ctx, failed) };
  if (run.ask === "end") {
    ctx.out.end("ok");
    return { ok: false, exit: ctx.out.final("step_up_needed") };
  }
  const code = await readCode(ctx.deps, "tty", ctx.codes);
  if (code === null) return { ok: false, exit: await finish(ctx, "invalid_input") };
  ctx.out.end("ok");
  return { ok: true, code };
}

/**
 * Step new_key with the code of replace_current: POST rotate {kind, new_sha256: hash(next K),
 * replace_current: true, code}; the next K is stored first. A next K from an earlier try of this
 * step is used again (the exact repeat), and if it is already the current key (an answer lost
 * after the swap) nothing is sent. Then the step is spent: write_key = next K, no waiting step.
 * Then K into the workers ((c): those with another fingerprint, (e): all) and the stop stage.
 */
async function afterReplace(ctx: Ctx, secrets: Secrets, code: string, run: NowRun): Promise<number> {
  ctx.out.start("new_key");
  if (ctx.out.stopped) return guarded(ctx);
  let next = ctx.file.write_key_next;
  let swapped = false;
  if (next === null) {
    next = generateKey("w");
    ctx.made.push(next);
    const failed = await ctx.save({ ...ctx.file, write_key_next: next });
    if (failed !== null) return finish(ctx, failed);
  } else {
    const view = await ctx.api.tenant(ctx.file.read_token);
    if (!view.ok) return finishApi(ctx, view.error);
    swapped = writeSlot(view.value, "current")?.fingerprint === keyFingerprint(next);
  }
  if (!swapped) {
    const r = await ctx.api.rotate(ctx.file.read_token, { newHash: keyHash(next), replaceCurrent: true, code });
    if (!r.ok) {
      // The collector did not take the next K: it goes (a later try makes a new one), unless the
      // answer leaves the step and its code worth another try with the same request.
      if (clearsPending(r.error.state) || r.error.state === "key_conflict") {
        const dropped = await ctx.save({ ...ctx.file, write_key_next: null });
        if (dropped !== null) return finish(ctx, dropped);
      }
      return finishApi(ctx, r.error);
    }
  }
  const promoted = await ctx.save({ ...ctx.file, write_key: next, write_key_next: null, pending_step_up: null });
  if (promoted !== null) return finish(ctx, promoted);
  ctx.out.end("ok");

  const fp = keyFingerprint(next);
  const targets = run.kase === "e" ? ctx.file.workers : ctx.file.workers.filter((w) => w.key_fingerprint !== fp);
  const outcome = newOutcome();
  const putExit = await keyStep(ctx, secrets, next, targets, outcome);
  if (putExit !== null) return putExit;
  if (outcome.failed.size > 0) return partialEnd(ctx, next, outcome);
  return stopStage(ctx, next, run, outcome);
}

/**
 * The stop stage after every worker has K: (1) every known worker is tested, T_check = the latest
 * seen_at; (2) GET /tenant every 10 s until server_time ≥ T_check + 60 s (at most 90 s); (3) the
 * old key must not have been seen after T_check; (4) step-up rotate_now with t_check stored;
 * (5) the stop. With force_stop 1-3 drop out.
 */
async function stopStage(ctx: Ctx, key: string, run: NowRun, outcome: Outcome): Promise<number> {
  let tCheck: string | null = null;
  if (!run.forceStop) {
    const tested = await testStep(ctx, ctx.file.workers, outcome);
    if (!tested.ok) return tested.exit;
    if (outcome.unverified.size > 0) return partialEnd(ctx, key, outcome);
    if (tested.tCheck === null) return finish(ctx, "old_key_still_used", { extra: { last_seen: null } });
    tCheck = tested.tCheck;
    const waited = await waitStep(ctx, tCheck);
    if (waited !== null) return waited;
  }
  const code = await codeStep(ctx, run, "rotate_now", tCheck);
  if (!code.ok) return code.exit;
  return stopStep(ctx, code.code, run, tCheck, key);
}

/** The old key was seen after T_check (null = never seen counts as quiet). */
const seenAfter = (lastSeen: string | null, tCheck: string) => lastSeen !== null && Date.parse(lastSeen) > Date.parse(tCheck);

/** Step wait (2 and 3 of the stop stage); null if the stop may follow. */
async function waitStep(ctx: Ctx, tCheck: string): Promise<number | null> {
  const { out, deps } = ctx;
  out.start("wait");
  if (out.stopped) return guarded(ctx);
  const started = deps.now();
  const until = Date.parse(tCheck) + QUIET_MS;
  let view: TenantView;
  for (let polls = 1; ; polls++) {
    const r = await ctx.api.tenant(ctx.file.read_token);
    if (!r.ok) return finishApi(ctx, r.error);
    if (Date.parse(r.value.server_time) >= until) {
      view = r.value;
      break;
    }
    // The server's clock does not move on: give up after 90 s.
    if (polls >= WAIT_POLLS || deps.now() - started + WAIT_EVERY_MS > WAIT_FOR_MS) return finish(ctx, "network_error");
    await deps.sleep(WAIT_EVERY_MS);
    if (out.stopped) return guarded(ctx);
  }
  if (writeSlot(view, "previous") === undefined) return finish(ctx, "nothing_to_stop");
  const lastSeen = view.write_key_prev_last_seen_at;
  if (seenAfter(lastSeen, tCheck)) return finish(ctx, "old_key_still_used", { extra: { last_seen: lastSeen } });
  out.end("ok");
  return null;
}

/**
 * Step stop (5): GET /tenant again; the local K must be the current key (else key_mismatch, the
 * step stays); without force_stop the old key must still be quiet since
 * T_check, else old_key_still_used and the code is not sent. Then POST revoke-previous {code}.
 */
async function stopStep(ctx: Ctx, code: string, run: NowRun, tCheck: string | null, key: string): Promise<number> {
  ctx.out.start("stop");
  if (ctx.out.stopped) return guarded(ctx);
  const view = await ctx.api.tenant(ctx.file.read_token);
  if (!view.ok) return finishApi(ctx, view.error);
  if (writeSlot(view.value, "previous") === undefined) return finish(ctx, "nothing_to_stop");
  // Only the key before this computer's current K may be stopped: if the local K is no longer the
  // current key (another rotation happened), the previous slot may hold this very K.
  const local = ctx.file.write_key;
  if (local === null || writeSlot(view.value, "current")?.fingerprint !== keyFingerprint(local)) return finish(ctx, "key_mismatch", { keep: true });
  const lastSeen = view.value.write_key_prev_last_seen_at;
  if (!run.forceStop && (tCheck === null || seenAfter(lastSeen, tCheck))) return finish(ctx, "old_key_still_used", { extra: { last_seen: lastSeen } });
  if (ctx.out.stopped) return guarded(ctx);
  const r = await ctx.api.revokePrevious(ctx.file.read_token, code);
  if (!r.ok) return finishApi(ctx, r.error);
  ctx.out.end("ok");
  const { workers } = report(ctx, key, newOutcome());
  return finish(ctx, "old_key_stopped", { extra: { workers }, hint: { n: workers.length } });
}
