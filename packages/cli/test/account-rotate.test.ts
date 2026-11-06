import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createApi } from "../src/account/api.ts";
import { generateKey, keyFingerprint, keyHash } from "../src/account/keys.ts";
import { accountPath, writeAccount } from "../src/account/store.ts";
import type { ActiveAccount, PendingStepUp, WorkerEntry } from "../src/account/store.ts";
import { exec as realExec, readHiddenFrom } from "../src/account/system.ts";
import { run } from "../src/cli.ts";
import type { Deps } from "../src/cli.ts";
import { recordingExec, tempDir, testDeps } from "./account-deps.ts";
import type { ExecHandler } from "./account-deps.ts";
import { startFakeCollector } from "./fake-collector.ts";
import type { FakeCollector, FakeTenant, Purpose } from "./fake-collector.ts";
import { createFakeWrangler } from "./fake-wrangler.ts";
import type { FakeWrangler } from "./fake-wrangler.ts";
import { startFakeWorker } from "./fake-worker.ts";
import type { FakeWorker, WorkerMode } from "./fake-worker.ts";

type Line = Record<string, unknown>;

const CONTACT = "a***@acme.example";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface KnownWorker {
  wrangler: FakeWrangler;
  worker: FakeWorker;
  name: string;
  /** K as the worker holds it: the last secret put, else the key it started with. */
  key: () => string;
  puts: () => number;
}

interface Setup {
  fake: FakeCollector;
  deps: ReturnType<typeof testDeps>;
  tenant: FakeTenant;
  read: string;
  /** The account's current K before the run (the key in the workers). */
  oldKey: string;
  workers: KnownWorker[];
  lines: () => Line[];
  final: () => Line;
  file: () => ActiveAccount;
  /** Runs `op8x rotate --json …args`; stdout of earlier runs is dropped first. */
  rotate: (...args: string[]) => Promise<number>;
  /** Requests of the last run only. */
  runRequests: () => FakeCollector["requests"];
}

interface SetupOptions {
  /** Number of known wrangler workers (default 2). */
  workers?: number;
  /** Workers whose entry has url null (by index). */
  noUrl?: number[];
  modes?: WorkerMode[];
  /** The local K: "current" (default), "previous" (someone else rotated), "stale", "none". */
  local?: "current" | "previous" | "stale" | "none";
  /** A previous key is open on the server (default false; true for local "previous"). */
  previous?: boolean;
  tty?: boolean;
  deps?: Partial<Deps>;
  file?: Partial<ActiveAccount>;
}

async function setup(t: TestContext, o: SetupOptions = {}): Promise<Setup> {
  const fake = await startFakeCollector();
  t.after(() => fake.close());
  const read = generateKey("r");
  const local = o.local ?? "current";
  const serverCurrent = generateKey("w");
  const otherCurrent = generateKey("w");
  const stale = generateKey("w");
  // previous: the local K is the server's previous key, someone else's key is current.
  const tenant = fake.addTenant({
    readKey: read,
    writeKey: local === "previous" ? otherCurrent : serverCurrent,
    contactHint: CONTACT,
    previousKey: local === "previous" ? serverCurrent : o.previous ? generateKey("w") : undefined,
  });
  const oldKey = serverCurrent;
  const localKey = local === "none" ? null : local === "stale" ? stale : serverCurrent;

  const workers: KnownWorker[] = [];
  const entries: WorkerEntry[] = [];
  for (let i = 0; i < (o.workers ?? 2); i++) {
    const name = `api${i + 1}`;
    const wrangler = createFakeWrangler();
    wrangler.file("wrangler.toml", `name = "${name}"\n`);
    const putCalls = () => wrangler.calls().filter((c) => c.argv[0] === "secret" && c.argv[1] === "put");
    const key = () => putCalls().at(-1)?.stdin ?? oldKey;
    const worker = await startFakeWorker({ collector: fake, key, mode: o.modes?.[i] });
    t.after(() => worker.close());
    workers.push({ wrangler, worker, name, key, puts: () => putCalls().length });
    entries.push({
      dir: wrangler.dir,
      name,
      env: null,
      env_file: null,
      url: o.noUrl?.includes(i) ? null : `${worker.origin}/paid`,
      deployed_at: "2026-11-01T10:00:00Z",
      verified_at: "2026-11-01T10:00:05Z",
      key_fingerprint: keyFingerprint(oldKey),
    });
  }
  const deps = testDeps({
    exec: realExec,
    now: () => fake.now(),
    sleep: async (ms) => {
      deps.sleeps.push(ms);
      fake.advance(ms);
    },
    stdinIsTTY: o.tty ?? false,
    // TTY: the human types the newest code from the mail.
    readHidden: async () => fake.mails.at(-1)?.code ?? "",
    env: { OP8X_COLLECTOR_URL: fake.url, ...(process.platform === "win32" ? { SystemRoot: "C:\\Windows" } : {}) },
    ...o.deps,
  });
  const file: ActiveAccount = {
    schema: "op8x.account/1",
    collector: fake.url,
    account: tenant.name,
    contact_hint: CONTACT,
    read_token: read,
    write_key: localKey,
    write_key_next: null,
    pending_step_up: null,
    deleted: null,
    workers: entries,
    ...o.file,
  };
  await writeAccount(deps, file);
  let out = "";
  let firstRequest = 0;
  const lines = () =>
    out
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Line);
  return {
    fake,
    deps,
    tenant,
    read,
    oldKey,
    workers,
    lines,
    final: () => lines().at(-1) ?? {},
    file: () => JSON.parse(readFileSync(accountPath(deps), "utf8")) as ActiveAccount,
    rotate: async (...args) => {
      firstRequest = fake.requests.length;
      const before = deps.stdout().length;
      const code = await run(["rotate", "--json", ...args], deps);
      out = deps.stdout().slice(before);
      return code;
    },
    runRequests: () => fake.requests.slice(firstRequest),
  };
}

function steps(lines: Line[]): [string, string][] {
  return lines.filter((l) => l.event === "step" && l.status !== "start").map((l) => [String(l.name), String(l.status)]);
}

const routes = (s: Setup) => s.runRequests().map((r) => r.route);

function assertNoSecret(s: Setup, secrets: (string | null | undefined)[]): void {
  const all = s.deps.stdout() + s.deps.stderr();
  for (const v of secrets) if (typeof v === "string") assert.equal(all.includes(v), false, "a secret reached the output");
}

// --- plain rotate ---------------------------------------------------------------------------------

test("rotate: new K stored as write_key_next before POST rotate, then write_key; into every worker; key_rotated", async (t) => {
  const s = await setup(t);
  let nextAtRotate: string | null = null;
  s.fake.onRequest = (req) => {
    if (req.route === "rotate") nextAtRotate = s.file().write_key_next;
  };
  assert.equal(await s.rotate(), 0);
  assert.deepEqual(steps(s.lines()), [
    ["new_key", "ok"],
    ["key", "ok"],
    ["test", "ok"],
  ]);
  for (const l of s.lines().filter((x) => x.event === "step")) assert.equal(l.of, 3);
  const f = s.file();
  const key = f.write_key;
  assert.ok(key !== null && key !== s.oldKey);
  assert.equal(f.write_key_next, null);
  assert.equal(nextAtRotate, key, "write_key_next held the new K when POST rotate went out");
  const body = JSON.parse(s.runRequests().find((r) => r.route === "rotate")?.body ?? "{}") as Line;
  assert.deepEqual(body, { kind: "write", new_sha256: keyHash(key) });
  assert.equal(s.runRequests().find((r) => r.route === "rotate")?.headers.authorization, `Bearer ${s.read}`);
  // Both workers got K and were proven by a nonce.
  for (const w of s.workers) assert.equal(w.key(), key);
  for (const w of f.workers) {
    assert.equal(w.key_fingerprint, keyFingerprint(key));
    assert.ok(w.verified_at !== null && w.verified_at > "2026-11-02");
  }
  const final = s.final();
  assert.equal(final.state, "key_rotated");
  assert.equal(final.exit_code, 0);
  assert.deepEqual(final.workers, [
    { name: "api1", env: null, env_file: null, status: "verified" },
    { name: "api2", env: null, env_file: null, status: "verified" },
  ]);
  const until = new Date(s.fake.now() + 24 * HOUR).toISOString().slice(0, 16);
  assert.match(String(final.agent_hint), /^The new server key is in 2 workers; the old key works until 2026-11-0\dT\d\d:\d\d/);
  assert.ok(String(final.agent_hint).includes(until.slice(0, 13)), String(final.agent_hint));
  assert.deepEqual(s.fake.violations, []);
  assertNoSecret(s, [key, s.oldKey, s.read]);
});

test("rotate needs R but not K; with no known worker the catalog sentence", async (t) => {
  const s = await setup(t, { workers: 0, local: "none" });
  assert.equal(await s.rotate(), 0);
  assert.deepEqual(steps(s.lines()), [
    ["new_key", "ok"],
    ["key", "skipped"],
    ["test", "skipped"],
  ]);
  assert.equal(s.final().state, "key_rotated");
  assert.equal(s.final().agent_hint, "No worker is known on this computer. Run op8x init in every worker folder within 24 hours.");
  assert.deepEqual(s.final().workers, []);
  assert.equal(s.file().write_key !== null, true);
});

test("rotate in text mode: Step n of 3 and the sentence", async (t) => {
  const s = await setup(t, { workers: 1 });
  assert.equal(await run(["rotate"], s.deps), 0);
  const out = s.deps.stdout();
  assert.match(out, /^Step 1 of 3: new_key\n/);
  assert.match(out, /Worker api1: verified\n/);
  assert.match(out, /The new server key is in 1 workers; the old key works until \d{4}-\d\d-\d\d \d\d:\d\d UTC\.\n$/);
});

test("rotate resumes write_key_next: network error after the swap, then a new run → write_key, key_rotated", async (t) => {
  let failRotate = true;
  const s = await setup(t, {
    deps: {
      fetchImpl: async (input, init) => {
        const r = await fetch(input, init);
        if (failRotate && String(input).endsWith("/tenant/rotate")) throw new TypeError("fetch failed");
        return r;
      },
    },
  });
  assert.equal(await s.rotate(), 2);
  assert.equal(s.final().state, "network_error");
  const next = s.file().write_key_next;
  assert.ok(next !== null);
  assert.equal(s.file().write_key, s.oldKey);
  assert.equal(s.tenant.write, keyHash(next), "the server swapped");

  failRotate = false;
  assert.equal(await s.rotate(), 0);
  assert.equal(s.final().state, "key_rotated");
  const f = s.file();
  assert.equal(f.write_key, next);
  assert.equal(f.write_key_next, null);
  // The next K was the current key: no second POST rotate.
  assert.equal(routes(s).includes("rotate"), false);
  for (const w of s.workers) assert.equal(w.key(), next);
});

test("rotate resumes write_key_next with the exact same POST rotate; key_conflict drops it", async (t) => {
  const s = await setup(t);
  // The next K is taken by another account: the collector answers 409 key_conflict.
  const taken = generateKey("w");
  s.fake.addTenant({ readKey: generateKey("r"), writeKey: taken });
  await writeAccount(s.deps, { ...s.file(), write_key_next: taken });
  assert.equal(await s.rotate(), 1);
  assert.equal(s.final().state, "key_conflict");
  assert.equal(s.final().agent_hint, "Run the command again.");
  const sent = s.runRequests().filter((r) => r.route === "rotate");
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0]!.body), { kind: "write", new_sha256: keyHash(taken) });
  assert.equal(s.file().write_key_next, null);
  assert.equal(s.file().write_key, s.oldKey);
  for (const w of s.workers) assert.equal(w.puts(), 0);
});

test("rotate after partial: no new POST rotate, K only into the worker that missed it", async (t) => {
  const s = await setup(t);
  s.workers[1]!.wrangler.answer("put", { exit: 1 });
  assert.equal(await s.rotate(), 1);
  assert.equal(s.final().state, "partial");
  assert.equal(s.final().agent_hint, "The new key is not in every worker: api2. Fix them and run the command again; nothing was stopped.");
  assert.deepEqual(s.final().workers, [
    { name: "api1", env: null, env_file: null, status: "verified" },
    { name: "api2", env: null, env_file: null, status: "failed" },
  ]);
  const key = s.file().write_key!;
  assert.equal(s.workers[0]!.puts(), 1);

  s.workers[1]!.wrangler.answer("put", { exit: 0 });
  assert.equal(await s.rotate(), 0);
  assert.deepEqual(steps(s.lines()), [
    ["new_key", "skipped"],
    ["key", "ok"],
    ["test", "ok"],
  ]);
  assert.equal(s.final().state, "key_rotated");
  assert.equal(routes(s).includes("rotate"), false);
  assert.equal(s.lines().some((l) => l.state === "rotation_pending"), false);
  assert.equal(s.workers[0]!.puts(), 1, "the worker that has K gets no second put");
  assert.equal(s.workers[1]!.puts(), 2);
  assert.equal(s.workers[1]!.key(), key);
  // Only the unverified worker is tested again.
  assert.equal(routes(s).filter((r) => r === "test_nonce").length, 1);
  assert.equal(s.file().write_key, key);
});

test("rotate: a worker without a test event is unverified and counts as partial; the next run tests only it", async (t) => {
  const s = await setup(t, { modes: ["module", "no_module"] });
  assert.equal(await s.rotate(), 1);
  assert.equal(s.final().state, "partial");
  assert.deepEqual(
    (s.final().workers as Line[]).map((w) => w.status),
    ["verified", "unverified"],
  );
  s.workers[1]!.worker.mode = "module";
  assert.equal(await s.rotate(), 0);
  assert.equal(s.final().state, "key_rotated");
  assert.equal(s.workers[1]!.puts(), 1, "K was already in the worker");
  assert.equal(routes(s).filter((r) => r === "test_nonce").length, 1);
});

test("rotate: a worker without url is no_url and does not make a plain rotate partial", async (t) => {
  const s = await setup(t, { noUrl: [1] });
  assert.equal(await s.rotate(), 0);
  assert.equal(s.final().state, "key_rotated");
  assert.deepEqual(
    (s.final().workers as Line[]).map((w) => w.status),
    ["verified", "no_url"],
  );
  assert.equal(s.workers[1]!.puts(), 1);
});

test("rotate while a rotation runs and K is not current: rotation_pending with the catalog sentence, next dropped", async (t) => {
  const s = await setup(t, { local: "previous" });
  assert.equal(await s.rotate(), 1);
  const final = s.final();
  assert.equal(final.state, "rotation_pending");
  assert.equal(typeof final.retry_after_s, "number");
  assert.match(String(final.agent_hint), /^A rotation is still running until \d{4}-\d\d-\d\dT[\d:]+Z\. Run op8x rotate --now to finish it early\.$/);
  assert.equal(s.file().write_key_next, null);
  for (const w of s.workers) assert.equal(w.puts(), 0);
});

test("rotate: Cloudflare not logged in → cloudflare_login_needed before anything is rotated", async (t) => {
  const s = await setup(t, { workers: 1 });
  s.workers[0]!.wrangler.answer("whoami", { exit: 1, stdout: '\n{"loggedIn":false}\n' });
  assert.equal(await s.rotate(), 1);
  assert.equal(s.final().state, "cloudflare_login_needed");
  assert.equal(routes(s).includes("rotate"), false);
  assert.equal(s.file().write_key, s.oldKey);
});

test("rotate: the output guard stops after the step line, before POST rotate", async (t) => {
  const s = await setup(t, { workers: 1 });
  s.deps.env = { ...s.deps.env, OP8X_TEST_TOKEN: '"name":"new_key"' };
  assert.equal(await s.rotate(), 2);
  assert.equal(s.final().state, "internal_error");
  assert.equal(routes(s).includes("rotate"), false);
  assert.equal(s.file().write_key_next, null);
});

test("rotate clears a waiting step of rotate at the end state, not before", async (t) => {
  const pending: PendingStepUp = {
    purpose: "rotate_now",
    command: "rotate",
    case: "b",
    phase: "stop",
    force_stop: false,
    t_check: "2026-11-03T14:00:00.000Z",
    expires_at: "2026-11-03T14:10:00.000Z",
  };
  let failRotate = true;
  const s = await setup(t, {
    workers: 1,
    file: { pending_step_up: pending },
    deps: {
      fetchImpl: async (input, init) => {
        if (failRotate && String(input).endsWith("/tenant/rotate")) throw new TypeError("fetch failed");
        return fetch(input, init);
      },
    },
  });
  // network_error is no end state of the list: the step stays.
  assert.equal(await s.rotate(), 2);
  assert.equal(s.final().state, "network_error");
  assert.deepEqual(s.file().pending_step_up, pending);
  failRotate = false;
  assert.equal(await s.rotate(), 0);
  assert.equal(s.final().state, "key_rotated");
  assert.equal(s.file().pending_step_up, null);
});

test("a waiting step of delete survives rotate (also its end state key_rotated)", async (t) => {
  const del: PendingStepUp = {
    purpose: "delete",
    command: "delete",
    case: null,
    phase: "delete",
    force_stop: false,
    t_check: null,
    expires_at: "2026-11-03T14:10:00.000Z",
  };
  const s = await setup(t, { workers: 1, file: { pending_step_up: del } });
  assert.equal(await s.rotate(), 0);
  assert.equal(s.final().state, "key_rotated");
  assert.deepEqual(s.file().pending_step_up, del);
});

test("key_rotated without an old key (previous_valid_until null) says only where the new key is", async (t) => {
  const s = await setup(t, { workers: 1, local: "none" });
  s.tenant.write = null;
  assert.equal(await s.rotate(), 0);
  assert.equal(s.final().state, "key_rotated");
  assert.equal(s.final().agent_hint, "The new server key is in 1 workers.");
});

test("resumption: the repeated POST rotate answers rotation_pending → write_key_next goes, the run goes on", async (t) => {
  const s = await setup(t, { previous: true });
  const orphan = generateKey("w");
  await writeAccount(s.deps, { ...s.file(), write_key_next: orphan });
  assert.equal(await s.rotate(), 0);
  const sent = s.runRequests().filter((r) => r.route === "rotate");
  assert.deepEqual(sent.map((r) => JSON.parse(r.body)), [{ kind: "write", new_sha256: keyHash(orphan) }]);
  assert.equal(s.final().state, "key_rotated");
  assert.equal(s.file().write_key_next, null);
  assert.equal(s.file().write_key, s.oldKey);
});

// --- env-file targets -------------------------------------------------------------------------------

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

/** git answers like an ignored, untracked file; under win32 whoami and icacls for the ACL. */
function gitExec(): ExecHandler {
  const ok = { code: 0, stdout: "", stderr: "" };
  return (file, args) => {
    if (args.includes("check-ignore")) return ok;
    if (args.includes("ls-files")) return { code: 1, stdout: "", stderr: "" };
    if (file.endsWith("whoami.exe")) return { code: 0, stdout: `"desktop-x\\anna","${SID}"\r\n`, stderr: "" };
    if (file.endsWith("icacls.exe")) {
      if (args[1] === "/save") writeFileSync(String(args[2]), Buffer.from(`x\r\nD:PAI(A;;FA;;;${SID})\r\n`, "utf16le"));
      return ok;
    }
    throw new Error(`unexpected program ${file}`);
  };
}

test("rotate rewrites the OP8X_KEY line of an --env-file target and keeps the other lines", async (t) => {
  const gitDir = tempDir("op8x-gitbin-");
  writeFileSync(join(gitDir, process.platform === "win32" ? "git.exe" : "git"), "");
  const project = tempDir("op8x-node-");
  const path = join(project, "secrets.local");
  const s = await setup(t, {
    workers: 0,
    deps: { exec: recordingExec(gitExec()), platform: process.platform },
  });
  s.deps.env = { ...s.deps.env, PATH: gitDir };
  writeFileSync(path, `PORT=8787\nOP8X_KEY=${s.oldKey}\n# note\n`);
  const entry: WorkerEntry = {
    dir: project,
    name: null,
    env: null,
    env_file: path,
    url: null,
    deployed_at: "2026-11-01T10:00:00Z",
    verified_at: null,
    key_fingerprint: keyFingerprint(s.oldKey),
  };
  await writeAccount(s.deps, { ...s.file(), workers: [entry] });
  assert.equal(await s.rotate(), 0);
  const key = s.file().write_key!;
  assert.equal(readFileSync(path, "utf8"), `PORT=8787\nOP8X_KEY=${key}\n# note\n`);
  assert.equal(s.final().state, "key_rotated");
  assert.deepEqual(s.final().workers, [{ name: null, env: null, env_file: path, status: "no_url" }]);
  assert.equal(s.file().workers[0]!.key_fingerprint, keyFingerprint(key));
  assertNoSecret(s, [key]);
});

// --- rotate --now -----------------------------------------------------------------------------------

const mailCode = (s: Setup, purpose: Purpose) => {
  const m = s.fake.mails.filter((x) => x.purpose === purpose).at(-1);
  assert.ok(m, `a ${purpose} mail`);
  return m.code;
};

/** T_check: the latest verified_at of the known workers (the seen_at of their nonces). */
const latestVerified = (s: Setup) => Math.max(...s.file().workers.map((w) => Date.parse(w.verified_at ?? "")));

/** Fake clock at each GET /tenant of the last run, between the last nonce poll and the step-up. */
function waitPolls(s: Setup, at: Map<object, number>): number[] {
  const reqs = s.runRequests();
  const lastNonce = reqs.map((r) => r.route).lastIndexOf("test_nonce_status");
  const stepUp = reqs.findIndex((r, i) => i > lastNonce && r.route === "step_up");
  return reqs.slice(lastNonce + 1, stepUp < 0 ? undefined : stepUp).filter((r) => r.route === "tenant").map((r) => at.get(r) ?? NaN);
}

/** Records the fake's clock at every request. */
function clockAt(s: Setup): Map<object, number> {
  const at = new Map<object, number>();
  const before = s.fake.onRequest;
  s.fake.onRequest = (req) => {
    at.set(req, s.fake.now());
    before?.(req);
  };
  return at;
}

test("--now case (a) with a TTY: new_key, key, test, wait, code, stop → old_key_stopped", async (t) => {
  const s = await setup(t, { tty: true });
  const at = clockAt(s);
  assert.equal(await s.rotate("--now"), 0);
  assert.deepEqual(steps(s.lines()), [
    ["new_key", "ok"],
    ["key", "ok"],
    ["test", "ok"],
    ["wait", "ok"],
    ["code", "ok"],
    ["stop", "ok"],
  ]);
  for (const l of s.lines().filter((x) => x.event === "step")) assert.equal(l.of, 6);
  const final = s.final();
  assert.equal(final.state, "old_key_stopped");
  assert.equal(final.exit_code, 0);
  assert.equal(final.agent_hint, "The old server key is stopped. The new key is in 2 workers.");
  assert.deepEqual(
    (final.workers as Line[]).map((w) => w.status),
    ["verified", "verified"],
  );
  const f = s.file();
  assert.equal(f.pending_step_up, null);
  assert.equal(s.tenant.prev, null, "the old key is stopped at the collector");
  assert.equal(s.tenant.write, keyHash(f.write_key!));
  const stepUp = s.runRequests().filter((r) => r.route === "step_up");
  assert.deepEqual(stepUp.map((r) => JSON.parse(r.body)), [{ purpose: "rotate_now" }]);
  const revoke = s.runRequests().filter((r) => r.route === "revoke_previous");
  assert.deepEqual(revoke.map((r) => JSON.parse(r.body)), [{ code: mailCode(s, "rotate_now") }]);
  // Step 2: GET /tenant every 10 s until server_time ≥ T_check + 60 s.
  const tCheck = latestVerified(s);
  const polls = waitPolls(s, at);
  assert.ok(polls.length >= 2, String(polls));
  assert.ok(polls.at(-1)! >= tCheck + MINUTE);
  assert.ok(polls.at(-2)! < tCheck + MINUTE);
  for (let i = 1; i < polls.length; i++) assert.equal(polls[i]! - polls[i - 1]!, 10_000);
  assertNoSecret(s, [mailCode(s, "rotate_now"), f.write_key, s.read]);
  assert.deepEqual(s.fake.violations, []);
});

test("--now: server_time stands still → network_error after 90 s, nothing stopped", async (t) => {
  let local = 0;
  const s = await setup(t, {
    tty: true,
    workers: 1,
    deps: {
      now: () => local,
      sleep: async (ms) => {
        local += ms;
      },
    },
  });
  local = s.fake.now();
  let waitStart = 0;
  let polls = 0;
  s.fake.onRequest = (req) => {
    if (req.route === "tenant" && s.runRequests().some((r) => r.route === "test_nonce_status")) {
      if (polls === 0) waitStart = local;
      polls += 1;
    }
  };
  assert.equal(await s.rotate("--now"), 2);
  assert.equal(s.final().state, "network_error");
  assert.deepEqual(steps(s.lines()).at(-1), ["wait", "failed"]);
  assert.equal(polls, 10);
  assert.equal(local - waitStart, 90_000);
  assert.equal(routes(s).includes("step_up"), false);
  assert.ok(s.tenant.prev !== null);
});

test("--now: traffic with the old K between swap and put, then quiet → stopped", async (t) => {
  let afterSwap: (() => void) | null = null;
  const s = await setup(t, {
    tty: true,
    deps: {
      fetchImpl: async (input, init) => {
        const r = await fetch(input, init);
        // The swap is done at the collector; no worker has the new K yet.
        if (String(input).endsWith("/tenant/rotate")) afterSwap?.();
        return r;
      },
    },
  });
  let putsAtTraffic = -1;
  afterSwap = () => {
    putsAtTraffic = s.workers.reduce((n, w) => n + w.puts(), 0);
    assert.equal(s.fake.ingest(s.oldKey), true);
    s.fake.advance(1000);
  };
  let seenAtStop: number | null = null;
  s.fake.onRequest = (req) => {
    if (req.route === "revoke_previous") seenAtStop = s.tenant.prevLastSeenAt;
  };
  assert.equal(await s.rotate("--now"), 0);
  assert.equal(s.final().state, "old_key_stopped");
  assert.ok(seenAtStop !== null && seenAtStop < latestVerified(s), "the old key was seen, but before T_check");
  assert.equal(putsAtTraffic, 0, "the traffic came between swap and put");
});

test("--now: an unknown worker uses the old K after T_check → old_key_still_used naming --force-stop", async (t) => {
  const s = await setup(t, { tty: true });
  let polls = 0;
  let seenAt = 0;
  s.fake.onRequest = (req) => {
    if (req.route === "tenant" && s.runRequests().some((r) => r.route === "test_nonce_status") && ++polls === 1) {
      s.fake.ingest(s.oldKey);
      seenAt = s.fake.now();
    }
  };
  assert.equal(await s.rotate("--now"), 1);
  const final = s.final();
  assert.equal(final.state, "old_key_still_used");
  assert.equal(final.last_seen, new Date(seenAt).toISOString());
  assert.ok(seenAt > latestVerified(s));
  assert.equal(
    final.agent_hint,
    `A worker this computer does not know still uses the old key (last seen ${new Date(seenAt).toISOString()}). Run op8x init in its folder, then run op8x rotate --now again. If the key leaked, run op8x rotate --now --force-stop.`,
  );
  assert.deepEqual(steps(s.lines()).at(-1), ["wait", "failed"]);
  assert.equal(routes(s).includes("step_up"), false);
  assert.equal(routes(s).includes("revoke_previous"), false);
  assert.equal(s.file().pending_step_up, null);
});

test("--now: traffic with the old K between step-up and code → old_key_still_used, no revoke-previous, code unspent", async (t) => {
  const s = await setup(t, { tty: true });
  s.deps.readHidden = async () => {
    s.fake.advance(1000);
    s.fake.ingest(s.oldKey);
    return mailCode(s, "rotate_now");
  };
  assert.equal(await s.rotate("--now"), 1);
  assert.equal(s.final().state, "old_key_still_used");
  assert.deepEqual(steps(s.lines()).slice(-2), [
    ["code", "ok"],
    ["stop", "failed"],
  ]);
  assert.equal(routes(s).includes("revoke_previous"), false);
  assert.equal(s.tenant.codes.get("rotate_now")?.used, false);
  assert.equal(s.file().pending_step_up, null);
  assert.ok(s.tenant.prev !== null);
});

test("--now case (b): rotation open and K current → test, wait, code, stop without POST rotate", async (t) => {
  const s = await setup(t, { tty: true, previous: true });
  assert.equal(await s.rotate("--now"), 0);
  assert.deepEqual(steps(s.lines()), [
    ["test", "ok"],
    ["wait", "ok"],
    ["code", "ok"],
    ["stop", "ok"],
  ]);
  assert.equal(s.final().state, "old_key_stopped");
  assert.equal(routes(s).includes("rotate"), false);
  for (const w of s.workers) assert.equal(w.puts(), 0);
  assert.equal(s.tenant.prev, null);
});

test("--now case (b): a worker with another key_fingerprint gets K first (step key)", async (t) => {
  const s = await setup(t, { tty: true, previous: true });
  const f = s.file();
  await writeAccount(s.deps, { ...f, workers: [f.workers[0]!, { ...f.workers[1]!, key_fingerprint: "00000000" }] });
  assert.equal(await s.rotate("--now"), 0);
  assert.deepEqual(steps(s.lines()).map((x) => x[0]), ["key", "test", "wait", "code", "stop"]);
  assert.equal(s.workers[0]!.puts(), 0);
  assert.equal(s.workers[1]!.puts(), 1);
  assert.equal(s.file().workers[1]!.key_fingerprint, keyFingerprint(s.oldKey));
});

test("--now case (c) with a TTY: both codes in one run; replace_current keeps the workers running", async (t) => {
  const s = await setup(t, { tty: true, local: "previous" });
  assert.equal(await s.rotate("--now"), 0);
  assert.deepEqual(steps(s.lines()), [
    ["code", "ok"],
    ["new_key", "ok"],
    ["key", "ok"],
    ["test", "ok"],
    ["wait", "ok"],
    ["code", "ok"],
    ["stop", "ok"],
  ]);
  for (const l of s.lines().filter((x) => x.event === "step")) assert.equal(l.of, 7);
  assert.equal(s.final().state, "old_key_stopped");
  assert.deepEqual(
    s.fake.mails.map((m) => m.purpose),
    ["replace_current", "rotate_now"],
  );
  const f = s.file();
  const rotateBodies = s.runRequests().filter((r) => r.route === "rotate").map((r) => JSON.parse(r.body) as Line);
  assert.deepEqual(rotateBodies, [{ kind: "write", new_sha256: keyHash(f.write_key!), replace_current: true, code: mailCode(s, "replace_current") }]);
  assert.equal(s.tenant.write, keyHash(f.write_key!));
  assert.equal(s.tenant.prev, null);
  for (const w of s.workers) assert.equal(w.key(), f.write_key);
  assertNoSecret(s, [mailCode(s, "replace_current"), mailCode(s, "rotate_now")]);
});

test("--now case (d): no local K → server_key_missing (rotate --now variant while a rotation runs)", async (t) => {
  const s = await setup(t, { tty: true, local: "none", previous: true });
  assert.equal(await s.rotate("--now"), 1);
  assert.equal(s.final().state, "server_key_missing");
  assert.match(String(s.final().agent_hint), /, or run op8x rotate --now\.$/);
  assert.deepEqual(routes(s), ["tenant"]);
});

test("--now case (e) with an open previous key: like (c), K into all known workers", async (t) => {
  const s = await setup(t, { tty: true, local: "stale", previous: true });
  assert.equal(await s.rotate("--now"), 0);
  assert.deepEqual(steps(s.lines()).map((x) => x[0]), ["code", "new_key", "key", "test", "wait", "code", "stop"]);
  assert.equal(s.final().state, "old_key_stopped");
  for (const w of s.workers) assert.equal(w.puts(), 1);
  assert.equal(JSON.parse(s.runRequests().find((r) => r.route === "rotate")!.body).replace_current, true);
});

test("--now case (e) without a previous key: like (a)", async (t) => {
  const s = await setup(t, { tty: true, local: "stale" });
  assert.equal(await s.rotate("--now"), 0);
  assert.deepEqual(steps(s.lines()).map((x) => x[0]), ["new_key", "key", "test", "wait", "code", "stop"]);
  assert.equal(s.final().state, "old_key_stopped");
  assert.equal(JSON.parse(s.runRequests().find((r) => r.route === "rotate")!.body).replace_current, undefined);
});

test("--now: a code of another purpose → code_invalid, the waiting step stays", async (t) => {
  const s = await setup(t, { tty: true });
  const api = createApi({ now: () => s.fake.now(), sleep: async () => {} }, s.fake.url);
  assert.equal((await api.stepUp(s.read, "delete")).ok, true);
  const deleteCode = mailCode(s, "delete");
  s.deps.readHidden = async () => deleteCode;
  assert.equal(await s.rotate("--now"), 1);
  assert.equal(s.final().state, "code_invalid");
  assert.equal(s.final().attempts_left, 4);
  assert.equal(s.final().agent_hint, "The code is not right. 4 tries left. Ask your human for the newest code.");
  const p = s.file().pending_step_up;
  assert.equal(p?.purpose, "rotate_now");
  assert.equal(p?.case, "a");
  assert.ok(s.tenant.prev !== null);
});

test("--now with a TTY: an empty answer (stdin closed) → invalid_input, no code sent", async (t) => {
  const s = await setup(t, { tty: true, workers: 1 });
  s.deps.readHidden = async () => "";
  assert.equal(await s.rotate("--now"), 4);
  assert.equal(s.final().state, "invalid_input");
  assert.equal(routes(s).includes("revoke_previous"), false);
  assert.equal(s.file().pending_step_up?.purpose, "rotate_now");
});

test("--now: the output guard stops after the code step line, before the step-up", async (t) => {
  const s = await setup(t, { tty: true, workers: 1 });
  s.deps.env = { ...s.deps.env, OP8X_TEST_TOKEN: '"name":"code","status":"start"' };
  assert.equal(await s.rotate("--now"), 2);
  assert.equal(s.final().state, "internal_error");
  assert.equal(routes(s).includes("step_up"), false);
});

test("--now: step-up limit reached → rate_limited with retry_at", async (t) => {
  const s = await setup(t, { tty: true, workers: 1 });
  s.tenant.stepUpCounts.set(`${s.tenant.read}|read|${new Date(s.fake.now()).toISOString().slice(0, 10)}`, 3);
  assert.equal(await s.rotate("--now"), 1);
  assert.equal(s.final().state, "rate_limited");
  assert.match(String(s.final().agent_hint), /^Too many requests\. Try again after \d{4}-\d\d-\d\dT[\d:]+Z\.$/);
});

// --- without a TTY: step_up_needed and --code-stdin ----------------------------------------------------

const STEP_UP_HINT = "Ask your human for the code from the mail, then run the same command with --code-stdin and pass the code on stdin.";

test("--now without a TTY, case (a): step_up_needed with the step stored, then --code-stdin stops", async (t) => {
  const s = await setup(t);
  assert.equal(await s.rotate("--now"), 1);
  assert.deepEqual(steps(s.lines()), [
    ["new_key", "ok"],
    ["key", "ok"],
    ["test", "ok"],
    ["wait", "ok"],
    ["code", "ok"],
  ]);
  for (const l of s.lines().filter((x) => x.event === "step")) assert.equal(l.of, 5);
  assert.equal(s.final().state, "step_up_needed");
  assert.equal(s.final().agent_hint, STEP_UP_HINT);
  const stepUp = s.runRequests().find((r) => r.route === "step_up");
  const p = s.file().pending_step_up;
  assert.deepEqual(p, {
    purpose: "rotate_now",
    command: "rotate",
    case: "a",
    phase: "stop",
    force_stop: false,
    t_check: new Date(latestVerified(s)).toISOString(),
    expires_at: new Date(s.tenant.codes.get("rotate_now")!.expiresAt).toISOString(),
  });
  assert.ok(stepUp);

  const code = mailCode(s, "rotate_now");
  s.deps.readStdin = async () => `${code}\n`;
  assert.equal(await s.rotate("--now", "--code-stdin"), 0);
  assert.deepEqual(steps(s.lines()), [
    ["code", "ok"],
    ["stop", "ok"],
  ]);
  for (const l of s.lines().filter((x) => x.event === "step")) assert.equal(l.of, 2);
  assert.equal(s.final().state, "old_key_stopped");
  assert.equal(s.file().pending_step_up, null);
  assert.equal(routes(s).includes("step_up"), false);
  assert.equal(s.tenant.prev, null);
  assertNoSecret(s, [code]);
});

test("--now without a TTY, case (c): three runs, two codes; run 2 starts exactly the next step-up", async (t) => {
  const s = await setup(t, { local: "previous" });
  assert.equal(await s.rotate("--now"), 1);
  assert.deepEqual(steps(s.lines()), [["code", "ok"]]);
  assert.equal(s.final().state, "step_up_needed");
  assert.deepEqual(routes(s), ["tenant", "step_up"]);
  const p1 = s.file().pending_step_up;
  assert.equal(p1?.purpose, "replace_current");
  assert.equal(p1?.case, "c");
  assert.equal(p1?.phase, "replace");
  assert.equal(p1?.t_check, null);

  s.deps.readStdin = async () => mailCode(s, "replace_current");
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.deepEqual(steps(s.lines()).map((x) => x[0]), ["code", "new_key", "key", "test", "wait", "code"]);
  assert.equal(s.final().state, "step_up_needed");
  const stepUps = s.runRequests().filter((r) => r.route === "step_up").map((r) => JSON.parse(r.body));
  assert.deepEqual(stepUps, [{ purpose: "rotate_now" }]);
  const rotateBody = JSON.parse(s.runRequests().find((r) => r.route === "rotate")!.body) as Line;
  assert.equal(rotateBody.replace_current, true);
  const f2 = s.file();
  assert.equal(f2.write_key_next, null);
  assert.equal(s.tenant.write, keyHash(f2.write_key!));
  assert.equal(f2.pending_step_up?.purpose, "rotate_now");
  assert.equal(f2.pending_step_up?.case, "c");
  assert.equal(f2.pending_step_up?.t_check, new Date(latestVerified(s)).toISOString());

  s.deps.readStdin = async () => mailCode(s, "rotate_now");
  assert.equal(await s.rotate("--now", "--code-stdin"), 0);
  assert.equal(s.final().state, "old_key_stopped");
  assert.equal(s.file().pending_step_up, null);
  assert.equal(s.tenant.prev, null);
});

test("--code-stdin without a waiting step → no_pending_step, nothing sent", async (t) => {
  const s = await setup(t);
  s.deps.readStdin = async () => "ABCD1234";
  assert.equal(await s.rotate("--now", "--code-stdin"), 4);
  assert.equal(s.final().state, "no_pending_step");
  assert.equal(s.final().agent_hint, "There is no step waiting for a code. Run the command without --code-stdin.");
  assert.deepEqual(s.runRequests(), []);
});

const pendingOf = (o: Partial<PendingStepUp>): PendingStepUp => ({
  purpose: "rotate_now",
  command: "rotate",
  case: "a",
  phase: "stop",
  force_stop: false,
  t_check: "2026-11-03T14:00:00.000Z",
  expires_at: "2026-11-03T14:15:00.000Z",
  ...o,
});

test("--code-stdin with an expired step → code_expired, the step goes, nothing sent", async (t) => {
  const s = await setup(t, { file: { pending_step_up: pendingOf({ expires_at: "2026-11-03T14:04:59.000Z" }) } });
  s.deps.readStdin = async () => "ABCD1234";
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.equal(s.final().state, "code_expired");
  assert.equal(s.final().agent_hint, "The code expired. Run the command again for a new code.");
  assert.equal(s.file().pending_step_up, null);
  assert.deepEqual(s.runRequests(), []);
});

test("--code-stdin that does not fit the waiting step (command or --force-stop) → no_pending_step, the step stays", async (t) => {
  const del = pendingOf({ purpose: "delete", command: "delete", case: null, phase: "delete", t_check: null });
  const s = await setup(t, { file: { pending_step_up: del } });
  s.deps.readStdin = async () => "ABCD1234";
  assert.equal(await s.rotate("--now", "--code-stdin"), 4);
  assert.equal(s.final().state, "no_pending_step");
  assert.equal(
    s.final().agent_hint,
    "The waiting step belongs to op8x delete. Run that same command with --code-stdin, or run this one without --code-stdin.",
  );
  assert.deepEqual(s.file().pending_step_up, del);

  await writeAccount(s.deps, { ...s.file(), pending_step_up: pendingOf({}) });
  assert.equal(await s.rotate("--now", "--force-stop", "--code-stdin"), 4);
  assert.equal(s.final().state, "no_pending_step");
  assert.match(String(s.final().agent_hint), /^The waiting step belongs to op8x rotate --now\. /);
  assert.deepEqual(s.file().pending_step_up, pendingOf({}));
  assert.deepEqual(s.runRequests(), []);
});

test("--code-stdin: spaces, hyphens and lower case are accepted; 7 characters, other signs or U → invalid_input, nothing sent", async (t) => {
  const s = await setup(t, { workers: 1 });
  assert.equal(await s.rotate("--now"), 1);
  const code = mailCode(s, "rotate_now");
  const stored = s.file().pending_step_up;
  for (const bad of ["ABC1234", "ABCD$EFG", "ABCDEFGU", "ABCD12345", ""]) {
    s.deps.readStdin = async () => `${bad}\n`;
    assert.equal(await s.rotate("--now", "--code-stdin"), 4, bad);
    assert.equal(s.final().state, "invalid_input");
    assert.equal(s.final().agent_hint, "The code must be 8 letters or digits. Ask your human for the code from the mail and pass it again.");
    assert.deepEqual(s.runRequests(), [], bad);
    assert.deepEqual(s.file().pending_step_up, stored);
  }
  s.deps.readStdin = async () => `  ${code.slice(0, 4).toLowerCase()}-${code.slice(4)}  \n`;
  assert.equal(await s.rotate("--now", "--code-stdin"), 0);
  assert.equal(s.final().state, "old_key_stopped");
});

test("pending_step_up stays on code_invalid and goes on code_exhausted", async (t) => {
  const s = await setup(t, { workers: 1 });
  assert.equal(await s.rotate("--now"), 1);
  const stored = s.file().pending_step_up;
  s.deps.readStdin = async () => "00000000";
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.equal(s.final().state, "code_invalid");
  assert.deepEqual(s.file().pending_step_up, stored);
  s.tenant.codes.get("rotate_now")!.attempts = 4;
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.equal(s.final().state, "code_exhausted");
  assert.equal(s.final().agent_hint, "Too many wrong codes. Run the command again for a new code.");
  assert.equal(s.file().pending_step_up, null);
});

test("pending_step_up goes on nothing_to_stop (no previous key seen, and 409 no_previous)", async (t) => {
  const s = await setup(t, { workers: 1 });
  assert.equal(await s.rotate("--now"), 1);
  s.tenant.prev = null;
  s.tenant.prevUntil = null;
  s.deps.readStdin = async () => mailCode(s, "rotate_now");
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.equal(s.final().state, "nothing_to_stop");
  assert.equal(s.final().agent_hint, "The old key is already stopped.");
  assert.equal(routes(s).includes("revoke_previous"), false);
  assert.equal(s.file().pending_step_up, null);

  // The collector answers 409 no_previous (the key ended between GET /tenant and the stop).
  const s2 = await setup(t, { tty: true, workers: 1, previous: true });
  s2.fake.onRequest = (req) => {
    if (req.route === "revoke_previous") s2.tenant.prev = null;
  };
  assert.equal(await s2.rotate("--now"), 1);
  assert.equal(s2.final().state, "nothing_to_stop");
  assert.equal(s2.file().pending_step_up, null);
});

test("pending_step_up goes on old_key_still_used (old K seen between the runs); no code is spent", async (t) => {
  const s = await setup(t, { workers: 1 });
  assert.equal(await s.rotate("--now"), 1);
  s.fake.advance(2 * MINUTE);
  s.fake.ingest(s.oldKey);
  s.deps.readStdin = async () => mailCode(s, "rotate_now");
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.equal(s.final().state, "old_key_still_used");
  assert.equal(routes(s).includes("revoke_previous"), false);
  assert.equal(s.tenant.codes.get("rotate_now")?.used, false);
  assert.equal(s.file().pending_step_up, null);
});

test("pending_step_up goes on partial (a worker fails after replace_current in run 2)", async (t) => {
  const s = await setup(t, { local: "previous" });
  assert.equal(await s.rotate("--now"), 1);
  s.workers[1]!.wrangler.answer("put", { exit: 1 });
  s.deps.readStdin = async () => mailCode(s, "replace_current");
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.equal(s.final().state, "partial");
  assert.equal(s.file().pending_step_up, null);
  assert.equal(routes(s).includes("step_up"), false);
  assert.equal(s.tenant.write, keyHash(s.file().write_key!), "the replacement itself happened");
});

test("a second run without --code-stdin within 10 minutes: code_already_sent, no new mail", async (t) => {
  const s = await setup(t, { workers: 1 });
  assert.equal(await s.rotate("--now"), 1);
  const expires = s.file().pending_step_up?.expires_at;
  assert.equal(await s.rotate("--now"), 1);
  assert.equal(s.final().state, "step_up_needed");
  const notices = s.lines().filter((l) => l.event === "notice" && l.id === "code_already_sent");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.text, "A code was already sent in the last 10 minutes. Check your mail for it.");
  assert.equal(s.fake.mails.length, 1);
  assert.equal(s.file().pending_step_up?.expires_at, expires);
  assert.equal(s.file().pending_step_up?.case, "b");
});

// --- --force-stop --------------------------------------------------------------------------------------

test("--force-stop only with --now, --code-stdin only with --now", async () => {
  for (const argv of [["rotate", "--force-stop"], ["rotate", "--code-stdin"], ["rotate", "--force-stop", "--code-stdin"], ["rotate", "--bogus"], ["rotate", "x"], ["rotate", "--now=yes"]]) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 4, argv.join(" "));
    assert.match(deps.stderr(), /Usage: op8x rotate/, argv.join(" "));
  }
  for (const argv of [["rotate"], ["rotate", "--now"], ["rotate", "--now", "--force-stop"], ["rotate", "--now", "--code-stdin"], ["--json", "rotate", "--now", "--force-stop", "--code-stdin"]]) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 1, argv.join(" "));
    assert.equal(deps.stderr(), "", argv.join(" "));
    assert.match(deps.stdout(), /not signed in/, argv.join(" "));
  }
});

test("--now --force-stop without a TTY: test and wait drop out; t_check null; the stop needs the code but no check", async (t) => {
  const s = await setup(t);
  assert.equal(await s.rotate("--now", "--force-stop"), 1);
  assert.deepEqual(steps(s.lines()), [
    ["new_key", "ok"],
    ["key", "ok"],
    ["code", "ok"],
  ]);
  assert.equal(routes(s).includes("test_nonce"), false);
  const p = s.file().pending_step_up;
  assert.equal(p?.force_stop, true);
  assert.equal(p?.t_check, null);
  // The old K is still in use: with force_stop the stop happens anyway.
  s.fake.advance(2 * MINUTE);
  s.fake.ingest(s.oldKey);
  s.deps.readStdin = async () => mailCode(s, "rotate_now");
  assert.equal(await s.rotate("--now", "--force-stop", "--code-stdin"), 0);
  assert.equal(s.final().state, "old_key_stopped");
  assert.equal(s.tenant.prev, null);
});

test("--now --force-stop: workers without url do not hold it up", async (t) => {
  const s = await setup(t, { tty: true, noUrl: [1] });
  assert.equal(await s.rotate("--now", "--force-stop"), 0);
  assert.deepEqual(steps(s.lines()).map((x) => x[0]), ["new_key", "key", "code", "stop"]);
  assert.equal(s.final().state, "old_key_stopped");
  assert.deepEqual(
    (s.final().workers as Line[]).map((w) => w.status),
    ["unverified", "no_url"],
  );
});

test("--now without --force-stop: no known worker → old_key_still_used; nothing rotated", async (t) => {
  const s = await setup(t, { tty: true, workers: 0 });
  assert.equal(await s.rotate("--now"), 1);
  assert.equal(s.final().state, "old_key_still_used");
  assert.equal(s.final().last_seen, null);
  assert.equal(s.final().exit_code, 1);
  assert.equal(
    s.final().agent_hint,
    "No worker is known on this computer. Run op8x init in every worker folder, then run op8x rotate --now again. If the key leaked, run op8x rotate --now --force-stop.",
  );
  assert.deepEqual(routes(s), ["tenant"]);
});

test("--now without --force-stop: known workers without url → url_required naming them; nothing rotated", async (t) => {
  const s = await setup(t, { tty: true, noUrl: [1] });
  assert.equal(await s.rotate("--now"), 1);
  assert.equal(s.final().state, "url_required");
  assert.deepEqual(s.final().workers, [{ name: "api2", env: null, env_file: null, status: "no_url" }]);
  assert.equal(
    s.final().agent_hint,
    "These workers have no test address: api2. Run op8x init --url https://… in their folders, or run op8x rotate --now --force-stop.",
  );
  assert.deepEqual(routes(s), ["tenant"]);
});

test("--now --force-stop: a worker that fails to get K → partial, nothing stopped, no step-up", async (t) => {
  const s = await setup(t, { tty: true });
  s.workers[1]!.wrangler.answer("put", { exit: 1 });
  assert.equal(await s.rotate("--now", "--force-stop"), 1);
  assert.equal(s.final().state, "partial");
  assert.equal(routes(s).includes("step_up"), false);
  assert.ok(s.tenant.prev !== null);
});

// --- readHidden ----------------------------------------------------------------------------------------

test("readHidden settles with an empty answer when stdin ends, and never echoes", async () => {
  const closed = new PassThrough();
  let shown = "";
  const sink = { write: (s: string) => ((shown += s), true) };
  const pending = readHiddenFrom("Code from the mail: ", closed, sink);
  closed.end();
  assert.equal(await pending, "");

  const typed = new PassThrough();
  shown = "";
  const answer = readHiddenFrom("Code from the mail: ", typed, sink);
  typed.write("ABCD1234\n");
  assert.equal(await answer, "ABCD1234");
  assert.equal(shown.includes("ABCD1234"), false);
  assert.ok(shown.startsWith("Code from the mail: "));
});

// --- a replace_current step that ends unredeemed -------------------------------------------------

test("code_invalid in run 2, then expiry: code_expired settles write_key_next; init later sends no POST rotate", async (t) => {
  const s = await setup(t, { local: "previous" });
  assert.equal(await s.rotate("--now"), 1);
  s.deps.readStdin = async () => "00000000";
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.equal(s.final().state, "code_invalid");
  const orphan = s.file().write_key_next;
  assert.ok(orphan !== null, "run 2 stored the next K before the refused request");
  assert.equal(s.file().pending_step_up?.purpose, "replace_current");

  s.fake.advance(11 * MINUTE);
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.equal(s.final().state, "code_expired");
  assert.equal(s.file().pending_step_up, null);
  assert.equal(s.file().write_key_next, null, "the next K is discarded, not left behind");

  // The predecessor ends meanwhile: a plain POST rotate with the orphan would now really swap.
  s.tenant.prev = null;
  s.tenant.prevUntil = null;
  s.deps.cwd = s.workers[0]!.wrangler.dir;
  const before = s.fake.requests.length;
  await run(["init", "--json", "--url", `${s.workers[0]!.worker.origin}/paid`], s.deps);
  assert.ok(s.fake.requests.length > before, "init asked the collector");
  assert.equal(s.fake.requests.slice(before).some((r) => r.route === "rotate"), false);
  assert.equal(s.file().write_key_next, null);
  assert.notEqual(s.tenant.write, keyHash(orphan));
});

test("login with a waiting replace_current settles its next K (discarded if not current, write_key if current)", async (t) => {
  for (const current of [false, true]) {
    const s = await setup(t, { local: "previous", workers: 1 });
    const next = generateKey("w");
    if (current) s.tenant.write = keyHash(next);
    const pending: PendingStepUp = {
      purpose: "replace_current",
      command: "rotate",
      case: "c",
      phase: "replace",
      force_stop: false,
      t_check: null,
      expires_at: "2026-11-03T14:15:00.000Z",
    };
    await writeAccount(s.deps, { ...s.file(), write_key_next: next, pending_step_up: pending });
    let granted = false;
    s.fake.onRequest = (req) => {
      if (req.route === "device_token" && !granted) {
        granted = true;
        s.fake.grant({ tenant: s.tenant.name });
      }
    };
    assert.equal(await run(["login", "--json"], s.deps), 0);
    const f = s.file();
    assert.equal(f.pending_step_up, null);
    assert.equal(f.write_key_next, null);
    assert.equal(f.write_key, current ? next : s.oldKey, String(current));
    assert.equal(s.fake.requests.some((r) => r.route === "rotate"), false);
  }
});

test("--code-stdin: the check before the code (no worker, no url) keeps the waiting step", async (t) => {
  const s = await setup(t, { local: "previous", workers: 2 });
  assert.equal(await s.rotate("--now"), 1);
  const stored = s.file().pending_step_up;
  const f = s.file();
  await writeAccount(s.deps, { ...f, workers: [f.workers[0]!, { ...f.workers[1]!, url: null }] });
  s.deps.readStdin = async () => mailCode(s, "replace_current");
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.equal(s.final().state, "url_required");
  assert.deepEqual(s.file().pending_step_up, stored);

  await writeAccount(s.deps, { ...s.file(), workers: [] });
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.equal(s.final().state, "old_key_still_used");
  assert.deepEqual(s.file().pending_step_up, stored);
  assert.equal(routes(s).includes("rotate"), false);
  assert.equal(s.tenant.codes.get("replace_current")?.used, false);
});

test("replace_current: the answer is lost after the swap; the same code again → no second request, promotion", async (t) => {
  let lose = false;
  const s = await setup(t, {
    local: "previous",
    deps: {
      fetchImpl: async (input, init) => {
        const r = await fetch(input, init);
        if (lose && String(input).endsWith("/tenant/rotate")) throw new TypeError("fetch failed");
        return r;
      },
    },
  });
  assert.equal(await s.rotate("--now"), 1);
  const code = mailCode(s, "replace_current");
  s.deps.readStdin = async () => code;
  lose = true;
  assert.equal(await s.rotate("--now", "--code-stdin"), 2);
  assert.equal(s.final().state, "network_error");
  const next = s.file().write_key_next;
  assert.ok(next !== null);
  assert.equal(s.tenant.write, keyHash(next), "the collector swapped");
  assert.equal(s.file().pending_step_up?.purpose, "replace_current");

  lose = false;
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.equal(s.final().state, "step_up_needed");
  assert.equal(routes(s).includes("rotate"), false, "no second request with the spent code");
  assert.equal(s.file().write_key, next);
  assert.equal(s.file().write_key_next, null);
  assert.equal(s.file().pending_step_up?.purpose, "rotate_now");
});

test("a fresh run with a waiting replace_current: next K current → write_key; not current → discarded, never sent", async (t) => {
  // current: the swap happened, the answer was lost.
  const a = await setup(t, { local: "previous" });
  assert.equal(await a.rotate("--now"), 1);
  const next = generateKey("w");
  a.tenant.write = keyHash(next);
  await writeAccount(a.deps, { ...a.file(), write_key_next: next });
  assert.equal(await a.rotate("--now"), 1);
  assert.equal(a.file().write_key, next);
  assert.equal(a.file().write_key_next, null);
  assert.equal(routes(a).includes("rotate"), false);
  assert.equal(a.final().state, "step_up_needed");
  assert.equal(a.file().pending_step_up?.purpose, "rotate_now", "now case (b)");

  // not current: never sent, the run starts over as (c).
  const b = await setup(t, { local: "previous" });
  assert.equal(await b.rotate("--now"), 1);
  const orphan = generateKey("w");
  await writeAccount(b.deps, { ...b.file(), write_key_next: orphan });
  assert.equal(await b.rotate("--now"), 1);
  assert.equal(routes(b).includes("rotate"), false);
  assert.equal(b.file().write_key_next, null);
  assert.equal(b.file().pending_step_up?.purpose, "replace_current");
});

// --- more runs without a TTY ----------------------------------------------------------------------------

test("--now without a TTY, case (b): test, wait, code (of 3), then --code-stdin stops", async (t) => {
  const s = await setup(t, { previous: true });
  assert.equal(await s.rotate("--now"), 1);
  assert.deepEqual(steps(s.lines()), [
    ["test", "ok"],
    ["wait", "ok"],
    ["code", "ok"],
  ]);
  for (const l of s.lines().filter((x) => x.event === "step")) assert.equal(l.of, 3);
  assert.equal(s.file().pending_step_up?.case, "b");
  s.deps.readStdin = async () => mailCode(s, "rotate_now");
  assert.equal(await s.rotate("--now", "--code-stdin"), 0);
  assert.equal(s.final().state, "old_key_stopped");
});

test("--now without a TTY, case (e) with a previous key: three runs, K into all known workers", async (t) => {
  const s = await setup(t, { local: "stale", previous: true });
  assert.equal(await s.rotate("--now"), 1);
  assert.deepEqual(steps(s.lines()), [["code", "ok"]]);
  assert.equal(s.file().pending_step_up?.case, "e");
  s.deps.readStdin = async () => mailCode(s, "replace_current");
  assert.equal(await s.rotate("--now", "--code-stdin"), 1);
  assert.deepEqual(steps(s.lines()).map((x) => x[0]), ["code", "new_key", "key", "test", "wait", "code"]);
  for (const l of s.lines().filter((x) => x.event === "step")) assert.equal(l.of, 6);
  for (const w of s.workers) assert.equal(w.puts(), 1);
  assert.equal(s.file().pending_step_up?.case, "e");
  s.deps.readStdin = async () => mailCode(s, "rotate_now");
  assert.equal(await s.rotate("--now", "--code-stdin"), 0);
  assert.equal(s.final().state, "old_key_stopped");
  assert.equal(s.tenant.prev, null);
});

test("--now: waiting gives up after at most 10 polls even if the local clock does not move", async (t) => {
  const s = await setup(t, { tty: true, workers: 1, deps: { now: () => 0, sleep: async () => {} } });
  let polls = 0;
  s.fake.onRequest = (req) => {
    if (req.route === "tenant" && s.runRequests().some((r) => r.route === "test_nonce_status")) polls += 1;
  };
  assert.equal(await s.rotate("--now"), 2);
  assert.equal(s.final().state, "network_error");
  assert.equal(polls, 10);
});
