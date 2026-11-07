import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { generateKey, keyFingerprint } from "../src/account/keys.ts";
import { accountPath, writeAccount } from "../src/account/store.ts";
import type { AccountFile, ActiveAccount, PendingStepUp, WorkerEntry } from "../src/account/store.ts";
import { exec as realExec } from "../src/account/system.ts";
import { run } from "../src/cli.ts";
import type { Deps } from "../src/cli.ts";
import { tempDir, testDeps } from "./account-deps.ts";
import { startFakeCollector } from "./fake-collector.ts";
import type { FakeCollector, FakeTenant } from "./fake-collector.ts";
import { createFakeWrangler, secretList } from "./fake-wrangler.ts";
import type { FakeWrangler } from "./fake-wrangler.ts";

type Line = Record<string, unknown>;

const CONTACT = "a***@acme.example";
const MINUTE = 60_000;

interface KnownWorker {
  wrangler: FakeWrangler;
  name: string;
  entry: WorkerEntry;
  deletes: () => string[][];
}

interface Setup {
  fake: FakeCollector;
  deps: ReturnType<typeof testDeps>;
  tenant: FakeTenant;
  read: string;
  key: string;
  workers: KnownWorker[];
  lines: () => Line[];
  final: () => Line;
  /** The op8x file as it is on disk, or null if it is gone. */
  file: () => AccountFile | null;
  /** Runs `op8x delete --json …args`; stdout of earlier runs is dropped first. */
  remove: (...args: string[]) => Promise<number>;
  runRequests: () => FakeCollector["requests"];
}

interface SetupOptions {
  workers?: number;
  tty?: boolean;
  deps?: Partial<Deps>;
  file?: Partial<ActiveAccount>;
  extraWorkers?: WorkerEntry[];
}

async function setup(t: TestContext, o: SetupOptions = {}): Promise<Setup> {
  const fake = await startFakeCollector();
  t.after(() => fake.close());
  const read = generateKey("r");
  const key = generateKey("w");
  const tenant = fake.addTenant({ readKey: read, writeKey: key, contactHint: CONTACT });
  const workers: KnownWorker[] = [];
  for (let i = 0; i < (o.workers ?? 2); i++) {
    const name = `api${i + 1}`;
    const wrangler = createFakeWrangler();
    wrangler.file("wrangler.toml", `name = "${name}"\n`);
    const entry: WorkerEntry = {
      dir: wrangler.dir,
      name,
      env: null,
      env_file: null,
      url: `https://${name}.example/paid`,
      deployed_at: "2026-11-01T10:00:00Z",
      verified_at: "2026-11-01T10:00:05Z",
      key_fingerprint: keyFingerprint(key),
    };
    const deletes = () =>
      wrangler
        .calls()
        .filter((c) => c.argv[0] === "secret" && c.argv[1] === "delete")
        .map((c) => c.argv);
    workers.push({ wrangler, name, entry, deletes });
  }
  const deps = testDeps({
    exec: realExec,
    now: () => fake.now(),
    sleep: async (ms) => {
      deps.sleeps.push(ms);
      fake.advance(ms);
    },
    stdinIsTTY: o.tty ?? false,
    readHidden: async () => fake.mails.at(-1)?.code ?? "",
    readStdin: async () => fake.mails.at(-1)?.code ?? "",
    env: { OP8X_COLLECTOR_URL: fake.url },
    ...o.deps,
  });
  const file: ActiveAccount = {
    schema: "op8x.account/1",
    collector: fake.url,
    account: tenant.name,
    contact_hint: CONTACT,
    read_token: read,
    write_key: key,
    write_key_next: null,
    salt: null,
    pending_step_up: null,
    deleted: null,
    workers: [...workers.map((w) => w.entry), ...(o.extraWorkers ?? [])],
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
    key,
    workers,
    lines,
    final: () => lines().at(-1) ?? {},
    file: () => (existsSync(accountPath(deps)) ? (JSON.parse(readFileSync(accountPath(deps), "utf8")) as AccountFile) : null),
    remove: async (...args) => {
      firstRequest = fake.requests.length;
      const before = deps.stdout().length;
      const code = await run(["delete", "--json", ...args], deps);
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

const deleteArgv = (w: KnownWorker) => ["secret", "delete", "OP8X_KEY", "--name", w.name, "--config", join(w.wrangler.dir, "wrangler.toml")];

const ALL_OK: [string, string][] = [
  ["code", "ok"],
  ["delete_account", "ok"],
  ["remove_secrets", "ok"],
  ["remove_file", "ok"],
];

// --- the whole run ----------------------------------------------------------------------------------

test("delete with a TTY: step-up, POST delete {code}, secret delete per worker, then the file; deleted with receipt", async (t) => {
  const s = await setup(t, { tty: true });
  let wranglerAtDelete = -1;
  s.fake.onRequest = (req) => {
    if (req.route === "delete") wranglerAtDelete = s.workers.reduce((n, w) => n + w.deletes().length, 0);
  };
  assert.equal(await s.remove(), 0);
  assert.deepEqual(steps(s.lines()), ALL_OK);
  for (const l of s.lines().filter((x) => x.event === "step")) assert.equal(l.of, 4);
  assert.deepEqual(routes(s), ["step_up", "delete"]);
  const stepUp = s.runRequests()[0]!;
  assert.deepEqual(JSON.parse(stepUp.body), { purpose: "delete" });
  assert.equal(stepUp.headers.authorization, `Bearer ${s.read}`);
  const del = s.runRequests()[1]!;
  const code = s.fake.lastCode(s.tenant.name, "delete");
  assert.deepEqual(JSON.parse(del.body), { code });
  assert.equal(del.headers.authorization, `Bearer ${s.read}`);
  assert.equal(wranglerAtDelete, 0, "no secret delete before the account is deleted");
  for (const w of s.workers) {
    assert.deepEqual(w.deletes(), [deleteArgv(w)]);
    const call = w.wrangler.calls().find((c) => c.argv[1] === "delete")!;
    assert.equal(call.stdin, "");
  }
  assert.equal(s.file(), null);
  assert.equal(s.fake.tenant(s.tenant.name).deleted, true);
  const final = s.final();
  assert.equal(final.command, "delete");
  assert.equal(final.state, "deleted");
  assert.equal(final.exit_code, 0);
  const receipt = final.receipt as Line;
  assert.deepEqual(Object.keys(receipt), ["action_id", "tenant", "ended_at"]);
  assert.match(String(receipt.action_id), /^[0-9a-f-]{36}$/);
  assert.equal(receipt.tenant, s.tenant.name);
  assert.equal(receipt.ended_at, new Date(s.fake.now()).toISOString());
  assert.equal(final.agent_hint, `The account is deleted. Receipt: ${String(receipt.action_id)}.`);
  assertNoSecret(s, [s.read, s.key, code]);
  assert.deepEqual(s.fake.violations, []);
});

test("delete without a TTY: step_up_needed with the stored step, then --code-stdin deletes", async (t) => {
  const s = await setup(t);
  assert.equal(await s.remove(), 1);
  assert.deepEqual(steps(s.lines()), [["code", "ok"]]);
  for (const l of s.lines().filter((x) => x.event === "step")) assert.equal(l.of, 4);
  assert.equal(s.final().state, "step_up_needed");
  assert.equal(
    s.final().agent_hint,
    "Ask your human for the code from the mail, then run the same command with --code-stdin and pass the code on stdin.",
  );
  assert.deepEqual(routes(s), ["step_up"]);
  const f = s.file() as ActiveAccount;
  assert.deepEqual(f.pending_step_up, {
    purpose: "delete",
    command: "delete",
    case: null,
    phase: "delete",
    force_stop: false,
    t_check: null,
    expires_at: new Date(s.fake.tenant(s.tenant.name).codes.get("delete")!.expiresAt).toISOString(),
  });

  assert.equal(await s.remove("--code-stdin"), 0);
  assert.deepEqual(steps(s.lines()), ALL_OK);
  assert.deepEqual(routes(s), ["delete"]);
  assert.equal(s.final().state, "deleted");
  assert.equal(s.file(), null);
  for (const w of s.workers) assert.equal(w.deletes().length, 1);
  assertNoSecret(s, [s.read, s.key, s.fake.lastCode(s.tenant.name, "delete")]);
});

test("delete again within 10 minutes: notice code_already_sent, no second mail; that code still works", async (t) => {
  const s = await setup(t);
  assert.equal(await s.remove(), 1);
  s.fake.advance(2 * MINUTE);
  assert.equal(await s.remove(), 1);
  const notice = s.lines().find((l) => l.event === "notice");
  assert.deepEqual(notice, {
    schema: "op8x.cli/1",
    command: "delete",
    final: false,
    event: "notice",
    id: "code_already_sent",
    text: "A code was already sent in the last 10 minutes. Check your mail for it.",
  });
  assert.equal(s.fake.mails.length, 1);
  assert.equal(s.final().state, "step_up_needed");
  assert.equal(await s.remove("--code-stdin"), 0);
  assert.equal(s.final().state, "deleted");
});

test("delete in text mode", async (t) => {
  const s = await setup(t, { tty: true, workers: 1 });
  const before = s.deps.stdout().length;
  assert.equal(await run(["delete"], s.deps), 0);
  const text = s.deps.stdout().slice(before).trimEnd().split("\n");
  assert.equal(text[0], "Step 1 of 4: code");
  assert.match(text[1] ?? "", /^Step 1 of 4: code ok \(\d+ ms\)$/);
  assert.equal(text[2], "Step 2 of 4: delete_account");
  assert.equal(text[4], "Step 3 of 4: remove_secrets");
  assert.equal(text[6], "Step 4 of 4: remove_file");
  assert.match(text[8] ?? "", /^The account is deleted\. Receipt: [0-9a-f-]{36}\.$/);
  assert.equal(text.length, 9);
});

// --- the waiting step -------------------------------------------------------------------------------

const rotateStep: PendingStepUp = {
  purpose: "rotate_now",
  command: "rotate",
  case: "a",
  phase: "stop",
  force_stop: false,
  t_check: "2026-11-03T14:00:00Z",
  expires_at: "2026-11-03T14:15:00Z",
};

test("delete --code-stdin with a waiting step of rotate: no_pending_step, the step stays, nothing sent", async (t) => {
  const s = await setup(t, { file: { pending_step_up: rotateStep } });
  const before = readFileSync(accountPath(s.deps), "utf8");
  assert.equal(await s.remove("--code-stdin"), 4);
  assert.equal(s.final().state, "no_pending_step");
  assert.equal(
    s.final().agent_hint,
    "The waiting step belongs to op8x rotate --now. Run that same command with --code-stdin, or run this one without --code-stdin.",
  );
  assert.equal(readFileSync(accountPath(s.deps), "utf8"), before);
  assert.equal(s.runRequests().length, 0);
  for (const w of s.workers) assert.equal(w.deletes().length, 0);
});

test("delete --code-stdin without a waiting step: no_pending_step; with an expired one: code_expired, the step goes", async (t) => {
  const s = await setup(t);
  assert.equal(await s.remove("--code-stdin"), 4);
  assert.equal(s.final().state, "no_pending_step");
  assert.equal(s.final().agent_hint, "There is no step waiting for a code. Run the command without --code-stdin.");
  assert.equal(s.runRequests().length, 0);

  assert.equal(await s.remove(), 1);
  s.fake.advance(11 * MINUTE);
  assert.equal(await s.remove("--code-stdin"), 1);
  assert.equal(s.final().state, "code_expired");
  assert.equal(s.runRequests().length, 0);
  assert.equal((s.file() as ActiveAccount).pending_step_up, null);
  assert.equal(s.fake.tenant(s.tenant.name).deleted, false);
});

test("a fresh delete run replaces a waiting rotate step; a replace_current step settles its next K first", async (t) => {
  const next = generateKey("w");
  const replace: PendingStepUp = { ...rotateStep, purpose: "replace_current", case: "c", phase: "replace", t_check: null };
  const s = await setup(t, { file: { pending_step_up: replace, write_key_next: next } });
  assert.equal(await s.remove(), 1);
  assert.equal(s.final().state, "step_up_needed");
  const f = s.file() as ActiveAccount;
  assert.equal(f.pending_step_up?.command, "delete");
  // The next K is not the account's current key: discarded, never sent as a plain rotation.
  assert.equal(f.write_key_next, null);
  assert.equal(f.write_key, s.key);
  assert.equal(routes(s).includes("rotate"), false);
  assertNoSecret(s, [next]);
});

test("a waiting rotate step survives a delete run whose step-up fails", async (t) => {
  const s = await setup(t, { file: { pending_step_up: rotateStep } });
  s.fake.respond("step_up", "server_error");
  assert.equal(await s.remove(), 2);
  assert.equal(s.final().state, "network_error");
  assert.deepEqual((s.file() as ActiveAccount).pending_step_up, rotateStep);
});

test("code_invalid keeps the step; code_exhausted ends it; invalid_input sends nothing", async (t) => {
  const s = await setup(t);
  assert.equal(await s.remove(), 1);
  const real = s.fake.lastCode(s.tenant.name, "delete");
  const wrong = real === "ZZZZZZZZ" ? "YYYYYYYY" : "ZZZZZZZZ";
  s.deps.readStdin = async () => wrong;
  assert.equal(await s.remove("--code-stdin"), 1);
  assert.equal(s.final().state, "code_invalid");
  assert.equal(s.final().attempts_left, 4);
  assert.equal(s.final().agent_hint, "The code is not right. 4 tries left. Ask your human for the newest code.");
  assert.equal((s.file() as ActiveAccount).pending_step_up?.command, "delete");

  s.deps.readStdin = async () => "ABC-12";
  assert.equal(await s.remove("--code-stdin"), 4);
  assert.equal(s.final().state, "invalid_input");
  assert.equal(s.runRequests().length, 0);
  assert.equal((s.file() as ActiveAccount).pending_step_up?.command, "delete");

  s.deps.readStdin = async () => wrong;
  for (let i = 0; i < 3; i++) await s.remove("--code-stdin");
  assert.equal(s.final().state, "code_invalid");
  assert.equal(await s.remove("--code-stdin"), 1);
  assert.equal(s.final().state, "code_exhausted");
  assert.equal((s.file() as ActiveAccount).pending_step_up, null);
  assert.equal(s.fake.tenant(s.tenant.name).deleted, false);
  for (const w of s.workers) assert.equal(w.deletes().length, 0);
  assertNoSecret(s, [real, wrong]);
});

test("delete: the code is read with spaces, hyphens and lower case", async (t) => {
  const s = await setup(t, { workers: 0 });
  assert.equal(await s.remove(), 1);
  const code = s.fake.lastCode(s.tenant.name, "delete");
  s.deps.readStdin = async () => ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)}\n`;
  assert.equal(await s.remove("--code-stdin"), 0);
  assert.equal(s.final().state, "deleted");
});

test("delete: a network error on POST delete keeps the step and the file", async (t) => {
  const s = await setup(t);
  assert.equal(await s.remove(), 1);
  const before = readFileSync(accountPath(s.deps), "utf8");
  s.fake.respond("delete", "drop");
  assert.equal(await s.remove("--code-stdin"), 2);
  assert.equal(s.final().state, "network_error");
  assert.deepEqual(steps(s.lines()), [
    ["code", "ok"],
    ["delete_account", "failed"],
  ]);
  assert.equal(readFileSync(accountPath(s.deps), "utf8"), before);
  for (const w of s.workers) assert.equal(w.deletes().length, 0);
});

test("delete: 503 busy on POST delete is retried with the same code", async (t) => {
  const s = await setup(t);
  assert.equal(await s.remove(), 1);
  s.fake.staleDeletes = 2;
  assert.equal(await s.remove("--code-stdin"), 0);
  assert.equal(s.final().state, "deleted");
  const bodies = s.runRequests().filter((r) => r.route === "delete").map((r) => r.body);
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(s.deps.sleeps, [10_000, 10_000]);
});

test("delete: the step-up limit (2 delete codes per day) gives rate_limited with retry_at", async (t) => {
  const s = await setup(t);
  assert.equal(await s.remove(), 1);
  s.fake.advance(11 * MINUTE);
  assert.equal(await s.remove(), 1);
  s.fake.advance(11 * MINUTE);
  assert.equal(await s.remove(), 1);
  const final = s.final();
  assert.equal(final.state, "rate_limited");
  assert.equal(typeof final.retry_after_s, "number");
  const retryAt = new Date(s.fake.now() + Number(final.retry_after_s) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  assert.equal(final.retry_at, retryAt);
  assert.equal(final.agent_hint, `Too many requests. Try again after ${String(final.retry_at)}.`);
  assert.deepEqual(steps(s.lines()), [["code", "failed"]]);
  assert.equal(s.fake.mails.length, 2);
});

// --- secrets that stay ------------------------------------------------------------------------------

test("deleted_partial: a failed secret delete leaves the remainder file; delete on it only retries the secrets", async (t) => {
  const s = await setup(t, { workers: 3, tty: true });
  s.workers[1]!.wrangler.answer("delete", { exit: 1, stderr: "boom" });
  // An unreadable configuration: put and delete fail without starting wrangler, the worker stays.
  s.workers[2]!.wrangler.file("wrangler.toml", 'name = """api3"""\n');
  assert.equal(await s.remove(), 1);
  const final = s.final();
  assert.equal(final.state, "deleted_partial");
  assert.deepEqual(steps(s.lines()), [
    ["code", "ok"],
    ["delete_account", "ok"],
    ["remove_secrets", "failed"],
    ["remove_file", "ok"],
  ]);
  assert.deepEqual(final.workers, [
    { name: "api2", env: null, env_file: null, status: "failed" },
    { name: "api3", env: null, env_file: null, status: "failed" },
  ]);
  assert.equal(final.agent_hint, "The account is deleted. Remove OP8X_KEY by hand from: api2, api3.");
  const receipt = final.receipt as Line;
  assert.equal(receipt.tenant, s.tenant.name);
  assert.equal(s.workers[2]!.deletes().length, 0, "no wrangler start for an unreadable configuration");
  assert.deepEqual(s.file(), {
    schema: "op8x.account/1",
    collector: s.fake.url,
    account: null,
    contact_hint: null,
    read_token: null,
    write_key: null,
    write_key_next: null,
    salt: null,
    pending_step_up: null,
    deleted: { action_id: receipt.action_id },
    workers: [s.workers[1]!.entry, s.workers[2]!.entry],
  });
  assertNoSecret(s, [s.read, s.key]);

  // The human fixes api2 only: a second delete retries the secrets, sends nothing to the collector.
  s.workers[1]!.wrangler.answer("delete", { exit: 0 });
  assert.equal(await s.remove(), 1);
  assert.equal(s.runRequests().length, 0);
  assert.deepEqual(steps(s.lines()), [
    ["code", "skipped"],
    ["delete_account", "skipped"],
    ["remove_secrets", "failed"],
    ["remove_file", "ok"],
  ]);
  assert.equal(s.final().state, "deleted_partial");
  assert.deepEqual(s.final().receipt, { action_id: receipt.action_id, tenant: null, ended_at: null });
  assert.deepEqual((s.file() as AccountFile).workers, [s.workers[2]!.entry]);
  assert.equal(s.workers[0]!.deletes().length, 1, "a removed worker is not touched again");
  assert.equal(s.workers[1]!.deletes().length, 2);

  s.workers[2]!.wrangler.file("wrangler.toml", 'name = "api3"\n');
  assert.equal(await s.remove("--code-stdin"), 0);
  assert.equal(s.runRequests().length, 0);
  assert.equal(s.final().state, "deleted");
  assert.deepEqual(s.final().receipt, { action_id: receipt.action_id, tenant: null, ended_at: null });
  assert.equal(s.final().agent_hint, `The account is deleted. Receipt: ${String(receipt.action_id)}.`);
  assert.equal(s.file(), null);
  assert.deepEqual(s.workers[2]!.deletes(), [deleteArgv(s.workers[2]!)]);
});

test("delete removes only the OP8X_KEY line of an --env-file target; a file that is gone counts as removed", async (t) => {
  const project = tempDir("op8x-node-");
  const path = join(project, "secrets.local");
  const gone = join(project, "gone.local");
  const key = generateKey("w");
  const entry = (p: string): WorkerEntry => ({
    dir: project,
    name: null,
    env: null,
    env_file: p,
    url: null,
    deployed_at: "2026-11-01T10:00:00Z",
    verified_at: null,
    key_fingerprint: keyFingerprint(key),
  });
  const s = await setup(t, { workers: 1, tty: true, extraWorkers: [entry(path), entry(gone)] });
  const content = `PORT=8787\r\nOP8X_KEY=${s.key}\r\n# note ä\r\nexport OP8X_KEY = old\nLAST=1`;
  writeFileSync(path, Buffer.from(content, "latin1"));
  assert.equal(await s.remove(), 0);
  assert.equal(s.final().state, "deleted");
  assert.deepEqual(readFileSync(path), Buffer.from("PORT=8787\r\n# note ä\r\nLAST=1", "latin1"));
  assert.equal(existsSync(gone), false);
  assert.equal(s.file(), null);
  assert.equal(s.workers[0]!.deletes().length, 1);
});

test("delete: an env file that cannot be read stays in the remainder file", async (t) => {
  const project = tempDir("op8x-node-");
  const entry: WorkerEntry = {
    dir: project,
    name: null,
    env: null,
    env_file: project, // a folder, not a regular file
    url: null,
    deployed_at: "2026-11-01T10:00:00Z",
    verified_at: null,
    key_fingerprint: "1a2b3c4d",
  };
  const s = await setup(t, { workers: 0, tty: true, extraWorkers: [entry] });
  assert.equal(await s.remove(), 1);
  assert.equal(s.final().state, "deleted_partial");
  assert.deepEqual(s.final().workers, [{ name: null, env: null, env_file: project, status: "failed" }]);
  assert.equal(s.final().agent_hint, `The account is deleted. Remove OP8X_KEY by hand from: ${project}.`);
  assert.deepEqual((s.file() as AccountFile).workers, [entry]);
});

test("delete with no known worker: steps remove_secrets ok, deleted", async (t) => {
  const s = await setup(t, { workers: 0, tty: true });
  assert.equal(await s.remove(), 0);
  assert.deepEqual(steps(s.lines()), ALL_OK);
  assert.equal(s.final().state, "deleted");
});

// --- the remainder file in other commands -------------------------------------------------------------

test("rotate on the remainder file: not_logged_in, nothing sent", async (t) => {
  const s = await setup(t, { workers: 0 });
  const remainder: AccountFile = {
    schema: "op8x.account/1",
    collector: s.fake.url,
    account: null,
    contact_hint: null,
    read_token: null,
    write_key: null,
    write_key_next: null,
    salt: null,
    pending_step_up: null,
    deleted: { action_id: "0b4e2f1a-1111-4222-8333-444455556666" },
    workers: [],
  };
  await writeAccount(s.deps, remainder);
  for (const argv of [["rotate", "--json"], ["rotate", "--now", "--json"], ["rotate", "--now", "--code-stdin", "--json"]]) {
    const before = s.deps.stdout().length;
    assert.equal(await run(argv, s.deps), 1, argv.join(" "));
    const last = JSON.parse(s.deps.stdout().slice(before).trimEnd().split("\n").at(-1) ?? "") as Line;
    assert.equal(last.state, "not_logged_in");
  }
  assert.equal(s.fake.requests.length, 0);
  assert.deepEqual(s.file(), remainder);
});

test("delete without a file: not_logged_in; with a file for another service address: collector_mismatch", async (t) => {
  const s = await setup(t, { workers: 0 });
  const none = testDeps({ env: { OP8X_COLLECTOR_URL: s.fake.url } });
  assert.equal(await run(["delete", "--json"], none), 1);
  const last = JSON.parse(none.stdout().trimEnd().split("\n").at(-1) ?? "") as Line;
  assert.equal(last.state, "not_logged_in");
  assert.equal(last.command, "delete");

  await writeAccount(s.deps, { ...(s.file() as ActiveAccount), collector: "https://analytics.op8x.com" });
  assert.equal(await s.remove(), 4);
  assert.equal(s.final().state, "collector_mismatch");
  assert.equal(s.fake.requests.length, 0);
});

// --- output guard and options -------------------------------------------------------------------------

test("delete: an output guard hit stops before the next side effect", async (t) => {
  // The "test token" matches the start line of a step: the guard stops the output there.
  for (const [token, expectRoutes, deleted] of [
    ['"name":"code"', [], false],
    ['"name":"delete_account"', ["step_up"], false],
    ['"name":"remove_secrets"', ["step_up", "delete"], true],
  ] as const) {
    const s = await setup(t, { tty: true, deps: {} });
    s.deps.env = { ...s.deps.env, OP8X_TEST_TOKEN: token };
    assert.equal(await s.remove(), 2, token);
    assert.equal(s.final().state, "internal_error");
    assert.deepEqual(routes(s), expectRoutes);
    assert.equal(s.fake.tenant(s.tenant.name).deleted, deleted);
    for (const w of s.workers) assert.equal(w.deletes().length, 0, token);
    const f = s.file();
    assert.notEqual(f, null);
    if (deleted) {
      // The account is gone: the file already holds no R and no K, and still names every worker.
      assert.equal(f?.read_token, null);
      assert.equal(f?.write_key, null);
      assert.equal(f?.write_key_next, null);
      assert.notEqual(f?.deleted, null);
      assert.deepEqual(f?.workers, s.workers.map((w) => w.entry));
    } else {
      assert.equal(f?.read_token, s.read);
    }
  }
});

// --- progress per worker, and file failures after the account is gone ---------------------------------

test("each removed worker leaves the remainder file at once: a run that breaks off is finished by the next delete", async (t) => {
  const s = await setup(t, { workers: 3, tty: true });
  // The run "breaks off" while the second worker's secret delete runs: the file as it is then.
  let snapshot: string | null = null;
  s.deps.exec = async (file, args, opts) => {
    if (args.includes("delete") && args.includes("api2")) snapshot = readFileSync(accountPath(s.deps), "utf8");
    return realExec(file, args, opts);
  };
  assert.equal(await s.remove(), 0);
  assert.ok(snapshot !== null);
  const broken = JSON.parse(snapshot) as AccountFile;
  assert.equal(broken.read_token, null);
  assert.deepEqual(broken.workers, [s.workers[1]!.entry, s.workers[2]!.entry]);

  // Back to that moment; the secrets of api1 (done) and api2 (deleted just before the break) are gone.
  writeFileSync(accountPath(s.deps), snapshot);
  s.workers[1]!.wrangler.answer("delete", { exit: 1 });
  s.workers[1]!.wrangler.answer("list", { exit: 0, stdout: secretList(["OTHER_SECRET"]) });
  assert.equal(await s.remove(), 0);
  assert.equal(s.runRequests().length, 0);
  assert.equal(s.final().state, "deleted");
  assert.equal(s.file(), null);
  assert.equal(s.workers[0]!.deletes().length, 1, "a removed worker is not touched again");
});

test("remainder run: a secret removed by hand counts as removed (secret list, read only); present or unknown stays", async (t) => {
  const s = await setup(t, { workers: 1 });
  const w = s.workers[0]!;
  const remainder: AccountFile = {
    schema: "op8x.account/1",
    collector: s.fake.url,
    account: null,
    contact_hint: null,
    read_token: null,
    write_key: null,
    write_key_next: null,
    salt: null,
    pending_step_up: null,
    deleted: { action_id: "0b4e2f1a-1111-4222-8333-444455556666" },
    workers: [w.entry],
  };
  await writeAccount(s.deps, remainder);
  w.wrangler.answer("delete", { exit: 1 });

  // Still there, or the list cannot be read: the worker stays.
  for (const list of [{ exit: 0, stdout: secretList(["OP8X_KEY"]) }, { exit: 1 }, { exit: 0, stdout: "not json" }]) {
    w.wrangler.answer("list", list);
    assert.equal(await s.remove(), 1);
    assert.equal(s.final().state, "deleted_partial");
    assert.deepEqual(s.file(), remainder);
  }

  w.wrangler.answer("list", { exit: 0, stdout: `\n${secretList(["OTHER_SECRET"])}` });
  assert.equal(await s.remove(), 0);
  assert.equal(s.final().state, "deleted");
  assert.equal(s.file(), null);
  assert.equal(s.runRequests().length, 0);
  const list = w.wrangler.calls().filter((c) => c.argv[1] === "list");
  assert.deepEqual(list.at(-1)?.argv, ["secret", "list", "--name", "api1", "--config", join(w.wrangler.dir, "wrangler.toml"), "--format", "json"]);
  assert.equal(list.at(-1)?.stdin, "");
  assert.equal(s.deps.stdout().includes("OTHER_SECRET"), false, "the answer of secret list is never shown");
});

test("the run that deletes the account does not ask secret list: a failed secret delete stays", async (t) => {
  const s = await setup(t, { workers: 1, tty: true });
  s.workers[0]!.wrangler.answer("delete", { exit: 1 });
  s.workers[0]!.wrangler.answer("list", { exit: 0, stdout: secretList([]) });
  assert.equal(await s.remove(), 1);
  assert.equal(s.final().state, "deleted_partial");
  assert.equal(s.workers[0]!.wrangler.calls().some((c) => c.argv[1] === "list"), false);
});

test("the op8x file cannot be written after the account is gone: permissions_failed names receipt and path", async (t) => {
  // Run 1 stores the step; then every write of the op8x file fails (win32 without SystemRoot).
  const s = await setup(t, { workers: 2 });
  assert.equal(await s.remove(), 1);
  const active = readFileSync(accountPath(s.deps), "utf8");
  s.deps.platform = "win32";
  s.deps.env = { OP8X_COLLECTOR_URL: s.fake.url };
  s.workers[1]!.wrangler.answer("delete", { exit: 1 });
  assert.equal(await s.remove("--code-stdin"), 1);
  const final = s.final();
  assert.equal(final.state, "permissions_failed");
  assert.equal(final.exit_code, 1);
  const receipt = final.receipt as Line;
  assert.equal(receipt.tenant, s.tenant.name);
  assert.equal(final.path, accountPath(s.deps));
  assert.equal(
    final.agent_hint,
    `The account is deleted (receipt ${String(receipt.action_id)}), but the op8x file could not be updated. Delete it by hand: ${accountPath(s.deps)}.`,
  );
  assert.deepEqual(steps(s.lines()).at(-1), ["remove_file", "failed"]);
  // Nothing could be written: the file is still the one from before.
  assert.equal(readFileSync(accountPath(s.deps), "utf8"), active);
  assertNoSecret(s, [s.read, s.key]);
});

test("the op8x file cannot be written after the account is gone, but every secret is removed: the file goes, deleted", async (t) => {
  const s = await setup(t, { workers: 2 });
  assert.equal(await s.remove(), 1);
  s.deps.platform = "win32";
  s.deps.env = { OP8X_COLLECTOR_URL: s.fake.url };
  assert.equal(await s.remove("--code-stdin"), 0);
  assert.equal(s.final().state, "deleted");
  assert.equal(s.file(), null);
});

test("delete takes --code-stdin and --json only, and no positional", async (t) => {
  for (const argv of [["delete", "now"], ["delete", "--now"], ["delete", "--force-stop"], ["delete", "--week"]]) {
    const s = await setup(t, { workers: 0 });
    assert.equal(await run(argv, s.deps), 4, argv.join(" "));
    assert.match(s.deps.stderr(), /Usage: op8x delete/);
    assert.equal(s.fake.requests.length, 0);
    assert.notEqual(s.file(), null);
  }
});

test("delete leaves no temp file next to the env file", async (t) => {
  const project = tempDir("op8x-node-");
  const path = join(project, "secrets.local");
  const s = await setup(t, {
    workers: 0,
    tty: true,
    extraWorkers: [
      { dir: project, name: null, env: null, env_file: path, url: null, deployed_at: "2026-11-01T10:00:00Z", verified_at: null, key_fingerprint: "1a2b3c4d" },
    ],
  });
  writeFileSync(path, "A=1\nOP8X_KEY=x\n");
  assert.equal(await s.remove(), 0);
  assert.equal(readFileSync(path, "utf8"), "A=1\n");
  assert.deepEqual(readdirSync(project), ["secrets.local"]);
});
