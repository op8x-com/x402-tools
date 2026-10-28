import type { AnalyticsOptions, AnalyticsRecord } from "./types.ts";
import { VERSION } from "./version.ts";
import { isOp8xEndpoint, KEY_MISSING_TRANSPORT, resolveKey } from "./key.ts";
import { rateLimitOk } from "./warnings.ts";

export interface Transport {
  /**
   * Never rejects. `key` (else `options.key`) is sent as `Authorization: Bearer <key>`;
   * the op8x collector endpoint sends nothing without a valid key.
   */
  send(record: AnalyticsRecord, key?: string): Promise<void>;
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

export function validEndpoint(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.username !== "" || url.password !== "") return undefined;
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
  let optionKey: unknown;
  let op8x = false;
  const wantLog = options?.log === true;

  try {
    if (options?.endpoint !== undefined) {
      endpoint = validEndpoint(options.endpoint);
      invalid = endpoint === undefined;
    }
    timeoutMs = clampTimeout(options?.timeoutMs);
    op8x = isOp8xEndpoint(endpoint);
    optionKey = options?.key;
  } catch {
    invalid = options?.endpoint !== undefined;
    endpoint = undefined;
  }

  let invalidWarned = false;

  function warn(message: string): void {
    try {
      const now = (deps.now ?? Date.now)();
      if (!rateLimitOk(message, now, WARN_INTERVAL_MS)) return;
      (deps.warn ?? console.warn)(message);
    } catch {
      // never let diagnostics break the seller
    }
  }

  async function send(record: AnalyticsRecord, key?: string): Promise<void> {
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
      const resolved = resolveKey(key !== undefined ? key : optionKey, op8x, () => undefined, KEY_MISSING_TRANSPORT);
      if (!resolved.ok) {
        warn(resolved.warning);
        return;
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": `op8x-analytics/${VERSION}`,
      };
      if (resolved.key !== undefined) headers["authorization"] = `Bearer ${resolved.key}`;
      const body = JSON.stringify(record);
      let reason: string | undefined;
      try {
        const res = await (deps.fetch ?? fetch)(endpoint, {
          method: "POST",
          headers,
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
