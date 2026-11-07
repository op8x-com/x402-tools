import type { Deps } from "../cli.ts";
import { normalizeCode } from "./api.ts";
import type { Api, ApiResult, StepUpPurpose } from "./api.ts";
import type { FinalState, HintVars, Output } from "./output.ts";
import type { ActiveAccount, PendingStepUp } from "./store.ts";

// Step-up codes: starting a step-up, reading the code from the
// mail, and the checks of a waiting step before it is redeemed. Shared by rotate --now and delete.
// A code never stands in argv or in the output; commands put every code they read into `codes`,
// which their output guard checks for the rest of the run.

/** The prompt of the hidden code input (stderr, no echo). */
export const CODE_PROMPT = "Code from the mail: ";

/**
 * The code: from stdin (--code-stdin) or typed without echo on the TTY. Normalized locally (trim,
 * spaces and hyphens removed, upper case, I/L → 1, O → 0); null unless 8 Crockford base32
 * characters remain (invalid_input, nothing is sent). What was read goes into `codes` first.
 */
export async function readCode(deps: Pick<Deps, "readStdin" | "readHidden">, source: "stdin" | "tty", codes: string[]): Promise<string | null> {
  let raw: string;
  try {
    raw = source === "stdin" ? await deps.readStdin() : await deps.readHidden(CODE_PROMPT);
  } catch {
    return null;
  }
  const typed = raw.trim();
  codes.push(typed);
  const code = normalizeCode(raw);
  if (code !== null) codes.push(code);
  return code;
}

export type PendingMatch =
  | { ok: true; pending: PendingStepUp }
  /** no_pending_step keeps the waiting step; code_expired is an end state (the caller clears it). */
  | { ok: false; state: "no_pending_step" | "code_expired"; hint?: HintVars };

/**
 * Does this run with --code-stdin fit the waiting step? No step → no_pending_step; another command,
 * or (rotate) another --force-stop → no_pending_step naming the step's command (the step stays);
 * expired (local clock at or after expires_at) → code_expired. The command is checked before the
 * expiry, so a run of another command never ends somebody else's step.
 */
export function matchPending(
  file: ActiveAccount,
  run: { command: "rotate" | "delete"; forceStop: boolean },
  now: number,
): PendingMatch {
  const p = file.pending_step_up;
  if (p === null) return { ok: false, state: "no_pending_step" };
  if (p.command !== run.command || (p.command === "rotate" && p.force_stop !== run.forceStop)) {
    const command = p.command === "delete" ? "delete" : p.force_stop ? "rotate --now --force-stop" : "rotate --now";
    return { ok: false, state: "no_pending_step", hint: { command } };
  }
  if (now >= Date.parse(p.expires_at)) return { ok: false, state: "code_expired" };
  return { ok: true, pending: p };
}

/**
 * POST step-up {purpose}. When the collector answers with the expires_at already stored for the
 * same purpose (its 10-minute repeat, no new mail), the notice code_already_sent comes first.
 */
export async function startStepUp(
  api: Api,
  out: Output,
  readToken: string,
  purpose: StepUpPurpose,
  stored: PendingStepUp | null,
): Promise<ApiResult<{ expires_at: string }>> {
  const r = await api.stepUp(readToken, purpose);
  if (r.ok && stored !== null && stored.purpose === purpose && stored.expires_at === r.value.expires_at) out.notice("code_already_sent");
  return r;
}

/** End states that clear the waiting step; every other state keeps it. */
const CLEARS: ReadonlySet<FinalState> = new Set<FinalState>([
  "old_key_stopped",
  "key_rotated",
  "deleted",
  "deleted_partial",
  "code_exhausted",
  "code_expired",
  "nothing_to_stop",
  "old_key_still_used",
  "partial",
]);

/** True if `state` ends the waiting step (it is removed from the op8x file). */
export function clearsPending(state: FinalState): boolean {
  return CLEARS.has(state);
}
