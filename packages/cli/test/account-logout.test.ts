import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { generateKey } from "../src/account/keys.ts";
import { accountPath, writeAccount } from "../src/account/store.ts";
import type { AccountFile, ActiveAccount } from "../src/account/store.ts";
import { run } from "../src/cli.ts";
import { testDeps } from "./account-deps.ts";
import { startFakeCollector } from "./fake-collector.ts";
import type { Canned, FakeCollector } from "./fake-collector.ts";

type Line = Record<string, unknown>;

async function setup(t: TestContext, o: { env?: Record<string, string>; key?: boolean; next?: boolean; collector?: string } = {}) {
  const fake: FakeCollector = await startFakeCollector();
  t.after(() => fake.close());
  const deps = testDeps({
    now: () => fake.now(),
    sleep: async (ms) => {
      deps.sleeps.push(ms);
      fake.advance(ms);
    },
    env: { OP8X_COLLECTOR_URL: fake.url, ...o.env },
  });
  const r = generateKey("r");
  const k = o.key ? generateKey("w") : null;
  const next = o.next ? generateKey("w") : null;
  const t0 = fake.addTenant({ readKey: r, writeKey: k });
  const file: ActiveAccount = {
    schema: "op8x.account/1",
    collector: o.collector ?? fake.url,
    account: t0.name,
    contact_hint: "a***@acme.example",
    read_token: r,
    write_key: k,
    write_key_next: next,
    pending_step_up: null,
    deleted: null,
    workers: [],
  };
  await writeAccount(deps, file);
  const lines = () =>
    deps
      .stdout()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Line);
  return { fake, deps, file, t0, lines, final: () => lines().at(-1) ?? {}, exists: () => existsSync(accountPath(deps)) };
}

test("logout revokes R with POST sign-out {} and Bearer R, then deletes the file: logged_out", async (t) => {
  const s = await setup(t);
  assert.equal(await run(["logout", "--json"], s.deps), 0);
  const req = s.fake.requests.find((x) => x.route === "sign_out");
  assert.equal(req?.body, "{}");
  assert.equal(req?.headers.authorization, `Bearer ${s.file.read_token}`);
  assert.equal(s.fake.tenant(s.t0.name).read, null);
  assert.equal(s.exists(), false);
  const final = s.final();
  assert.equal(final.command, "logout");
  assert.equal(final.state, "logged_out");
  assert.equal(final.exit_code, 0);
  assert.equal(final.agent_hint, "This computer is signed out.");
  assert.deepEqual(
    (final.steps as Line[]).map((x) => [x.name, x.status]),
    [["sign_out", "ok"]],
  );
  assert.equal(s.lines().some((l) => l.event === "notice"), false);
  assert.equal(s.deps.stdout().includes(s.file.read_token), false);
  assert.deepEqual(s.fake.violations, []);
});

test("logout with a local K: notice logout_removes_key before the file goes (A11)", async (t) => {
  for (const o of [{ key: true }, { next: true }]) {
    const s = await setup(t, o);
    assert.equal(await run(["logout", "--json"], s.deps), 0);
    const lines = s.lines();
    const notice = lines.findIndex((l) => l.event === "notice");
    assert.deepEqual(lines[notice], {
      schema: "op8x.cli/1",
      command: "logout",
      final: false,
      event: "notice",
      id: "logout_removes_key",
      text: "This computer holds the server key. It is deleted with the op8x file; your workers keep their copy.",
    });
    assert.equal(notice, lines.length - 2);
    assert.equal(s.final().agent_hint, "This computer is signed out. The server key on this computer is removed too.");
    assert.equal(s.exists(), false);
    for (const k of [s.file.write_key, s.file.write_key_next]) if (k) assert.equal(s.deps.stdout().includes(k), false);
  }
});

test("logout offline or on a 5xx keeps the file and ends with network_error, so a later logout can revoke R", async (t) => {
  for (const canned of ["drop", "server_error", "mail_unavailable", "redirect"] as Canned[]) {
    const s = await setup(t, { key: true });
    const before = readFileSync(accountPath(s.deps), "utf8");
    s.fake.respond("sign_out", canned);
    assert.equal(await run(["logout", "--json"], s.deps), 2, String(canned));
    assert.equal(s.final().state, "network_error");
    assert.deepEqual(
      (s.final().steps as Line[]).map((x) => [x.name, x.status]),
      [["sign_out", "failed"]],
    );
    assert.equal(readFileSync(accountPath(s.deps), "utf8"), before);
    assert.equal(s.lines().some((l) => l.event === "notice"), false);
  }
});

test("logout while busy for 2 minutes keeps the file (busy); an unexpected answer keeps it too", async (t) => {
  const s = await setup(t);
  s.fake.respond("sign_out", "busy", 13);
  assert.equal(await run(["logout", "--json"], s.deps), 2);
  assert.equal(s.final().state, "busy");
  assert.equal(s.exists(), true);

  const u = await setup(t);
  u.fake.respond("sign_out", "not_found");
  assert.equal(await run(["logout", "--json"], u.deps), 2);
  assert.equal(u.final().state, "unexpected_response");
  assert.equal(u.final().status, 404);
  assert.equal(u.exists(), true);
});

test("logout with an R the collector no longer knows (401) deletes the file", async (t) => {
  const s = await setup(t, { key: true });
  s.fake.tenant(s.t0.name).read = null;
  assert.equal(await run(["logout", "--json"], s.deps), 0);
  assert.equal(s.final().state, "logged_out");
  assert.equal(s.exists(), false);
  assert.equal(s.lines().some((l) => l.id === "logout_removes_key"), true);
});

test("logout without a file or on a remainder file: not_logged_in, nothing sent", async (t) => {
  const s = await setup(t);
  const none = testDeps({ env: { OP8X_COLLECTOR_URL: s.fake.url } });
  assert.equal(await run(["logout", "--json"], none), 1);
  const last = JSON.parse(none.stdout().trimEnd().split("\n").at(-1) ?? "") as Line;
  assert.equal(last.state, "not_logged_in");
  assert.equal(last.agent_hint, "This computer is not signed in. Run op8x init or op8x login.");

  const remainder: AccountFile = {
    schema: "op8x.account/1",
    collector: s.fake.url,
    account: null,
    contact_hint: null,
    read_token: null,
    write_key: null,
    write_key_next: null,
    pending_step_up: null,
    deleted: { action_id: "0b4e2f1a-1111-4222-8333-444455556666" },
    workers: [],
  };
  await writeAccount(s.deps, remainder);
  assert.equal(await run(["logout", "--json"], s.deps), 1);
  assert.equal(s.final().state, "not_logged_in");
  assert.equal(s.exists(), true);
  assert.equal(s.fake.requests.length, 0);
});

test("logout with a file for another service address: collector_mismatch, nothing sent, file kept", async (t) => {
  const s = await setup(t, { collector: "https://analytics.op8x.com" });
  assert.equal(await run(["logout", "--json"], s.deps), 4);
  assert.equal(s.final().state, "collector_mismatch");
  assert.equal(s.fake.requests.length, 0);
  assert.equal(s.exists(), true);
});

test("an output guard hit before the file is deleted stops logout there; the file stays", async (t) => {
  // The notice line holds the "test token": the guard stops the output, no file is removed.
  const s = await setup(t, { key: true, env: { OP8X_TEST_TOKEN: "holds the server key" } });
  assert.equal(await run(["logout", "--json"], s.deps), 2);
  assert.equal(s.final().state, "internal_error");
  assert.equal(s.exists(), true);
});

test("logout in text mode", async (t) => {
  const s = await setup(t, { key: true });
  assert.equal(await run(["logout"], s.deps), 0);
  const text = s.deps.stdout().trimEnd().split("\n");
  assert.equal(text[0], "Step 1 of 1: sign_out");
  assert.match(text[1] ?? "", /^Step 1 of 1: sign_out ok \(\d+ ms\)$/);
  assert.equal(text[2], "This computer holds the server key. It is deleted with the op8x file; your workers keep their copy.");
  assert.equal(text[3], "This computer is signed out. The server key on this computer is removed too.");
});

test("logout takes no option but --json and no positional", async (t) => {
  for (const argv of [["logout", "now"], ["logout", "--force-stop"], ["logout", "--url", "https://x.example"]]) {
    const s = await setup(t);
    assert.equal(await run(argv, s.deps), 4, argv.join(" "));
    assert.match(s.deps.stderr(), /Usage: op8x logout/);
    assert.equal(s.exists(), true);
    assert.equal(s.fake.requests.length, 0);
  }
});
