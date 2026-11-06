import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { generateKey, keyHash } from "../src/account/keys.ts";
import { accountPath, writeAccount } from "../src/account/store.ts";
import type { AccountFile, ActiveAccount } from "../src/account/store.ts";
import { run } from "../src/cli.ts";
import type { Deps } from "../src/cli.ts";
import { testDeps } from "./account-deps.ts";
import { startFakeCollector } from "./fake-collector.ts";
import type { FakeCollector } from "./fake-collector.ts";

type Line = Record<string, unknown>;

async function setup(t: TestContext, o: { env?: Record<string, string>; deps?: Partial<Deps> } = {}) {
  const fake: FakeCollector = await startFakeCollector();
  t.after(() => fake.close());
  const deps = testDeps({
    now: () => fake.now(),
    sleep: async (ms) => {
      deps.sleeps.push(ms);
      fake.advance(ms);
    },
    env: { OP8X_COLLECTOR_URL: fake.url, ...o.env },
    ...o.deps,
  });
  const lines = () =>
    deps
      .stdout()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Line);
  const file = () => JSON.parse(readFileSync(accountPath(deps), "utf8")) as AccountFile;
  return { fake, deps, lines, file, final: () => lines().at(-1) ?? {} };
}

/** The human acts after the first poll of the newest flow. */
function onFirstPoll(fake: FakeCollector, act: () => void): void {
  let done = false;
  fake.onRequest = (req) => {
    if (req.route === "device_token" && !done) {
      done = true;
      act();
    }
  };
}

function active(collector: string, o: Partial<ActiveAccount> = {}): ActiveAccount {
  return {
    schema: "op8x.account/1",
    collector,
    account: "t-aaaaaaaaaa",
    contact_hint: "o***@old.example",
    read_token: generateKey("r"),
    write_key: null,
    write_key_next: null,
    pending_step_up: null,
    deleted: null,
    workers: [],
    ...o,
  };
}

const worker = {
  dir: "/work/api",
  name: "api",
  env: null,
  env_file: null,
  url: "https://api.example/paid",
  deployed_at: "2026-11-01T10:00:00Z",
  verified_at: "2026-11-01T10:01:00Z",
  key_fingerprint: "1a2b3c4d",
};

test("login without a file: device login with mode login, writes a new op8x file, connected with contact_hint (A1)", async (t) => {
  const s = await setup(t);
  const t0 = s.fake.addTenant({ readKey: generateKey("r"), contactHint: "a***@acme.example" });
  onFirstPoll(s.fake, () => s.fake.grant({ tenant: t0.name }));
  assert.equal(await run(["login", "--json"], s.deps), 0);

  const start = JSON.parse(s.fake.requests[0]?.body ?? "") as Line;
  assert.equal(start.mode, "login");
  assert.equal(Object.hasOwn(start, "write_sha256"), false);

  const f = s.file() as ActiveAccount;
  assert.equal(f.collector, s.fake.url);
  assert.equal(f.account, t0.name);
  assert.equal(f.contact_hint, "a***@acme.example");
  assert.equal(keyHash(f.read_token), s.fake.tenant(t0.name).read);
  assert.equal(f.write_key, null);
  assert.deepEqual(f.workers, []);

  const lines = s.lines();
  assert.equal(lines[0]?.event, "step");
  assert.deepEqual([lines[0]?.name, lines[0]?.status, lines[0]?.n, lines[0]?.of], ["browser", "start", 1, 1]);
  assert.equal(lines[1]?.event, "link");
  const final = s.final();
  assert.equal(final.command, "login");
  assert.equal(final.state, "connected");
  assert.equal(final.exit_code, 0);
  assert.equal(final.account, t0.name);
  assert.equal(final.contact_hint, "a***@acme.example");
  assert.equal(
    final.agent_hint,
    `op8x is connected to account ${t0.name} (a***@acme.example). Tell your human which address this account belongs to; if it is not theirs, run op8x logout.`,
  );
  assert.deepEqual(
    (final.steps as Line[]).map((x) => [x.name, x.status]),
    [["browser", "ok"]],
  );
  assert.equal(s.deps.stdout().includes(f.read_token), false);
  assert.equal(s.deps.stderr(), "");
  assert.deepEqual(s.fake.violations, []);
});

const PENDING = {
  purpose: "delete",
  command: "delete",
  case: null,
  phase: "delete",
  force_stop: false,
  t_check: null,
  expires_at: "2026-11-03T14:15:00Z",
} as const;

test("login for the same account keeps K, the next K and the workers; it replaces R and clears the waiting step", async (t) => {
  const s = await setup(t);
  const k = generateKey("w");
  const next = generateKey("w");
  const t0 = s.fake.addTenant({ readKey: generateKey("r"), writeKey: k, contactHint: "a***@acme.example" });
  const before = active(s.fake.url, { account: t0.name, write_key: k, write_key_next: next, workers: [worker], pending_step_up: { ...PENDING } });
  await writeAccount(s.deps, before);
  onFirstPoll(s.fake, () => s.fake.grant({ tenant: t0.name }));
  assert.equal(await run(["login", "--json"], s.deps), 0);
  const start = JSON.parse(s.fake.requests[0]?.body ?? "") as Line;
  assert.equal(Object.hasOwn(start, "write_sha256"), false);
  const f = s.file() as ActiveAccount;
  assert.notEqual(f.read_token, before.read_token);
  assert.equal(keyHash(f.read_token), s.fake.tenant(t0.name).read);
  // Step-up codes are bound to the old R: the waiting step goes.
  assert.equal(f.pending_step_up, null);
  assert.deepEqual({ ...f, read_token: before.read_token, contact_hint: before.contact_hint, pending_step_up: before.pending_step_up }, before);
  assert.equal(f.contact_hint, "a***@acme.example");
  for (const secret of [k, next, f.read_token, before.read_token]) assert.equal(s.deps.stdout().includes(secret), false);
});

test("login granted for a different account replaces the file as if there was none: no old K, step or workers", async (t) => {
  const s = await setup(t);
  const oldKey = generateKey("w");
  const next = generateKey("w");
  const before = active(s.fake.url, { account: "t-aaaaaaaaaa", write_key: oldKey, write_key_next: next, workers: [worker], pending_step_up: { ...PENDING } });
  await writeAccount(s.deps, before);
  const other = s.fake.addTenant({ readKey: generateKey("r"), contactHint: "b***@other.example" });
  assert.notEqual(other.name, before.account);
  onFirstPoll(s.fake, () => s.fake.grant({ tenant: other.name }));
  assert.equal(await run(["login", "--json"], s.deps), 0);
  const f = s.file() as ActiveAccount;
  assert.deepEqual(f, {
    schema: "op8x.account/1",
    collector: s.fake.url,
    account: other.name,
    contact_hint: "b***@other.example",
    read_token: f.read_token,
    write_key: null,
    write_key_next: null,
    pending_step_up: null,
    deleted: null,
    workers: [],
  });
  assert.equal(keyHash(f.read_token), s.fake.tenant(other.name).read);
  assert.equal(s.final().state, "connected");
  assert.equal(
    s.final().agent_hint,
    `op8x is connected to account ${other.name} (b***@other.example). Tell your human which address this account belongs to; if it is not theirs, run op8x logout.`,
  );
  for (const secret of [oldKey, next, before.read_token, f.read_token]) assert.equal(s.deps.stdout().includes(secret), false);
});

test("login on a remainder file (deleted) acts as without a file, even for another service address", async (t) => {
  const s = await setup(t);
  const t0 = s.fake.addTenant({ readKey: generateKey("r") });
  const remainder: AccountFile = {
    schema: "op8x.account/1",
    collector: "https://analytics.op8x.com",
    account: null,
    contact_hint: null,
    read_token: null,
    write_key: null,
    write_key_next: null,
    pending_step_up: null,
    deleted: { action_id: "0b4e2f1a-1111-4222-8333-444455556666" },
    workers: [worker],
  };
  await writeAccount(s.deps, remainder);
  onFirstPoll(s.fake, () => s.fake.grant({ tenant: t0.name }));
  assert.equal(await run(["login", "--json"], s.deps), 0);
  const f = s.file() as ActiveAccount;
  assert.equal(f.deleted, null);
  assert.equal(f.collector, s.fake.url);
  assert.equal(f.account, t0.name);
  assert.deepEqual(f.workers, []);
});

test("login with an unknown address ends with no_account; no file is written", async (t) => {
  const s = await setup(t);
  onFirstPoll(s.fake, () => s.fake.grant());
  assert.equal(await run(["login", "--json"], s.deps), 1);
  assert.equal(s.final().state, "no_account");
  assert.equal(s.final().agent_hint, "There is no op8x account for this address. Run op8x init to create one.");
  assert.deepEqual(
    (s.final().steps as Line[]).map((x) => [x.name, x.status]),
    [["browser", "failed"]],
  );
  assert.equal(existsSync(accountPath(s.deps)), false);
});

test("denied, expired and terms_draft keep an existing file unchanged", async (t) => {
  for (const [outcome, state] of [
    [null, "denied"],
    ["terms_draft", "terms_draft"],
  ] as const) {
    const s = await setup(t);
    await writeAccount(s.deps, active(s.fake.url));
    const before = readFileSync(accountPath(s.deps), "utf8");
    onFirstPoll(s.fake, () => s.fake.deny(outcome));
    assert.equal(await run(["login", "--json"], s.deps), 1);
    assert.equal(s.final().state, state);
    assert.equal(readFileSync(accountPath(s.deps), "utf8"), before);
  }
  const s = await setup(t);
  assert.equal(await run(["login", "--json"], s.deps), 1);
  assert.equal(s.final().state, "expired");
});

test("login after a lost answer recovers through GET /tenant: contact unknown, connected without the address", async (t) => {
  const s = await setup(t);
  const t0 = s.fake.addTenant({ readKey: generateKey("r"), contactHint: "a***@acme.example" });
  let polls = 0;
  s.fake.onRequest = (req) => {
    if (req.route === "device_token" && ++polls === 1) {
      s.fake.grant({ tenant: t0.name });
      const f = s.fake.lastFlow();
      if (f) f.state = "collected";
      s.fake.respond("device_token", "drop");
    }
  };
  assert.equal(await run(["login", "--json"], s.deps), 0);
  const notice = s.lines().find((l) => l.event === "notice");
  assert.equal(notice?.id, "contact_unknown");
  assert.equal(s.final().state, "connected");
  assert.equal(s.final().contact_hint, null);
  assert.equal(
    s.final().agent_hint,
    `op8x is connected to account ${t0.name}. This computer does not know the account's address; ask your human to check that it is theirs, and if not, run op8x logout.`,
  );
  assert.equal((s.file() as ActiveAccount).contact_hint, null);
});

test("login refuses a foreign OP8X_COLLECTOR_URL (4) and a file made for another address (collector_mismatch, 4); nothing is sent", async (t) => {
  const s = await setup(t, { env: { OP8X_COLLECTOR_URL: "https://evil.example" } });
  assert.equal(await run(["login", "--json"], s.deps), 4);
  assert.equal(s.final().state, "collector_url_not_allowed");
  assert.equal(s.deps.stderr(), "");

  const m = await setup(t);
  await writeAccount(m.deps, active("https://analytics.op8x.com"));
  assert.equal(await run(["login", "--json"], m.deps), 4);
  assert.equal(m.final().state, "collector_mismatch");
  assert.equal(m.fake.requests.length, 0);
});

test("a broken op8x file stops login with import_failed and stays as it is; no byte of it is printed", async (t) => {
  const s = await setup(t);
  mkdirSync(s.deps.configDir, { recursive: true });
  const secret = "op8x_w_" + "S".repeat(43);
  writeFileSync(accountPath(s.deps), `{"schema":"op8x.account/1","note":"zqx-marker","write_key":"${secret}",`);
  assert.equal(await run(["login", "--json"], s.deps), 1);
  assert.equal(s.final().state, "import_failed");
  assert.equal(s.fake.requests.length, 0);
  assert.equal(s.deps.stdout().includes(secret), false);
  assert.equal(s.deps.stdout().includes("zqx-marker"), false);
  assert.equal(s.deps.stdout().includes("op8x.account/1"), false);
  assert.ok(readFileSync(accountPath(s.deps), "utf8").includes(secret));
});

test("a file that cannot be written ends with permissions_failed", async (t) => {
  const s = await setup(t);
  // The op8x folder cannot be made: a file stands where its parent should be.
  const blocker = join(s.deps.cwd, "blocker");
  writeFileSync(blocker, "x");
  const deps = { ...s.deps, configDir: join(blocker, "op8x") };
  const t0 = s.fake.addTenant({ readKey: generateKey("r") });
  onFirstPoll(s.fake, () => s.fake.grant({ tenant: t0.name }));
  assert.equal(await run(["login", "--json"], deps), 1);
  assert.equal(s.final().state, "permissions_failed");
  assert.deepEqual(
    (s.final().steps as Line[]).map((x) => [x.name, x.status]),
    [["browser", "failed"]],
  );
});

test("an output guard hit during login stops before the file is written", async (t) => {
  const s = await setup(t, { env: { OP8X_TEST_TOKEN: "analytics.op8x.com" } });
  assert.equal(await run(["login", "--json"], s.deps), 2);
  assert.equal(s.final().state, "internal_error");
  assert.equal(s.fake.requests.filter((r) => r.route === "device_token").length, 0);
  assert.equal(existsSync(accountPath(s.deps)), false);
});

test("login in text mode: Step 1 of 1, the link block, the connected sentence last", async (t) => {
  const s = await setup(t);
  const t0 = s.fake.addTenant({ readKey: generateKey("r"), contactHint: "a***@acme.example" });
  onFirstPoll(s.fake, () => s.fake.grant({ tenant: t0.name }));
  assert.equal(await run(["login"], s.deps), 0);
  const text = s.deps.stdout().trimEnd().split("\n");
  assert.equal(text[0], "Step 1 of 1: browser");
  assert.match(text[1] ?? "", /^Ask your human to open the link and click Allow\. Their screen shows "[a-z]+ [a-z]+ \d\d"\.$/);
  assert.match(text[2] ?? "", /^Link: "https:\/\/analytics\.op8x\.com\/link\/[A-Za-z0-9_-]{32}"$/);
  assert.match(text.at(-2) ?? "", /^Step 1 of 1: browser ok \(\d+ ms\)$/);
  assert.match(text.at(-1) ?? "", /^op8x is connected to account t-[a-z2-7]{10} \(a\*\*\*@acme\.example\)\./);
});

test("login takes no option but --json and no positional", async (t) => {
  for (const argv of [["login", "extra"], ["login", "--now"], ["login", "--env", "x"], ["login", "--json=1"]]) {
    const s = await setup(t);
    assert.equal(await run(argv, s.deps), 4, argv.join(" "));
    assert.match(s.deps.stderr(), /Usage: op8x login/);
    assert.equal(s.deps.stdout(), "");
    assert.equal(s.fake.requests.length, 0);
  }
  const s = await setup(t);
  assert.equal(await run(["--json", "login", "extra"], s.deps), 4);
  assert.equal(s.final().state, "usage_error");
  assert.equal(s.final().command, "login");
});
