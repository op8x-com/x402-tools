import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { generateKey } from "../src/account/keys.ts";
import { newSalt } from "../src/account/salt.ts";
import { accountPath, writeAccount } from "../src/account/store.ts";
import type { AccountFile, ActiveAccount, PendingStepUp } from "../src/account/store.ts";
import { run } from "../src/cli.ts";
import { tempDir, testDeps } from "./account-deps.ts";
import { startFakeCollector } from "./fake-collector.ts";
import type { FakeCollector } from "./fake-collector.ts";

type Line = Record<string, unknown>;

/** This computer: signed in with R, no K. The account's current K and a previous K exist on the server. */
async function setup(t: TestContext, o: { collector?: string; local?: "none" | "remainder" } = {}) {
  const fake: FakeCollector = await startFakeCollector();
  t.after(() => fake.close());
  const deps = testDeps({ now: () => fake.now(), env: { OP8X_COLLECTOR_URL: fake.url } });
  const r = generateKey("r");
  const current = generateKey("w");
  const previous = generateKey("w");
  const t0 = fake.addTenant({ readKey: r, writeKey: current, previousKey: previous });
  const local: ActiveAccount = {
    schema: "op8x.account/1",
    collector: o.collector ?? fake.url,
    account: t0.name,
    contact_hint: "a***@acme.example",
    read_token: r,
    write_key: null,
    write_key_next: null,
    salt: null,
    pending_step_up: null,
    deleted: null,
    workers: [],
  };
  if (o.local === "remainder") {
    await writeAccount(deps, {
      ...local,
      account: null,
      contact_hint: null,
      read_token: null,
      deleted: { action_id: "0b4e2f1a-1111-4222-8333-444455556666" },
    } as AccountFile);
  } else if (o.local !== "none") {
    await writeAccount(deps, local);
  }
  const lines = () =>
    deps
      .stdout()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Line);
  /** The op8x file of the other computer, with `key` as its K. */
  const other = (key: string | null, name = "other.json") => {
    const dir = tempDir();
    const path = join(dir, name);
    const file: ActiveAccount = { ...local, collector: "https://analytics.op8x.com", read_token: generateKey("r"), write_key: key };
    writeFileSync(path, JSON.stringify(file));
    return path;
  };
  return { fake, deps, local, current, previous, other, lines, final: () => lines().at(-1) ?? {}, read: () => readFileSync(accountPath(deps), "utf8") };
}

test("import-key takes only K from the other file after GET /tenant with R shows it is the current key: imported", async (t) => {
  const s = await setup(t);
  const path = s.other(s.current);
  assert.equal(await run(["import-key", path, "--json"], s.deps), 0);
  const f = JSON.parse(s.read()) as ActiveAccount;
  assert.deepEqual(f, { ...s.local, write_key: s.current });
  const reqs = s.fake.requests;
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0]?.route, "tenant");
  assert.equal(reqs[0]?.headers.authorization, `Bearer ${s.local.read_token}`);
  // K never leaves this computer.
  for (const r of reqs) assert.equal(JSON.stringify(r).includes(s.current), false);
  const final = s.final();
  assert.equal(final.command, "import-key");
  assert.equal(final.state, "imported");
  assert.equal(final.exit_code, 0);
  assert.equal(final.agent_hint, "The server key is on this computer now. Run op8x init in a worker folder.");
  assert.deepEqual(
    (final.steps as Line[]).map((x) => [x.name, x.status]),
    [["check_key", "ok"]],
  );
  assert.equal(s.deps.stdout().includes(s.current), false);
  assert.deepEqual(s.fake.violations, []);
});

test("import-key resolves a relative path against the current folder", async (t) => {
  const s = await setup(t);
  const path = s.other(s.current);
  const deps = { ...s.deps, cwd: join(path, "..") };
  assert.equal(await run(["import-key", "other.json", "--json"], deps), 0);
  assert.equal(s.final().state, "imported");
});

test("import-key with the previous key: key_previous; with an unknown key: key_mismatch; the file stays", async (t) => {
  for (const [which, state, hint] of [
    ["previous", "key_previous", "This key is the old one. Run op8x rotate."],
    ["unknown", "key_mismatch", "The key on this computer is not the account's current key. Run op8x rotate."],
  ] as const) {
    const s = await setup(t);
    const before = s.read();
    const key = which === "previous" ? s.previous : generateKey("w");
    assert.equal(await run(["import-key", s.other(key), "--json"], s.deps), 1);
    assert.equal(s.final().state, state);
    assert.equal(s.final().agent_hint, hint);
    assert.equal(s.read(), before);
    assert.equal(s.deps.stdout().includes(key), false);
  }
});

test("import-key on broken or foreign files: import_failed, nothing sent, no byte of the file printed", async (t) => {
  const fakeSecret = "op8x_w_" + "Z".repeat(43);
  const other = "sk_live_" + "Q".repeat(24);
  const dir = tempDir();
  const write = (name: string, content: string) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };
  const cases: [string, string[]][] = [
    [write("not-json.txt", `OP8X_KEY=${fakeSecret}\nSTRIPE=${other}\n`), [fakeSecret, other, "OP8X_KEY", "STRIPE"]],
    [write("broken.json", `{"schema":"op8x.account/1","note":"zqx-marker","write_key":"${fakeSecret}"`), [fakeSecret, "zqx-marker", "op8x.account/1"]],
    [write("foreign.json", JSON.stringify({ api_key: other, write_key: fakeSecret })), [fakeSecret, other, "api_key"]],
    [write("bad-key.json", JSON.stringify({ write_key: "op8x_w_short" })), ["op8x_w_short"]],
    [write("huge.json", `{"pad":"${"x".repeat(2 * 1024 * 1024)}","k":"${fakeSecret}"}`), [fakeSecret]],
    [join(dir, "missing.json"), ["missing.json"]],
    [dir, []],
  ];
  for (const [path, needles] of cases) {
    const s = await setup(t);
    const before = s.read();
    assert.equal(await run(["import-key", path, "--json"], s.deps), 1, path);
    assert.equal(s.final().state, "import_failed", path);
    assert.equal(s.final().agent_hint, "The file could not be read as an op8x file.");
    assert.equal(s.fake.requests.length, 0, path);
    assert.equal(s.read(), before);
    const printed = s.deps.stdout() + s.deps.stderr();
    for (const n of needles) assert.equal(printed.includes(n), false, `${path}: ${n}`);
    // The path itself is not repeated either (it may be anything the agent was told).
    assert.equal(printed.includes(path), false, path);
  }
});

test("import-key on an op8x file without K (or a remainder file): import_failed", async (t) => {
  const s = await setup(t);
  assert.equal(await run(["import-key", s.other(null), "--json"], s.deps), 1);
  assert.equal(s.final().state, "import_failed");

  const r = await setup(t);
  const dir = tempDir();
  const path = join(dir, "remainder.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...r.local,
      account: null,
      contact_hint: null,
      read_token: null,
      deleted: { action_id: "0b4e2f1a-1111-4222-8333-444455556666" },
    }),
  );
  assert.equal(await run(["import-key", path, "--json"], r.deps), 1);
  assert.equal(r.final().state, "import_failed");
});

test("import-key needs a signed-in computer: no file or a remainder file → not_logged_in, nothing sent", async (t) => {
  for (const local of ["none", "remainder"] as const) {
    const s = await setup(t, { local });
    assert.equal(await run(["import-key", s.other(s.current), "--json"], s.deps), 1, local);
    assert.equal(s.final().state, "not_logged_in");
    assert.equal(s.fake.requests.length, 0);
  }
});

test("import-key with a file for another service address: collector_mismatch, nothing sent", async (t) => {
  const s = await setup(t, { collector: "https://analytics.op8x.com" });
  assert.equal(await run(["import-key", s.other(s.current), "--json"], s.deps), 4);
  assert.equal(s.final().state, "collector_mismatch");
  assert.equal(s.fake.requests.length, 0);
});

test("import-key when R is no longer valid: key_auth; on a network fault: network_error; the file stays", async (t) => {
  const s = await setup(t);
  const before = s.read();
  s.fake.tenant(s.local.account).read = null;
  assert.equal(await run(["import-key", s.other(s.current), "--json"], s.deps), 1);
  assert.equal(s.final().state, "key_auth");
  assert.equal(s.read(), before);

  const n = await setup(t);
  n.fake.respond("tenant", "drop");
  assert.equal(await run(["import-key", n.other(n.current), "--json"], n.deps), 2);
  assert.equal(n.final().state, "network_error");
});

test("import-key replaces a different local K only when the imported one is current", async (t) => {
  const s = await setup(t);
  const stale = generateKey("w");
  await writeAccount(s.deps, { ...s.local, write_key: stale });
  assert.equal(await run(["import-key", s.other(s.current), "--json"], s.deps), 0);
  assert.equal((JSON.parse(s.read()) as ActiveAccount).write_key, s.current);
  for (const k of [stale, s.current]) assert.equal(s.deps.stdout().includes(k), false);
});

test("import-key drops a next K of this computer once the imported K is the current key", async (t) => {
  const s = await setup(t);
  const orphan = generateKey("w");
  await writeAccount(s.deps, { ...s.local, write_key: generateKey("w"), write_key_next: orphan });
  assert.equal(await run(["import-key", s.other(s.current), "--json"], s.deps), 0);
  const f = JSON.parse(s.read()) as ActiveAccount;
  assert.equal(f.write_key, s.current);
  assert.equal(f.write_key_next, null);
  assert.equal(f.pending_step_up, null);
  assert.equal(s.fake.requests.length, 1);
  assert.equal(s.deps.stdout().includes(orphan), false);
});

test("import-key settles a waiting replace_current step with its next K; a waiting delete step stays", async (t) => {
  const pending = (purpose: "replace_current" | "delete"): PendingStepUp => ({
    purpose,
    command: purpose === "delete" ? "delete" : "rotate",
    case: purpose === "delete" ? null : "c",
    phase: purpose === "delete" ? "delete" : "replace",
    force_stop: false,
    t_check: null,
    expires_at: "2099-01-01T00:00:00Z",
  });
  const s = await setup(t);
  await writeAccount(s.deps, { ...s.local, write_key: s.previous, write_key_next: generateKey("w"), pending_step_up: pending("replace_current") });
  assert.equal(await run(["import-key", s.other(s.current), "--json"], s.deps), 0);
  let f = JSON.parse(s.read()) as ActiveAccount;
  assert.equal(f.write_key, s.current);
  assert.equal(f.write_key_next, null);
  assert.equal(f.pending_step_up, null);
  assert.equal(s.fake.requests.length, 1);

  const d = await setup(t);
  const waiting = pending("delete");
  await writeAccount(d.deps, { ...d.local, pending_step_up: waiting });
  assert.equal(await run(["import-key", d.other(d.current), "--json"], d.deps), 0);
  f = JSON.parse(d.read()) as ActiveAccount;
  assert.equal(f.write_key, d.current);
  assert.deepEqual(f.pending_step_up, waiting);
});

test("import-key needs exactly one path", async (t) => {
  for (const argv of [["import-key"], ["import-key", "a.json", "b.json"], ["import-key", "--now", "a.json"]]) {
    const s = await setup(t);
    assert.equal(await run(argv, s.deps), 4, argv.join(" "));
    assert.match(s.deps.stderr(), /Usage: op8x import-key <path>/);
    assert.equal(s.deps.stdout(), "");
  }
  const s = await setup(t);
  mkdirSync(join(s.deps.cwd, "x"), { recursive: true });
  assert.equal(await run(["--json", "import-key"], s.deps), 4);
  assert.equal(s.final().state, "usage_error");
  assert.equal(s.final().command, "import-key");
});

// --- the salt ---------------------------------------------------------------------------------

/** The other computer's op8x file with K and a salt. */
function otherWithSalt(s: Awaited<ReturnType<typeof setup>>, key: string, salt: string | null): string {
  const path = s.other(key);
  const file = JSON.parse(readFileSync(path, "utf8")) as ActiveAccount;
  writeFileSync(path, JSON.stringify({ ...file, salt }));
  return path;
}

test("import-key takes K and the salt from the other file; neither shows in any output", async (t) => {
  const s = await setup(t);
  const salt = newSalt();
  assert.equal(await run(["import-key", otherWithSalt(s, s.current, salt), "--json"], s.deps), 0);
  assert.equal(s.final().state, "imported");
  const f = JSON.parse(s.read()) as ActiveAccount;
  assert.equal(f.write_key, s.current);
  assert.equal(f.salt, salt);
  assert.equal(s.deps.stdout().includes("op8x_s_"), false);
  assert.equal(s.deps.stderr().includes("op8x_s_"), false);
  for (const r of s.fake.requests) assert.equal(JSON.stringify(r).includes("op8x_s_"), false);
});

test("import-key from a file without a salt keeps this computer's salt; with neither the salt stays null", async (t) => {
  const s = await setup(t);
  const mine = newSalt();
  await writeAccount(s.deps, { ...s.local, salt: mine });
  assert.equal(await run(["import-key", otherWithSalt(s, s.current, null), "--json"], s.deps), 0);
  assert.equal((JSON.parse(s.read()) as ActiveAccount).salt, mine);

  const n = await setup(t);
  assert.equal(await run(["import-key", n.other(n.current), "--json"], n.deps), 0);
  assert.equal((JSON.parse(n.read()) as ActiveAccount).salt, null);
});

test("import-key replaces this computer's salt with the other file's salt", async (t) => {
  const s = await setup(t);
  await writeAccount(s.deps, { ...s.local, salt: newSalt() });
  const theirs = newSalt();
  assert.equal(await run(["import-key", otherWithSalt(s, s.current, theirs), "--json"], s.deps), 0);
  assert.equal((JSON.parse(s.read()) as ActiveAccount).salt, theirs);
});

test("import-key with an invalid salt in the other file: import_failed, the salt not printed, the file stays", async (t) => {
  const s = await setup(t);
  const before = s.read();
  const bad = `op8x_s_${"A".repeat(42)}B`;
  assert.equal(await run(["import-key", otherWithSalt(s, s.current, bad), "--json"], s.deps), 1);
  assert.equal(s.final().state, "import_failed");
  assert.equal(s.deps.stdout().includes(bad), false);
  assert.equal(s.read(), before);
  assert.deepEqual(s.fake.requests, []);
});

test("a key that is not current: the other file's salt is not taken either", async (t) => {
  const s = await setup(t);
  const before = s.read();
  assert.equal(await run(["import-key", otherWithSalt(s, s.previous, newSalt()), "--json"], s.deps), 1);
  assert.equal(s.final().state, "key_previous");
  assert.equal(s.read(), before);
});
