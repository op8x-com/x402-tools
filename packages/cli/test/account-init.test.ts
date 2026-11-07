import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { generateKey, keyFingerprint, keyHash } from "../src/account/keys.ts";
import { accountPath, writeAccount } from "../src/account/store.ts";
import type { AccountFile, ActiveAccount, WorkerEntry } from "../src/account/store.ts";
import { exec as realExec } from "../src/account/system.ts";
import { run } from "../src/cli.ts";
import type { Deps } from "../src/cli.ts";
import { recordingExec, tempDir, testDeps } from "./account-deps.ts";
import type { ExecHandler } from "./account-deps.ts";
import { startFakeCollector } from "./fake-collector.ts";
import type { FakeCollector } from "./fake-collector.ts";
import { createFakeWrangler } from "./fake-wrangler.ts";
import type { FakeWrangler } from "./fake-wrangler.ts";
import { startFakeWorker } from "./fake-worker.ts";
import type { FakeWorker, WorkerMode } from "./fake-worker.ts";

type Line = Record<string, unknown>;

const CONTACT = "a***@acme.example";
const CHECK_ADDRESS = "Tell your human which address this account belongs to; if it is not theirs, run op8x logout.";

interface Setup {
  fake: FakeCollector;
  wrangler: FakeWrangler;
  worker: FakeWorker;
  deps: ReturnType<typeof testDeps>;
  lines: () => Line[];
  final: () => Line;
  file: () => ActiveAccount;
  /** K as the fake wrangler got it on stdin (the last secret put). */
  putKey: () => string | null;
  url: string;
}

async function setup(
  t: TestContext,
  o: { config?: string | null; mode?: WorkerMode; env?: Record<string, string>; deps?: Partial<Deps>; workerKey?: () => string | null } = {},
): Promise<Setup> {
  const fake = await startFakeCollector();
  t.after(() => fake.close());
  const wrangler = createFakeWrangler();
  if (o.config !== null) wrangler.file("wrangler.toml", o.config ?? 'name = "api"\n');
  const putKey = () => wrangler.calls().filter((c) => c.argv[0] === "secret" && c.argv[1] === "put").at(-1)?.stdin ?? null;
  const worker = await startFakeWorker({ collector: fake, key: o.workerKey ?? putKey, mode: o.mode });
  t.after(() => worker.close());
  // The recorded platform stays POSIX for the op8x file unless a test sets it (the real Windows ACL
  // runs in the store and connect tests).
  const deps = testDeps({
    cwd: wrangler.dir,
    exec: realExec,
    now: () => fake.now(),
    sleep: async (ms) => {
      deps.sleeps.push(ms);
      fake.advance(ms);
    },
    env: { OP8X_COLLECTOR_URL: fake.url, ...(process.platform === "win32" ? { SystemRoot: "C:\\Windows" } : {}), ...o.env },
    ...o.deps,
  });
  const lines = () =>
    deps
      .stdout()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Line);
  const file = () => JSON.parse(readFileSync(accountPath(deps), "utf8")) as ActiveAccount;
  return { fake, wrangler, worker, deps, lines, final: () => lines().at(-1) ?? {}, file, putKey, url: `${worker.origin}/paid` };
}

/** The human allows after the first poll of the newest flow. */
function onFirstPoll(fake: FakeCollector, act: () => void): void {
  let done = false;
  fake.onRequest = (req) => {
    if (req.route === "device_token" && !done) {
      done = true;
      act();
    }
  };
}

function steps(lines: Line[]): [string, string][] {
  return lines.filter((l) => l.event === "step" && l.status !== "start").map((l) => [String(l.name), String(l.status)]);
}

function active(collector: string, o: Partial<ActiveAccount> = {}): ActiveAccount {
  return {
    schema: "op8x.account/1",
    collector,
    account: "t-aaaaaaaaaa",
    contact_hint: CONTACT,
    read_token: generateKey("r"),
    write_key: null,
    write_key_next: null,
    salt: null,
    pending_step_up: null,
    deleted: null,
    workers: [],
    ...o,
  };
}

/** A signed-in computer: an account at the fake with R and K, and the op8x file for it. */
async function signedIn(s: Setup, o: { withKey?: boolean; contactHint?: string | null; previousKey?: string; file?: Partial<ActiveAccount> } = {}) {
  const read = generateKey("r");
  const write = generateKey("w");
  const tenant = s.fake.addTenant({ readKey: read, writeKey: write, contactHint: CONTACT, previousKey: o.previousKey });
  const file = active(s.fake.url, {
    account: tenant.name,
    read_token: read,
    write_key: o.withKey === false ? null : write,
    contact_hint: o.contactHint === undefined ? CONTACT : o.contactHint,
    ...o.file,
  });
  await writeAccount(s.deps, file);
  return { tenant, read, write, file };
}

function assertNoSecret(s: Setup, secrets: (string | null | undefined)[]): void {
  const all = s.deps.stdout() + s.deps.stderr();
  for (const v of secrets) if (typeof v === "string") assert.equal(all.includes(v), false, "a secret reached the output");
}

const sameDir = (a: string, b: string) => realpathSync.native(a) === realpathSync.native(b);

// --- first init ---------------------------------------------------------------------------------

test("first init: cloudflare, browser, key, test until connected with contact_hint and the sentence that asks to check the address", async (t) => {
  const s = await setup(t);
  onFirstPoll(s.fake, () => s.fake.grant({ contactHint: CONTACT }));
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 0);

  const lines = s.lines();
  assert.deepEqual(steps(lines), [
    ["cloudflare", "ok"],
    ["browser", "ok"],
    ["key", "ok"],
    ["test", "ok"],
  ]);
  for (const l of lines.filter((x) => x.event === "step")) {
    assert.equal(l.of, 4);
    if (l.status !== "start") assert.equal(typeof l.elapsed_ms, "number");
  }
  const f = s.file();
  const key = s.putKey();
  assert.ok(key !== null && f.write_key === key, "the worker got the K of the op8x file");
  // device/start sent write_sha256 of exactly that K.
  const start = JSON.parse(s.fake.requests.find((r) => r.route === "device_start")?.body ?? "{}") as Line;
  assert.equal(start.mode, "init");
  assert.equal(start.write_sha256, keyHash(key));

  const final = s.final();
  assert.equal(final.state, "connected");
  assert.equal(final.exit_code, 0);
  assert.equal(final.account, f.account);
  assert.equal(final.contact_hint, CONTACT);
  assert.equal(final.agent_hint, `op8x is connected to account ${f.account} (${CONTACT}). ${CHECK_ADDRESS}`);
  assert.deepEqual(final.workers, [{ name: "api", env: null, env_file: null, status: "verified" }]);
  assert.deepEqual((final.steps as Line[]).map((x) => x.name), ["cloudflare", "browser", "key", "test"]);

  assert.equal(f.workers.length, 1);
  const w = f.workers[0]!;
  assert.ok(sameDir(w.dir, s.wrangler.dir));
  assert.equal(w.name, "api");
  assert.equal(w.env, null);
  assert.equal(w.env_file, null);
  assert.equal(w.url, s.url);
  assert.equal(w.key_fingerprint, keyFingerprint(key));
  assert.match(w.deployed_at, /Z$/);
  assert.ok(w.verified_at !== null);

  const notices = lines.filter((l) => l.event === "notice").map((l) => l.id);
  assert.deepEqual(notices, ["secret_put_deploys", "test_host"]);
  // The worker got exactly one request, with the nonce and nothing of op8x' secrets.
  assert.equal(s.worker.requests.length, 1);
  assertNoSecret(s, [f.read_token, f.write_key]);
  assert.equal(JSON.stringify(s.worker.requests).includes(f.read_token), false);
  assert.deepEqual(s.fake.violations, []);
});

test("first init in text mode shows Step n of 4 and the connected sentence", async (t) => {
  const s = await setup(t);
  onFirstPoll(s.fake, () => s.fake.grant({ contactHint: CONTACT }));
  assert.equal(await run(["init", "--url", s.url], s.deps), 0);
  const out = s.deps.stdout();
  assert.match(out, /^Step 1 of 4: cloudflare\n/);
  assert.match(out, /Step 4 of 4: test ok \(\d+ ms\)\n/);
  assert.match(out, /Worker api: verified\n/);
  assert.ok(out.endsWith(`${CHECK_ADDRESS}\n`));
});

test("first init writes the op8x file after granted and before wrangler (put fails → partial, file holds K)", async (t) => {
  const s = await setup(t);
  s.wrangler.answer("put", { exit: 1 });
  onFirstPoll(s.fake, () => s.fake.grant({ contactHint: CONTACT }));
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 1);
  const f = s.file();
  assert.ok(f.write_key !== null);
  assert.equal(s.putKey(), f.write_key);
  assert.deepEqual(f.workers, []);
  const final = s.final();
  assert.equal(final.state, "partial");
  assert.deepEqual(final.workers, [{ name: "api", env: null, env_file: null, status: "failed" }]);
  assert.deepEqual(steps(s.lines()), [
    ["cloudflare", "ok"],
    ["browser", "ok"],
    ["key", "failed"],
  ]);
  assert.equal(s.worker.requests.length, 0);
});

test("first init: granted with server_key ignored writes the file with write_key null and ends server_key_missing", async (t) => {
  const s = await setup(t);
  const existing = s.fake.addTenant({ readKey: generateKey("r"), writeKey: generateKey("w"), contactHint: CONTACT });
  onFirstPoll(s.fake, () => s.fake.grant({ tenant: existing.name }));
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 1);
  const f = s.file();
  assert.equal(f.account, existing.name);
  assert.equal(f.write_key, null);
  const final = s.final();
  assert.equal(final.state, "server_key_missing");
  assert.equal(final.path, accountPath(s.deps));
  assert.match(String(final.agent_hint), /^This computer has no server key\. Run op8x import-key/);
  assert.equal(s.putKey(), null);
  assert.equal(s.wrangler.calls().filter((c) => c.argv[0] === "secret").length, 0);
});

test("first init: a remainder file (deleted) counts as no file, even for another collector", async (t) => {
  const s = await setup(t);
  mkdirSync(s.deps.configDir, { recursive: true });
  const remainder: AccountFile = {
    schema: "op8x.account/1",
    collector: "https://analytics.op8x.com",
    account: null,
    contact_hint: null,
    read_token: null,
    write_key: null,
    write_key_next: null,
    salt: null,
    pending_step_up: null,
    deleted: { action_id: "4b8f1c2e-1111-4222-8333-444455556666" },
    workers: [],
  };
  writeFileSync(accountPath(s.deps), JSON.stringify(remainder));
  onFirstPoll(s.fake, () => s.fake.grant({ contactHint: CONTACT }));
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 0);
  assert.equal(s.file().deleted, null);
  assert.equal(s.file().collector, s.fake.url);
  assert.ok(s.fake.requests.some((r) => r.route === "device_start"));
});

test("first init: without wrangler or Cloudflare login the device login never starts", async (t) => {
  const s = await setup(t);
  s.wrangler.answer("whoami", { exit: 1, stdout: '\n{"loggedIn":false}\n' });
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 1);
  assert.equal(s.final().state, "cloudflare_login_needed");
  assert.deepEqual(steps(s.lines()), [["cloudflare", "failed"]]);
  assert.deepEqual(s.fake.requests, []);

  const empty = testDeps({ env: { OP8X_COLLECTOR_URL: s.fake.url } });
  assert.equal(await run(["init", "--json"], empty), 1);
  assert.equal(JSON.parse(empty.stdout().trim().split("\n").at(-1)!).state, "wrangler_missing");
});

test("first init: several environments without --env end with env_required; a config without name needs --name", async (t) => {
  const s = await setup(t, { config: 'name = "api"\n[env.staging]\n[env.prod]\n' });
  assert.equal(await run(["init", "--json"], s.deps), 1);
  assert.equal(s.final().state, "env_required");

  const n = await setup(t, { config: "" });
  assert.equal(await run(["init", "--json"], n.deps), 4);
  assert.equal(n.final().state, "usage_error");
  assert.match(n.deps.stderr(), /Usage: op8x init/);
  assert.deepEqual(n.fake.requests, []);
});

// --- --name, --env and the URL order ---------------------------------------------------------------

test("--name replaces the configuration's name; with --env the name becomes <name>-<env>", async (t) => {
  const s = await setup(t, { config: 'name = "api"\n[env.staging]\n' });
  await signedIn(s);
  assert.equal(await run(["init", "--json", "--name", "shop", "--env", "staging", "--url", s.url], s.deps), 0);
  const put = s.wrangler.calls().find((c) => c.argv[1] === "put")!;
  assert.deepEqual(put.argv.slice(0, 7), ["secret", "put", "OP8X_KEY", "--name", "shop", "--env", "staging"]);
  assert.equal(s.file().workers[0]!.name, "shop-staging");
  assert.equal(s.file().workers[0]!.env, "staging");
});

test("--env and --name that look like flags are usage errors (isWranglerName)", async () => {
  for (const argv of [
    ["init", "--env", "-x"],
    ["init", "--name", "-api"],
    ["init", "--env=-x"],
  ]) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 4, argv.join(" "));
    assert.match(deps.stderr(), /Usage: op8x init/);
  }
});

test("URL order: the first fixed-domain route is the test address; checked against lookup, then tested over https", async (t) => {
  const s = await setup(t, {
    config: 'name = "api"\nroutes = [ { pattern = "*.example.com/*", zone_name = "example.com" }, "api.example/paid*" ]\n',
    deps: { lookup: async (host: string) => (host === "api.example" ? ["93.184.216.34"] : []) },
  });
  const worker = s.worker;
  s.deps.fetchImpl = async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname !== "api.example") return fetch(input, init);
    return fetch(`${worker.origin}${u.pathname}`, init);
  };
  await signedIn(s);
  assert.equal(await run(["init", "--json"], s.deps), 0);
  assert.equal(s.file().workers[0]!.url, "https://api.example/paid");
  const notice = s.lines().find((l) => l.id === "test_host");
  assert.equal(notice?.host, "api.example");
  assert.equal(worker.requests[0]?.path, "/paid");
});

test("URL order: --url beats the route; a custom_domain route gives https://host/", async (t) => {
  const s = await setup(t, { config: 'name = "api"\nroute = { pattern = "shop.example", custom_domain = true }\n' });
  await signedIn(s);
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 0);
  assert.equal(s.file().workers[0]!.url, s.url);

  const c = await setup(t, { config: 'name = "api"\nroute = { pattern = "shop.example", custom_domain = true }\n', mode: "no_module" });
  await signedIn(c);
  c.deps.lookup = async () => ["93.184.216.34"];
  c.deps.fetchImpl = async (input, init) => (new URL(String(input)).hostname === "shop.example" ? fetch(`${c.worker.origin}/`, init) : fetch(input, init));
  assert.equal(await run(["init", "--json"], c.deps), 1);
  assert.equal(c.file().workers[0]!.url, "https://shop.example/");
});

test("no --url and no fixed-domain route: K is put, the worker stored with url null, test skipped, url_required", async (t) => {
  const s = await setup(t, { config: 'name = "api"\nworkers_dev = true\n' });
  const a = await signedIn(s);
  assert.equal(await run(["init", "--json"], s.deps), 1);
  assert.equal(s.putKey(), a.write);
  const w = s.file().workers[0]!;
  assert.equal(w.url, null);
  assert.equal(w.verified_at, null);
  assert.equal(w.key_fingerprint, keyFingerprint(a.write));
  assert.deepEqual(steps(s.lines()), [
    ["key", "ok"],
    ["test", "skipped"],
  ]);
  const final = s.final();
  assert.equal(final.state, "url_required");
  assert.equal(final.agent_hint, "Pass --url https://… with a path the op8x module handles.");
  assert.deepEqual(final.workers, [{ name: "api", env: null, env_file: null, status: "no_url" }]);
  assert.equal(s.fake.requests.some((r) => r.route === "test_nonce"), false);
});

test("a route whose host resolves to a private address is not tested: url_required, no nonce, no request", async (t) => {
  const s = await setup(t, { config: 'name = "api"\nroute = "api.example/paid*"\n', deps: { lookup: async () => ["93.184.216.34", "10.0.0.8"] } });
  let fetched = 0;
  s.deps.fetchImpl = async (input, init) => {
    if (new URL(String(input)).hostname === "api.example") fetched++;
    return fetch(input, init);
  };
  await signedIn(s);
  assert.equal(await run(["init", "--json"], s.deps), 1);
  assert.equal(s.final().state, "url_required");
  assert.deepEqual(s.final().workers, [{ name: "api", env: null, env_file: null, status: "unverified" }]);
  assert.equal(fetched, 0);
  assert.equal(s.fake.requests.some((r) => r.route === "test_nonce"), false);
  assert.equal(s.lines().some((l) => l.id === "test_host"), false);
});

test("no test event within 60 s: deployed_unverified, the worker stays unverified", async (t) => {
  const s = await setup(t, { mode: "no_module" });
  await signedIn(s);
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 1);
  const final = s.final();
  assert.equal(final.state, "deployed_unverified");
  assert.deepEqual(final.workers, [{ name: "api", env: null, env_file: null, status: "unverified" }]);
  assert.equal(s.file().workers[0]!.verified_at, null);
  assert.equal(s.fake.requests.filter((r) => r.route === "test_nonce_status").length, 20);
  assert.deepEqual(steps(s.lines()).at(-1), ["test", "failed"]);
});

test("409 no_write_key at test-nonce ends with server_key_missing and the catalog sentence", async (t) => {
  const s = await setup(t);
  await signedIn(s);
  s.fake.respond("test_nonce", { status: 409, headers: { "content-type": "application/problem+json" }, body: JSON.stringify({ type: "https://op8x.com/errors/no_write_key", title: "x", status: 409, code: "no_write_key" }) });
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 1);
  const final = s.final();
  assert.equal(final.state, "server_key_missing");
  assert.match(String(final.agent_hint), /^This computer has no server key\./);
  assert.equal(s.worker.requests.length, 0);
});

// --- signed in -------------------------------------------------------------------------------

test("second init on a signed-in computer: no browser, steps key and test; the same folder updates its entry", async (t) => {
  const s = await setup(t);
  const a = await signedIn(s);
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 0);
  assert.deepEqual(steps(s.lines()), [
    ["key", "ok"],
    ["test", "ok"],
  ]);
  assert.equal(s.lines().find((l) => l.event === "step")?.of, 2);
  assert.equal(s.fake.requests.some((r) => r.route === "device_start"), false);
  assert.equal(s.putKey(), a.write);
  assert.equal(s.final().state, "connected");
  assert.equal(s.final().contact_hint, CONTACT);
  const first = s.file().workers[0]!;

  s.fake.advance(60_000);
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 0);
  const f = s.file();
  assert.equal(f.workers.length, 1);
  assert.notEqual(f.workers[0]!.deployed_at, first.deployed_at);
  assertNoSecret(s, [a.read, a.write]);
});

test("connected without a known address uses the sentence without one", async (t) => {
  const s = await setup(t);
  const a = await signedIn(s, { contactHint: null });
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 0);
  const final = s.final();
  assert.equal(final.contact_hint, null);
  assert.equal(
    final.agent_hint,
    `op8x is connected to account ${a.tenant.name}. This computer does not know the account's address; ask your human to check that it is theirs, and if not, run op8x logout.`,
  );
});

test("signed in without K: server_key_missing with the file's path; with a running rotation the rotate --now variant", async (t) => {
  const s = await setup(t);
  await signedIn(s, { withKey: false });
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 1);
  let final = s.final();
  assert.equal(final.state, "server_key_missing");
  assert.equal(final.path, accountPath(s.deps));
  assert.ok(String(final.agent_hint).endsWith("or run op8x rotate and then op8x init in every worker folder within 24 hours."));
  assert.equal(s.wrangler.calls().length, 0);

  const r = await setup(t);
  await signedIn(r, { withKey: false, previousKey: generateKey("w") });
  assert.equal(await run(["init", "--json", "--url", r.url], r.deps), 1);
  final = r.final();
  assert.equal(final.state, "server_key_missing");
  assert.ok(String(final.agent_hint).endsWith(", or run op8x rotate --now."));
});

test("signed in with a K that is not the account's current key: key_mismatch, nothing put", async (t) => {
  const s = await setup(t);
  await signedIn(s, { file: { write_key: generateKey("w") } });
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 1);
  assert.equal(s.final().state, "key_mismatch");
  // The step that was running ends as failed and is listed in the final line.
  assert.deepEqual(steps(s.lines()), [["key", "failed"]]);
  assert.deepEqual((s.final().steps as Line[]).map((x) => [x.name, x.status]), [["key", "failed"]]);
  assert.equal(s.wrangler.calls().length, 0);
});

test("a file made for another collector ends with collector_mismatch and sends nothing", async (t) => {
  const s = await setup(t);
  await writeAccount(s.deps, active("https://analytics.op8x.com", { write_key: generateKey("w") }));
  assert.equal(await run(["init", "--json"], s.deps), 4);
  assert.equal(s.final().state, "collector_mismatch");
  assert.deepEqual(s.fake.requests, []);
});

// --- write_key_next ----------------------------------------------------------------------------------

test("write_key_next that is already current becomes write_key, then init goes on with it", async (t) => {
  const s = await setup(t);
  const read = generateKey("r");
  const next = generateKey("w");
  const tenant = s.fake.addTenant({ readKey: read, writeKey: next, contactHint: CONTACT });
  await writeAccount(s.deps, active(s.fake.url, { account: tenant.name, read_token: read, write_key: generateKey("w"), write_key_next: next }));
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 0);
  const f = s.file();
  assert.equal(f.write_key, next);
  assert.equal(f.write_key_next, null);
  assert.equal(s.putKey(), next);
  assert.equal(s.fake.requests.some((r) => r.route === "rotate"), false);
});

test("init after a rotate whose request was lost: the next K is discarded without POST rotate, known workers keep working", async (t) => {
  const s = await setup(t);
  const elsewhere = tempDir();
  const envFile = join(elsewhere, "op8x-secrets");
  const a = await signedIn(s);
  writeFileSync(envFile, `OP8X_KEY=${a.write}\n`);
  const known: WorkerEntry = {
    dir: elsewhere,
    name: null,
    env: null,
    env_file: envFile,
    url: null,
    deployed_at: "2026-11-01T00:00:00Z",
    verified_at: null,
    key_fingerprint: keyFingerprint(a.write),
  };
  await writeAccount(s.deps, { ...a.file, workers: [known] });
  // rotate: the request never reaches the collector, so the next K stays in the file.
  s.fake.respond("rotate", "drop");
  assert.equal(await run(["rotate", "--json"], s.deps), 2);
  const orphan = s.file().write_key_next;
  assert.notEqual(orphan, null);
  assert.equal(a.tenant.write, keyHash(a.write));

  const before = s.fake.requests.length;
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 0);
  assert.equal(s.final().state, "connected");
  assert.equal(s.fake.requests.slice(before).some((r) => r.route === "rotate"), false);
  const f = s.file();
  assert.equal(f.write_key, a.write);
  assert.equal(f.write_key_next, null);
  assert.equal(s.putKey(), a.write);
  // The server still has K as its only key, and the known worker still holds it.
  assert.equal(a.tenant.write, keyHash(a.write));
  assert.equal(a.tenant.prev, null);
  assert.equal(f.workers.find((w) => w.env_file === envFile)?.key_fingerprint, keyFingerprint(a.write));
  assert.equal(readFileSync(envFile, "utf8"), `OP8X_KEY=${a.write}\n`);
  assertNoSecret(s, [a.read, a.write, orphan]);
});

test("two computers: import-key of the other's current K, then init sends no POST rotate for an old next K", async (t) => {
  const s = await setup(t);
  // This computer: an old K and a next K whose rotate never reached the collector; the other
  // computer rotated meanwhile, so the account's current key is the other computer's K.
  const staleKey = generateKey("w");
  const orphan = generateKey("w");
  const a = await signedIn(s, { file: { write_key: staleKey, write_key_next: orphan } });
  const otherDir = tempDir();
  const otherFile = join(otherDir, "other.json");
  writeFileSync(otherFile, JSON.stringify({ ...a.file, collector: "https://analytics.op8x.com", read_token: generateKey("r"), write_key: a.write, write_key_next: null }));

  assert.equal(await run(["import-key", otherFile, "--json"], s.deps), 0);
  assert.equal(s.final().state, "imported");
  assert.equal(s.file().write_key, a.write);
  assert.equal(s.file().write_key_next, null);

  const before = s.fake.requests.length;
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 0);
  assert.equal(s.final().state, "connected");
  assert.equal(s.fake.requests.slice(before).some((r) => r.route === "rotate"), false);
  assert.equal(s.putKey(), a.write);
  assert.equal(a.tenant.write, keyHash(a.write));
  assert.equal(a.tenant.prev, null);
  assertNoSecret(s, [a.read, a.write, staleKey, orphan]);
});

test("init with a next K that is not current: discarded without any request, even when a rotate would conflict", async (t) => {
  const s = await setup(t);
  const read = generateKey("r");
  const old = generateKey("w");
  const tenant = s.fake.addTenant({ readKey: read, writeKey: old, contactHint: CONTACT });
  const next = generateKey("w");
  await writeAccount(s.deps, active(s.fake.url, { account: tenant.name, read_token: read, write_key: old, write_key_next: next }));
  s.fake.respond("rotate", { status: 409, headers: { "content-type": "application/problem+json" }, body: JSON.stringify({ type: "https://op8x.com/errors/key_conflict", title: "x", status: 409, code: "key_conflict" }) });
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 0);
  assert.equal(s.final().state, "connected");
  assert.equal(s.fake.requests.some((r) => r.route === "rotate"), false);
  const f = s.file();
  assert.equal(f.write_key, old);
  assert.equal(f.write_key_next, null);
  assert.equal(s.putKey(), old);
});

// --- output guard ----------------------------------------------------------------------------------

test("after the output guard hit, nothing further happens (no wrangler, no test request)", async (t) => {
  // The guard treats OP8X_TEST_TOKEN as a secret: a value that appears in the first step line.
  const s = await setup(t, { env: { OP8X_TEST_TOKEN: "cloudflare" } });
  assert.equal(await run(["init", "--json", "--url", s.url], s.deps), 2);
  assert.equal(s.final().state, "internal_error");
  assert.equal(s.wrangler.calls().length, 0);
  assert.deepEqual(s.fake.requests, []);

  const h = await setup(t);
  await signedIn(h);
  h.deps.env = { ...h.deps.env, OP8X_TEST_TOKEN: new URL(h.url).host };
  assert.equal(await run(["init", "--json", "--url", h.url], h.deps), 2);
  assert.equal(h.final().state, "internal_error");
  assert.equal(h.worker.requests.length, 0);
  assert.equal(h.file().workers[0]!.verified_at, null);
});

// --- --env-file -------------------------------------------------------------------------------------

const ENV_NAME = "secrets.local";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

/**
 * A recorded exec that answers git like an ignored, untracked file (or as set). Under win32 it also
 * answers whoami, icacls (the ACL of the file's temp file) and the browser opener; nothing else.
 */
function gitExec(o: { ignore?: number; tracked?: number } = {}) {
  const ok = { code: 0, stdout: "", stderr: "" };
  const handler: ExecHandler = (file, args) => {
    if (args.includes("check-ignore")) return { code: o.ignore ?? 0, stdout: "", stderr: "" };
    if (args.includes("ls-files")) return { code: o.tracked ?? 1, stdout: "", stderr: "" };
    if (file.endsWith("whoami.exe")) return { code: 0, stdout: `"desktop-x\\anna","${SID}"\r\n`, stderr: "" };
    if (file.endsWith("icacls.exe")) {
      if (args[1] === "/save") writeFileSync(String(args[2]), Buffer.from(`x\r\nD:PAI(A;;FA;;;${SID})\r\n`, "utf16le"));
      return ok;
    }
    if (file.endsWith("rundll32.exe")) return ok;
    throw new Error(`unexpected program ${file}`);
  };
  return recordingExec(handler);
}

async function envFileSetup(t: TestContext, o: { ignore?: number; tracked?: number; name?: string } = {}) {
  const gitDir = tempDir("op8x-gitbin-");
  writeFileSync(join(gitDir, process.platform === "win32" ? "git.exe" : "git"), "");
  const project = tempDir("op8x-node-");
  const path = join(project, o.name ?? ENV_NAME);
  const exec = gitExec(o);
  const envKey = () => {
    try {
      return /^OP8X_KEY=(.*)$/m.exec(readFileSync(path, "utf8"))?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  };
  const s = await setup(t, { config: null, workerKey: envKey, deps: { exec, cwd: project, platform: process.platform }, env: { PATH: gitDir } });
  return { ...s, exec, path, project };
}

test("--env-file without a file: browser, key, test skipped; K in the file, other lines kept; url_required", async (t) => {
  const s = await envFileSetup(t);
  writeFileSync(s.path, "PORT=8787\n# note\n");
  onFirstPoll(s.fake, () => s.fake.grant({ contactHint: CONTACT }));
  assert.equal(await run(["init", "--json", "--env-file", ENV_NAME], s.deps), 1);
  assert.deepEqual(steps(s.lines()), [
    ["browser", "ok"],
    ["key", "ok"],
    ["test", "skipped"],
  ]);
  const f = s.file();
  assert.equal(readFileSync(s.path, "utf8"), `PORT=8787\n# note\nOP8X_KEY=${f.write_key}\n`);
  assert.equal(f.workers.length, 1);
  const w: WorkerEntry = f.workers[0]!;
  assert.equal(w.env_file, s.path);
  assert.equal(w.name, null);
  assert.equal(w.env, null);
  assert.equal(w.url, null);
  assert.equal(s.final().state, "url_required");
  assert.deepEqual(s.final().workers, [{ name: null, env: null, env_file: s.path, status: "no_url" }]);
  // git, no wrangler (under win32 also whoami and icacls for the files' ACL, and the opener).
  const gitCalls = s.exec.calls.filter((c) => /[\\/]git(\.exe)?$/.test(c.file));
  assert.deepEqual(
    gitCalls.map((c) => c.args.filter((a) => a === "check-ignore" || a === "ls-files")[0]),
    ["check-ignore", "ls-files"],
  );
  assert.ok(s.exec.calls.every((c) => !c.args.some((a) => a.endsWith("wrangler.js"))));
  assert.equal(s.deps.stdout().includes("PORT=8787"), false);
  assertNoSecret(s, [f.write_key, f.read_token]);
});

test("--env-file with --url on a signed-in computer: key and test, connected", async (t) => {
  const s = await envFileSetup(t);
  const a = await signedIn(s);
  assert.equal(await run(["init", "--json", "--env-file", s.path, "--url", s.url], s.deps), 0);
  assert.deepEqual(steps(s.lines()), [
    ["key", "ok"],
    ["test", "ok"],
  ]);
  assert.equal(readFileSync(s.path, "utf8"), `OP8X_KEY=${a.write}\n`);
  assert.equal(s.final().state, "connected");
  assert.deepEqual(s.final().workers, [{ name: null, env: null, env_file: s.path, status: "verified" }]);
  // A second run with the same file updates the same entry.
  assert.equal(await run(["init", "--json", "--env-file", s.path, "--url", s.url], s.deps), 0);
  assert.equal(s.file().workers.length, 1);
});

test("--env-file that git does not ignore, tracks, outside a repo, or .dev.vars: env_file_not_ignored, nothing sent or written", async (t) => {
  for (const o of [{ ignore: 1 }, { tracked: 0 }, { ignore: 128 }, { name: ".dev.vars" }]) {
    const s = await envFileSetup(t, o);
    assert.equal(await run(["init", "--json", "--env-file", s.path], s.deps), 4, JSON.stringify(o));
    assert.equal(s.final().state, "env_file_not_ignored");
    assert.equal(s.final().agent_hint, "Use a file that git ignores (and not .dev.vars).");
    assert.deepEqual(s.fake.requests, []);
    assert.deepEqual(readdirSync(s.project), []);
  }
});
