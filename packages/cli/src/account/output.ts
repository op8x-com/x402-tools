import type { Deps } from "../cli.ts";
import { cleanText, printEscaped } from "../extract.ts";
import type { ApiError } from "./api.ts";

// Output of the account commands. Without --json: text lines with "Step n of N". With --json:
// JSON Lines on stdout, intermediate lines (step, link, notice) and one final line with
// "final": true. Every line passes the output guard before it is written: a line that holds
// R, K (current or next), D or OP8X_TEST_TOKEN is replaced by the internal_error final line,
// and the original is written nowhere. Strings from the server lose control and format
// characters (cleanText) before they are printed, in JSON and in text.

export const CLI_SCHEMA = "op8x.cli/1";

/** The account commands registered so far (the dispatcher's table grows per task). */
export type AccountCommand = "init" | "login" | "logout" | "import-key" | "rotate";

/** Every account command, for the output envelope. */
export type CommandName = "init" | "login" | "logout" | "import-key" | "rotate" | "delete" | "report";

/** The final JSON line of a usage error or of a run without Deps (no hint, no steps). */
export function finalLine(
  command: AccountCommand | null,
  state: string,
  exitCode: number,
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({ schema: CLI_SCHEMA, command, final: true, state, exit_code: exitCode, ...extra })}\n`;
}

// --- state catalog ----------------------------------------------------------------------------

/** Exit code of every final state (0 success, 1 expected state, 2 network or server, 4 usage). */
export const EXIT_CODES = {
  connected: 0,
  key_rotated: 0,
  old_key_stopped: 0,
  deleted: 0,
  logged_out: 0,
  imported: 0,
  cloudflare_login_needed: 1,
  wrangler_missing: 1,
  wrangler_too_old: 1,
  env_required: 1,
  url_required: 1,
  deployed_unverified: 1,
  denied: 1,
  expired: 1,
  no_account: 1,
  terms_draft: 1,
  granted_lost: 1,
  server_key_missing: 1,
  key_mismatch: 1,
  key_previous: 1,
  partial: 1,
  old_key_still_used: 1,
  rotation_pending: 1,
  nothing_to_stop: 1,
  step_up_needed: 1,
  code_invalid: 1,
  code_expired: 1,
  code_exhausted: 1,
  rate_limited: 1,
  key_conflict: 1,
  deleted_partial: 1,
  not_logged_in: 1,
  key_auth: 1,
  import_failed: 1,
  config_unreadable: 1,
  permissions_failed: 1,
  not_available_yet: 1,
  network_error: 2,
  busy: 2,
  unexpected_response: 2,
  internal_error: 2,
  usage_error: 4,
  invalid_input: 4,
  code_missing: 4,
  no_pending_step: 4,
  env_file_not_ignored: 4,
  collector_url_not_allowed: 4,
  collector_mismatch: 4,
} as const;

export type FinalState = keyof typeof EXIT_CODES;

/** Values a hint names; times are ISO 8601 UTC and printed per mode. */
export interface HintVars {
  account?: string;
  contact_hint?: string | null;
  n?: number;
  /** {time}: until when, or last seen; null = never seen. */
  time?: string | null;
  action_id?: string;
  names?: readonly string[];
  words?: string;
  retry_at?: string;
  attempts_left?: number;
  status?: number;
  code?: string | null;
  /** no_pending_step: the command the waiting step belongs to (variant "other command"). */
  command?: string;
  /** logged_out: the computer held K. */
  with_key?: boolean;
  /** url_required: the rotate --now variant with the workers' names. */
  rotate_now?: boolean;
  /** server_key_missing: a rotation is running. */
  rotation_running?: boolean;
}

type Mode = "json" | "text";

const MAX_FIELD = 1024;
/** A server value as printed: no control or format characters. */
const clean = (s: string) => cleanText(s, MAX_FIELD);

/** ISO 8601 UTC as `YYYY-MM-DD HH:MM UTC` (the text form of every time). */
export function textTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return clean(iso);
  const s = d.toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
}

const time = (v: string | null | undefined, mode: Mode) => (v === null || v === undefined ? "never" : mode === "text" ? textTime(v) : clean(v));
const text = (v: string | number | null | undefined) => (v === null || v === undefined ? "null" : clean(String(v)));
const list = (v: readonly string[] | undefined) => (v ?? []).map(clean).join(", ");

const HINTS: Record<FinalState | "waiting_for_human", ((v: HintVars, mode: Mode) => string) | null> = {
  connected: (v) =>
    v.contact_hint === null || v.contact_hint === undefined
      ? `op8x is connected to account ${text(v.account)}. This computer does not know the account's address; ask your human to check that it is theirs, and if not, run op8x logout.`
      : `op8x is connected to account ${text(v.account)} (${text(v.contact_hint)}). Tell your human which address this account belongs to; if it is not theirs, run op8x logout.`,
  key_rotated: (v, m) =>
    v.n === 0
      ? "No worker is known on this computer. Run op8x init in every worker folder within 24 hours."
      : `The new server key is in ${text(v.n)} workers; the old key works until ${time(v.time, m)}.`,
  old_key_stopped: (v) => `The old server key is stopped. The new key is in ${text(v.n)} workers.`,
  deleted: (v) => `The account is deleted. Receipt: ${text(v.action_id)}.`,
  logged_out: (v) => (v.with_key === true ? "This computer is signed out. The server key on this computer is removed too." : "This computer is signed out."),
  imported: () => "The server key is on this computer now. Run op8x init in a worker folder.",
  waiting_for_human: (v) => `Ask your human to open the link and click Allow. Their screen shows ${text(v.words)}.`,
  cloudflare_login_needed: () => "Ask your human to run npx wrangler login, then run op8x init again.",
  wrangler_missing: () => "Run npm i -D wrangler in this project, then run op8x init again.",
  wrangler_too_old: () => "This needs wrangler 4.152.0 or newer and Node.js 22 or newer. Update them, then run the command again.",
  env_required: () => "This worker has several environments. Run op8x init --env <name>.",
  url_required: (v) =>
    v.rotate_now === true
      ? `These workers have no test address: ${list(v.names)}. Run op8x init --url https://… in their folders, or run op8x rotate --now --force-stop.`
      : "Pass --url https://… with a path the op8x module handles.",
  deployed_unverified: () =>
    "The key is stored, but no test event arrived. Check that the module is mounted on that path and has the endpoint option; that it is @op8x/analytics 0.0.2 or later (older versions do not send the test event); or pass --url.",
  denied: () => "The request was denied. Run op8x init again when your human is ready.",
  expired: () => "The link expired. Run op8x init again when your human is ready.",
  no_account: () => "There is no op8x account for this address. Run op8x init to create one.",
  terms_draft: () => "op8x accounts are not open yet.",
  granted_lost: () => "The sign-in finished but this computer missed the answer. Run op8x login.",
  server_key_missing: (v) =>
    v.rotation_running === true
      ? "This computer has no server key. Run op8x import-key <path to the op8x file of your other computer>, or run op8x rotate --now."
      : "This computer has no server key. Run op8x import-key <path to the op8x file of your other computer>, or run op8x rotate and then op8x init in every worker folder within 24 hours.",
  key_mismatch: () => "The key on this computer is not the account's current key. Run op8x rotate.",
  key_previous: () => "This key is the old one. Run op8x rotate.",
  partial: (v) => `The new key is not in every worker: ${list(v.names)}. Fix them and run the command again; nothing was stopped.`,
  old_key_still_used: (v, m) =>
    `A worker this computer does not know still uses the old key (last seen ${time(v.time, m)}). Run op8x init in its folder, then run op8x rotate --now again. If the key leaked, run op8x rotate --now --force-stop.`,
  rotation_pending: (v, m) => `A rotation is still running until ${time(v.time, m)}. Run op8x rotate --now to finish it early.`,
  nothing_to_stop: () => "The old key is already stopped.",
  step_up_needed: () => "Ask your human for the code from the mail, then run the same command with --code-stdin and pass the code on stdin.",
  code_invalid: (v) => `The code is not right. ${text(v.attempts_left)} tries left. Ask your human for the newest code.`,
  code_expired: () => "The code expired. Run the command again for a new code.",
  code_exhausted: () => "Too many wrong codes. Run the command again for a new code.",
  rate_limited: (v, m) => `Too many requests. Try again after ${time(v.retry_at, m)}.`,
  key_conflict: () => "Run the command again.",
  deleted_partial: (v) => `The account is deleted. Remove OP8X_KEY by hand from: ${list(v.names)}.`,
  not_logged_in: () => "This computer is not signed in. Run op8x init or op8x login.",
  key_auth: () => "This computer's access is no longer valid. Run op8x login.",
  import_failed: () => "The file could not be read as an op8x file.",
  config_unreadable: () => "The wrangler configuration could not be read.",
  permissions_failed: () => "The op8x file could not be protected; nothing was written.",
  not_available_yet: () => "Numbers are not available in this version yet.",
  network_error: () => "Check the connection and run the command again.",
  busy: () => "The service is busy; try again in a minute.",
  unexpected_response: (v) =>
    `op8x got an answer it does not expect (status ${text(v.status)}, code ${text(v.code)}). Update op8x and run the command again; if it stays, please report it.`,
  internal_error: () => "op8x stopped because of an internal error. Please report this.",
  // The help of the command goes to stderr instead.
  usage_error: null,
  invalid_input: () => "The code must be 8 letters or digits. Ask your human for the code from the mail and pass it again.",
  code_missing: () => "Internal error: the code was not sent. Please report this.",
  no_pending_step: (v) =>
    v.command === undefined
      ? "There is no step waiting for a code. Run the command without --code-stdin."
      : `The waiting step belongs to op8x ${text(v.command)}. Run that same command with --code-stdin, or run this one without --code-stdin.`,
  env_file_not_ignored: () => "Use a file that git ignores (and not .dev.vars).",
  collector_url_not_allowed: () => "OP8X_COLLECTOR_URL may only point to 127.0.0.1, localhost or [::1].",
  collector_mismatch: () =>
    "The op8x file on this computer was made for a different service address. Unset OP8X_COLLECTOR_URL, or set it to the address the file was made for.",
};

/** The agent_hint of a state (null for usage_error); every value it names is cleaned. */
export function agentHint(state: FinalState | "waiting_for_human", vars: HintVars, mode: Mode): string | null {
  const hint = HINTS[state];
  return hint === null ? null : hint(vars, mode);
}

// --- notices ----------------------------------------------------------------------------------

export const NOTICES = {
  code_already_sent: "A code was already sent in the last 10 minutes. Check your mail for it.",
  contact_unknown: "This computer does not know the contact address of this account.",
  secret_put_deploys: "wrangler secret put deploys the worker right away.",
  test_host: "Sending one test request to {host}.",
  logout_removes_key: "This computer holds the server key. It is deleted with the op8x file; your workers keep their copy.",
} as const;

export type NoticeId = keyof typeof NOTICES;

// --- the writer -------------------------------------------------------------------------------

export type StepStatus = "ok" | "failed" | "skipped";

export interface Output {
  /** True once the guard replaced a line or the final line is written; nothing more is written. */
  readonly stopped: boolean;
  /** Starts the next step (n counts up from 1). */
  start: (name: string) => void;
  /** Ends the running step. */
  end: (status: "ok" | "failed") => void;
  /** A step that does not run this time (status skipped, elapsed_ms 0). */
  skip: (name: string) => void;
  /** Once after device/start: link and words for the human (state waiting_for_human). */
  link: (v: { link: string; words: string; expires_at: string }) => void;
  notice: (id: NoticeId, vars?: { host?: string }) => void;
  /**
   * The final line. `extra` holds the state's fields (workers, last_seen, retry_at, receipt,
   * attempts_left, status/code, ...); the hint takes its values from `extra` and `hint`.
   * Returns the exit code (2 if the guard replaced a line of this run).
   */
  final: (state: FinalState, o?: { extra?: Record<string, unknown>; hint?: HintVars }) => number;
  /** The final line of an API error, with the fields its state carries. */
  error: (e: ApiError, o?: { extra?: Record<string, unknown>; hint?: HintVars }) => number;
}

export interface OutputOptions {
  command: CommandName;
  json: boolean;
  deps: Pick<Deps, "out" | "now" | "env">;
  /** N of "Step n of N": the number of steps of this run, fixed before the first step. */
  steps: number;
  /** R, K, the next K, D: asked before every line, so a key made during the run counts at once. */
  secrets: () => Iterable<string | null | undefined>;
}

/** Shorter values are no secret of the CLI (keys are 50 characters) and would match almost any line. */
const MIN_SECRET = 8;

/** Every string in a JSON value (keys too) cleaned of control and format characters. */
function cleanDeep(v: unknown): unknown {
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k), cleanDeep(x)]));
  return v;
}

interface DoneStep {
  n: number;
  name: string;
  status: StepStatus;
  elapsed_ms: number;
}

const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number => typeof x === "number";

/** Hint values taken from the final line's fields; `hint` overrides them. */
function hintVars(state: FinalState, extra: Record<string, unknown>, hint: HintVars): HintVars {
  const derived: HintVars = {};
  if (isStr(extra.account)) derived.account = extra.account;
  if (extra.contact_hint === null || isStr(extra.contact_hint)) derived.contact_hint = extra.contact_hint;
  if (isStr(extra.retry_at)) derived.retry_at = extra.retry_at;
  if (isNum(extra.attempts_left)) derived.attempts_left = extra.attempts_left;
  if (isNum(extra.status)) derived.status = extra.status;
  if (extra.code === null || isStr(extra.code)) derived.code = extra.code;
  const receipt = extra.receipt;
  if (typeof receipt === "object" && receipt !== null && isStr((receipt as { action_id?: unknown }).action_id)) {
    derived.action_id = (receipt as { action_id: string }).action_id;
  }
  if (extra.last_seen === null || isStr(extra.last_seen)) derived.time = extra.last_seen;
  if (state === "rotation_pending" && isStr(extra.retry_at)) derived.time = extra.retry_at;
  return { ...derived, ...hint };
}

export function createOutput(o: OutputOptions): Output {
  const { command, json, deps } = o;
  const mode: Mode = json ? "json" : "text";
  let stopped = false;
  let finalExit: number | null = null;
  let n = 0;
  let running: { n: number; name: string; started: number } | null = null;
  const done: DoneStep[] = [];

  const internalHint = agentHint("internal_error", {}, mode);
  const internalLine = () =>
    json
      ? `${JSON.stringify({ schema: CLI_SCHEMA, command, final: true, state: "internal_error", exit_code: 2, agent_hint: internalHint })}\n`
      : `${internalHint}\n`;

  /** Writes one line through the guard; false if the guard replaced it (the output then stops with exit 2). */
  function write(line: string): boolean {
    if (stopped) return false;
    const secrets = [...o.secrets(), deps.env.OP8X_TEST_TOKEN];
    if (secrets.some((s) => typeof s === "string" && s.length >= MIN_SECRET && line.includes(s))) {
      stopped = true;
      finalExit = 2;
      deps.out(internalLine());
      return false;
    }
    deps.out(line);
    return true;
  }

  const event = (fields: Record<string, unknown>) => write(`${JSON.stringify({ schema: CLI_SCHEMA, command, final: false, ...fields })}\n`);

  function stepLine(step: number, name: string, status: StepStatus | "start", elapsed: number): void {
    if (json) {
      event({ event: "step", n: step, of: o.steps, name, status, ...(status === "start" ? {} : { elapsed_ms: elapsed }) });
      return;
    }
    const head = `Step ${step} of ${o.steps}: ${clean(name)}`;
    if (status === "start") write(`${head}\n`);
    else if (status === "skipped") write(`${head} skipped\n`);
    else write(`${head} ${status} (${elapsed} ms)\n`);
  }

  function final(state: FinalState, f: { extra?: Record<string, unknown>; hint?: HintVars } = {}): number {
    if (stopped) return finalExit ?? 2;
    const extra = cleanDeep(f.extra ?? {}) as Record<string, unknown>;
    const exit = EXIT_CODES[state];
    const hint = agentHint(state, hintVars(state, extra, f.hint ?? {}), mode);
    let lines: string;
    if (json) {
      lines = `${JSON.stringify({ schema: CLI_SCHEMA, command, final: true, state, exit_code: exit, ...(hint === null ? {} : { agent_hint: hint }), steps: done, ...extra })}\n`;
    } else {
      lines = "";
      const workers = Array.isArray(extra.workers) ? (extra.workers as Record<string, unknown>[]) : [];
      for (const w of workers) {
        const target = isStr(w.env_file) ? w.env_file : `${String(w.name ?? "")}${isStr(w.env) ? ` (env ${w.env})` : ""}`;
        lines += `Worker ${target}: ${String(w.status ?? "")}\n`;
      }
      if (hint !== null) lines += `${hint}\n`;
    }
    const ok = lines === "" || write(lines);
    stopped = true;
    finalExit = ok ? exit : 2;
    return finalExit;
  }

  return {
    get stopped() {
      return stopped;
    },
    start: (name) => {
      n += 1;
      running = { n, name, started: deps.now() };
      stepLine(n, name, "start", 0);
    },
    end: (status) => {
      if (running === null) return;
      const elapsed = Math.max(0, Math.round(deps.now() - running.started));
      done.push({ n: running.n, name: running.name, status, elapsed_ms: elapsed });
      stepLine(running.n, running.name, status, elapsed);
      running = null;
    },
    skip: (name) => {
      n += 1;
      done.push({ n, name, status: "skipped", elapsed_ms: 0 });
      stepLine(n, name, "skipped", 0);
    },
    link: (v) => {
      const words = clean(v.words);
      const hint = agentHint("waiting_for_human", { words }, mode);
      if (json) {
        event({ event: "link", state: "waiting_for_human", agent_hint: hint, link: clean(v.link), words, expires_at: clean(v.expires_at) });
        return;
      }
      // The human compares the words with their screen: printed escaped and quoted, so a look-alike
      // character (U+00A0, U+200B, ...) shows as an escape instead of passing for a plain one.
      const shown = agentHint("waiting_for_human", { words: printEscaped(v.words) }, mode);
      write(`${shown}\nLink: ${printEscaped(v.link)}\nThe link is valid until ${textTime(v.expires_at)}.\n`);
    },
    notice: (id, vars = {}) => {
      const host = vars.host === undefined ? "" : clean(vars.host);
      const message = NOTICES[id].replace("{host}", host);
      if (json) event({ event: "notice", id, text: message, ...(id === "test_host" ? { host } : {}) });
      else write(`${message}\n`);
    },
    final,
    error: (e, f = {}) => {
      const { state, ...fields } = e;
      return final(state, { ...f, extra: { ...fields, ...(f.extra ?? {}) } });
    },
  };
}
