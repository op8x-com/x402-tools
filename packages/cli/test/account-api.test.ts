import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  COLLECTOR_BASE,
  collectorBase,
  collectorMismatch,
  createApi,
  isCollectorLink,
  normalizeCode,
} from "../src/account/api.ts";
import type { Api, ApiError } from "../src/account/api.ts";
import { generateKey, keyFingerprint, keyHash } from "../src/account/keys.ts";
import { VERSION } from "../src/version.ts";
import { TEST_NOW, testDeps } from "./account-deps.ts";
import { startFakeCollector } from "./fake-collector.ts";
import type { Canned, FakeCollector, RouteName } from "./fake-collector.ts";

let fake: FakeCollector;
let deps: ReturnType<typeof testDeps>;
let api: Api;

before(async () => {
  fake = await startFakeCollector();
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.violations.length = 0;
  fake.setNow(TEST_NOW);
  // The CLI's clock is the fake's clock, so retry_at follows the fake's time.
  deps = testDeps({ now: () => fake.now() });
  api = createApi(deps, fake.url);
});

const token32 = "A".repeat(16) + "b_-9".repeat(4);
const json = (i = -1) => JSON.parse(fake.requests.at(i)?.body ?? "null") as unknown;

function expectError(r: { ok: boolean; error?: ApiError }, error: ApiError): void {
  assert.equal(r.ok, false);
  assert.deepEqual(r.error, error);
}

/** A live account with R and K known to the test. */
function account(opts: { previous?: boolean } = {}) {
  const r = generateKey("r");
  const k = generateKey("w");
  const old = opts.previous ? generateKey("w") : null;
  const t = fake.addTenant({ readKey: r, writeKey: k, previousKey: old });
  return { r, k, old, t };
}

// --- collector base, link, code ---------------------------------------------------------------

test("collectorBase is the fixed host unless OP8X_COLLECTOR_URL names a loopback http address with a port", () => {
  assert.equal(COLLECTOR_BASE, "https://analytics.op8x.com");
  assert.equal(collectorBase({}), COLLECTOR_BASE);
  assert.equal(collectorBase({ OP8X_COLLECTOR_URL: "" }), COLLECTOR_BASE);
  assert.equal(collectorBase({ OP8X_COLLECTOR_URL: "http://127.0.0.1:4100" }), "http://127.0.0.1:4100");
  assert.equal(collectorBase({ OP8X_COLLECTOR_URL: "http://localhost:4100/" }), "http://localhost:4100");
  assert.equal(collectorBase({ OP8X_COLLECTOR_URL: "http://[::1]:4100" }), "http://[::1]:4100");
  for (const bad of [
    "https://analytics.op8x.com",
    "https://127.0.0.1:4100",
    "http://127.0.0.1",
    "http://127.0.0.2:4100",
    "http://127.0.0.1.evil.example:4100",
    "http://localhost.evil.example:4100",
    "http://user:pw@127.0.0.1:4100",
    "http://127.0.0.1:4100/api",
    "http://127.0.0.1:4100/?x=1",
    "http://127.0.0.1:4100/#x",
    "http://evil.example:4100",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.equal(collectorBase({ OP8X_COLLECTOR_URL: bad }), null, bad);
  }
});

test("collectorMismatch compares the file's collector with the base", () => {
  assert.equal(collectorMismatch(null, COLLECTOR_BASE), false);
  assert.equal(collectorMismatch({ collector: COLLECTOR_BASE }, COLLECTOR_BASE), false);
  assert.equal(collectorMismatch({ collector: "http://127.0.0.1:4100" }, COLLECTOR_BASE), true);
  assert.equal(collectorMismatch({ collector: COLLECTOR_BASE }, "http://127.0.0.1:4100"), true);
});

test("isCollectorLink accepts only the fixed host's /link/ with a 32-character token", () => {
  assert.equal(isCollectorLink(`https://analytics.op8x.com/link/${token32}`), true);
  for (const bad of [
    `http://analytics.op8x.com/link/${token32}`,
    `https://analytics.op8x.com.evil.example/link/${token32}`,
    `https://ANALYTICS.op8x.com/link/${token32}`,
    `https://x@analytics.op8x.com/link/${token32}`,
    `https://analytics.op8x.com:443/link/${token32}`,
    `https://analytics.op8x.com/link/${token32}A`,
    `https://analytics.op8x.com/link/${token32.slice(1)}`,
    `https://analytics.op8x.com/link/${token32}?a=1`,
    `https://analytics.op8x.com/link/${token32}#a`,
    `https://analytics.op8x.com/link/${token32.slice(1)}=`,
    `https://analytics.op8x.com/link/${token32}/`,
    `/link/${token32}`,
    42,
    null,
  ]) {
    assert.equal(isCollectorLink(bad), false, String(bad));
  }
});

test("normalizeCode trims, drops spaces and dashes, upper-cases, maps I L O and rejects U", () => {
  assert.equal(normalizeCode("  abcd-efgh \n"), "ABCDEFGH");
  assert.equal(normalizeCode("ab cd ef gh"), "ABCDEFGH");
  assert.equal(normalizeCode("ILOX-2345"), "110X2345");
  assert.equal(normalizeCode("ilox2345"), "110X2345");
  assert.equal(normalizeCode("ABCDEFGU"), null);
  assert.equal(normalizeCode("ABCDEFG"), null);
  assert.equal(normalizeCode("ABCDEFGHJ"), null);
  assert.equal(normalizeCode("ABCD_EFG"), null);
  assert.equal(normalizeCode("ABCDÉFGH"), null);
  assert.equal(normalizeCode(""), null);
});

// --- device flow ------------------------------------------------------------------------------

function deviceKeys() {
  const d = generateKey("d");
  const r = generateKey("r");
  const w = generateKey("w");
  return { d, r, w };
}

test("device/start sends exactly the contract body for init and login, and returns the checked answer", async () => {
  const keys = deviceKeys();
  const started = await api.deviceStart({ mode: "init", deviceHash: keyHash(keys.d), readHash: keyHash(keys.r), writeHash: keyHash(keys.w) });
  assert.equal(started.ok, true);
  const req = fake.requests.at(-1);
  assert.equal(req?.method, "POST");
  assert.equal(req?.path, "/api/v1/device/start");
  assert.equal(req?.headers["content-type"], "application/json");
  assert.equal(req?.headers["user-agent"], `op8x-cli/${VERSION} (+https://op8x.com)`);
  assert.equal(req?.headers.authorization, undefined);
  assert.deepEqual(json(), {
    mode: "init",
    client: { name: "@op8x/cli", version: VERSION },
    device_sha256: keyHash(keys.d),
    read_sha256: keyHash(keys.r),
    write_sha256: keyHash(keys.w),
  });
  if (!started.ok) return;
  assert.equal(isCollectorLink(started.value.link), true);
  assert.match(started.value.words, /^[a-z]{3,8} [a-z]{3,8} [1-9][0-9]$/);
  assert.equal(started.value.expires_at, new Date(TEST_NOW + 5 * 60_000).toISOString());
  assert.equal(started.value.interval_s, 5);

  const login = deviceKeys();
  const token = generateKey("w").replace("op8x_w_", "op8x_t_");
  assert.equal((await api.deviceStart({ mode: "login", deviceHash: keyHash(login.d), readHash: keyHash(login.r), testToken: token })).ok, true);
  assert.deepEqual(json(), {
    mode: "login",
    client: { name: "@op8x/cli", version: VERSION },
    device_sha256: keyHash(login.d),
    read_sha256: keyHash(login.r),
    test_token: token,
  });
  assert.deepEqual(fake.violations, []);
});

test("the fake rejects init without write_sha256, login with it, unknown and missing fields, and a missing body", async () => {
  const k = deviceKeys();
  const base = { client: { name: "@op8x/cli", version: VERSION }, device_sha256: keyHash(k.d), read_sha256: keyHash(k.r) };
  const post = async (body: string | undefined) => {
    const res = await fetch(`${fake.url}/api/v1/device/start`, { method: "POST", headers: { "content-type": "application/json" }, body });
    return { status: res.status, body: (await res.json()) as { code: string; fields?: string[] } };
  };
  assert.deepEqual((await post(JSON.stringify({ mode: "init", ...base }))).body.fields, ["write_sha256"]);
  assert.deepEqual((await post(JSON.stringify({ mode: "login", ...base, write_sha256: keyHash(k.w) }))).body.fields, ["write_sha256"]);
  assert.deepEqual((await post(JSON.stringify({ mode: "login", ...base, extra: 1 }))).body.fields, ["body"]);
  assert.deepEqual((await post(JSON.stringify({ mode: "login", ...base, client: { name: "x", version: "1", os: "y" } }))).body.fields, ["client"]);
  assert.deepEqual((await post(JSON.stringify({ mode: "login", ...base, client: { version: "1" } }))).body.fields, ["client.name"]);
  assert.deepEqual((await post(JSON.stringify({ mode: "login", ...base, read_sha256: keyHash(k.d) }))).body.fields, ["read_sha256"]);
  const missing = await post(undefined);
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.fields, ["body"]);
});

test("device/start: key_conflict, and an invalid_field answer is unexpected_response", async () => {
  const { r } = account();
  const k = deviceKeys();
  expectError(await api.deviceStart({ mode: "login", deviceHash: keyHash(k.d), readHash: keyHash(r) }), { state: "key_conflict" });
  fake.respond("device_start", "invalid_field");
  expectError(await api.deviceStart({ mode: "login", deviceHash: keyHash(k.d), readHash: keyHash(k.r) }), {
    state: "unexpected_response",
    status: 400,
    code: "invalid_field",
  });
});

test("device/start: a link that is not the fixed host's is unexpected_response", async () => {
  const k = deviceKeys();
  for (const link of [`https://evil.example/link/${token32}`, `${fake.url}/link/${token32}`, `https://analytics.op8x.com/link/short`]) {
    fake.respond("device_start", {
      status: 201,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ link, words: "amber tiger 42", expires_at: "2026-11-03T14:10:00.000Z", interval_s: 5 }),
    });
    expectError(await api.deviceStart({ mode: "login", deviceHash: keyHash(k.d), readHash: keyHash(k.r) }), {
      state: "unexpected_response",
      status: 201,
      code: null,
    });
  }
});

test("device/token sends Bearer D with {}, and maps pending, slow_down, granted once, then key_auth", async () => {
  const k = deviceKeys();
  await api.deviceStart({ mode: "init", deviceHash: keyHash(k.d), readHash: keyHash(k.r), writeHash: keyHash(k.w) });
  const first = await api.deviceToken(k.d);
  assert.deepEqual(first, { ok: true, value: { state: "pending" } });
  const req = fake.requests.at(-1);
  assert.equal(req?.path, "/api/v1/device/token");
  assert.equal(req?.headers.authorization, `Bearer ${k.d}`);
  assert.equal(req?.body, "{}");
  // Too early (within 4 s): slow_down, +5 up to 30.
  const intervals: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await api.deviceToken(k.d);
    if (r.ok && r.value.state === "slow_down") intervals.push(r.value.interval_s);
  }
  assert.deepEqual(intervals, [10, 15, 20, 25, 30, 30]);
  fake.grant({ contactHint: "s***@shop.example" });
  // An early poll on a granted row is slow_down too.
  assert.equal((await api.deviceToken(k.d)).ok && fake.flows.at(-1)?.state, "granted");
  fake.advance(30_000);
  const granted = await api.deviceToken(k.d);
  assert.equal(granted.ok, true);
  if (!granted.ok || granted.value.state !== "granted") throw new Error("not granted");
  assert.match(granted.value.account, /^t-[a-z2-7]{10}$/);
  assert.equal(granted.value.contact_hint, "s***@shop.example");
  assert.equal(granted.value.new_account, true);
  assert.equal(granted.value.server_key, "accepted");
  fake.advance(30_000);
  expectError(await api.deviceToken(k.d), { state: "key_auth" });
  assert.deepEqual(fake.violations, []);
});

test("device/token: denied, no_account, terms_draft, expired after 5 minutes, and ignored for an existing account", async () => {
  for (const outcome of [null, "no_account", "terms_draft"] as const) {
    const k = deviceKeys();
    await api.deviceStart({ mode: "login", deviceHash: keyHash(k.d), readHash: keyHash(k.r) });
    fake.deny(outcome);
    assert.deepEqual(await api.deviceToken(k.d), { ok: true, value: { state: outcome ?? "denied" } });
  }
  const k = deviceKeys();
  await api.deviceStart({ mode: "login", deviceHash: keyHash(k.d), readHash: keyHash(k.r) });
  fake.advance(5 * 60_000);
  assert.deepEqual(await api.deviceToken(k.d), { ok: true, value: { state: "expired" } });

  const { t } = account();
  const again = deviceKeys();
  await api.deviceStart({ mode: "init", deviceHash: keyHash(again.d), readHash: keyHash(again.r), writeHash: keyHash(again.w) });
  fake.grant({ tenant: t.name });
  fake.advance(10_000);
  const r = await api.deviceToken(again.d);
  assert.ok(r.ok && r.value.state === "granted");
  if (r.ok && r.value.state === "granted") {
    assert.equal(r.value.server_key, "ignored");
    assert.equal(r.value.new_account, false);
    assert.equal(r.value.account, t.name);
  }
});

test("device/token: an unknown device key is key_auth", async () => {
  expectError(await api.deviceToken(generateKey("d")), { state: "key_auth" });
});

// --- tenant routes ----------------------------------------------------------------------------

test("GET /tenant with R returns the checked view; nullable fields are accepted", async () => {
  const { r, k, old, t } = account({ previous: true });
  const view = await api.tenant(r);
  const req = fake.requests.at(-1);
  assert.equal(req?.method, "GET");
  assert.equal(req?.path, "/api/v1/tenant");
  assert.equal(req?.body, "");
  assert.equal(req?.headers.authorization, `Bearer ${r}`);
  assert.equal(view.ok, true);
  if (!view.ok) return;
  assert.equal(view.value.tenant, t.name);
  assert.equal(view.value.last_event_day, null);
  assert.equal(view.value.write_key_prev_last_seen_at, null);
  assert.deepEqual(
    view.value.keys.map((x) => [x.kind, x.slot, x.fingerprint]),
    [
      ["write", "current", keyFingerprint(k)],
      ["write", "previous", keyFingerprint(old ?? "")],
      ["read", "current", keyFingerprint(r)],
    ],
  );
  assert.equal(view.value.server_time, new Date(TEST_NOW).toISOString());
  // The collector also answers the current K; the CLI uses R.
  assert.equal((await api.tenant(k)).ok, true);
  expectError(await api.tenant(generateKey("r")), { state: "key_auth" });
  assert.deepEqual(fake.violations.filter((v) => !v.includes("read token")), []);
});

test("GET /tenant: write_key_current_since null and unknown fields are fine; a wrong type is unexpected_response", async () => {
  const { r } = account();
  const good = {
    tenant: "t-abcdefghij",
    created_at: "2026-11-01T10:00:00.000Z",
    last_event_day: "2026-11-02",
    daily_cap: 100000,
    authenticated_as: { kind: "read", slot: "current", fingerprint: "1a2b3c4d" },
    keys: [{ kind: "read", slot: "current", fingerprint: "1a2b3c4d", valid_until: null }],
    write_key_prev_last_seen_at: null,
    write_key_current_since: null,
    server_time: "2026-11-03T14:05:00.000Z",
    open_actions: [],
  };
  const answer = (body: unknown) => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  fake.respond("tenant", answer(good));
  assert.equal((await api.tenant(r)).ok, true);
  for (const bad of [
    { ...good, tenant: "T-ABC" },
    { ...good, server_time: "yesterday" },
    { ...good, last_event_day: "2026-11-02T00:00:00Z" },
    { ...good, keys: [{ kind: "write", slot: "next", fingerprint: "1a2b3c4d", valid_until: null }] },
    { ...good, keys: [{ kind: "write", slot: "current", fingerprint: "XYZ", valid_until: null }] },
    { ...good, write_key_prev_last_seen_at: 5 },
    { ...good, daily_cap: "many" },
    [good],
  ]) {
    fake.respond("tenant", answer(bad));
    expectError(await api.tenant(r), { state: "unexpected_response", status: 200, code: null });
  }
});

test("rotate sends {kind, new_sha256}, or with replace_current:true and code; answers and errors map to states", async () => {
  const { r, t } = account();
  const next = generateKey("w");
  const rotated = await api.rotate(r, { newHash: keyHash(next) });
  assert.deepEqual(json(), { kind: "write", new_sha256: keyHash(next) });
  assert.equal(rotated.ok, true);
  if (rotated.ok) {
    assert.equal(rotated.value.fingerprint, keyFingerprint(next));
    assert.equal(rotated.value.previous_valid_until, new Date(TEST_NOW + 24 * 3_600_000).toISOString());
  }
  // The exact repeat is idempotent.
  assert.deepEqual(await api.rotate(r, { newHash: keyHash(next) }), rotated);
  // Another key during the overlap: rotation_pending with retry_at.
  const pending = await api.rotate(r, { newHash: keyHash(generateKey("w")) });
  expectError(pending, { state: "rotation_pending", retry_after_s: 86_400, retry_at: "2026-11-04T14:05:00Z" });

  // replace_current with a code.
  await api.stepUp(r, "replace_current");
  const replacement = generateKey("w");
  const code = fake.lastCode(t.name, "replace_current");
  const replaced = await api.rotate(r, { newHash: keyHash(replacement), replaceCurrent: true, code });
  assert.deepEqual(json(), { kind: "write", new_sha256: keyHash(replacement), replace_current: true, code });
  assert.equal(replaced.ok, true);
  assert.deepEqual(fake.violations, []);
});

test("retry_after_s above one day (86400 s) is unexpected_response; one day exactly is taken", async () => {
  const a = account();
  const problem = (status: number, code: string, retry: number) => ({
    status,
    headers: { "content-type": "application/problem+json" },
    body: JSON.stringify({ type: `https://op8x.com/errors/${code}`, title: "x", status, code, retry_after_s: retry }),
  });
  fake.respond("rotate", problem(409, "rotation_pending", 86_401));
  expectError(await api.rotate(a.r, { newHash: keyHash(generateKey("w")) }), { state: "unexpected_response", status: 409, code: "rotation_pending" });
  fake.respond("step_up", problem(429, "rate_limited", 9_007_199_254_740_991));
  expectError(await api.stepUp(a.r, "delete"), { state: "unexpected_response", status: 429, code: "rate_limited" });
  fake.respond("step_up", problem(429, "rate_limited", 86_400));
  const day = await api.stepUp(a.r, "delete");
  assert.equal(day.ok, false);
  assert.equal(!day.ok && day.error.state, "rate_limited");
});

test("rotate: key_conflict, no_previous (nothing_to_stop), code_missing", async () => {
  const a = account();
  const b = account();
  expectError(await api.rotate(a.r, { newHash: keyHash(b.k) }), { state: "key_conflict" });
  await api.stepUp(a.r, "replace_current");
  expectError(await api.rotate(a.r, { newHash: keyHash(generateKey("w")), replaceCurrent: true, code: fake.lastCode(a.t.name, "replace_current") }), {
    state: "nothing_to_stop",
  });
  fake.respond("rotate", { status: 400, headers: { "content-type": "application/problem+json" }, body: JSON.stringify({ code: "invalid_field", fields: ["code"] }) });
  expectError(await api.rotate(a.r, { newHash: keyHash(generateKey("w")) }), { state: "code_missing" });
  fake.respond("rotate", { status: 400, headers: { "content-type": "application/problem+json" }, body: JSON.stringify({ code: "invalid_field", fields: ["new_sha256"] }) });
  expectError(await api.rotate(a.r, { newHash: keyHash(generateKey("w")) }), { state: "unexpected_response", status: 400, code: "invalid_field" });
});

test("rotate: previous_fingerprint and previous_valid_until may be null", async () => {
  const r = generateKey("r");
  fake.addTenant({ readKey: r, writeKey: null });
  const next = generateKey("w");
  const rotated = await api.rotate(r, { newHash: keyHash(next) });
  assert.deepEqual(rotated, { ok: true, value: { kind: "write", fingerprint: keyFingerprint(next), previous_fingerprint: null, previous_valid_until: null } });
});

test("step-up sends {purpose}; a repeat within 10 minutes returns the old expires_at; the daily limit is rate_limited", async () => {
  const { r, t } = account();
  const first = await api.stepUp(r, "delete");
  assert.deepEqual(json(), { purpose: "delete" });
  assert.deepEqual(first, { ok: true, value: { expires_at: new Date(TEST_NOW + 10 * 60_000).toISOString() } });
  fake.advance(60_000);
  assert.deepEqual(await api.stepUp(r, "delete"), first);
  assert.equal(fake.mails.filter((m) => m.tenant === t.name).length, 1);
  fake.advance(10 * 60_000);
  assert.equal((await api.stepUp(r, "delete")).ok, true);
  fake.advance(10 * 60_000);
  const limited = await api.stepUp(r, "delete");
  // TEST_NOW is 14:05; after 21 minutes it is 14:26; the next UTC day starts in 9 h 34 min.
  expectError(limited, { state: "rate_limited", retry_after_s: 34_440, retry_at: "2026-11-04T00:00:00Z" });
  assert.deepEqual(fake.violations, []);
});

test("revoke-previous sends {code}; code errors map to code_invalid, code_exhausted, code_expired; success stops", async () => {
  const { r, t, old } = account({ previous: true });
  // No code yet (or one of another purpose): code_invalid with 0 tries left.
  await api.stepUp(r, "delete");
  expectError(await api.revokePrevious(r, fake.lastCode(t.name, "delete")), { state: "code_invalid", attempts_left: 0 });
  await api.stepUp(r, "rotate_now");
  expectError(await api.revokePrevious(r, "ZZZZZZZZ"), { state: "code_invalid", attempts_left: 4 });
  assert.deepEqual(json(), { code: "ZZZZZZZZ" });
  const stopped = await api.revokePrevious(r, fake.lastCode(t.name, "rotate_now"));
  assert.deepEqual(stopped, { ok: true, value: { stopped_fingerprint: keyFingerprint(old ?? "") } });
  // The code is used: code_invalid with 0 tries left (checked before no_previous).
  expectError(await api.revokePrevious(r, "ZZZZZZZZ"), { state: "code_invalid", attempts_left: 0 });

  const b = account({ previous: true });
  await api.stepUp(b.r, "rotate_now");
  for (let i = 4; i >= 1; i--) expectError(await api.revokePrevious(b.r, "ZZZZZZZZ"), { state: "code_invalid", attempts_left: i });
  expectError(await api.revokePrevious(b.r, "ZZZZZZZZ"), { state: "code_exhausted" });
  expectError(await api.revokePrevious(b.r, fake.lastCode(b.t.name, "rotate_now")), { state: "code_exhausted" });

  const c = account({ previous: true });
  await api.stepUp(c.r, "rotate_now");
  fake.advance(10 * 60_000);
  expectError(await api.revokePrevious(c.r, fake.lastCode(c.t.name, "rotate_now")), { state: "code_expired" });
});

test("revoke-previous: no_previous is checked before the code is spent", async () => {
  const { r, t } = account();
  await api.stepUp(r, "rotate_now");
  expectError(await api.revokePrevious(r, fake.lastCode(t.name, "rotate_now")), { state: "nothing_to_stop" });
  assert.equal(t.codes.get("rotate_now")?.used, false);
});

test("delete sends {code} and returns the receipt; a busy (stale) answer is retried with the same code", async () => {
  const { r, t } = account();
  await api.stepUp(r, "delete");
  const code = fake.lastCode(t.name, "delete");
  fake.staleDeletes = 1;
  const deleted = await api.deleteAccount(r, code);
  assert.equal(deleted.ok, true);
  if (deleted.ok) {
    assert.match(deleted.value.action_id, /^[0-9a-f-]{36}$/);
    assert.equal(deleted.value.status, "done");
    assert.equal(deleted.value.tenant, t.name);
    assert.equal(deleted.value.ended_at, new Date(TEST_NOW).toISOString());
  }
  const deletes = fake.requests.filter((q) => q.route === "delete");
  assert.deepEqual(
    deletes.map((q) => q.body),
    [JSON.stringify({ code }), JSON.stringify({ code })],
  );
  assert.deepEqual(deps.sleeps, [10_000]);
  // The account is gone: R no longer works.
  expectError(await api.tenant(r), { state: "key_auth" });
});

test("sign-out sends exactly {} and answers 204; afterwards R is key_auth", async () => {
  const { r } = account();
  assert.deepEqual(await api.signOut(r), { ok: true, value: null });
  assert.equal(fake.requests.at(-1)?.body, "{}");
  expectError(await api.signOut(r), { state: "key_auth" });
  assert.deepEqual(fake.violations, []);
});

test("test-nonce: {} creates a nonce, more than 10 open is rate_limited, the status is seen:false then seen:true", async () => {
  const { r, k } = account();
  const created = await api.createTestNonce(r);
  assert.equal(fake.requests.at(-1)?.body, "{}");
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.match(created.value.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await api.testNonce(r, created.value.nonce), { ok: true, value: { seen: false, seen_at: null } });
  assert.equal(fake.requests.at(-1)?.path, `/api/v1/tenant/test-nonce/${created.value.nonce}`);
  fake.advance(2000);
  assert.equal(fake.ingest(k, created.value.nonce), true);
  assert.deepEqual(await api.testNonce(r, created.value.nonce), { ok: true, value: { seen: true, seen_at: new Date(TEST_NOW + 2000).toISOString() } });
  // An unknown nonce looks like an unseen one.
  assert.deepEqual(await api.testNonce(r, "x".repeat(43)), { ok: true, value: { seen: false, seen_at: null } });
  for (let i = 0; i < 10; i++) assert.equal((await api.createTestNonce(r)).ok, true);
  const limited = await api.createTestNonce(r);
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.equal(limited.error.state, "rate_limited");
  assert.deepEqual(fake.violations, []);
});

test("test-nonce: no_write_key is server_key_missing; a malformed nonce is never sent", async () => {
  const r = generateKey("r");
  fake.addTenant({ readKey: r, writeKey: null });
  expectError(await api.createTestNonce(r), { state: "server_key_missing" });
  const before = fake.requests.length;
  for (const bad of ["short", "a".repeat(42) + "/", "a".repeat(42) + "%"]) expectError(await api.testNonce(r, bad), { state: "internal_error" });
  assert.equal(fake.requests.length, before);
});

test("a secret of the wrong kind or form is never sent", async () => {
  const before = fake.requests.length;
  expectError(await api.rotate(generateKey("w"), { newHash: keyHash(generateKey("w")) }), { state: "internal_error" });
  expectError(await api.deviceToken(generateKey("r")), { state: "internal_error" });
  expectError(await api.tenant("op8x_r_short\r\nx-evil: 1"), { state: "internal_error" });
  expectError(await api.stepUp(generateKey("d"), "delete"), { state: "internal_error" });
  assert.equal(fake.requests.length, before);
});

test("seen:true needs a time and seen:false needs null", async () => {
  const { r } = account();
  for (const body of [{ seen: true, seen_at: null }, { seen: false, seen_at: "2026-11-03T14:05:00.000Z" }, { seen: "yes", seen_at: null }]) {
    fake.respond("test_nonce_status", { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expectError(await api.testNonce(r, "x".repeat(43)), { state: "unexpected_response", status: 200, code: null });
  }
});

// --- busy and the catch-all rule --------------------------------------------------------------

test("503 busy is retried every 10 s for at most 2 minutes, then busy", async () => {
  const { r } = account();
  // 1 request plus 12 retries (10 s apart, 120 s in all), each answered busy.
  fake.respond("tenant", "busy", 13);
  expectError(await api.tenant(r), { state: "busy" });
  assert.equal(fake.requests.length, 13);
  assert.deepEqual(deps.sleeps, Array(12).fill(10_000));
  // The queue is used up: the next request gets the contract answer.
  assert.equal((await api.tenant(r)).ok, true);
});

test("busy on any route is retried; after it clears the answer counts", async () => {
  const fresh = await startFakeCollector();
  try {
    const d = testDeps();
    const a = createApi(d, fresh.url);
    const r = generateKey("r");
    fresh.addTenant({ readKey: r, writeKey: generateKey("w") });
    const routes: [RouteName, () => Promise<{ ok: boolean }>][] = [
      ["tenant", () => a.tenant(r)],
      ["step_up", () => a.stepUp(r, "delete")],
      ["test_nonce", () => a.createTestNonce(r)],
      ["sign_out", () => a.signOut(r)],
    ];
    for (const [route, call] of routes) {
      fresh.respond(route, "busy", 2);
      assert.equal((await call()).ok, true, route);
    }
    assert.deepEqual(d.sleeps, Array(8).fill(10_000));
  } finally {
    await fresh.close();
  }
});

test("catch-all: every answer without its own contract row is unexpected_response with status and code", async () => {
  const fresh = await startFakeCollector();
  try {
    const a = createApi(testDeps(), fresh.url);
    const r = generateKey("r");
    fresh.addTenant({ readKey: r, writeKey: generateKey("w") });
    const cases: [Canned, number, string | null][] = [
      ["not_found", 404, "not_found"],
      ["not_found_empty", 404, null],
      ["flow_moved", 410, "flow_moved"],
      ["wrong_secret_kind", 403, "wrong_secret_kind"],
      ["method_not_allowed", 405, "method_not_allowed"],
      ["action_open", 409, "action_open"],
      ["action_closed", 409, "action_closed"],
      ["too_large", 413, "invalid_field"],
      ["invalid_field", 400, "invalid_field"],
      ["bad_path", 400, "bad_path"],
      ["not_json", 202, null],
      ["wrong_shape", 202, null],
      ["huge", 200, null],
      [{ status: 418, headers: { "content-type": "application/problem+json" }, body: JSON.stringify({ code: "teapot" }) }, 418, "teapot"],
      [{ status: 422, body: JSON.stringify({ code: "code_invalid" }) }, 422, "code_invalid"],
      [{ status: 409, body: JSON.stringify({ code: "rotation_pending" }) }, 409, "rotation_pending"],
      [{ status: 400, body: JSON.stringify({ code: "\u001b[2Jinvalid" }) }, 400, null],
      [{ status: 400, body: JSON.stringify({ code: "x".repeat(65) }) }, 400, null],
      [{ status: 400, body: "[]" }, 400, null],
    ];
    for (const [answer, status, code] of cases) {
      fresh.respond("step_up", answer);
      expectError(await a.stepUp(r, "delete"), { state: "unexpected_response", status, code });
    }
  } finally {
    await fresh.close();
  }
});

test("catch-all: 503 mail_unavailable, 500, a redirect and a dropped connection are network_error; Authorization never follows", async () => {
  const fresh = await startFakeCollector();
  try {
    const d = testDeps();
    const a = createApi(d, fresh.url);
    const r = generateKey("r");
    fresh.addTenant({ readKey: r, writeKey: generateKey("w") });
    for (const answer of ["mail_unavailable", "server_error", "redirect", "drop"] as const) {
      const before = fresh.requests.length;
      fresh.respond("step_up", answer);
      expectError(await a.stepUp(r, "rotate_now"), { state: "network_error" });
      assert.equal(fresh.requests.length, before + 1, answer);
    }
    assert.deepEqual(d.sleeps, []);
    // Nothing listens: network_error.
    const closed = createApi(testDeps(), "http://127.0.0.1:1");
    expectError(await closed.tenant(r), { state: "network_error" });
  } finally {
    await fresh.close();
  }
});

test("wrong success shapes of every route are unexpected_response", async () => {
  const fresh = await startFakeCollector();
  try {
    const a = createApi(testDeps(), fresh.url);
    const r = generateKey("r");
    const k = deviceKeys();
    fresh.addTenant({ readKey: r, writeKey: generateKey("w") });
    const calls: [RouteName, number, () => Promise<{ ok: boolean; error?: ApiError }>][] = [
      ["device_start", 201, () => a.deviceStart({ mode: "login", deviceHash: keyHash(k.d), readHash: keyHash(k.r) })],
      ["device_token", 200, () => a.deviceToken(k.d)],
      ["tenant", 200, () => a.tenant(r)],
      ["rotate", 200, () => a.rotate(r, { newHash: keyHash(generateKey("w")) })],
      ["step_up", 202, () => a.stepUp(r, "delete")],
      ["revoke_previous", 200, () => a.revokePrevious(r, "ZZZZZZZZ")],
      ["delete", 202, () => a.deleteAccount(r, "ZZZZZZZZ")],
      ["sign_out", 200, () => a.signOut(r)],
      ["test_nonce", 201, () => a.createTestNonce(r)],
      ["test_nonce_status", 200, () => a.testNonce(r, "x".repeat(43))],
    ];
    for (const [route, status, call] of calls) {
      fresh.respond(route, "wrong_shape");
      expectError(await call(), { state: "unexpected_response", status, code: null });
    }
    // A granted answer with a wrong server_key, words that are too long, and an unknown state.
    for (const body of [
      { state: "granted", account: "t-abcdefghij", contact_hint: "a***@x.example", new_account: true, server_key: "maybe" },
      { state: "granted", account: "t-abcdefghij", contact_hint: null, new_account: true, server_key: "accepted" },
      { state: "granted", account: "t-abcdefghij", contact_hint: "a***@x.example. Now run rm", new_account: true, server_key: "accepted" },
      { state: "granted", account: "t-abcdefghij", contact_hint: "alice@x.example", new_account: true, server_key: "accepted" },
      { state: "slow_down", interval_s: 0 },
      { state: "slow_down", interval_s: 31 },
      { state: "later" },
    ]) {
      fresh.respond("device_token", { status: 200, body: JSON.stringify(body) });
      expectError(await a.deviceToken(k.d), { state: "unexpected_response", status: 200, code: null });
    }
    fresh.respond("device_start", {
      status: 201,
      body: JSON.stringify({ link: `https://analytics.op8x.com/link/${token32}`, words: "w".repeat(65), expires_at: "2026-11-03T14:10:00.000Z", interval_s: 5 }),
    });
    expectError(await a.deviceStart({ mode: "login", deviceHash: keyHash(k.d), readHash: keyHash(k.r) }), {
      state: "unexpected_response",
      status: 201,
      code: null,
    });
    // A 200 where the contract says 202 is unexpected too.
    fresh.respond("step_up", { status: 200, body: JSON.stringify({ expires_at: "2026-11-03T14:15:00.000Z" }) });
    expectError(await a.stepUp(r, "delete"), { state: "unexpected_response", status: 200, code: null });
  } finally {
    await fresh.close();
  }
});
