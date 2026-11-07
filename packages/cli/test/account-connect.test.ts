import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createApi } from "../src/account/api.ts";
import {
  POLL_EVERY_MS,
  envFileAllowed,
  gitOnPath,
  isBlockedAddress,
  sendTestRequest,
  testUrlAllowed,
  upsertWorker,
  verifyWorker,
  withEnvKey,
  withEnvValues,
  withoutEnvKey,
  writeEnvKey,
} from "../src/account/connect.ts";
import { generateKey } from "../src/account/keys.ts";
import { newSalt } from "../src/account/salt.ts";
import { createOutput } from "../src/account/output.ts";
import { StoreError, systemRootOf } from "../src/account/store.ts";
import type { WorkerEntry } from "../src/account/store.ts";
import type { Deps, ExecOptions } from "../src/cli.ts";
import { recordingExec, tempDir, testDeps } from "./account-deps.ts";
import type { ExecHandler } from "./account-deps.ts";
import { startFakeCollector } from "./fake-collector.ts";
import { startFakeWorker } from "./fake-worker.ts";
import type { WorkerMode } from "./fake-worker.ts";

type Line = Record<string, unknown>;

// --- host guard ----------------------------------------------------------------------------

test("isBlockedAddress: private, loopback, link-local, ULA, CGNAT, unspecified, multicast and mapped addresses", () => {
  const blocked = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.255.255.255",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "not an address",
    "",
  ];
  const open = ["93.184.216.34", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111", "2001:db8::1"];
  for (const a of blocked) assert.equal(isBlockedAddress(a), true, a);
  for (const a of open) assert.equal(isBlockedAddress(a), false, a);
});

test("testUrlAllowed: without --url only https to public hosts (IP literal and every looked-up address)", async () => {
  const deps = testDeps({
    lookupTable: {
      "api.example": ["93.184.216.34", "2606:4700::6810:1"],
      "mixed.example": ["93.184.216.34", "10.0.0.5"],
      "inner.example": ["192.168.0.10"],
      "v6inner.example": ["fd00::5"],
      "empty.example": [],
    },
  });
  const cases: [string, boolean][] = [
    ["https://api.example/paid", true],
    ["https://93.184.216.34/paid", true],
    ["https://[2606:4700:4700::1111]/paid", true],
    ["http://api.example/paid", false], // https only
    ["https://mixed.example/paid", false], // one private address is enough
    ["https://inner.example/paid", false],
    ["https://v6inner.example/paid", false],
    ["https://empty.example/paid", false],
    ["https://unknown.example/paid", false], // lookup fails
    ["https://127.0.0.1/paid", false],
    ["https://[::1]/paid", false],
    ["https://[::ffff:127.0.0.1]/paid", false],
    ["https://10.0.0.1/paid", false],
    ["https://169.254.169.254/latest", false],
    ["https://user:pw@api.example/paid", false],
    ["not a url", false],
  ];
  for (const [url, ok] of cases) assert.equal(await testUrlAllowed(deps, url, false), ok, url);
});

test("testUrlAllowed: an explicit --url may name a private or loopback host; http only on loopback", async () => {
  const deps = testDeps();
  const cases: [string, boolean][] = [
    ["https://10.0.0.1/paid", true],
    ["https://inner.example/paid", true], // no lookup needed
    ["http://127.0.0.1:8787/paid", true],
    ["http://localhost:8787/paid", true],
    ["http://[::1]:8787/paid", true],
    ["http://10.0.0.1/paid", false],
    ["http://api.example/paid", false],
    ["ftp://127.0.0.1/x", false],
    ["https://user:pw@api.example/paid", false],
  ];
  for (const [url, ok] of cases) assert.equal(await testUrlAllowed(deps, url, true), ok, url);
});

// --- test request ----------------------------------------------------------------------------------

async function collectorAndWorker(t: TestContext, mode: WorkerMode = "module", o: { withKey?: boolean } = {}) {
  const fake = await startFakeCollector();
  t.after(() => fake.close());
  const read = generateKey("r");
  const write = generateKey("w");
  const tenant = fake.addTenant({ readKey: read, writeKey: o.withKey === false ? null : write });
  const worker = await startFakeWorker({ collector: fake, key: () => write, mode });
  t.after(() => worker.close());
  const deps = testDeps({
    now: () => fake.now(),
    sleep: async (ms) => {
      deps.sleeps.push(ms);
      fake.advance(ms);
    },
    env: { OP8X_COLLECTOR_URL: fake.url },
  });
  const out = createOutput({ command: "init", json: true, deps, steps: 1, secrets: () => [read, write] });
  const api = createApi(deps, fake.url);
  const lines = () =>
    deps
      .stdout()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Line);
  return { fake, worker, deps, out, api, read, write, tenant, lines };
}

test("sendTestRequest: GET with only op8x-test and the User-Agent; no op8x secret; a redirect is not followed", async (t) => {
  const s = await collectorAndWorker(t, "redirect");
  const nonce = "N".repeat(43);
  await sendTestRequest(s.deps, `${s.worker.origin}/paid`, nonce);
  assert.equal(s.worker.requests.length, 1);
  const req = s.worker.requests[0]!;
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/paid");
  assert.equal(req.headers["op8x-test"], nonce);
  assert.equal(req.headers.authorization, undefined);
  assert.match(String(req.headers["user-agent"]), /^op8x-cli\//);
  const all = JSON.stringify(req.headers);
  assert.equal(all.includes(s.read), false);
  assert.equal(all.includes(s.write), false);
});

test("verifyWorker: nonce, notice test_host before the request, polling until the collector saw it", async (t) => {
  const s = await collectorAndWorker(t);
  let noticedBeforeRequest = false;
  const url = `${s.worker.origin}/paid`;
  const r = await verifyWorker({ deps: s.deps, api: s.api, out: s.out, readToken: s.read, url, explicit: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.seenAt, /^\d{4}-\d{2}-\d{2}T/);
  const notice = s.lines().find((l) => l.event === "notice");
  assert.deepEqual(notice, {
    schema: "op8x.cli/1",
    command: "init",
    final: false,
    event: "notice",
    id: "test_host",
    text: `Sending one test request to ${new URL(url).host}.`,
    host: new URL(url).host,
  });
  noticedBeforeRequest = s.worker.requests.length === 1;
  assert.ok(noticedBeforeRequest);
  // One nonce, then one poll after 3 s.
  assert.deepEqual(
    s.fake.requests.map((q) => q.route),
    ["test_nonce", "test_nonce_status"],
  );
  assert.deepEqual(s.deps.sleeps, [POLL_EVERY_MS]);
  assert.deepEqual(s.fake.violations, []);
});

test("verifyWorker: no test event within 60 s is deployed_unverified, at most one poll per 3 s", async (t) => {
  const s = await collectorAndWorker(t, "no_module");
  const t0 = s.fake.now();
  const r = await verifyWorker({ deps: s.deps, api: s.api, out: s.out, readToken: s.read, url: `${s.worker.origin}/paid`, explicit: true });
  assert.deepEqual(r, { ok: false, state: "deployed_unverified" });
  const polls = s.fake.requests.filter((q) => q.route === "test_nonce_status");
  assert.equal(polls.length, 20);
  assert.ok(s.deps.sleeps.every((ms) => ms === 3000));
  assert.equal(s.deps.sleeps.length, 20);
  assert.equal(s.fake.now() - t0, 60_000);
});

test("verifyWorker: a refused host costs no nonce and sends nothing", async (t) => {
  const s = await collectorAndWorker(t);
  const deps = { ...s.deps, lookup: async () => ["10.0.0.7"] };
  const r = await verifyWorker({ deps, api: s.api, out: s.out, readToken: s.read, url: "https://api.example/paid", explicit: false });
  assert.deepEqual(r, { ok: false, state: "host_refused" });
  assert.deepEqual(s.fake.requests, []);
  assert.equal(s.deps.stdout(), "");
});

test("verifyWorker: 409 no_write_key at test-nonce is the API error server_key_missing", async (t) => {
  const s = await collectorAndWorker(t, "module", { withKey: false });
  const r = await verifyWorker({ deps: s.deps, api: s.api, out: s.out, readToken: s.read, url: `${s.worker.origin}/paid`, explicit: true });
  assert.deepEqual(r, { ok: false, state: "api", error: { state: "server_key_missing" } });
  assert.equal(s.worker.requests.length, 0);
});

test("verifyWorker: after the output guard stopped, no test request goes out", async (t) => {
  const s = await collectorAndWorker(t);
  // The host of the notice holds the read token: the guard replaces the line and stops.
  const url = `${s.worker.origin}/paid`;
  const out = createOutput({ command: "init", json: true, deps: s.deps, steps: 1, secrets: () => [new URL(url).host] });
  const r = await verifyWorker({ deps: s.deps, api: s.api, out, readToken: s.read, url, explicit: true });
  assert.deepEqual(r, { ok: false, state: "stopped" });
  assert.equal(s.worker.requests.length, 0);
  assert.equal(JSON.parse(s.deps.stdout()).state, "internal_error");
});

// --- env file content -----------------------------------------------------------------------------

test("withEnvKey: appends or replaces OP8X_KEY and keeps every other byte", () => {
  const key = generateKey("w");
  assert.equal(withEnvKey(null, key).toString(), `OP8X_KEY=${key}\n`);
  assert.equal(withEnvKey(Buffer.alloc(0), key).toString(), `OP8X_KEY=${key}\n`);
  assert.equal(withEnvKey(Buffer.from("A=1\nB=2\n"), key).toString(), `A=1\nB=2\nOP8X_KEY=${key}\n`);
  assert.equal(withEnvKey(Buffer.from("A=1"), key).toString(), `A=1\nOP8X_KEY=${key}\n`);
  assert.equal(withEnvKey(Buffer.from("A=1\r\nB=2"), key).toString(), `A=1\r\nB=2\r\nOP8X_KEY=${key}\r\n`);
  assert.equal(withEnvKey(Buffer.from("A=1\nOP8X_KEY=old\nB=2\n"), key).toString(), `A=1\nOP8X_KEY=${key}\nB=2\n`);
  assert.equal(withEnvKey(Buffer.from("A=1\r\nexport OP8X_KEY = old\r\n"), key).toString(), `A=1\r\nOP8X_KEY=${key}\r\n`);
  assert.equal(withEnvKey(Buffer.from("OP8X_KEY_OTHER=x\n# OP8X_KEY=x\n"), key).toString(), `OP8X_KEY_OTHER=x\n# OP8X_KEY=x\nOP8X_KEY=${key}\n`);
  // Bytes that are no UTF-8 stay as they are.
  const raw = Buffer.from([0x41, 0x3d, 0xff, 0xfe, 0x0a, 0x42, 0x3d, 0xc3, 0x28, 0x0a]);
  const result = withEnvKey(raw, key);
  assert.deepEqual(result.subarray(0, raw.length), raw);
  assert.equal(result.subarray(raw.length).toString(), `OP8X_KEY=${key}\n`);
});

// --- git check, recorded exec ------------------------------------------------------------------

/** A folder with an empty file named like git, for PATH. */
function fakeGitDir(platform: NodeJS.Platform): { dir: string; git: string } {
  const dir = tempDir("op8x-gitbin-");
  const git = join(dir, platform === "win32" ? "git.exe" : "git");
  writeFileSync(git, "");
  return { dir, git };
}

function gitDeps(answers: { ignore?: number | null; tracked?: number | null }, o: { platform?: NodeJS.Platform; env?: Record<string, string> } = {}) {
  const platform = o.platform ?? process.platform;
  const bin = fakeGitDir(platform);
  const handler: ExecHandler = (_file, args) => {
    if (args.includes("check-ignore")) return { code: answers.ignore === undefined ? 0 : answers.ignore, stdout: "", stderr: "" };
    if (args.includes("ls-files")) return { code: answers.tracked === undefined ? 1 : answers.tracked, stdout: "", stderr: "" };
    throw new Error("unexpected git call");
  };
  const exec = recordingExec(handler);
  const sep = platform === "win32" ? ";" : ":";
  const deps = testDeps({ platform, exec, env: { PATH: ["relative/bin", bin.dir].join(sep), ...o.env } });
  return { deps, exec, git: bin.git };
}

test("envFileAllowed: git check-ignore, then ls-files, from the file's folder, git by its absolute path", async () => {
  const dir = tempDir();
  const path = join(dir, "local.env");
  const g = gitDeps({}, { env: { CLOUDFLARE_API_TOKEN: "cf-token-value", OP8X_TEST_TOKEN: "test-token-value", HOME: "/home/x", GIT_DIR: "/elsewhere" } });
  assert.equal(await envFileAllowed(g.deps, path), true);
  assert.deepEqual(
    g.exec.calls.map((c) => [c.file, c.args]),
    [
      [g.git, ["-c", "core.fsmonitor=false", "check-ignore", "-q", "--", path]],
      [g.git, ["-c", "core.fsmonitor=false", "ls-files", "--error-unmatch", "--", path]],
    ],
  );
  const opts: ExecOptions = g.exec.calls[0]!.opts;
  assert.equal(opts.cwd, dir);
  assert.equal(opts.input, undefined);
  assert.deepEqual(Object.keys(opts.env).sort(), ["HOME", "PATH"]);
  // check-ignore takes plain paths; ls-files a pathspec, read literally.
  assert.deepEqual(Object.keys(g.exec.calls[1]!.opts.env).sort(), ["GIT_LITERAL_PATHSPECS", "HOME", "PATH"]);
});

test("envFileAllowed: not ignored, tracked, no repo, git errors, no git, relative path, .dev.vars → false", async () => {
  const path = join(tempDir(), "local.env");
  assert.equal(await envFileAllowed(gitDeps({ ignore: 1 }).deps, path), false); // not ignored
  assert.equal(await envFileAllowed(gitDeps({ ignore: 128 }).deps, path), false); // no repo
  assert.equal(await envFileAllowed(gitDeps({ ignore: null }).deps, path), false); // timeout
  assert.equal(await envFileAllowed(gitDeps({ tracked: 0 }).deps, path), false); // tracked
  assert.equal(await envFileAllowed(gitDeps({ tracked: 128 }).deps, path), false);
  assert.equal(await envFileAllowed(gitDeps({}).deps, "local.env"), false);
  for (const name of [".dev.vars", ".DEV.VARS", ".dev.vars.staging"]) {
    const g = gitDeps({});
    assert.equal(await envFileAllowed(g.deps, join(tempDir(), name)), false, name);
    assert.equal(g.exec.calls.length, 0, name);
  }
  const none = testDeps({ platform: process.platform, env: { PATH: ["relative", "also/relative"].join(process.platform === "win32" ? ";" : ":") } });
  assert.equal(await envFileAllowed(none, path), false);
  assert.equal(await gitOnPath(none), null);
  const throwing = testDeps({
    platform: process.platform,
    env: { PATH: fakeGitDir(process.platform).dir },
    exec: recordingExec(() => {
      throw new Error("spawn failed");
    }),
  });
  assert.equal(await envFileAllowed(throwing, path), false);
});

test("gitOnPath on win32: PATH in any case, git.exe, quoted entries", async () => {
  const bin = fakeGitDir("win32");
  const deps = testDeps({ platform: "win32", env: { Path: `C:\\nowhere-op8x;"${bin.dir}"` } });
  assert.equal(await gitOnPath(deps), bin.git);
});

test("envFileAllowed for real: an ignored file passes; a tracked, a not ignored and a file outside a repo do not", { skip: !hasGit() }, async () => {
  const { exec } = await import("../src/account/system.ts");
  const repo = tempDir("op8x-repo-");
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv });
  writeFileSync(join(repo, ".gitignore"), "local.env\ntracked.env\n");
  writeFileSync(join(repo, "local.env"), "A=1\n");
  writeFileSync(join(repo, "plain.env"), "A=1\n");
  writeFileSync(join(repo, "tracked.env"), "A=1\n");
  execFileSync("git", ["add", "-f", "tracked.env"], { cwd: repo, env: gitEnv });
  const deps = testDeps({ platform: process.platform, env: process.env as Record<string, string>, exec });
  assert.equal(await envFileAllowed(deps, join(repo, "local.env")), true);
  assert.equal(await envFileAllowed(deps, join(repo, "plain.env")), false);
  assert.equal(await envFileAllowed(deps, join(repo, "tracked.env")), false);
  assert.equal(await envFileAllowed(deps, join(repo, "missing-folder", "x.env")), false);
});

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// --- writing the env file -----------------------------------------------------------------------------

test("writeEnvKey: writes K into the file, keeps the other lines, leaves no temp file", async () => {
  const dir = tempDir();
  const path = join(dir, "local.env");
  writeFileSync(path, "PORT=8787\nOP8X_KEY=stale\n");
  const key = generateKey("w");
  await writeEnvKey(testDeps(), path, key);
  assert.equal(readFileSync(path, "utf8"), `PORT=8787\nOP8X_KEY=${key}\n`);
  assert.deepEqual(readdirSync(dir), ["local.env"]);
  if (process.platform !== "win32") {
    const { statSync } = await import("node:fs");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test("writeEnvKey: a folder in place of the file is permissions_failed and nothing is written", async () => {
  const dir = tempDir();
  const path = join(dir, "local.env");
  mkdirSync(path);
  await assert.rejects(writeEnvKey(testDeps(), path, generateKey("w")), (e) => e instanceof StoreError && e.code === "permissions_failed");
  assert.deepEqual(readdirSync(dir), ["local.env"]);
});

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

test("withEnvValues: OP8X_KEY and OP8X_SALT replaced in place or appended in order, other bytes kept", () => {
  const key = generateKey("w");
  const salt = newSalt();
  const both = [
    ["OP8X_KEY", key],
    ["OP8X_SALT", salt],
  ] as const;
  assert.equal(withEnvValues(null, both).toString(), `OP8X_KEY=${key}\nOP8X_SALT=${salt}\n`);
  assert.equal(withEnvValues(Buffer.from("A=1\r\nB=2"), both).toString(), `A=1\r\nB=2\r\nOP8X_KEY=${key}\r\nOP8X_SALT=${salt}\r\n`);
  assert.equal(
    withEnvValues(Buffer.from("OP8X_SALT=old\nA=1\nexport OP8X_KEY=old\n"), both).toString(),
    `OP8X_SALT=${salt}\nA=1\nOP8X_KEY=${key}\n`,
  );
  assert.equal(withEnvValues(Buffer.from("OP8X_SALTY=x\n"), both).toString(), `OP8X_SALTY=x\nOP8X_KEY=${key}\nOP8X_SALT=${salt}\n`);
  // Only K given (rotate): the salt line stays as it is.
  assert.equal(withEnvValues(Buffer.from(`OP8X_KEY=old\nOP8X_SALT=${salt}\n`), [["OP8X_KEY", key]]).toString(), `OP8X_KEY=${key}\nOP8X_SALT=${salt}\n`);
});

test("withoutEnvKey: removes the OP8X_KEY and OP8X_SALT lines, keeps every other line", () => {
  const salt = newSalt();
  assert.equal(withoutEnvKey(Buffer.from(`A=1\nOP8X_KEY=k\r\nexport OP8X_SALT = ${salt}\nOP8X_SALTY=x\n`))?.toString(), "A=1\nOP8X_SALTY=x\n");
  assert.equal(withoutEnvKey(Buffer.from(`OP8X_SALT=${salt}`))?.toString(), "");
  assert.equal(withoutEnvKey(Buffer.from("A=1\n")), null);
});

test("writeEnvKey with a salt writes both lines in one protected write; without one it keeps the salt line", async () => {
  const dir = tempDir();
  const path = join(dir, "local.env");
  writeFileSync(path, "PORT=1\n");
  const key = generateKey("w");
  const salt = newSalt();
  await writeEnvKey(testDeps(), path, key, salt);
  assert.equal(readFileSync(path, "utf8"), `PORT=1\nOP8X_KEY=${key}\nOP8X_SALT=${salt}\n`);
  const next = generateKey("w");
  await writeEnvKey(testDeps(), path, next);
  assert.equal(readFileSync(path, "utf8"), `PORT=1\nOP8X_KEY=${next}\nOP8X_SALT=${salt}\n`);
  assert.deepEqual(readdirSync(dir), ["local.env"]);
});

test("writeEnvKey on Windows (recorded exec): SID, ACL set and checked on the temp file before K goes in", async () => {
  const dir = tempDir();
  const path = join(dir, "local.env");
  writeFileSync(path, "A=1\n");
  const seen: { step: string; content: string }[] = [];
  const exec = recordingExec((file, args) => {
    if (file.endsWith("whoami.exe")) {
      seen.push({ step: "whoami", content: "" });
      return { code: 0, stdout: `"desktop-x\\anna","${SID}"\r\n`, stderr: "" };
    }
    seen.push({ step: String(args[1]), content: readFileSync(String(args[0]), "utf8") });
    if (args[1] === "/save") writeFileSync(String(args[2]), Buffer.from(`x\r\nD:PAI(A;;FA;;;${SID})\r\n`, "utf16le"));
    return { code: 0, stdout: "", stderr: "" };
  });
  const deps = testDeps({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exec });
  const key = generateKey("w");
  await writeEnvKey(deps, path, key);
  assert.deepEqual(
    seen.map((s) => s.step),
    ["whoami", "/inheritance:r", "/save", "/save"],
  );
  assert.ok(seen.every((s) => !s.content.includes(key)), "K goes in only after the ACL is checked");
  assert.deepEqual(
    exec.calls.map((c) => c.file),
    [win32.join("C:\\Windows", "System32", "whoami.exe"), ...Array(3).fill(win32.join("C:\\Windows", "System32", "icacls.exe"))],
  );
  assert.equal(readFileSync(path, "utf8"), `A=1\nOP8X_KEY=${key}\n`);
  // The folder of an env file keeps its rights: no icacls call names it.
  assert.ok(exec.calls.every((c) => c.args[0] !== dir));
});

test("writeEnvKey on Windows (recorded exec): an ACL that stays open is permissions_failed, the file is unchanged", async () => {
  const dir = tempDir();
  const path = join(dir, "local.env");
  writeFileSync(path, "A=1\n");
  const exec = recordingExec((file, args) => {
    if (file.endsWith("whoami.exe")) return { code: 0, stdout: `"desktop-x\\anna","${SID}"\r\n`, stderr: "" };
    if (args[1] === "/save") writeFileSync(String(args[2]), Buffer.from(`x\r\nD:AI(A;;FA;;;${SID})(A;;FA;;;WD)\r\n`, "utf16le"));
    return { code: 0, stdout: "", stderr: "" };
  });
  const deps = testDeps({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exec });
  await assert.rejects(writeEnvKey(deps, path, generateKey("w")), (e) => e instanceof StoreError && e.code === "permissions_failed");
  assert.equal(readFileSync(path, "utf8"), "A=1\n");
  assert.deepEqual(readdirSync(dir), ["local.env"]);
});

test("writeEnvKey on Windows for real: the env file ends with exactly one ACE for the user", { skip: process.platform !== "win32" }, async () => {
  const { exec } = await import("../src/account/system.ts");
  const root = systemRootOf(process.env) ?? "";
  const dir = tempDir();
  const path = join(dir, "local.env");
  writeFileSync(path, "A=1\r\n");
  const deps: Deps = testDeps({ platform: "win32", env: { SystemRoot: root }, exec });
  const key = generateKey("w");
  await writeEnvKey(deps, path, key);
  assert.equal(readFileSync(path, "utf8"), `A=1\r\nOP8X_KEY=${key}\r\n`);
  assert.deepEqual(readdirSync(dir), ["local.env"]);
  const who = await exec(win32.join(root, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { cwd: dir, env: { SystemRoot: root }, timeoutMs: 10_000 });
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(who.stdout)?.[1];
  assert.ok(sid);
  const saved = join(dir, "check.acl");
  const save = await exec(win32.join(root, "System32", "icacls.exe"), [path, "/save", saved], { cwd: dir, env: { SystemRoot: root }, timeoutMs: 10_000 });
  assert.equal(save.code, 0);
  const lines = readFileSync(saved).toString("utf16le").split(/\r?\n/).filter((l) => l !== "");
  const { sddlTrusteeIsSid } = await import("../src/account/store.ts");
  const trustee = /^D:P[A-Z]*\(A;;FA;;;([^;()]+)\)$/.exec(lines[1] ?? "")?.[1];
  assert.ok(trustee !== undefined && sddlTrusteeIsSid(trustee, sid), `unexpected SDDL: ${lines[1]}`);
});

// --- worker entries -------------------------------------------------------------------------------

test("upsertWorker: the same target is updated in place, another is appended", () => {
  const base: WorkerEntry = { dir: "/w/api", name: "api", env: null, env_file: null, url: null, deployed_at: "2026-11-01T10:00:00Z", verified_at: null, key_fingerprint: "1a2b3c4d" };
  const staging = { ...base, env: "staging", name: "api-staging" };
  const file: WorkerEntry = { ...base, dir: "/w/node", name: null, env_file: "/w/node/local.env" };
  let list = upsertWorker([], base);
  list = upsertWorker(list, staging);
  list = upsertWorker(list, file);
  assert.equal(list.length, 3);
  list = upsertWorker(list, { ...base, url: "https://api.example/paid" });
  list = upsertWorker(list, { ...file, dir: "/elsewhere", key_fingerprint: "9f8e7d6c" });
  assert.equal(list.length, 3);
  assert.equal(list[0]!.url, "https://api.example/paid");
  assert.equal(list[1]!.url, null);
  assert.equal(list[2]!.key_fingerprint, "9f8e7d6c");
});
