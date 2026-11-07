import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TEST_NOW } from "./account-deps.ts";

// A fake op8x collector for the account commands: a real HTTP server on 127.0.0.1 that answers
// like the collector's /api/v1 device and tenant routes (the contract of the
// real collector). Not a test file itself, like server.ts.
//
// Clock: the fake has its own virtual clock (`now()`, start TEST_NOW), moved only by `advance(ms)`
// or `setNow(ms)`. Tests usually wire `deps.now = fake.now` and `deps.sleep = async (ms) => fake.advance(ms)`.
//
// State: device flows (`flows`), accounts (`tenants`, with read token, current and previous
// server key, step-up codes and test nonces). Tests drive the human side with `grant`, `deny`,
// `extendFlow`, read mailed codes with `lastCode`, simulate worker traffic with `ingest`, and
// switch catch-all answers with `respond`. Every request is recorded in `requests`; every
// break of the request contract (wrong body, missing content-type, ...) lands in `violations`.

export type RouteName =
  | "device_start"
  | "device_token"
  | "tenant"
  | "rotate"
  | "step_up"
  | "revoke_previous"
  | "delete"
  | "sign_out"
  | "test_nonce"
  | "test_nonce_status"
  | "report";

export type Purpose = "rotate_now" | "replace_current" | "delete";

/** Canned answers for the catch-all rule; a custom answer gives status, headers and raw body. */
export type Canned =
  | "busy" // 503 busy
  | "not_found" // 404 not_found (problem+json), as a collector without the routes
  | "not_found_empty" // 404 with an empty body, as the collector for a wrong host
  | "flow_moved" // 410 flow_moved {use}
  | "wrong_secret_kind" // 403 wrong_secret_kind {required}
  | "method_not_allowed" // 405 method_not_allowed
  | "action_open" // 409 action_open
  | "action_closed" // 409 action_closed
  | "too_large" // 413 invalid_field
  | "invalid_field" // 400 invalid_field {fields:["body"]}
  | "bad_path" // 400 bad_path
  | "not_json" // the route's success status with an HTML body
  | "wrong_shape" // the route's success status with {"unexpected":true}
  | "mail_unavailable" // 503 mail_unavailable
  | "server_error" // 500 internal
  | "redirect" // 302 to another host
  | "huge" // 200 with a body over 1 MiB
  | "drop" // the connection is closed without an answer
  | { status: number; headers?: Record<string, string>; body?: string };

export interface RecordedRequest {
  method: string;
  /** The raw request target, query included. */
  path: string;
  route: RouteName | null;
  /** Lowercase header names. */
  headers: Record<string, string>;
  /** The raw body text ("" without a body). */
  body: string;
}

export interface FakeFlow {
  mode: "init" | "login";
  client: { name: string; version: string };
  deviceHash: string;
  readHash: string;
  writeHash: string | null;
  testToken: string | undefined;
  token: string;
  link: string;
  words: string;
  expiresAt: number;
  intervalS: number;
  lastPollAt: number | null;
  polls: number;
  state: "pending" | "granted" | "denied" | "collected";
  outcome: "no_account" | "terms_draft" | null;
  grant: { tenant: string; newAccount: boolean; serverKey: "accepted" | "ignored" } | null;
}

export interface FakeCode {
  code: string;
  readHash: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  used: boolean;
}

export interface FakeNonce {
  writeHash: string;
  createdAt: number;
  expiresAt: number;
  seenAt: number | null;
}

export interface FakeTenant {
  name: string;
  contactHint: string;
  createdAt: number;
  lastEventDay: string | null;
  dailyCap: number;
  /** SHA-256 hex of the read token R, or null after sign-out. */
  read: string | null;
  /** SHA-256 hex of the current server key K. */
  write: string | null;
  writeSince: number | null;
  /** The previous server key during an overlap. */
  prev: string | null;
  prevUntil: number | null;
  prevLastSeenAt: number | null;
  /** After a rotation without overlap, no second rotation until then. */
  holdUntil: number | null;
  codes: Map<Purpose, FakeCode>;
  /** Step-up codes started per R, scope and UTC day: key `${readHash}|${scope}|${day}`. */
  stepUpCounts: Map<string, number>;
  nonces: Map<string, FakeNonce>;
  deleted: boolean;
}

export interface GrantOptions {
  /** An existing account: the flow's R replaces its read token, server_key "ignored". */
  tenant?: string;
  contactHint?: string;
  /** The name of a new account (default: a random realistic name). */
  name?: string;
}

export interface AddTenantOptions {
  name?: string;
  contactHint?: string;
  readKey?: string;
  writeKey?: string | null;
  previousKey?: string | null;
  /** End of the overlap of previousKey (default now + 24 h). */
  previousUntil?: number;
  previousLastSeenAt?: number | null;
}

export interface FakeCollector {
  /** Base URL, `http://127.0.0.1:<port>`; set it as OP8X_COLLECTOR_URL. */
  url: string;
  close: () => Promise<void>;
  requests: RecordedRequest[];
  /** Requests that break the contract (body, content type, auth form); tests assert it stays empty. */
  violations: string[];
  now: () => number;
  advance: (ms: number) => void;
  setNow: (ms: number) => void;
  /** Answer the next `times` requests of `route` ("*" = any route) with `answer` instead of the contract. */
  respond: (route: RouteName | "*", answer: Canned, times?: number) => void;
  /** Called with every request before it is answered (after recording); may change state. */
  onRequest: ((req: RecordedRequest) => void) | null;
  /** The next delete requests answered 503 busy without spending the code (a "stale" account). */
  staleDeletes: number;
  flows: FakeFlow[];
  lastFlow: () => FakeFlow | undefined;
  /** The human clicks Allow on the newest flow. Login without `tenant` ends as no_account. */
  grant: (opts?: GrantOptions) => FakeFlow;
  /** The human or the server denies the newest flow (outcome no_account / terms_draft, or plain denied). */
  deny: (outcome?: "no_account" | "terms_draft" | null) => FakeFlow;
  /** The code mail of the newest flow went out: its expiry moves to now + 15 min. */
  extendFlow: () => FakeFlow;
  tenants: Map<string, FakeTenant>;
  tenant: (name: string) => FakeTenant;
  /** An existing account with the given keys (keys are hashed; never stored in plain). */
  addTenant: (opts?: AddTenantOptions) => FakeTenant;
  /** The code of the last step-up mail of an account and purpose. */
  lastCode: (tenant: string, purpose: Purpose) => string;
  /** Mails with codes, in order (only real mails, not the 10-minute repeats). */
  mails: { tenant: string; purpose: Purpose; code: string }[];
  /** The next codes handed out (FIFO), instead of random ones. */
  nextCodes: string[];
  /**
   * An event from a worker with `writeKey`: counts last_seen of a previous key (at most once a
   * minute, as the collector) and, with `nonce`, marks that nonce seen if it was made for this key.
   * Returns false if the key is not current or previous of any account.
   */
  ingest: (writeKey: string, nonce?: string) => boolean;
  /**
   * The raw body of a successful GET /tenant/report (sent as is with status 200); null: a small
   * op8x.metrics/1 document for the asked days.
   */
  reportBody: string | null;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
const API = "/api/v1";
const LINK_BASE = "https://analytics.op8x.com/link/";
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const WORDS = ["amber", "tiger", "maple", "river", "stone", "cloud", "otter", "lemon", "cedar", "comet"];
const MAX_BODY = 16_384;

const hash = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const utcDay = (ms: number) => iso(ms).slice(0, 10);

// --- strict body parser, as the collector's enroll.ts `parse` -------------------------------

type Spec =
  | { t: "string"; min: number; max: number; check?: (s: string) => boolean }
  | { t: "bool" }
  | { t: "object"; fields: Record<string, Spec>; optional?: readonly string[] };

const FORBIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const HEX64 = /^[0-9a-f]{64}$/;
const str = (min: number, max: number, check?: (s: string) => boolean): Spec => ({ t: "string", min, max, ...(check ? { check } : {}) });
const HASH: Spec = str(64, 64, (s) => HEX64.test(s) && s !== "0".repeat(64));
const CODE: Spec = str(1, 64);
const EMPTY: Spec = { t: "object", fields: {} };

const SPECS = {
  start: {
    t: "object",
    fields: {
      mode: str(1, 8, (s) => s === "init" || s === "login"),
      client: { t: "object", fields: { name: str(1, 64), version: str(1, 64) } },
      device_sha256: HASH,
      read_sha256: HASH,
      write_sha256: HASH,
      test_token: str(0, 256),
    },
    optional: ["write_sha256", "test_token"],
  },
  rotate: {
    t: "object",
    fields: { kind: str(1, 16, (s) => s === "write"), new_sha256: HASH, replace_current: { t: "bool" }, code: CODE },
    optional: ["replace_current", "code"],
  },
  stepUp: { t: "object", fields: { purpose: str(1, 32, (s) => s === "rotate_now" || s === "replace_current" || s === "delete") } },
  code: { t: "object", fields: { code: CODE } },
} satisfies Record<string, Spec>;

function check(value: unknown, spec: Spec, path: string, bad: string[]): void {
  switch (spec.t) {
    case "string": {
      if (typeof value !== "string") return void bad.push(path);
      const s = value.normalize("NFC");
      const n = [...s].length;
      if (n < spec.min || n > spec.max || FORBIDDEN.test(s) || s.includes("\n") || (spec.check && !spec.check(s))) bad.push(path);
      return;
    }
    case "bool":
      if (typeof value !== "boolean") bad.push(path);
      return;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return void bad.push(path);
      const obj = value as Record<string, unknown>;
      // An unknown key is reported by its parent's path, so a key never echoes.
      if (Object.keys(obj).some((k) => !Object.hasOwn(spec.fields, k))) bad.push(path);
      for (const [key, sub] of Object.entries(spec.fields)) {
        const child = path === "body" ? key : `${path}.${key}`;
        if (!Object.hasOwn(obj, key)) {
          if (!spec.optional?.includes(key)) bad.push(child);
          continue;
        }
        check(obj[key], sub, child, bad);
      }
    }
  }
}

type Parsed = { ok: true; value: Record<string, unknown> } | { ok: false; fields: string[] };

function parse(text: string, spec: Spec): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, fields: ["body"] };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, fields: ["body"] };
  if (/"(__proto__|constructor)"\s*:/.test(text)) return { ok: false, fields: ["body"] };
  const bad: string[] = [];
  check(json, spec, "body", bad);
  return bad.length > 0 ? { ok: false, fields: [...new Set(bad)] } : { ok: true, value: json as Record<string, unknown> };
}

/** The collector's normalizeCode (secrets.ts): edges, label, upper case, I/L -> 1, O -> 0, spaces and dashes out. */
function normalizeCode(input: string): string | null {
  const edges = /^[\s.,;:]+|[\s.,;:]+$/g;
  const code = input
    .replace(edges, "")
    .replace(/^(?:your\s+)?code\s*:/i, "")
    .replace(edges, "")
    .toUpperCase()
    .replace(/[ -]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/.test(code) ? code : null;
}

// --- answers ----------------------------------------------------------------------------------

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  drop?: boolean;
}

const ok = (status: number, body: unknown): Answer => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

function problem(status: number, code: string, extra: Record<string, unknown> = {}): Answer {
  return {
    status,
    headers: { "content-type": "application/problem+json" },
    body: JSON.stringify({ type: `https://op8x.com/errors/${code}`, title: code.replace(/_/g, " "), status, code, ...extra }),
  };
}

const keyAuth = () => problem(401, "key_auth");
const invalid = (fields: string[]) => problem(400, "invalid_field", { fields });

const SUCCESS_STATUS: Record<RouteName, number> = {
  device_start: 201,
  device_token: 200,
  tenant: 200,
  rotate: 200,
  step_up: 202,
  revoke_previous: 200,
  delete: 202,
  sign_out: 204,
  test_nonce: 201,
  test_nonce_status: 200,
  report: 200,
};

/**
 * 503 busy of the report route, with the Retry-After header (null: without it). The body has no
 * retry_after_s; only the header says how long to wait.
 */
export function busyAnswer(retryAfter: string | null): Canned {
  const headers: Record<string, string> = { "content-type": "application/problem+json" };
  if (retryAfter !== null) headers["retry-after"] = retryAfter;
  return { status: 503, headers, body: JSON.stringify({ type: "https://op8x.com/errors/busy", title: "Busy, try again shortly", status: 503, code: "busy" }) };
}

function canned(answer: Canned, route: RouteName | null): Answer {
  if (typeof answer === "object") return answer;
  const success = route === null ? 200 : SUCCESS_STATUS[route] === 204 ? 200 : SUCCESS_STATUS[route];
  switch (answer) {
    case "busy":
      return problem(503, "busy");
    case "not_found":
      return problem(404, "not_found");
    case "not_found_empty":
      return { status: 404 };
    case "flow_moved":
      return problem(410, "flow_moved", { use: "op8x rotate" });
    case "wrong_secret_kind":
      return problem(403, "wrong_secret_kind", { required: ["read"] });
    case "method_not_allowed":
      return { ...problem(405, "method_not_allowed"), headers: { "content-type": "application/problem+json", allow: "POST" } };
    case "action_open":
      return problem(409, "action_open");
    case "action_closed":
      return problem(409, "action_closed");
    case "too_large":
      return problem(413, "invalid_field");
    case "invalid_field":
      return invalid(["body"]);
    case "bad_path":
      return problem(400, "bad_path");
    case "not_json":
      return { status: success, headers: { "content-type": "text/html" }, body: "<html><body>maintenance</body></html>" };
    case "wrong_shape":
      return ok(success, { unexpected: true });
    case "mail_unavailable":
      return problem(503, "mail_unavailable");
    case "server_error":
      return problem(500, "internal");
    case "redirect":
      return { status: 302, headers: { location: "https://elsewhere.example/api" } };
    case "huge":
      return { status: 200, headers: { "content-type": "application/json" }, body: `{"pad":"${"x".repeat(1_100_000)}"}` };
    case "drop":
      return { status: 0, drop: true };
  }
}

function routeOf(method: string, path: string): { route: RouteName; nonce?: string } | null {
  if (method === "POST" && path === `${API}/device/start`) return { route: "device_start" };
  if (method === "POST" && path === `${API}/device/token`) return { route: "device_token" };
  if (method === "GET" && path === `${API}/tenant`) return { route: "tenant" };
  if (method === "POST" && path === `${API}/tenant/rotate`) return { route: "rotate" };
  if (method === "POST" && path === `${API}/tenant/step-up`) return { route: "step_up" };
  if (method === "POST" && path === `${API}/tenant/revoke-previous`) return { route: "revoke_previous" };
  if (method === "POST" && path === `${API}/tenant/delete`) return { route: "delete" };
  if (method === "POST" && path === `${API}/tenant/sign-out`) return { route: "sign_out" };
  if (method === "POST" && path === `${API}/tenant/test-nonce`) return { route: "test_nonce" };
  const prefix = `${API}/tenant/test-nonce/`;
  if (method === "GET" && path.startsWith(prefix)) return { route: "test_nonce_status", nonce: path.slice(prefix.length) };
  const report = `${API}/tenant/report`;
  if (method === "GET" && (path === report || path.startsWith(`${report}?`))) return { route: "report" };
  return null;
}

// --- the fake ---------------------------------------------------------------------------------

export async function startFakeCollector(opts: { start?: number; testToken?: string } = {}): Promise<FakeCollector> {
  let clock = opts.start ?? TEST_NOW;
  const queue: { route: RouteName | "*"; answer: Canned; left: number }[] = [];
  const flows: FakeFlow[] = [];
  const tenants = new Map<string, FakeTenant>();

  const randomName = (test: boolean) => {
    const n = test ? 8 : 10;
    let name = test ? "e2e-" : "t-";
    for (let i = 0; i < n; i++) name += NAME_ALPHABET[randomInt(NAME_ALPHABET.length)];
    return name;
  };
  const newCode = () => {
    const next = fake.nextCodes.shift();
    if (next !== undefined) return next;
    let code = "";
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return code;
  };
  const prevValid = (t: FakeTenant) => t.prev !== null && t.prevUntil !== null && t.prevUntil > clock;
  const live = () => [...tenants.values()].filter((t) => !t.deleted);
  /** A hash any live account holds as R, K or previous K. */
  const hashInUse = (h: string) => live().some((t) => t.read === h || t.write === h || (prevValid(t) && t.prev === h));

  function newTenant(o: { name?: string; contactHint?: string; read: string | null; write: string | null; test?: boolean }): FakeTenant {
    const t: FakeTenant = {
      name: o.name ?? randomName(o.test === true),
      contactHint: o.contactHint ?? "a***@acme.example",
      createdAt: clock,
      lastEventDay: null,
      dailyCap: 100_000,
      read: o.read,
      write: o.write,
      writeSince: o.write === null ? null : clock,
      prev: null,
      prevUntil: null,
      prevLastSeenAt: null,
      holdUntil: null,
      codes: new Map(),
      stepUpCounts: new Map(),
      nonces: new Map(),
      deleted: false,
    };
    tenants.set(t.name, t);
    return t;
  }

  type Who = { t: FakeTenant; kind: "read" | "write" | "previous" };
  /** "Bearer " + key, exactly; resolves R, current K or previous K of a live account. */
  function resolve(header: string | undefined): Who | null {
    const m = /^Bearer (op8x_[wr]_[A-Za-z0-9_-]{43})$/.exec(header ?? "");
    if (!m?.[1]) return null;
    const h = hash(m[1]);
    for (const t of live()) {
      if (t.read === h) return { t, kind: "read" };
      if (t.write === h) return { t, kind: "write" };
      if (prevValid(t) && t.prev === h) return { t, kind: "previous" };
    }
    return null;
  }

  /** Only R: the current K gets 403 wrong_secret_kind, a previous K 401 key_auth. */
  function readOnly(req: RecordedRequest): FakeTenant | Answer {
    const who = resolve(req.headers.authorization);
    if (who === null || who.kind === "previous") return keyAuth();
    if (who.kind === "write") return problem(403, "wrong_secret_kind", { required: ["read"] });
    return who.t;
  }

  type CodeFailure = Answer;
  /** The collector's spendCode: used or missing code first, then the precondition, then exhausted, expired, match. */
  function spend(t: FakeTenant, purpose: Purpose, input: string, precondition: () => Answer | null = () => null): "ok" | CodeFailure {
    const row = t.codes.get(purpose);
    if (row === undefined || row.used) return problem(422, "code_invalid", { attempts_left: 0 });
    const unmet = precondition();
    if (unmet !== null) return unmet;
    if (row.attempts >= 5) return problem(422, "attempts_exhausted", { attempts_left: 0 });
    if (row.expiresAt <= clock) return problem(422, "code_expired");
    const code = normalizeCode(input);
    if (code !== null && code === row.code) {
      row.used = true;
      return "ok";
    }
    row.attempts += 1;
    if (row.attempts >= 5) return problem(422, "attempts_exhausted", { attempts_left: 0 });
    return problem(422, "code_invalid", { attempts_left: 5 - row.attempts });
  }

  function body(req: RecordedRequest, spec: Spec): Parsed | Answer {
    if (Buffer.byteLength(req.body) > MAX_BODY) return problem(413, "invalid_field");
    const parsed = parse(req.body, spec);
    return parsed.ok ? parsed : invalid(parsed.fields);
  }
  const isAnswer = (v: unknown): v is Answer => typeof v === "object" && v !== null && "status" in v;

  // --- routes ---------------------------------------------------------------------------------

  function deviceStart(req: RecordedRequest): Answer {
    const p = body(req, SPECS.start);
    if (isAnswer(p)) return p;
    if (!p.ok) return invalid(p.fields);
    const v = p.value as {
      mode: "init" | "login";
      client: { name: string; version: string };
      device_sha256: string;
      read_sha256: string;
      write_sha256?: string;
      test_token?: string;
    };
    if ((v.mode === "init") !== (v.write_sha256 !== undefined)) return invalid(["write_sha256"]);
    if (v.read_sha256 === v.device_sha256) return invalid(["read_sha256"]);
    if (v.write_sha256 !== undefined && (v.write_sha256 === v.device_sha256 || v.write_sha256 === v.read_sha256)) return invalid(["write_sha256"]);
    const hashes = [v.read_sha256, ...(v.write_sha256 ? [v.write_sha256] : [])];
    if (hashes.some(hashInUse) || flows.some((f) => f.deviceHash === v.device_sha256)) return problem(409, "key_conflict");
    const token = randomBytes(24).toString("base64url");
    const words = `${WORDS[randomInt(WORDS.length)]} ${WORDS[randomInt(WORDS.length)]} ${10 + randomInt(90)}`;
    const flow: FakeFlow = {
      mode: v.mode,
      client: v.client,
      deviceHash: v.device_sha256,
      readHash: v.read_sha256,
      writeHash: v.write_sha256 ?? null,
      testToken: v.test_token,
      token,
      link: `${LINK_BASE}${token}`,
      words,
      expiresAt: clock + 5 * MINUTE,
      intervalS: 5,
      lastPollAt: null,
      polls: 0,
      state: "pending",
      outcome: null,
      grant: null,
    };
    flows.push(flow);
    return ok(201, { link: flow.link, words, expires_at: iso(flow.expiresAt), interval_s: flow.intervalS });
  }

  function deviceToken(req: RecordedRequest): Answer {
    // The body is not read (the collector ignores it); only the device key counts.
    const m = /^Bearer (op8x_d_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "");
    if (!m?.[1]) return keyAuth();
    const h = hash(m[1]);
    const f = flows.find((x) => x.deviceHash === h);
    if (f === undefined || f.state === "collected") return keyAuth();
    f.polls += 1;
    if (f.lastPollAt !== null && f.lastPollAt > clock - 4000) {
      f.intervalS = Math.min(f.intervalS + 5, 30);
      return ok(200, { state: "slow_down", interval_s: f.intervalS });
    }
    f.lastPollAt = clock;
    if (f.state === "granted" && f.grant) {
      f.state = "collected";
      const t = tenants.get(f.grant.tenant);
      if (t === undefined || t.deleted) return ok(200, { state: "expired" });
      return ok(200, { state: "granted", account: t.name, contact_hint: t.contactHint, new_account: f.grant.newAccount, server_key: f.grant.serverKey });
    }
    if (f.state === "denied") return ok(200, { state: f.outcome ?? "denied" });
    return ok(200, { state: f.expiresAt <= clock ? "expired" : "pending" });
  }

  function tenantView(req: RecordedRequest): Answer {
    const who = resolve(req.headers.authorization);
    if (who === null) return keyAuth();
    const t = who.t;
    const keys: unknown[] = [];
    const fp = (h: string) => h.slice(0, 8);
    if (t.write !== null) keys.push({ kind: "write", slot: "current", fingerprint: fp(t.write), valid_until: null });
    if (prevValid(t) && t.prev !== null && t.prevUntil !== null) keys.push({ kind: "write", slot: "previous", fingerprint: fp(t.prev), valid_until: iso(t.prevUntil) });
    if (t.read !== null) keys.push({ kind: "read", slot: "current", fingerprint: fp(t.read), valid_until: null });
    const own = who.kind === "read" ? t.read : who.kind === "write" ? t.write : t.prev;
    return ok(200, {
      tenant: t.name,
      created_at: iso(t.createdAt),
      last_event_day: t.lastEventDay,
      daily_cap: t.dailyCap,
      authenticated_as: { kind: who.kind === "read" ? "read" : "write", slot: who.kind === "previous" ? "previous" : "current", fingerprint: fp(own ?? "") },
      keys,
      write_key_prev_last_seen_at: prevValid(t) && t.prevLastSeenAt !== null ? iso(t.prevLastSeenAt) : null,
      write_key_current_since: t.writeSince === null ? null : iso(t.writeSince),
      server_time: iso(clock),
    });
  }

  function rotate(req: RecordedRequest): Answer {
    const p = body(req, SPECS.rotate);
    if (isAnswer(p)) return p;
    if (!p.ok) return invalid(p.fields);
    const v = p.value as { kind: "write"; new_sha256: string; replace_current?: boolean; code?: string };
    if (v.replace_current === false) return invalid(["replace_current"]);
    const replace = v.replace_current === true;
    if (replace !== (v.code !== undefined)) return invalid(["code"]);
    const t = readOnly(req);
    if (isAnswer(t)) return t;
    const h = v.new_sha256;
    const answer = (prevFp: string | null, prevUntil: number | null) =>
      ok(200, { kind: "write", fingerprint: h.slice(0, 8), previous_fingerprint: prevFp, previous_valid_until: prevUntil === null ? null : iso(prevUntil) });
    if (!prevValid(t)) {
      t.prev = null;
      t.prevUntil = null;
    }
    // An exact repeat answers the same and changes nothing (no code asked again).
    if (t.write === h) return answer(t.prev === null ? null : t.prev.slice(0, 8), t.prev === null ? null : t.prevUntil);
    if (replace) {
      const spent = spend(t, "replace_current", v.code ?? "", () => {
        if (t.prev === null) return problem(409, "no_previous");
        return hashInUse(h) ? problem(409, "key_conflict") : null;
      });
      if (spent !== "ok") return spent;
      t.write = h;
      t.writeSince = clock;
      return answer(t.prev?.slice(0, 8) ?? null, t.prevUntil);
    }
    if (t.prev !== null && t.prevUntil !== null) return problem(409, "rotation_pending", { retry_after_s: Math.max(1, Math.ceil((t.prevUntil - clock) / 1000)) });
    if (t.holdUntil !== null && t.holdUntil > clock) return problem(409, "rotation_pending", { retry_after_s: Math.ceil((t.holdUntil - clock) / 1000) });
    if (hashInUse(h)) return problem(409, "key_conflict");
    const old = t.write;
    t.write = h;
    t.writeSince = clock;
    if (old === null) {
      t.holdUntil = clock + 10 * MINUTE;
      return answer(null, null);
    }
    t.prev = old;
    t.prevUntil = clock + 24 * HOUR;
    t.prevLastSeenAt = null;
    return answer(old.slice(0, 8), t.prevUntil);
  }

  function stepUp(req: RecordedRequest): Answer {
    const p = body(req, SPECS.stepUp);
    if (isAnswer(p)) return p;
    if (!p.ok) return invalid(p.fields);
    const purpose = (p.value as { purpose: Purpose }).purpose;
    const t = readOnly(req);
    if (isAnswer(t)) return t;
    const readHash = t.read ?? "";
    const prior = t.codes.get(purpose);
    // Within 10 minutes, same R and purpose: the old expires_at again, no mail (every purpose).
    if (prior !== undefined && prior.createdAt > clock - 10 * MINUTE && prior.readHash === readHash) return ok(202, { expires_at: iso(prior.expiresAt) });
    const scope = purpose === "delete" ? "delete" : "read";
    const countKey = `${readHash}|${scope}|${utcDay(clock)}`;
    const used = t.stepUpCounts.get(countKey) ?? 0;
    if (used >= (scope === "delete" ? 2 : 3)) {
      const midnight = Date.UTC(new Date(clock).getUTCFullYear(), new Date(clock).getUTCMonth(), new Date(clock).getUTCDate() + 1);
      return problem(429, "rate_limited", { limit_scope: "tenant", retry_after_s: Math.ceil((midnight - clock) / 1000) });
    }
    t.stepUpCounts.set(countKey, used + 1);
    const code = newCode();
    const row: FakeCode = { code, readHash, createdAt: clock, expiresAt: clock + 10 * MINUTE, attempts: 0, used: false };
    t.codes.set(purpose, row);
    fake.mails.push({ tenant: t.name, purpose, code });
    return ok(202, { expires_at: iso(row.expiresAt) });
  }

  function revokePrevious(req: RecordedRequest): Answer {
    const p = body(req, SPECS.code);
    if (isAnswer(p)) return p;
    if (!p.ok) return invalid(p.fields);
    const t = readOnly(req);
    if (isAnswer(t)) return t;
    if (!prevValid(t)) t.prev = null;
    const spent = spend(t, "rotate_now", (p.value as { code: string }).code, () => (t.prev === null ? problem(409, "no_previous") : null));
    if (spent !== "ok") return spent;
    const stopped = (t.prev ?? "").slice(0, 8);
    t.prev = null;
    t.prevUntil = null;
    t.prevLastSeenAt = null;
    return ok(200, { stopped_fingerprint: stopped });
  }

  function deleteAccount(req: RecordedRequest): Answer {
    const p = body(req, SPECS.code);
    if (isAnswer(p)) return p;
    if (!p.ok) return invalid(p.fields);
    const t = readOnly(req);
    if (isAnswer(t)) return t;
    // A session or device row took the account meanwhile: 503 busy, the code stays unspent.
    if (fake.staleDeletes > 0) {
      fake.staleDeletes -= 1;
      return problem(503, "busy");
    }
    const spent = spend(t, "delete", (p.value as { code: string }).code);
    if (spent !== "ok") return spent;
    t.deleted = true;
    return ok(202, { action_id: randomUUID(), status: "done", tenant: t.name, ended_at: iso(clock) });
  }

  function signOut(req: RecordedRequest): Answer {
    const p = body(req, EMPTY);
    if (isAnswer(p)) return p;
    const t = readOnly(req);
    if (isAnswer(t)) return t;
    t.read = null;
    return { status: 204, headers: { "cache-control": "no-store" } };
  }

  function createNonce(req: RecordedRequest): Answer {
    const p = body(req, EMPTY);
    if (isAnswer(p)) return p;
    const t = readOnly(req);
    if (isAnswer(t)) return t;
    if (t.write === null) return problem(409, "no_write_key");
    const open = [...t.nonces.values()].filter((n) => n.seenAt === null && n.expiresAt > clock && n.writeHash === t.write);
    if (open.length >= 10) {
      const first = Math.min(...open.map((n) => n.expiresAt));
      return problem(429, "rate_limited", { limit_scope: "tenant", retry_after_s: Math.max(1, Math.ceil((first - clock) / 1000)) });
    }
    const hourStart = Math.floor(clock / HOUR) * HOUR;
    if ([...t.nonces.values()].filter((n) => n.createdAt >= hourStart).length >= 60) {
      return problem(429, "rate_limited", { limit_scope: "tenant", retry_after_s: Math.ceil((hourStart + HOUR - clock) / 1000) });
    }
    const nonce = randomBytes(32).toString("base64url");
    const row: FakeNonce = { writeHash: t.write, createdAt: clock, expiresAt: clock + 5 * MINUTE, seenAt: null };
    t.nonces.set(nonce, row);
    return ok(201, { nonce, expires_at: iso(row.expiresAt) });
  }

  function nonceStatus(req: RecordedRequest, nonce: string): Answer {
    if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) return invalid(["nonce"]);
    const t = readOnly(req);
    if (isAnswer(t)) return t;
    const row = t.nonces.get(nonce);
    // Unknown, foreign, expired or unseen look the same.
    if (row === undefined || row.seenAt === null) return ok(200, { seen: false, seen_at: null });
    return ok(200, { seen: true, seen_at: iso(row.seenAt) });
  }

  /**
   * GET /tenant/report?days=N in the collector's order: Bearer form, then days (1..30, absent = 7;
   * repeated, bare or any other form is 400 invalid_field), then R only (K: 403 wrong_secret_kind).
   */
  function report(req: RecordedRequest): Answer {
    if (!/^Bearer op8x_[wr]_[A-Za-z0-9_-]{43}$/.test(req.headers.authorization ?? "")) return keyAuth();
    const query = req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "";
    const parts = query === "" ? [] : query.split("&");
    const daysParts = parts.filter((x) => x === "days" || x.startsWith("days="));
    let days = 7;
    if (daysParts.length > 1) return invalid(["days"]);
    if (daysParts.length === 1) {
      const raw = daysParts[0] === "days" ? null : (daysParts[0] ?? "").slice("days=".length);
      if (raw === null || !/^(?:[1-9]|[12][0-9]|30)$/.test(raw)) return invalid(["days"]);
      days = Number(raw);
    }
    const t = readOnly(req);
    if (isAnswer(t)) return t;
    if (fake.reportBody !== null) return { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: fake.reportBody };
    const to = utcDay(clock);
    const from = utcDay(clock - (days - 1) * 24 * HOUR);
    return ok(200, { schema: "op8x.metrics/1", definitions_version: "2026-11-06", generated_at: iso(clock).replace(/\.\d{3}Z$/, "Z"), window: { from, to, days, timezone: "UTC", partial_today: true, incomplete_days: [] } });
  }

  function contractChecks(req: RecordedRequest, route: RouteName): void {
    const say = (s: string) => fake.violations.push(`${req.method} ${req.path}: ${s}`);
    if (req.method === "GET") {
      if (req.body !== "") say("a GET carries a body");
    } else {
      if (req.headers["content-type"] !== "application/json") say("POST without content-type: application/json");
      if ((route === "device_token" || route === "sign_out" || route === "test_nonce") && req.body !== "{}") say("a POST without content must send exactly {}");
    }
    const auth = req.headers.authorization;
    if (route === "device_start") {
      if (auth !== undefined) say("device/start carries an Authorization header");
    } else if (route === "device_token") {
      if (!/^Bearer op8x_d_[A-Za-z0-9_-]{43}$/.test(auth ?? "")) say("device/token without Bearer <device key>");
    } else if (!/^Bearer op8x_r_[A-Za-z0-9_-]{43}$/.test(auth ?? "")) {
      say("a tenant route without Bearer <read token>");
    }
    if (!/^op8x-cli\/\S+ \(\+https:\/\/op8x\.com\)$/.test(req.headers["user-agent"] ?? "")) say("unexpected User-Agent");
  }

  function answer(req: RecordedRequest, nonce: string | undefined): Answer {
    const queued = queue.find((q) => q.left > 0 && (q.route === "*" || q.route === req.route));
    if (queued) {
      queued.left -= 1;
      return canned(queued.answer, req.route);
    }
    if (req.route === null) return problem(404, "not_found");
    contractChecks(req, req.route);
    switch (req.route) {
      case "device_start":
        return deviceStart(req);
      case "device_token":
        return deviceToken(req);
      case "tenant":
        return tenantView(req);
      case "rotate":
        return rotate(req);
      case "step_up":
        return stepUp(req);
      case "revoke_previous":
        return revokePrevious(req);
      case "delete":
        return deleteAccount(req);
      case "sign_out":
        return signOut(req);
      case "test_nonce":
        return createNonce(req);
      case "test_nonce_status":
        return nonceStatus(req, nonce ?? "");
      case "report":
        return report(req);
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "/";
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
      const found = routeOf(req.method ?? "", path);
      const rec: RecordedRequest = { method: req.method ?? "", path, route: found?.route ?? null, headers, body: Buffer.concat(chunks).toString("utf8") };
      fake.requests.push(rec);
      fake.onRequest?.(rec);
      const a = answer(rec, found?.nonce);
      if (a.drop) {
        req.socket.destroy();
        return;
      }
      res.writeHead(a.status, a.headers ?? {});
      res.end(a.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const newest = () => {
    const f = flows.at(-1);
    if (f === undefined) throw new Error("fake collector: no device flow started");
    return f;
  };

  const fake: FakeCollector = {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    requests: [],
    violations: [],
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    setNow: (ms) => {
      clock = ms;
    },
    respond: (route, answer, times = 1) => {
      queue.push({ route, answer, left: times });
    },
    onRequest: null,
    staleDeletes: 0,
    reportBody: null,
    flows,
    lastFlow: () => flows.at(-1),
    grant: (o = {}) => {
      const f = newest();
      if (o.tenant !== undefined) {
        const t = fake.tenant(o.tenant);
        t.read = f.readHash;
        f.grant = { tenant: t.name, newAccount: false, serverKey: "ignored" };
      } else if (f.mode === "login") {
        f.state = "denied";
        f.outcome = "no_account";
        return f;
      } else {
        const test = opts.testToken !== undefined && f.testToken === opts.testToken;
        const t = newTenant({ name: o.name, contactHint: o.contactHint, read: f.readHash, write: f.writeHash, test });
        f.grant = { tenant: t.name, newAccount: true, serverKey: "accepted" };
      }
      f.state = "granted";
      return f;
    },
    deny: (outcome = null) => {
      const f = newest();
      f.state = "denied";
      f.outcome = outcome;
      return f;
    },
    extendFlow: () => {
      const f = newest();
      f.expiresAt = clock + 15 * MINUTE;
      return f;
    },
    tenants,
    tenant: (name) => {
      const t = tenants.get(name);
      if (t === undefined) throw new Error("fake collector: no such account");
      return t;
    },
    addTenant: (o = {}) => {
      const t = newTenant({
        name: o.name,
        contactHint: o.contactHint,
        read: o.readKey === undefined ? null : hash(o.readKey),
        write: o.writeKey === undefined || o.writeKey === null ? null : hash(o.writeKey),
      });
      if (o.previousKey) {
        t.prev = hash(o.previousKey);
        t.prevUntil = o.previousUntil ?? clock + 24 * HOUR;
        t.prevLastSeenAt = o.previousLastSeenAt ?? null;
      }
      return t;
    },
    lastCode: (tenant, purpose) => {
      const row = fake.tenant(tenant).codes.get(purpose);
      if (row === undefined) throw new Error("fake collector: no code of this purpose");
      return row.code;
    },
    mails: [],
    nextCodes: [],
    ingest: (writeKey, nonce) => {
      const h = hash(writeKey);
      const t = live().find((x) => x.write === h || (prevValid(x) && x.prev === h));
      if (t === undefined) return false;
      t.lastEventDay = utcDay(clock);
      // The collector writes last_seen of the previous key at most once a minute.
      if (t.prev === h && (t.prevLastSeenAt === null || clock - t.prevLastSeenAt >= MINUTE)) t.prevLastSeenAt = clock;
      if (nonce !== undefined) {
        const row = t.nonces.get(nonce);
        if (row && row.writeHash === h && row.seenAt === null && row.expiresAt > clock) row.seenAt = clock;
      }
      return true;
    },
  };
  return fake;
}
