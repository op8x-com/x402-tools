import type { Deps } from "../cli.ts";
import { send } from "../probe.ts";
import { VERSION } from "../version.ts";
import { isKey } from "./keys.ts";
import type { KeyKind } from "./keys.ts";

// The client of the collector's device and tenant routes. Every request goes through `send`
// (no redirect, 10 s timeout, op8x User-Agent, size-limited body). Every answer is checked
// against the contract of its route; an answer without a row of its own becomes
// unexpected_response, a network fault, a redirect or a 5xx other than 503 busy becomes
// network_error, and 503 busy is retried every 10 s for at most 2 minutes on every route (on the
// report route as long as its Retry-After header says, within the same 2 minutes).
// Requests go out one at a time (the collector has two shared slots).

/** The fixed collector. */
export const COLLECTOR_BASE = "https://analytics.op8x.com";
const LINK = /^https:\/\/analytics\.op8x\.com\/link\/[A-Za-z0-9_-]{32}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The base for all requests: the fixed collector, or OP8X_COLLECTOR_URL if it is exactly
 * `http://<127.0.0.1|localhost|[::1]>:<port>` (a trailing slash is fine). Null means the
 * override is not allowed (collector_url_not_allowed). An empty value counts as unset.
 */
export function collectorBase(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env.OP8X_COLLECTOR_URL;
  if (raw === undefined || raw === "") return COLLECTOR_BASE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const plain = url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.port === "" || !plain) return null;
  // No stray characters the URL parser would forgive (e.g. "#" or "?" without text).
  if (raw !== url.origin && raw !== `${url.origin}/`) return null;
  return url.origin;
}

/** True if the account file was made for another service address (collector_mismatch; send nothing). */
export function collectorMismatch(file: { collector: string } | null, base: string): boolean {
  return file !== null && file.collector !== base;
}

/** Exactly `https://analytics.op8x.com/link/` plus a 32-character base64url token. */
export function isCollectorLink(value: unknown): value is string {
  return typeof value === "string" && LINK.test(value);
}

const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * A step-up code as typed: trimmed, spaces and hyphens removed, upper case, I and L to 1, O to 0.
 * Null unless 8 Crockford base32 characters remain (no I, L, O, U); then nothing is sent.
 */
export function normalizeCode(input: string): string | null {
  const code = input
    .trim()
    .replace(/[ -]/g, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  return CODE.test(code) ? code : null;
}

// --- results ----------------------------------------------------------------------------------

/** A failed request as a state of the catalog, with the fields that state carries. */
export type ApiError =
  | { state: "network_error" }
  | { state: "busy" }
  | { state: "unexpected_response"; status: number; code: string | null }
  | { state: "internal_error" }
  | { state: "key_auth" }
  | { state: "key_conflict" }
  | { state: "rotation_pending"; retry_after_s: number; retry_at: string }
  | { state: "rate_limited"; retry_after_s: number; retry_at: string }
  | { state: "nothing_to_stop" }
  | { state: "code_invalid"; attempts_left: number }
  | { state: "code_expired" }
  | { state: "code_exhausted" }
  | { state: "code_missing" }
  /** 409 no_write_key of POST test-nonce; the command adds its hint ("run op8x rotate first"). */
  | { state: "server_key_missing" }
  /** GET /tenant/report answered a JSON object whose `schema` is not op8x.metrics/1. */
  | { state: "schema_unsupported" };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface DeviceStart {
  link: string;
  words: string;
  expires_at: string;
  interval_s: number;
}

export type DeviceToken =
  | { state: "pending" }
  | { state: "slow_down"; interval_s: number }
  | { state: "granted"; account: string; contact_hint: string; new_account: boolean; server_key: "accepted" | "ignored" }
  | { state: "denied" | "expired" | "no_account" | "terms_draft" };

export interface TenantKey {
  kind: "write" | "read";
  slot: "current" | "previous";
  fingerprint: string;
  valid_until: string | null;
}

export interface TenantView {
  tenant: string;
  created_at: string;
  last_event_day: string | null;
  daily_cap: number;
  authenticated_as: { kind: string; slot: string; fingerprint: string };
  keys: TenantKey[];
  write_key_prev_last_seen_at: string | null;
  write_key_current_since: string | null;
  server_time: string;
}

export interface Rotated {
  kind: "write";
  fingerprint: string;
  previous_fingerprint: string | null;
  previous_valid_until: string | null;
}

export interface Receipt {
  action_id: string;
  status: "done";
  tenant: string;
  ended_at: string;
}

export interface TestNonce {
  nonce: string;
  expires_at: string;
}

export interface NonceStatus {
  seen: boolean;
  seen_at: string | null;
}

export type StepUpPurpose = "rotate_now" | "replace_current" | "delete";

export interface StartInput {
  mode: "init" | "login";
  deviceHash: string;
  readHash: string;
  /** Required for init, never sent for login. */
  writeHash?: string;
  /** OP8X_TEST_TOKEN, only into this body. */
  testToken?: string;
}

export interface RotateInput {
  newHash: string;
  /** Both together (case c: replace the current key with a code), or neither. */
  replaceCurrent?: true;
  code?: string;
}

/** The schema of the report document; the only field of it the API client checks. */
export const METRICS_SCHEMA = "op8x.metrics/1";

/** A report as received: the body text exactly as sent, and the parsed object. */
export interface MetricsReport {
  text: string;
  doc: Record<string, unknown>;
}

export interface Api {
  deviceStart: (input: StartInput) => Promise<ApiResult<DeviceStart>>;
  deviceToken: (deviceKey: string) => Promise<ApiResult<DeviceToken>>;
  /** GET /tenant; the CLI sends R (the collector also takes the current or previous K). */
  tenant: (secret: string) => Promise<ApiResult<TenantView>>;
  rotate: (readToken: string, input: RotateInput) => Promise<ApiResult<Rotated>>;
  stepUp: (readToken: string, purpose: StepUpPurpose) => Promise<ApiResult<{ expires_at: string }>>;
  revokePrevious: (readToken: string, code: string) => Promise<ApiResult<{ stopped_fingerprint: string }>>;
  deleteAccount: (readToken: string, code: string) => Promise<ApiResult<Receipt>>;
  signOut: (readToken: string) => Promise<ApiResult<null>>;
  createTestNonce: (readToken: string) => Promise<ApiResult<TestNonce>>;
  testNonce: (readToken: string, nonce: string) => Promise<ApiResult<NonceStatus>>;
  /** GET /tenant/report?days=N with R; days is an integer 1..30. */
  report: (readToken: string, days: number) => Promise<ApiResult<MetricsReport>>;
}

// --- shape checks -----------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const isTime = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v));
const isTimeOrNull = (v: unknown) => v === null || isTime(v);
const isDay = (v: unknown) => v === null || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)));
const FINGERPRINT = /^[0-9a-f]{8}$/;
const isFingerprint = (v: unknown): v is string => typeof v === "string" && FINGERPRINT.test(v);
const ACCOUNT = /^(t-[a-z2-7]{10}|e2e-[a-z2-7]{8})$/;
const isAccount = (v: unknown): v is string => typeof v === "string" && ACCOUNT.test(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** A non-empty string of at most `max` code points. */
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && Array.from(v).length <= max;
const isInterval = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 30;
/** The collector's masked address: first character and `***`, or `*`, then `@domain`; no spaces. */
const CONTACT = /^(?:[^\s@]\*\*\*|\*)@[^\s@]{1,253}$/u;
const isContact = (v: unknown): v is string => typeof v === "string" && CONTACT.test(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function deviceStartShape(v: unknown): DeviceStart | null {
  if (!isObj(v)) return null;
  if (!isCollectorLink(v.link) || !isText(v.words, 64) || !isTime(v.expires_at) || !isInterval(v.interval_s)) return null;
  return { link: v.link, words: v.words, expires_at: v.expires_at, interval_s: v.interval_s };
}

function deviceTokenShape(v: unknown): DeviceToken | null {
  if (!isObj(v)) return null;
  switch (v.state) {
    case "pending":
    case "denied":
    case "expired":
    case "no_account":
    case "terms_draft":
      return { state: v.state };
    case "slow_down":
      return isInterval(v.interval_s) ? { state: "slow_down", interval_s: v.interval_s } : null;
    case "granted":
      if (!isAccount(v.account) || !isContact(v.contact_hint) || typeof v.new_account !== "boolean") return null;
      if (v.server_key !== "accepted" && v.server_key !== "ignored") return null;
      return { state: "granted", account: v.account, contact_hint: v.contact_hint, new_account: v.new_account, server_key: v.server_key };
    default:
      return null;
  }
}

function tenantShape(v: unknown): TenantView | null {
  if (!isObj(v)) return null;
  if (!isAccount(v.tenant) || !isTime(v.created_at) || !isDay(v.last_event_day) || !isCount(v.daily_cap)) return null;
  const who = v.authenticated_as;
  if (!isObj(who) || typeof who.kind !== "string" || typeof who.slot !== "string" || !isFingerprint(who.fingerprint)) return null;
  if (!Array.isArray(v.keys)) return null;
  const keys: TenantKey[] = [];
  for (const k of v.keys) {
    if (!isObj(k) || (k.kind !== "write" && k.kind !== "read") || (k.slot !== "current" && k.slot !== "previous")) return null;
    if (!isFingerprint(k.fingerprint) || !isTimeOrNull(k.valid_until)) return null;
    keys.push({ kind: k.kind, slot: k.slot, fingerprint: k.fingerprint, valid_until: k.valid_until as string | null });
  }
  if (!isTimeOrNull(v.write_key_prev_last_seen_at) || !isTimeOrNull(v.write_key_current_since) || !isTime(v.server_time)) return null;
  return {
    tenant: v.tenant,
    created_at: v.created_at,
    last_event_day: v.last_event_day as string | null,
    daily_cap: v.daily_cap,
    authenticated_as: { kind: who.kind, slot: who.slot, fingerprint: who.fingerprint },
    keys,
    write_key_prev_last_seen_at: v.write_key_prev_last_seen_at as string | null,
    write_key_current_since: v.write_key_current_since as string | null,
    server_time: v.server_time,
  };
}

function rotatedShape(v: unknown): Rotated | null {
  if (!isObj(v) || v.kind !== "write" || !isFingerprint(v.fingerprint)) return null;
  if (!(v.previous_fingerprint === null || isFingerprint(v.previous_fingerprint)) || !isTimeOrNull(v.previous_valid_until)) return null;
  return {
    kind: "write",
    fingerprint: v.fingerprint,
    previous_fingerprint: v.previous_fingerprint as string | null,
    previous_valid_until: v.previous_valid_until as string | null,
  };
}

const expiresShape = (v: unknown) => (isObj(v) && isTime(v.expires_at) ? { expires_at: v.expires_at } : null);
const stoppedShape = (v: unknown) => (isObj(v) && isFingerprint(v.stopped_fingerprint) ? { stopped_fingerprint: v.stopped_fingerprint } : null);

function receiptShape(v: unknown): Receipt | null {
  if (!isObj(v) || typeof v.action_id !== "string" || !UUID.test(v.action_id) || v.status !== "done") return null;
  if (!isAccount(v.tenant) || !isTime(v.ended_at)) return null;
  return { action_id: v.action_id, status: "done", tenant: v.tenant, ended_at: v.ended_at };
}

const NONCE = /^[A-Za-z0-9_-]{43}$/;

function nonceShape(v: unknown): TestNonce | null {
  if (!isObj(v) || typeof v.nonce !== "string" || !NONCE.test(v.nonce) || !isTime(v.expires_at)) return null;
  return { nonce: v.nonce, expires_at: v.expires_at };
}

function nonceStatusShape(v: unknown): NonceStatus | null {
  if (!isObj(v)) return null;
  if (v.seen === true && isTime(v.seen_at)) return { seen: true, seen_at: v.seen_at };
  if (v.seen === false && v.seen_at === null) return { seen: false, seen_at: null };
  return null;
}

// --- the request pipeline ---------------------------------------------------------------------

const TIMEOUT_MS = 10_000;
const BUSY_STEP_MS = 10_000;
const BUSY_MAX_MS = 120_000;
/** The longest retry_after_s taken from the collector: one day (a rotation's overlap). */
const MAX_RETRY_AFTER_S = 86_400;
/** A problem code is passed on only in this form; anything else is reported as null. */
const PROBLEM_CODE = /^[a-z0-9_]{1,64}$/;

/** The shortest and longest wait the CLI takes from a Retry-After header, in seconds. */
const RETRY_AFTER_MIN_S = 1;
const RETRY_AFTER_MAX_S = 60;

/**
 * The wait of a Retry-After header in ms: whole seconds only (an HTTP date or anything else is
 * ignored), clamped to 1..60 s; null when absent or not of that form.
 */
export function retryAfterMs(header: string | undefined): number | null {
  if (header === undefined || !/^\d{1,20}$/.test(header.trim())) return null;
  const s = Number(header.trim());
  return Math.min(RETRY_AFTER_MAX_S, Math.max(RETRY_AFTER_MIN_S, s)) * 1000;
}

interface Answer {
  status: number;
  /** The body text exactly as received. */
  text: string;
  /** The parsed body, or undefined if it is not JSON. */
  body: unknown;
  /** The problem+json `code`, if the body has one in the expected form. */
  code: string | null;
}

type Raw = { ok: true; answer: Answer } | { ok: false; error: ApiError };

/** What a route accepts besides its success answer: a problem code and status mapped to a state. */
type ErrorMap = (a: Answer, problem: Obj) => ApiError | null;

const fail = (error: ApiError) => ({ ok: false as const, error });
const unexpected = (a: { status: number; code: string | null }): ApiError => ({ state: "unexpected_response", status: a.status, code: a.code });

export function createApi(deps: Pick<Deps, "now" | "sleep" | "fetchImpl">, base: string): Api {
  /** ISO 8601 UTC without milliseconds, `seconds` from now, rounded up to the second. */
  const retryAt = (seconds: number) => new Date(Math.ceil((deps.now() + seconds * 1000) / 1000) * 1000).toISOString().replace(".000Z", "Z");

  /** One request; a 503 busy comes back as `busy` with the Retry-After wait (null without one). */
  async function once(method: "GET" | "POST", path: string, secret: string | null, body: unknown): Promise<Raw | { busy: number | null }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") headers["content-type"] = "application/json";
    if (secret !== null) headers.authorization = `Bearer ${secret}`;
    const sent = await send(
      `${base}${path}`,
      { method, headers, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined },
      { timeoutMs: TIMEOUT_MS, version: VERSION, fetchImpl: deps.fetchImpl },
    );
    if (sent.status === undefined || sent.error !== undefined) return fail({ state: "network_error" });
    const status = sent.status;
    if (sent.bodyError !== undefined) {
      // Over the size limit: an answer the CLI does not expect; any other read failure is the network.
      return sent.bodyError.startsWith("http response body too large") ? fail(unexpected({ status, code: null })) : fail({ state: "network_error" });
    }
    // A redirect is never followed (Authorization would go along).
    if (status >= 300 && status < 400) return fail({ state: "network_error" });
    let parsed: unknown;
    try {
      parsed = sent.bodyText === "" ? undefined : JSON.parse(sent.bodyText);
    } catch {
      parsed = undefined;
    }
    const code = isObj(parsed) && typeof parsed.code === "string" && PROBLEM_CODE.test(parsed.code) ? parsed.code : null;
    if (status === 503 && code === "busy") return { busy: retryAfterMs(sent.headers["retry-after"]) };
    if (status >= 500) return fail({ state: "network_error" });
    return { ok: true, answer: { status, text: sent.bodyText, body: parsed, code } };
  }

  /**
   * One request with the busy rule: every 10 s again, at most 2 minutes, then busy. With
   * `retryAfter` (the report route only) the wait is the answer's Retry-After (1..60 s), else 10 s;
   * the 2 minutes stay the limit.
   */
  async function request(method: "GET" | "POST", path: string, secret: string | null, body: unknown, retryAfter: boolean): Promise<Raw> {
    const started = deps.now();
    let waited = 0;
    for (;;) {
      const r = await once(method, path, secret, body);
      if (!("busy" in r)) return r;
      const step = retryAfter && r.busy !== null ? r.busy : BUSY_STEP_MS;
      if (waited + step > BUSY_MAX_MS || deps.now() - started + step > BUSY_MAX_MS) return fail({ state: "busy" });
      await deps.sleep(step);
      waited += step;
    }
  }

  async function call<T>(
    route: { method: "GET" | "POST"; path: string; secret: string | null; kind: KeyKind | KeyKind[] | null; body?: unknown; retryAfter?: boolean },
    success: number,
    shape: (v: unknown, text: string) => T | null,
    errors: ErrorMap,
  ): Promise<ApiResult<T>> {
    // A secret of the wrong kind or form never leaves (it would also break the header).
    if (route.kind !== null) {
      const kinds = Array.isArray(route.kind) ? route.kind : [route.kind];
      if (!kinds.some((k) => isKey(route.secret, k))) return fail({ state: "internal_error" });
    }
    const raw = await request(route.method, route.path, route.secret, route.body, route.retryAfter === true);
    if (!raw.ok) return raw;
    const a = raw.answer;
    if (a.status === success) {
      if (success === 204) return { ok: true, value: null as T };
      const value = shape(a.body, a.text);
      return value === null ? fail(unexpected({ status: a.status, code: null })) : { ok: true, value };
    }
    if (isObj(a.body) && a.code !== null) {
      const mapped = errors(a, a.body);
      if (mapped !== null) return fail(mapped);
    }
    return fail(unexpected(a));
  }

  const keyAuth: ErrorMap = (a) => (a.status === 401 && a.code === "key_auth" ? { state: "key_auth" } : null);
  /** More than a day is no wait the CLI expects (and would make an absurd date): unexpected_response. */
  const withRetry = (state: "rotation_pending" | "rate_limited", p: Obj): ApiError | null =>
    isCount(p.retry_after_s) && p.retry_after_s <= MAX_RETRY_AFTER_S ? { state, retry_after_s: p.retry_after_s, retry_at: retryAt(p.retry_after_s) } : null;
  /** The answers of a route that takes a step-up code. */
  const codeErrors: ErrorMap = (a, p) => {
    if (a.status === 422 && a.code === "code_invalid" && isCount(p.attempts_left) && p.attempts_left <= 5) return { state: "code_invalid", attempts_left: p.attempts_left };
    if (a.status === 422 && a.code === "code_expired") return { state: "code_expired" };
    if (a.status === 422 && a.code === "attempts_exhausted") return { state: "code_exhausted" };
    const fields = p.fields;
    if (a.status === 400 && a.code === "invalid_field" && Array.isArray(fields) && fields.length === 1 && fields[0] === "code") return { state: "code_missing" };
    return null;
  };
  const either =
    (...maps: ErrorMap[]): ErrorMap =>
    (a, p) => {
      for (const m of maps) {
        const r = m(a, p);
        if (r !== null) return r;
      }
      return null;
    };
  const conflict: ErrorMap = (a) => (a.status === 409 && a.code === "key_conflict" ? { state: "key_conflict" } : null);
  const noPrevious: ErrorMap = (a) => (a.status === 409 && a.code === "no_previous" ? { state: "nothing_to_stop" } : null);
  const rateLimited: ErrorMap = (a, p) => (a.status === 429 && a.code === "rate_limited" ? withRetry("rate_limited", p) : null);

  const tenantPath = "/api/v1/tenant";

  return {
    deviceStart: (input) => {
      const body: Obj = {
        mode: input.mode,
        client: { name: "@op8x/cli", version: VERSION },
        device_sha256: input.deviceHash,
        read_sha256: input.readHash,
      };
      if (input.writeHash !== undefined) body.write_sha256 = input.writeHash;
      if (input.testToken !== undefined) body.test_token = input.testToken;
      return call({ method: "POST", path: "/api/v1/device/start", secret: null, kind: null, body }, 201, deviceStartShape, conflict);
    },
    // The collector reads only the device key; the body is `{}` anyway.
    deviceToken: (d) => call({ method: "POST", path: "/api/v1/device/token", secret: d, kind: "d", body: {} }, 200, deviceTokenShape, keyAuth),
    tenant: (secret) => call({ method: "GET", path: tenantPath, secret, kind: ["r", "w"] }, 200, tenantShape, keyAuth),
    rotate: (r, input) => {
      const body: Obj = { kind: "write", new_sha256: input.newHash };
      if (input.replaceCurrent === true) {
        body.replace_current = true;
        body.code = input.code;
      }
      return call(
        { method: "POST", path: `${tenantPath}/rotate`, secret: r, kind: "r", body },
        200,
        rotatedShape,
        either(keyAuth, conflict, noPrevious, codeErrors, (a, p) => (a.status === 409 && a.code === "rotation_pending" ? withRetry("rotation_pending", p) : null)),
      );
    },
    stepUp: (r, purpose) =>
      call({ method: "POST", path: `${tenantPath}/step-up`, secret: r, kind: "r", body: { purpose } }, 202, expiresShape, either(keyAuth, rateLimited)),
    revokePrevious: (r, code) =>
      call({ method: "POST", path: `${tenantPath}/revoke-previous`, secret: r, kind: "r", body: { code } }, 200, stoppedShape, either(keyAuth, noPrevious, codeErrors)),
    deleteAccount: (r, code) =>
      call({ method: "POST", path: `${tenantPath}/delete`, secret: r, kind: "r", body: { code } }, 202, receiptShape, either(keyAuth, codeErrors)),
    signOut: (r) => call({ method: "POST", path: `${tenantPath}/sign-out`, secret: r, kind: "r", body: {} }, 204, () => null, keyAuth),
    createTestNonce: (r) =>
      call(
        { method: "POST", path: `${tenantPath}/test-nonce`, secret: r, kind: "r", body: {} },
        201,
        nonceShape,
        either(keyAuth, rateLimited, (a) => (a.status === 409 && a.code === "no_write_key" ? { state: "server_key_missing" } : null)),
      ),
    testNonce: async (r, nonce) => {
      // The segment goes out raw; only the collector's own nonce form is ever sent.
      if (!NONCE.test(nonce)) return fail({ state: "internal_error" });
      return call({ method: "GET", path: `${tenantPath}/test-nonce/${nonce}`, secret: r, kind: "r" }, 200, nonceStatusShape, keyAuth);
    },
    report: async (r, days) => {
      if (!Number.isInteger(days) || days < 1 || days > 30) return fail({ state: "internal_error" });
      // Any JSON object passes here; its schema decides below (only the schema is checked).
      const res = await call(
        { method: "GET", path: `${tenantPath}/report?days=${days}`, secret: r, kind: "r", retryAfter: true },
        200,
        (v, text): MetricsReport | null => (isObj(v) ? { text, doc: v } : null),
        keyAuth,
      );
      if (res.ok && res.value.doc.schema !== METRICS_SCHEMA) return fail({ state: "schema_unsupported" });
      return res;
    },
  };
}
