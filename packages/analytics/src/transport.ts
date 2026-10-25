import type { AnalyticsOptions, AnalyticsRecord } from "./types.ts";
import { VERSION } from "./version.ts";

export interface Transport {
  /** Never rejects. */
  send(record: AnalyticsRecord): Promise<void>;
}

export interface TransportDeps {
  fetch?: typeof fetch;
  log?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10000;
const WARN_INTERVAL_MS = 60_000;

export function clampTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, value));
}

function validEndpoint(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.protocol === "https:") return url.href;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return url.href;
  } catch {
    // fall through: invalid
  }
  return undefined;
}

export function createTransport(options: AnalyticsOptions, deps: TransportDeps = {}): Transport {
  let endpoint: string | undefined;
  let invalid = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let lastWarn = Number.NEGATIVE_INFINITY;
  const wantLog = options?.log === true;

  try {
    if (options?.endpoint !== undefined) {
      endpoint = validEndpoint(options.endpoint);
      invalid = endpoint === undefined;
    }
    timeoutMs = clampTimeout(options?.timeoutMs);
  } catch {
    invalid = options?.endpoint !== undefined;
    endpoint = undefined;
  }

  let invalidWarned = false;

  function warn(message: string): void {
    try {
      const now = (deps.now ?? Date.now)();
      if (now - lastWarn < WARN_INTERVAL_MS) return;
      lastWarn = now;
      (deps.warn ?? console.warn)(message);
    } catch {
      // never let diagnostics break the seller
    }
  }

  async function send(record: AnalyticsRecord): Promise<void> {
    try {
      if (wantLog) {
        try {
          (deps.log ?? console.log)("op8x.analytics", JSON.stringify(record));
        } catch {
          // ignore
        }
      }
      if (invalid) {
        if (!invalidWarned) {
          invalidWarned = true;
          warn("op8x.analytics: invalid endpoint, sending disabled");
        }
        return;
      }
      if (endpoint === undefined) return;
      const body = JSON.stringify(record);
      let reason: string | undefined;
      try {
        const res = await (deps.fetch ?? fetch)(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": `op8x-analytics/${VERSION}` },
          body,
          // Never follow: a redirect would bypass the endpoint rule, and a loop would repeat the POST.
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        try {
          await res.body?.cancel();
        } catch {
          // ignore
        }
        if (res.status < 200 || res.status > 299) reason = `status ${res.status}`;
      } catch (err) {
        reason = (err as { name?: unknown } | null)?.name === "TimeoutError" ? "timeout" : "network";
      }
      if (reason !== undefined) warn(`op8x.analytics: send failed (${reason})`);
    } catch {
      // fail open: nothing may escape
    }
  }

  return { send };
}
