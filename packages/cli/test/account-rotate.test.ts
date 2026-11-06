import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { generateKey, keyFingerprint, keyHash } from "../src/account/keys.ts";
import { accountPath, writeAccount } from "../src/account/store.ts";
import type { ActiveAccount, PendingStepUp, WorkerEntry } from "../src/account/store.ts";
import { exec as realExec } from "../src/account/system.ts";
import { run } from "../src/cli.ts";
import type { Deps } from "../src/cli.ts";
import { recordingExec, tempDir, testDeps } from "./account-deps.ts";
import type { ExecHandler } from "./account-deps.ts";
import { startFakeCollector } from "./fake-collector.ts";
import type { FakeCollector, FakeTenant } from "./fake-collector.ts";
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

test("rotate clears a waiting step of rotate (key_rotated is an end state)", async (t) => {
  const pending: PendingStepUp = {
    purpose: "rotate_now",
    command: "rotate",
    case: "b",
    phase: "stop",
    force_stop: false,
    t_check: "2026-11-03T14:00:00.000Z",
    expires_at: "2026-11-03T14:10:00.000Z",
  };
  const s = await setup(t, { workers: 1, file: { pending_step_up: pending } });
  assert.equal(await s.rotate(), 0);
  assert.equal(s.file().pending_step_up, null);
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

