import type { Deps } from "../cli.ts";
import { createApi } from "./api.ts";
import type { Api, ApiError, Rotated, TenantView } from "./api.ts";
import { fileSecrets, resumeNextKey, signedIn, storeState, workerName, writeSlot } from "./common.ts";
import type { Save } from "./common.ts";
import { isoNow, putIntoWorker, upsertWorker, verifyWorker, workerLine } from "./connect.ts";
import type { WorkerStatus } from "./connect.ts";
import { generateKey, keyFingerprint, keyHash } from "./keys.ts";
import { createOutput } from "./output.ts";
import type { FinalState, HintVars, Output } from "./output.ts";
import { clearsPending } from "./stepup.ts";
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
  if (o.codeStdin) return out.final("internal_error");
  const start = await freshStart(ctx);
  if (!start.ok) return start.exit;
  if (o.now) return out.final("internal_error");
  return plainRotate(ctx, start.view);
}

// --- shared pieces ------------------------------------------------------------------------------

/**
 * The end of the run: a running step ends as failed, an end state of the list clears the waiting
 * step, then the final line.
 */
async function finish(ctx: Ctx, state: FinalState, o: { extra?: Record<string, unknown>; hint?: HintVars } = {}): Promise<number> {
  ctx.out.end("failed");
  if (clearsPending(state) && ctx.file.pending_step_up !== null) {
    const failed = await ctx.save({ ...ctx.file, pending_step_up: null });
    if (failed !== null) return ctx.out.final(failed);
  }
  return ctx.out.final(state, o);
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
 * A run without --code-stdin starts over: write_key_next is resumed (GET /tenant first), then a
 * waiting step of rotate goes, together with the next K of a waiting replace_current (it was never
 * sent without its code). `stored` is that step, for the notice code_already_sent.
 */
async function freshStart(ctx: Ctx): Promise<Started> {
  const stored = ctx.file.pending_step_up;
  const resumed = await resumeNextKey(ctx.api, ctx.out, ctx.file, ctx.save);
  if (!resumed.ok) return resumed;
  const p = ctx.file.pending_step_up;
  if (p !== null && p.command === "rotate") {
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
