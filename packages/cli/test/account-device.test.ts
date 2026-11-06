import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createApi } from "../src/account/api.ts";
import { deviceKeys, deviceLogin, openBrowser, openerFor } from "../src/account/device.ts";
import type { DeviceKeys, DeviceOutcome } from "../src/account/device.ts";
import { generateKey, keyFingerprint, keyHash } from "../src/account/keys.ts";
import { createOutput } from "../src/account/output.ts";
import type { Deps } from "../src/cli.ts";
import { recordingExec, testDeps } from "./account-deps.ts";
import type { RecordingExec } from "./account-deps.ts";
import { startFakeCollector } from "./fake-collector.ts";
import type { FakeCollector } from "./fake-collector.ts";

const LINK = "https://analytics.op8x.com/link/" + "A".repeat(16) + "b_-9".repeat(4);
const MINUTE = 60_000;

async function session(t: TestContext, o: { mode?: "init" | "login"; json?: boolean; env?: Record<string, string>; deps?: Partial<Deps> } = {}) {
  const fake: FakeCollector = await startFakeCollector();
  t.after(() => fake.close());
  const exec = recordingExec();
  const deps = testDeps({
    now: () => fake.now(),
    sleep: async (ms) => {
      deps.sleeps.push(ms);
      fake.advance(ms);
    },
    exec,
    env: o.env ?? {},
    ...o.deps,
  });
  const mode = o.mode ?? "login";
  const keys: DeviceKeys = deviceKeys(mode === "init");
  const out = createOutput({ command: mode, json: o.json ?? true, deps, steps: 1, secrets: () => [keys.device, keys.read, keys.write] });
  const api = createApi(deps, fake.url);
  const login = () => deviceLogin({ deps, api, out, mode, keys });
  const lines = () =>
    deps
      .stdout()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const polls = () => fake.requests.filter((r) => r.route === "device_token").length;
  return { fake, deps, exec: deps.exec as RecordingExec, keys, out, api, login, lines, polls };
}

/** Lets the human act after `n` polls (the hook runs before the fake answers the n-th poll). */
function afterPolls(fake: FakeCollector, n: number, act: () => void): void {
  let seen = 0;
  fake.onRequest = (req) => {
    if (req.route !== "device_token") return;
    seen += 1;
    if (seen === n) act();
  };
}

function expectOk(r: DeviceOutcome): Extract<DeviceOutcome, { ok: true }> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<DeviceOutcome, { ok: true }>;
}

function expectFail(r: DeviceOutcome, state: string): void {
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal((r as { fail: { state: string } }).fail.state, state);
}

// --- opener -------------------------------------------------------------------------------------

test("openerFor: Windows runs rundll32 by absolute path from SystemRoot (any case), no shell, only SystemRoot in env", () => {
  for (const name of ["SystemRoot", "SYSTEMROOT", "systemroot"]) {
    const deps = testDeps({ platform: "win32", env: { [name]: "C:\\Windows", Path: "C:\\evil", OP8X_TEST_TOKEN: "t".repeat(20) } });
    const o = openerFor(deps, LINK);
    assert.ok(o, name);
    assert.equal(o.file, "C:\\Windows\\System32\\rundll32.exe");
    assert.deepEqual(o.args, ["url.dll,FileProtocolHandler", LINK]);
    assert.deepEqual(o.opts.env, { SystemRoot: "C:\\Windows" });
    assert.equal(o.opts.cwd, "C:\\Windows");
    assert.equal(o.opts.input, undefined);
  }
});

test("openerFor: Windows without SystemRoot or with a relative one opens nothing", () => {
  for (const env of [{}, { SystemRoot: "Windows" }, { SystemRoot: "\\\\server\\share" }, { SystemRoot: "" }]) {
    assert.equal(openerFor(testDeps({ platform: "win32", env }), LINK), null, JSON.stringify(env));
  }
});

test("openerFor: macOS runs /usr/bin/open; Linux runs xdg-open from PATH with only absolute PATH entries", () => {
  const mac = openerFor(testDeps({ platform: "darwin", env: { HOME: "/Users/a", OP8X_TEST_TOKEN: "t".repeat(20) } }), LINK);
  assert.ok(mac);
  assert.equal(mac.file, "/usr/bin/open");
  assert.deepEqual(mac.args, [LINK]);
  assert.equal(mac.opts.cwd, "/");
  assert.equal(Object.hasOwn(mac.opts.env, "OP8X_TEST_TOKEN"), false);

  const env = { PATH: ":./bin:/usr/bin::bin:/bin", DISPLAY: ":0", HOME: "/home/a", OP8X_TEST_TOKEN: "t".repeat(20), OP8X_COLLECTOR_URL: "http://127.0.0.1:1" };
  const linux = openerFor(testDeps({ platform: "linux", env }), LINK);
  assert.ok(linux);
  assert.equal(linux.file, "xdg-open");
  assert.deepEqual(linux.args, [LINK]);
  assert.equal(linux.opts.cwd, "/");
  assert.equal(linux.opts.env.PATH, "/usr/bin:/bin");
  assert.equal(linux.opts.env.DISPLAY, ":0");
  assert.equal(Object.hasOwn(linux.opts.env, "OP8X_TEST_TOKEN"), false);
  assert.equal(Object.hasOwn(linux.opts.env, "OP8X_COLLECTOR_URL"), false);
  // Without any absolute PATH entry nothing runs (a bare name would be looked up in the project).
  assert.equal(openerFor(testDeps({ platform: "linux", env: { PATH: "./bin::node_modules/.bin" } }), LINK), null);
  assert.equal(openerFor(testDeps({ platform: "linux", env: {} }), LINK), null);
});

test("openerFor opens only the collector's checked link (A43)", () => {
  const deps = testDeps({ platform: "win32", env: { SystemRoot: "C:\\Windows" } });
  for (const url of [
    "https://analytics.op8x.com/link/short",
    "https://analytics.op8x.com/link/" + "A".repeat(32) + "&calc",
    "https://evil.example/link/" + "A".repeat(32),
    "http://analytics.op8x.com/link/" + "A".repeat(32),
    "file:///C:/Windows/System32/calc.exe",
  ]) {
    assert.equal(openerFor(deps, url), null, url);
  }
});

test("openBrowser: true on exit 0; false on another exit, a timeout, a throw or no opener", async () => {
  const run = async (handler: Parameters<typeof recordingExec>[0], platform: NodeJS.Platform = "darwin") => {
    const exec = recordingExec(handler);
    return { ok: await openBrowser(testDeps({ platform, exec }), LINK), calls: exec.calls.length };
  };
  assert.deepEqual(await run(() => ({ code: 0, stdout: "", stderr: "" })), { ok: true, calls: 1 });
  assert.deepEqual(await run(() => ({ code: 3, stdout: "", stderr: "" })), { ok: false, calls: 1 });
  assert.deepEqual(await run(() => ({ code: null, stdout: "", stderr: "" })), { ok: false, calls: 1 });
  assert.deepEqual(
    await run(() => {
      throw new Error("spawn failed");
    }),
    { ok: false, calls: 1 },
  );
  assert.deepEqual(await run(() => ({ code: 0, stdout: "", stderr: "" }), "win32"), { ok: false, calls: 0 });
});

// --- device login -----------------------------------------------------------------------------

test("deviceKeys: D and R, and K only for init; all distinct", () => {
  const login = deviceKeys(false);
  assert.match(login.device, /^op8x_d_[A-Za-z0-9_-]{43}$/);
  assert.match(login.read, /^op8x_r_[A-Za-z0-9_-]{43}$/);
  assert.equal(login.write, null);
  const init = deviceKeys(true);
  assert.match(init.write ?? "", /^op8x_w_[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set([init.device, init.read, init.write]).size, 3);
});

test("login: device/start with mode login and no write_sha256, a link event, the browser, polls every interval_s until granted", async (t) => {
  const s = await session(t, { deps: { platform: "darwin" } });
  const t0 = s.fake.addTenant({ readKey: generateKey("r"), contactHint: "a***@acme.example" });
  afterPolls(s.fake, 3, () => s.fake.grant({ tenant: t0.name }));
  const r = expectOk(await s.login());
  assert.deepEqual(r, { ok: true, account: t0.name, contactHint: "a***@acme.example", newAccount: false, serverKey: "ignored", recovered: false });

  const start = JSON.parse(s.fake.requests[0]?.body ?? "") as Record<string, unknown>;
  assert.deepEqual(Object.keys(start).sort(), ["client", "device_sha256", "mode", "read_sha256"]);
  assert.equal(start.mode, "login");
  assert.equal(start.device_sha256, keyHash(s.keys.device));
  assert.equal(start.read_sha256, keyHash(s.keys.read));
  // The fake's flow now holds the new R.
  assert.equal(s.fake.tenant(t0.name).read, keyHash(s.keys.read));

  const flow = s.fake.lastFlow();
  assert.ok(flow);
  const [link] = s.lines();
  assert.deepEqual(link, {
    schema: "op8x.cli/1",
    command: "login",
    final: false,
    event: "link",
    state: "waiting_for_human",
    agent_hint: `Ask your human to open the link and click Allow. Their screen shows ${flow.words}.`,
    link: flow.link,
    words: flow.words,
    expires_at: new Date(flow.expiresAt).toISOString(),
  });
  assert.equal(s.exec.calls.length, 1);
  assert.equal(s.exec.calls[0]?.file, "/usr/bin/open");
  assert.deepEqual(s.exec.calls[0]?.args, [flow.link]);
  assert.equal(s.polls(), 3);
  assert.deepEqual(s.deps.sleeps, [5000, 5000, 5000]);
  assert.deepEqual(s.fake.violations, []);
  // No key in any line.
  for (const k of [s.keys.device, s.keys.read]) assert.equal(s.deps.stdout().includes(k), false);
});

test("init: device/start carries write_sha256; granted with accepted and new_account", async (t) => {
  const s = await session(t, { mode: "init" });
  afterPolls(s.fake, 1, () => s.fake.grant({ contactHint: "b***@shop.example" }));
  const r = expectOk(await s.login());
  assert.equal(r.serverKey, "accepted");
  assert.equal(r.newAccount, true);
  assert.equal(r.contactHint, "b***@shop.example");
  const start = JSON.parse(s.fake.requests[0]?.body ?? "") as Record<string, unknown>;
  assert.equal(start.mode, "init");
  assert.equal(start.write_sha256, keyHash(s.keys.write ?? ""));
  assert.equal(s.fake.tenant(r.account).write, keyHash(s.keys.write ?? ""));
});

test("OP8X_TEST_TOKEN goes only into the body of device/start", async (t) => {
  const token = "op8x-test-" + "z".repeat(30);
  const s = await session(t, { env: { OP8X_TEST_TOKEN: token } });
  afterPolls(s.fake, 1, () => s.fake.deny());
  expectFail(await s.login(), "denied");
  const start = s.fake.requests[0];
  assert.equal((JSON.parse(start?.body ?? "") as Record<string, unknown>).test_token, token);
  for (const req of s.fake.requests) {
    assert.equal(JSON.stringify(req.headers).includes(token), false);
    assert.equal(req.path.includes(token), false);
    if (req !== start) assert.equal(req.body.includes(token), false);
  }
  assert.equal(s.deps.stdout().includes(token), false);
  // Without the variable (or empty) there is no test_token.
  const e = await session(t, { env: { OP8X_TEST_TOKEN: "" } });
  afterPolls(e.fake, 1, () => e.fake.deny());
  await e.login();
  assert.equal(Object.hasOwn(JSON.parse(e.fake.requests[0]?.body ?? "") as object, "test_token"), false);
});

test("slow_down: the next poll waits the interval_s the server names", async (t) => {
  const s = await session(t);
  s.fake.respond("device_token", { status: 200, headers: { "content-type": "application/json" }, body: '{"state":"slow_down","interval_s":15}' });
  s.fake.respond("device_token", { status: 200, headers: { "content-type": "application/json" }, body: '{"state":"slow_down","interval_s":20}' });
  afterPolls(s.fake, 3, () => s.fake.deny());
  expectFail(await s.login(), "denied");
  assert.deepEqual(s.deps.sleeps, [5000, 15000, 20000]);
});

test("denied, no_account and terms_draft end the flow with that state", async (t) => {
  for (const outcome of [null, "no_account", "terms_draft"] as const) {
    const s = await session(t);
    afterPolls(s.fake, 2, () => s.fake.deny(outcome));
    expectFail(await s.login(), outcome ?? "denied");
    assert.equal(s.polls(), 2);
  }
  // Login without an account: the fake answers no_account.
  const s = await session(t);
  afterPolls(s.fake, 1, () => s.fake.grant());
  expectFail(await s.login(), "no_account");
});

test("expired from the server ends the flow; polling is not cut off at the start expires_at", async (t) => {
  const s = await session(t);
  expectFail(await s.login(), "expired");
  // expires_at is +5 min: the poll at 5 min says expired.
  assert.equal(s.polls(), 60);

  // The mail went out: the server extends to 15 min; a grant at minute 12 still arrives.
  const x = await session(t);
  const t0 = x.fake.addTenant({ readKey: generateKey("r") });
  afterPolls(x.fake, 1, () => x.fake.extendFlow());
  let polls = 0;
  const hook = x.fake.onRequest;
  x.fake.onRequest = (req) => {
    hook?.(req);
    if (req.route === "device_token" && ++polls === 144) x.fake.grant({ tenant: t0.name });
  };
  expectOk(await x.login());
  assert.equal(x.polls(), 144);
});

test("at most 20 minutes of polling, then expired", async (t) => {
  const s = await session(t);
  s.fake.respond("device_token", { status: 200, headers: { "content-type": "application/json" }, body: '{"state":"pending"}' }, 10_000);
  const started = s.fake.now();
  expectFail(await s.login(), "expired");
  const waited = s.fake.now() - started;
  assert.ok(waited <= 20 * MINUTE, String(waited));
  assert.ok(waited > 20 * MINUTE - 10_000, String(waited));
  assert.equal(s.polls(), 240);
});

test("busy on device/token is retried every 10 s for at most 2 minutes, then busy", async (t) => {
  const s = await session(t);
  s.fake.respond("device_token", "busy", 13);
  const r = await s.login();
  assert.deepEqual(r, { ok: false, fail: { state: "busy" } });
  assert.deepEqual(s.deps.sleeps, [5000, ...Array(12).fill(10_000)]);
  // Busy then pending, then a grant: the flow goes on.
  const b = await session(t);
  const t0 = b.fake.addTenant({ readKey: generateKey("r") });
  b.fake.respond("device_token", "busy", 2);
  afterPolls(b.fake, 3, () => b.fake.grant({ tenant: t0.name }));
  expectOk(await b.login());
});

test("device/start key_conflict: new keys once and again; a second conflict ends with key_conflict", async (t) => {
  const conflict = { status: 409, headers: { "content-type": "application/problem+json" }, body: '{"code":"key_conflict","status":409}' };
  const s = await session(t, { mode: "init" });
  const first = { ...s.keys };
  s.fake.respond("device_start", conflict);
  afterPolls(s.fake, 1, () => s.fake.deny());
  expectFail(await s.login(), "denied");
  const starts = s.fake.requests.filter((r) => r.route === "device_start").map((r) => JSON.parse(r.body) as Record<string, string>);
  assert.equal(starts.length, 2);
  assert.equal(starts[0]?.device_sha256, keyHash(first.device));
  for (const k of ["device", "read", "write"] as const) assert.notEqual(s.keys[k], first[k], k);
  assert.equal(starts[1]?.device_sha256, keyHash(s.keys.device));
  assert.equal(starts[1]?.read_sha256, keyHash(s.keys.read));
  assert.equal(starts[1]?.write_sha256, keyHash(s.keys.write ?? ""));

  const c = await session(t);
  c.fake.respond("device_start", conflict, 2);
  assert.deepEqual(await c.login(), { ok: false, fail: { state: "key_conflict" } });
  assert.equal(c.fake.requests.length, 2);
  assert.equal(c.deps.stdout(), "");
  assert.equal(c.exec.calls.length, 0);
});

test("device/start errors end the flow before any link or browser", async (t) => {
  for (const [canned, state] of [
    ["server_error", "network_error"],
    ["not_found", "unexpected_response"],
    ["wrong_shape", "unexpected_response"],
  ] as const) {
    const s = await session(t);
    s.fake.respond("device_start", canned);
    expectFail(await s.login(), state);
    assert.equal(s.deps.stdout(), "");
    assert.equal(s.exec.calls.length, 0);
  }
  // A link from another host is unexpected_response (A43), nothing is opened.
  const s = await session(t);
  s.fake.respond("device_start", {
    status: 201,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ link: "https://evil.example/link/" + "A".repeat(32), words: "amber tiger 42", expires_at: "2026-11-03T14:10:00Z", interval_s: 5 }),
  });
  expectFail(await s.login(), "unexpected_response");
  assert.equal(s.exec.calls.length, 0);
});

test("a failing browser leaves the link in the output and the flow goes on", async (t) => {
  const s = await session(t, { deps: { platform: "win32", env: {} } });
  const t0 = s.fake.addTenant({ readKey: generateKey("r") });
  afterPolls(s.fake, 1, () => s.fake.grant({ tenant: t0.name }));
  expectOk(await s.login());
  assert.equal(s.exec.calls.length, 0);
  assert.equal(s.lines()[0]?.link, s.fake.lastFlow()?.link);

  const f = await session(t, { deps: { platform: "darwin", exec: recordingExec(() => ({ code: 1, stdout: "", stderr: "no browser" })) } });
  const t1 = f.fake.addTenant({ readKey: generateKey("r") });
  afterPolls(f.fake, 1, () => f.fake.grant({ tenant: t1.name }));
  expectOk(await f.login());
  assert.equal(f.deps.stdout().includes("no browser"), false);
});

test("text mode shows words and link escaped, so look-alike characters are visible", async (t) => {
  const s = await session(t, { json: false });
  s.fake.respond("device_start", {
    status: 201,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ link: LINK, words: "amber\u00a0tiger 42", expires_at: "2026-11-03T14:10:00Z", interval_s: 5 }),
  });
  s.fake.respond("device_token", { status: 200, headers: { "content-type": "application/json" }, body: '{"state":"denied"}' });
  expectFail(await s.login(), "denied");
  const text = s.deps.stdout();
  assert.ok(text.includes('Their screen shows "amber\\u{00A0}tiger 42".'), text);
  assert.ok(text.includes(`Link: "${LINK}"`), text);
});

test("network errors: polling goes on after one or two; three in a row end with network_error", async (t) => {
  const s = await session(t);
  const t0 = s.fake.addTenant({ readKey: generateKey("r") });
  s.fake.respond("device_token", "drop", 2);
  afterPolls(s.fake, 4, () => s.fake.grant({ tenant: t0.name }));
  expectOk(await s.login());

  const n = await session(t);
  n.fake.respond("device_token", "drop", 3);
  expectFail(await n.login(), "network_error");
  assert.equal(n.polls(), 3);
});

/** The fake hands out the grant but the answer is lost on the way (the row is collected). */
function loseGrant(fake: FakeCollector, atPoll: number, grant: () => void): void {
  let seen = 0;
  fake.onRequest = (req) => {
    if (req.route !== "device_token") return;
    seen += 1;
    if (seen === atPoll) {
      grant();
      const f = fake.lastFlow();
      if (f) f.state = "collected";
      fake.respond("device_token", "drop");
    }
  };
}

test("granted_lost recovery: a lost answer, then 401: GET /tenant with the new R; contact unknown", async (t) => {
  const s = await session(t);
  const t0 = s.fake.addTenant({ readKey: generateKey("r"), contactHint: "a***@acme.example" });
  loseGrant(s.fake, 2, () => s.fake.grant({ tenant: t0.name }));
  const r = expectOk(await s.login());
  assert.deepEqual(r, { ok: true, account: t0.name, contactHint: null, newAccount: null, serverKey: "ignored", recovered: true });
  const tenantReq = s.fake.requests.at(-1);
  assert.equal(tenantReq?.route, "tenant");
  assert.equal(tenantReq?.headers.authorization, `Bearer ${s.keys.read}`);
  const notices = s.lines().filter((l) => l.event === "notice");
  assert.deepEqual(notices, [
    {
      schema: "op8x.cli/1",
      command: "login",
      final: false,
      event: "notice",
      id: "contact_unknown",
      text: "This computer does not know the contact address of this account.",
    },
  ]);
  assert.deepEqual(s.fake.violations, []);
});

test("granted_lost recovery for init: server_key from the fingerprint of the current key", async (t) => {
  const s = await session(t, { mode: "init" });
  loseGrant(s.fake, 1, () => s.fake.grant());
  const r = expectOk(await s.login());
  assert.equal(r.serverKey, "accepted");
  assert.equal(r.recovered, true);
  // The current K of the account is someone else's: ignored.
  const x = await session(t, { mode: "init" });
  loseGrant(x.fake, 1, () => {
    x.fake.grant();
    const f = x.fake.lastFlow();
    const tenant = [...x.fake.tenants.values()].at(-1);
    if (f && tenant) tenant.write = keyHash(generateKey("w"));
  });
  const ignored = expectOk(await x.login());
  assert.equal(ignored.serverKey, "ignored");
  assert.notEqual(keyFingerprint(x.keys.write ?? ""), "");
});

test("granted_lost only after a network error: a plain 401 is unexpected_response; failed recovery is granted_lost", async (t) => {
  const s = await session(t);
  s.fake.respond("device_token", { status: 401, headers: { "content-type": "application/problem+json" }, body: '{"code":"key_auth","status":401}' });
  assert.deepEqual(await s.login(), { ok: false, fail: { state: "unexpected_response", status: 401, code: "key_auth" } });
  assert.equal(s.fake.requests.some((r) => r.route === "tenant"), false);

  // Lost answer, but the new R does not work (e.g. the grant went elsewhere).
  const g = await session(t);
  g.fake.respond("device_token", "drop");
  g.fake.respond("device_token", { status: 401, headers: { "content-type": "application/problem+json" }, body: '{"code":"key_auth","status":401}' });
  assert.deepEqual(await g.login(), { ok: false, fail: { state: "granted_lost" } });
  assert.equal(g.fake.requests.at(-1)?.route, "tenant");
});

test("after an output guard hit nothing more happens: no browser, no polls", async (t) => {
  // The link line holds the test token: the guard stops the output there.
  const s = await session(t, { env: { OP8X_TEST_TOKEN: "analytics.op8x.com" }, deps: { platform: "darwin" } });
  const r = await s.login();
  expectFail(r, "internal_error");
  assert.equal(s.exec.calls.length, 0);
  assert.equal(s.polls(), 0);
  assert.deepEqual(s.lines().map((l) => l.state), ["internal_error"]);
});
