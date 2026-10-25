/**
 * Module-scoped warning state, shared by every analytics() instance and transport of this
 * isolate. A seller who builds analytics() per request must not flood the log.
 */
const warnedKeys = new Set<string>();
const lastWarnAt = new Map<string, number>();

/** True the first time `key` is seen in this isolate, false afterwards. */
export function firstTime(key: string): boolean {
  if (warnedKeys.has(key)) return false;
  warnedKeys.add(key);
  return true;
}

/** True when `message` was not warned within `intervalMs` before `now`; records `now` then. */
export function rateLimitOk(message: string, now: number, intervalMs: number): boolean {
  const last = lastWarnAt.get(message);
  if (last !== undefined && now - last < intervalMs) return false;
  lastWarnAt.set(message, now);
  return true;
}

/** Test-only (not exported from index.ts): forget all warning state. */
export function resetWarnings(): void {
  warnedKeys.clear();
  lastWarnAt.clear();
}
