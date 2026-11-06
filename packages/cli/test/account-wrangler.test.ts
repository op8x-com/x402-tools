import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { generateKey } from "../src/account/keys.ts";
import { createOutput } from "../src/account/output.ts";
import { exec } from "../src/account/system.ts";
import {
  WRANGLER_TIMEOUT_MS,
  cloudflareLoggedIn,
  createSecrets,
  findWrangler,
  readWranglerConfig,
  resolveTarget,
  wranglerEnv,
} from "../src/account/wrangler.ts";
import type { WranglerBin } from "../src/account/wrangler.ts";
import { recordingExec, tempDir, testDeps } from "./account-deps.ts";
import type { TestDeps } from "./account-deps.ts";
import { LOGGED_IN, LOGGED_IN_ACCOUNT, LOGGED_IN_EMAIL, LOGGED_OUT, createFakeWrangler } from "./fake-wrangler.ts";
import type { FakeWrangler } from "./fake-wrangler.ts";

const win = process.platform === "win32";

/**
 * Under Windows libuv adds these names to every child environment when they are missing (copied
 * from the parent; uv_spawn, required_vars). They are not in the CLI's hands; every other name the
 * child sees must come from the allowlist.
 */
const LIBUV_REQUIRED = new Set(["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"]);

/** The child's environment without the names libuv adds under Windows (unless the CLI passed them). */
function childEnv(seen: Record<string, string>, passed: Record<string, string>): Record<string, string> {
  if (!win) return seen;
  const passedLower = new Set(Object.keys(passed).map((k) => k.toLowerCase()));
  return Object.fromEntries(Object.entries(seen).filter(([k]) => !LIBUV_REQUIRED.has(k.toUpperCase()) || passedLower.has(k.toLowerCase())));
}

/** The environment a real child needs on this system, plus names the allowlist must drop. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {
    HOME: "/home/seller",
    CLOUDFLARE_API_TOKEN: "cf-test-token-value",
    https_proxy: "http://proxy.example:3128",
    NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
    WRANGLER_LOG: "debug",
    WRANGLER_LOG_PATH: "/tmp/wrangler.log",
    DEBUG: "*",
    NODE_OPTIONS: "--require ./evil.js",
    OP8X_TEST_TOKEN: "op8x-test-token-value",
    CI: "1",
  };
  if (win && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function realDeps(env: Record<string, string> = baseEnv(), fake?: FakeWrangler): TestDeps {
  return testDeps({ exec, env, platform: process.platform, ...(fake ? { cwd: fake.dir } : {}) });
}

async function found(fake: FakeWrangler, deps: TestDeps = realDeps()): Promise<WranglerBin> {
  const r = await findWrangler(deps, fake.dir);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("not found");
  return r.bin;
}

function output(deps: TestDeps, secrets: () => string[] = () => []) {
  return createOutput({ command: "init", json: true, deps, steps: 1, secrets });
}

// --- finding and versions ------------------------------------------------------------------------

test("findWrangler: the project's own wrangler is found, with the real path of wrangler.js", async () => {
  const fake = createFakeWrangler();
  const r = await findWrangler(realDeps(), fake.dir);
  assert.deepEqual(r, { ok: true, bin: { dir: resolve(fake.dir), script: realpathSync(fake.script), version: "4.152.0" } });
});

test("findWrangler: no node_modules/wrangler in the folder -> wrangler_missing", async () => {
  const dir = tempDir();
  assert.deepEqual(await findWrangler(realDeps(), dir), { ok: false, state: "wrangler_missing" });
});

test("findWrangler: a package that is not named wrangler -> wrangler_missing", async () => {
  const fake = createFakeWrangler({ name: "wrangler-tools" });
  assert.deepEqual(await findWrangler(realDeps(), fake.dir), { ok: false, state: "wrangler_missing" });
});

test("findWrangler: package.json without bin/wrangler.js -> wrangler_missing", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "node_modules", "wrangler"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "wrangler", "package.json"), JSON.stringify({ name: "wrangler", version: "4.152.0" }));
  assert.deepEqual(await findWrangler(realDeps(), dir), { ok: false, state: "wrangler_missing" });
});

test("findWrangler: package.json that is not JSON or is too big -> wrangler_missing", async () => {
  const fake = createFakeWrangler();
  writeFileSync(join(fake.dir, "node_modules", "wrangler", "package.json"), "{ name: wrangler");
  assert.deepEqual(await findWrangler(realDeps(), fake.dir), { ok: false, state: "wrangler_missing" });
  writeFileSync(
    join(fake.dir, "node_modules", "wrangler", "package.json"),
    JSON.stringify({ name: "wrangler", version: "4.152.0", pad: "x".repeat(2 * 1024 * 1024) }),
  );
  assert.deepEqual(await findWrangler(realDeps(), fake.dir), { ok: false, state: "wrangler_missing" });
});

test("findWrangler: node_modules/wrangler linked to a folder outside the project -> wrangler_missing (A42)", async () => {
  const outside = createFakeWrangler();
  const project = tempDir();
  mkdirSync(join(project, "node_modules"));
  symlinkSync(join(outside.dir, "node_modules", "wrangler"), join(project, "node_modules", "wrangler"), "junction");
  assert.deepEqual(await findWrangler(realDeps(), project), { ok: false, state: "wrangler_missing" });
});

test("findWrangler: wrangler only in a parent folder -> wrangler_missing (no search upwards)", async () => {
  const parent = createFakeWrangler();
  const child = join(parent.dir, "worker");
  mkdirSync(child);
  assert.deepEqual(await findWrangler(realDeps(), child), { ok: false, state: "wrangler_missing" });
});

test("findWrangler: version below 4.152.0 or a pre-release of it -> wrangler_too_old", async () => {
  for (const version of ["4.151.0", "4.151.99", "3.200.0", "4.152.0-beta.1"]) {
    const fake = createFakeWrangler({ version });
    assert.deepEqual(await findWrangler(realDeps(), fake.dir), { ok: false, state: "wrangler_too_old" }, version);
  }
  for (const version of ["4.152.0", "4.152.1", "4.153.0", "5.0.0", "10.0.0"]) {
    const fake = createFakeWrangler({ version });
    assert.equal((await findWrangler(realDeps(), fake.dir)).ok, true, version);
  }
});

test("findWrangler: a version that is no version -> wrangler_missing", async () => {
  for (const version of ["latest", "4.152", "", "v4.152.0"]) {
    const fake = createFakeWrangler({ version });
    assert.deepEqual(await findWrangler(realDeps(), fake.dir), { ok: false, state: "wrangler_missing" }, version);
  }
});

test("findWrangler: Node below 22 -> wrangler_too_old", async () => {
  const fake = createFakeWrangler();
  for (const nodeVersion of ["20.19.0", "21.7.3", "18.0.0"]) {
    const deps = testDeps({ nodeVersion });
    assert.deepEqual(await findWrangler(deps, fake.dir), { ok: false, state: "wrangler_too_old" }, nodeVersion);
  }
  assert.equal((await findWrangler(testDeps({ nodeVersion: "22.0.0" }), fake.dir)).ok, true);
});

// --- start and environment -----------------------------------------------------------------------

test("wranglerEnv (POSIX): exactly the allowlist, exact spelling, log and debug names dropped (A39)", () => {
  const env = wranglerEnv(
    {
      PATH: "/usr/bin",
      Path: "/ignored",
      SystemRoot: "/sr",
      SYSTEMROOT: "/ignored",
      HOME: "/home/s",
      USERPROFILE: "/u",
      APPDATA: "/a",
      LOCALAPPDATA: "/la",
      XDG_CONFIG_HOME: "/x",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      CLOUDFLARE_API_TOKEN: "tok",
      HTTPS_PROXY: "hp",
      HTTP_PROXY: "p",
      NO_PROXY: "n",
      https_proxy: "hp2",
      http_proxy: "p2",
      no_proxy: "n2",
      NODE_EXTRA_CA_CERTS: "ca",
      TEMP: "t",
      TMP: "t2",
      Https_Proxy: "ignored",
      WRANGLER_LOG: "debug",
      WRANGLER_LOG_PATH: "/l",
      DEBUG: "*",
      NODE_OPTIONS: "--x",
      OP8X_TEST_TOKEN: "secret",
      CI: "1",
      EMPTY: undefined,
      TMPDIR: undefined,
    },
    "linux",
  );
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    SystemRoot: "/sr",
    HOME: "/home/s",
    USERPROFILE: "/u",
    APPDATA: "/a",
    LOCALAPPDATA: "/la",
    XDG_CONFIG_HOME: "/x",
    CLOUDFLARE_ACCOUNT_ID: "acc",
    CLOUDFLARE_API_TOKEN: "tok",
    HTTPS_PROXY: "hp",
    HTTP_PROXY: "p",
    NO_PROXY: "n",
    https_proxy: "hp2",
    http_proxy: "p2",
    no_proxy: "n2",
    NODE_EXTRA_CA_CERTS: "ca",
    TEMP: "t",
    TMP: "t2",
  });
  assert.equal(Object.getPrototypeOf(env), Object.prototype);
});

test("wranglerEnv (win32): names compared without case, original spelling kept", () => {
  const env = wranglerEnv(
    {
      Path: "C:\\Windows",
      SYSTEMROOT: "C:\\Windows",
      userprofile: "C:\\Users\\s",
      Temp: "C:\\t",
      https_proxy: "hp",
      wrangler_log: "debug",
      Debug: "*",
      Wrangler_Log_Path: "C:\\l",
      node_options: "--x",
      ComSpec: "C:\\Windows\\cmd.exe",
    },
    "win32",
  );
  assert.deepEqual(env, { Path: "C:\\Windows", SYSTEMROOT: "C:\\Windows", userprofile: "C:\\Users\\s", Temp: "C:\\t", https_proxy: "hp" });
});

test("whoami through the real exec: argv, empty stdin pipe, worker folder, exact environment", async () => {
  const fake = createFakeWrangler();
  const deps = realDeps(baseEnv(), fake);
  const bin = await found(fake, deps);
  assert.equal(await cloudflareLoggedIn(deps, bin), true);
  const calls = fake.calls();
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.deepEqual(call.argv, ["whoami", "--json"]);
  assert.equal(call.stdin, "");
  assert.equal(call.stdinIsTTY, false);
  assert.equal(realpathSync(call.cwd), realpathSync(fake.dir));
  const expected: Record<string, string> = {
    HOME: "/home/seller",
    CLOUDFLARE_API_TOKEN: "cf-test-token-value",
    https_proxy: "http://proxy.example:3128",
    NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
  };
  if (win && process.env.SystemRoot) expected.SystemRoot = process.env.SystemRoot;
  assert.deepEqual(childEnv(call.env, expected), expected);
  // None of the dropped names reaches the child, also not through libuv.
  for (const name of ["WRANGLER_LOG", "WRANGLER_LOG_PATH", "DEBUG", "NODE_OPTIONS", "OP8X_TEST_TOKEN", "CI"]) {
    assert.ok(!Object.keys(call.env).some((k) => k.toUpperCase() === name), name);
  }
});

test("whoami through the real exec under win32: Path and SYSTEMROOT keep their spelling", { skip: !win }, async () => {
  const fake = createFakeWrangler();
  const env = {
    Path: process.env.Path ?? process.env.PATH ?? "C:\\Windows\\System32",
    SYSTEMROOT: process.env.SystemRoot ?? "C:\\Windows",
    https_proxy: "http://proxy.example:3128",
    wrangler_log: "debug",
    Debug: "*",
  };
  const deps = realDeps(env, fake);
  const bin = await found(fake, deps);
  assert.equal(await cloudflareLoggedIn(deps, bin), true);
  const want = { Path: env.Path, SYSTEMROOT: env.SYSTEMROOT, https_proxy: env.https_proxy };
  const seen = fake.calls()[0]!.env;
  assert.deepEqual(childEnv(seen, want), want);
  assert.ok(!Object.keys(seen).some((k) => /^(wrangler_log|debug)$/i.test(k)));
});

test("start: node itself with wrangler.js, timeout 120 s, no shell, no npx", async () => {
  const fake = createFakeWrangler();
  const rec = recordingExec(() => ({ code: 0, stdout: LOGGED_IN, stderr: "" }));
  const deps = testDeps({ exec: rec, env: { PATH: "/usr/bin", DEBUG: "*" } });
  const bin = await found(fake, deps);
  assert.equal(await cloudflareLoggedIn(deps, bin), true);
  assert.equal(rec.calls.length, 1);
  const c = rec.calls[0]!;
  assert.equal(c.file, process.execPath);
  assert.deepEqual(c.args, [realpathSync(fake.script), "whoami", "--json"]);
  assert.deepEqual(c.opts, { cwd: resolve(fake.dir), env: { PATH: "/usr/bin" }, timeoutMs: 120_000 });
  assert.equal(WRANGLER_TIMEOUT_MS, 120_000);
  assert.ok(!c.args.some((a) => /npx|shell/i.test(a)));
});

// --- whoami --------------------------------------------------------------------------------------

test("whoami: logged in -> true; address and accounts appear in no output", async () => {
  const fake = createFakeWrangler();
  const deps = realDeps(baseEnv(), fake);
  const bin = await found(fake, deps);
  const r = await cloudflareLoggedIn(deps, bin);
  assert.equal(r, true);
  assert.equal(deps.stdout(), "");
  assert.equal(deps.stderr(), "");
  assert.ok(!JSON.stringify(r).includes(LOGGED_IN_EMAIL));
  assert.ok(!JSON.stringify(r).includes(LOGGED_IN_ACCOUNT));
});

test("whoami: not logged in (empty line, {loggedIn:false}, exit 1) -> false", async () => {
  const fake = createFakeWrangler();
  fake.answer("whoami", { exit: 1, stdout: LOGGED_OUT });
  const deps = realDeps(baseEnv(), fake);
  assert.equal(await cloudflareLoggedIn(deps, await found(fake, deps)), false);
  assert.equal(deps.stdout(), "");
});

test("whoami: only exit 0 together with loggedIn === true counts", async () => {
  const cases: { code: number | null; stdout: string; want: boolean }[] = [
    { code: 0, stdout: LOGGED_IN, want: true },
    { code: 0, stdout: `\n${JSON.stringify({ loggedIn: true })}\n`, want: true },
    { code: 0, stdout: `some banner line\n{"loggedIn":true,"email":"x@y.example"}\n`, want: true },
    { code: 0, stdout: `{"loggedIn":true}\r\n`, want: true },
    { code: 1, stdout: LOGGED_IN, want: false },
    { code: null, stdout: LOGGED_IN, want: false },
    { code: 0, stdout: `{"loggedIn":false}`, want: false },
    { code: 0, stdout: `{"loggedIn":"true"}`, want: false },
    { code: 0, stdout: `{"loggedIn":1}`, want: false },
    { code: 0, stdout: `[{"loggedIn":true}]`, want: false },
    { code: 0, stdout: `not json`, want: false },
    { code: 0, stdout: ``, want: false },
    { code: 0, stdout: `{"loggedIn":true}\n{"loggedIn":false}\n`, want: false },
    { code: 0, stdout: `{"loggedIn":true`, want: false },
  ];
  const fake = createFakeWrangler();
  for (const c of cases) {
    const deps = testDeps({ exec: recordingExec(() => ({ code: c.code, stdout: c.stdout, stderr: "" })) });
    assert.equal(await cloudflareLoggedIn(deps, await found(fake, deps)), c.want, JSON.stringify(c));
  }
});

test("whoami: a huge answer of many object lines is handled quickly", async () => {
  const fake = createFakeWrangler();
  const big = `${"{\n".repeat(200_000)}{"loggedIn":true}\n`;
  const deps = testDeps({ exec: recordingExec(() => ({ code: 0, stdout: big, stderr: "" })) });
  const t0 = Date.now();
  assert.equal(await cloudflareLoggedIn(deps, await found(fake, deps)), true);
  assert.ok(Date.now() - t0 < 2000);
});

// --- configuration reader ------------------------------------------------------------------------

/** A parsed value as plain JSON (the reader builds objects without prototype). */
const plain = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function project(files: Record<string, string | Buffer>): string {
  const dir = tempDir();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("config: TOML subset (bare and quoted keys, dotted keys, tables, array tables, comments, both strings)", async () => {
  const dir = project({
    "wrangler.toml": `# top comment
name = "api" # trailing comment
"workers_dev" = false
main = 'src/index.ts'
compatibility_flags = ["nodejs_compat", "x#y"]
route = { pattern = "shop.example/paid*", zone_name = "shop.example" }

[vars]
GREETING = "a # not a comment"

[env.staging]
name = "api-stage"
workers_dev = true

[[env.staging.routes]]
pattern = "staging.example/*"
zone_name = "staging.example"

[[env.staging.routes]]
pattern = "x.example/y*" # comment
custom_domain = false

[env."prod"]
routes = [
  # a comment inside an array
  { pattern = "api.example/*", custom_domain = false },
  "other.example/*",
]
env.dotted.name = "dotted-name"
`,
  });
  const r = await readWranglerConfig(dir);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.file, join(dir, "wrangler.toml"));
  assert.equal(r.config.name, "api");
  assert.equal(r.config.workers_dev, false);
  assert.deepEqual(plain(r.config.route), { pattern: "shop.example/paid*", zone_name: "shop.example" });
  assert.deepEqual(Object.keys(r.config.env).sort(), ["prod", "staging"]);
  assert.equal(r.config.env.staging!.name, "api-stage");
  assert.equal(r.config.env.staging!.workers_dev, true);
  assert.deepEqual(plain(r.config.env.staging!.routes), [
    { pattern: "staging.example/*", zone_name: "staging.example" },
    { pattern: "x.example/y*", custom_domain: false },
  ]);
  assert.deepEqual(plain(r.config.env.prod!.routes), [{ pattern: "api.example/*", custom_domain: false }, "other.example/*"]);
  // `env.dotted.name` below [env."prod"] belongs to env.prod, not to the top level.
  assert.equal(r.config.env.dotted, undefined);
});

test("config: TOML dotted keys at the top level and string escapes", async () => {
  const dir = project({
    "wrangler.toml": `env.staging.name = "st\\u0061ge-\\"q\\""
env.qa.workers_dev = true
name = 'lit\\n'
`,
  });
  const r = await readWranglerConfig(dir);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.config.env.staging!.name, 'stage-"q"');
  assert.equal(r.config.env.qa!.workers_dev, true);
  assert.equal(r.config.name, "lit\\n");
});

test("config: TOML lines outside the subset are skipped, multi-line strings never become keys", async () => {
  const dir = project({
    "wrangler.toml": `created = 1979-05-27T07:32:00Z
ratio = 0.5
notes = """
name = "evil"
[env.evil]
"""
lit = '''
route = "evil.example/*"
'''
name = "api"
weird key = "x"
`,
  });
  const r = await readWranglerConfig(dir);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.config.name, "api");
  assert.equal(r.config.route, undefined);
  assert.deepEqual(Object.keys(r.config.env), []);
});

test("config: JSONC with comments and trailing commas; .json with the same rules", async () => {
  const text = `{
  // line comment with "quotes"
  "name": "api", /* block
  comment */
  "workers_dev": false,
  "routes": [
    { "pattern": "api.example/paid*", "zone_name": "api.example", },
    "b.example/*",
  ],
  "vars": { "URL": "https://x.example/*not-a-comment*/" },
  "env": {
    "staging": { "name": "api-st", "route": "st.example/*", },
  },
}`;
  for (const file of ["wrangler.jsonc", "wrangler.json"]) {
    const r = await readWranglerConfig(project({ [file]: text }));
    assert.equal(r.ok, true, file);
    if (!r.ok) continue;
    assert.equal(r.config.name, "api");
    assert.equal(r.config.workers_dev, false);
    assert.deepEqual(plain(r.config.routes), [{ pattern: "api.example/paid*", zone_name: "api.example" }, "b.example/*"]);
    assert.equal(r.config.env.staging!.route, "st.example/*");
  }
});

test("config: wrangler.json before wrangler.jsonc before wrangler.toml, like wrangler", async () => {
  const all = { "wrangler.toml": `name = "from-toml"`, "wrangler.jsonc": `{"name":"from-jsonc"}`, "wrangler.json": `{"name":"from-json"}` };
  const r1 = await readWranglerConfig(project(all));
  assert.ok(r1.ok && r1.config.name === "from-json");
  const { "wrangler.json": _drop, ...rest } = all;
  const r2 = await readWranglerConfig(project(rest));
  assert.ok(r2.ok && r2.config.name === "from-jsonc");
  const r3 = await readWranglerConfig(project({ "wrangler.toml": all["wrangler.toml"] }));
  assert.ok(r3.ok && r3.config.name === "from-toml");
});

test("config: no configuration file -> an empty configuration", async () => {
  const r = await readWranglerConfig(tempDir());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.file, null);
  assert.equal(r.config.name, undefined);
  assert.deepEqual(Object.keys(r.config.env), []);
});

test("config: hostile files end as config_unreadable, never crash", async () => {
  const deep = (n: number) => `{"a":${"[".repeat(n)}${"]".repeat(n)}}`;
  const bad: Record<string, string | Buffer>[] = [
    { "wrangler.json": `{"name": "x"` },
    { "wrangler.json": `{"name": "x" /* open comment` },
    { "wrangler.json": `{"name": "unterminated}` },
    { "wrangler.json": `{"name": "x",, }` },
    { "wrangler.json": `{"name": 12}` },
    { "wrangler.json": `{"env": "staging"}` },
    { "wrangler.json": `{"env": {"staging": []}}` },
    { "wrangler.json": `["not", "an", "object"]` },
    { "wrangler.json": `{"name":"x"} trailing` },
    { "wrangler.json": deep(16) },
    { "wrangler.json": "[".repeat(200_000) },
    { "wrangler.json": `{"name":"${"x".repeat(256 * 1024)}"}` },
    { "wrangler.json": Buffer.from([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]) },
    { "wrangler.toml": `name = "x"\nname = { a = ${"{ a = ".repeat(20)}1${" }".repeat(20)} }` },
    { "wrangler.toml": `${Array.from({ length: 17 }, (_, i) => `k${i}`).join(".")} = 1` },
    { "wrangler.toml": `name = "open` },
    { "wrangler.toml": `routes = [ "a.example/*",\n` },
    { "wrangler.toml": `notes = """ never closed\nname = "x"` },
    { "wrangler.toml": `name = "a"\n[name]\nx = 1` },
    { "wrangler.toml": `env = "x"\n[env.staging]\nname = "s"` },
    { "wrangler.toml": `name = 5` },
  ];
  for (const files of bad) {
    const r = await readWranglerConfig(project(files));
    assert.deepEqual(r, { ok: false, state: "config_unreadable" }, JSON.stringify(Object.values(files)[0]).slice(0, 80));
  }
});

test("config: nesting up to depth 16 is read", async () => {
  const ok = `{"a":${"[".repeat(15)}${"]".repeat(15)}}`;
  const r = await readWranglerConfig(project({ "wrangler.json": ok }));
  assert.equal(r.ok, true);
});

test("config: a folder named like the configuration -> config_unreadable", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "wrangler.toml"));
  assert.deepEqual(await readWranglerConfig(dir), { ok: false, state: "config_unreadable" });
});

test("config: __proto__ and constructor keys are plain data (objects without prototype)", async () => {
  const before = ({} as Record<string, unknown>).name;
  const r = await readWranglerConfig(
    project({
      "wrangler.json": `{"__proto__": {"name": "evil", "polluted": true}, "constructor": {"name": "c"}, "name": "api",
        "env": {"__proto__": {"name": "e"}, "staging": {"name": "s", "__proto__": {"workers_dev": true}}}}`,
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.config.name, "api");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(({} as Record<string, unknown>).name, before);
  assert.deepEqual(Object.keys(r.config.env).sort(), ["__proto__", "staging"]);
  assert.equal(r.config.env.staging!.workers_dev, undefined);
  assert.equal(Object.getPrototypeOf(r.config.env), null);
  const t = await readWranglerConfig(project({ "wrangler.toml": `__proto__.name = "evil"\nconstructor = "c"\nname = "api"\n[env.__proto__]\nname = "x"` }));
  assert.equal(t.ok, true);
  if (!t.ok) return;
  assert.equal(t.config.name, "api");
  assert.equal(({} as Record<string, unknown>).name, before);
  assert.deepEqual(Object.keys(t.config.env), ["__proto__"]);
});

// --- target --------------------------------------------------------------------------------------

test("target: worker name from the configuration, or --name in its place", async () => {
  const dir = project({ "wrangler.toml": `name = "api"` });
  const r = await resolveTarget(dir, {});
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.target.name, "api");
  assert.equal(r.target.env, null);
  assert.equal(r.target.dir, resolve(dir));
  const n = await resolveTarget(dir, { name: "other" });
  assert.ok(n.ok && n.target.name === "other");
});

test("target: no name in the configuration and no --name -> usage_error; --name without a configuration works", async () => {
  assert.deepEqual(await resolveTarget(project({ "wrangler.toml": `main = "x.ts"` }), {}), { ok: false, state: "usage_error" });
  assert.deepEqual(await resolveTarget(tempDir(), {}), { ok: false, state: "usage_error" });
  const r = await resolveTarget(tempDir(), { name: "api" });
  assert.ok(r.ok && r.target.name === "api" && r.target.url === null);
});

test("target: env.X.name first, else <name>-<X>, with --name as <name>", async () => {
  const dir = project({ "wrangler.toml": `name = "api"\n[env.staging]\nname = "custom"\n[env.qa]\nworkers_dev = true` });
  const s = await resolveTarget(dir, { env: "staging" });
  assert.ok(s.ok && s.target.name === "custom" && s.target.env === "staging");
  const q = await resolveTarget(dir, { env: "qa" });
  assert.ok(q.ok && q.target.name === "api-qa" && q.target.env === "qa" && q.target.workers_dev === true);
  const qn = await resolveTarget(dir, { env: "qa", name: "shop" });
  assert.ok(qn.ok && qn.target.name === "shop-qa");
  const sn = await resolveTarget(dir, { env: "staging", name: "shop" });
  assert.ok(sn.ok && sn.target.name === "custom");
});

test("target: several environments without --env -> env_required; one environment is fine", async () => {
  const two = project({ "wrangler.toml": `name = "api"\n[env.staging]\n[env.production]` });
  assert.deepEqual(await resolveTarget(two, {}), { ok: false, state: "env_required" });
  const one = project({ "wrangler.jsonc": `{"name":"api","env":{"staging":{}}}` });
  const r = await resolveTarget(one, {});
  assert.ok(r.ok && r.target.name === "api" && r.target.env === null);
});

test("target: --env that the configuration does not have -> usage_error", async () => {
  const dir = project({ "wrangler.toml": `name = "api"\n[env.staging]` });
  assert.deepEqual(await resolveTarget(dir, { env: "stagin" }), { ok: false, state: "usage_error" });
  assert.deepEqual(await resolveTarget(dir, { env: "__proto__" }), { ok: false, state: "usage_error" });
});

test("target: values in flag form or off the pattern are refused", async () => {
  const dir = project({ "wrangler.toml": `name = "api"\n[env.staging]` });
  for (const o of [{ env: "-x" }, { env: "--name" }, { name: "--config" }, { name: "-" }, { name: "API" }, { name: "a".repeat(64) }, { env: "a b" }]) {
    assert.deepEqual(await resolveTarget(dir, o), { ok: false, state: "usage_error" }, JSON.stringify(o));
  }
  for (const toml of [`name = "-evil"`, `name = "--config=x"`, `name = "Api"`, `name = "api"\n[env.staging]\nname = "--x"`]) {
    const r = await resolveTarget(project({ "wrangler.toml": toml }), toml.includes("staging") ? { env: "staging" } : {});
    assert.deepEqual(r, { ok: false, state: "config_unreadable" }, toml);
  }
  const long = await resolveTarget(project({ "wrangler.toml": `name = "${"a".repeat(60)}"\n[env.staging]` }), { env: "staging" });
  assert.deepEqual(long, { ok: false, state: "config_unreadable" });
});

test("target: the first route with a fixed domain wins (route before routes)", async () => {
  const cases: { toml: string; url: string | null; pattern: string | null }[] = [
    { toml: `route = "api.example/paid*"\nroutes = ["b.example/*"]`, url: "https://api.example/paid", pattern: "api.example/paid*" },
    { toml: `routes = ["*.example/*", "*shop.example/*", "shop.example/*"]`, url: "https://shop.example/", pattern: "shop.example/*" },
    { toml: `routes = [{ pattern = "api.example", custom_domain = true }]`, url: "https://api.example/", pattern: "api.example" },
    { toml: `routes = [{ pattern = "api.example/x/*", zone_name = "api.example" }]`, url: "https://api.example/x/", pattern: "api.example/x/*" },
    { toml: `routes = [{ pattern = "api.example/*/x" }, "https://b.example/v1*"]`, url: "https://b.example/v1", pattern: "https://b.example/v1*" },
    { toml: `routes = [{ pattern = "api.example/x", custom_domain = true }, { zone_name = "z" }, 5, "c.example"]`, url: "https://c.example/", pattern: "c.example" },
    { toml: `routes = ["*/*", "localhost:8787/*", "a b.example/*"]`, url: null, pattern: null },
    { toml: `workers_dev = true`, url: null, pattern: null },
  ];
  for (const c of cases) {
    const r = await resolveTarget(project({ "wrangler.toml": `name = "api"\n${c.toml}` }), {});
    assert.ok(r.ok, c.toml);
    if (!r.ok) continue;
    assert.equal(r.target.url, c.url, c.toml);
    assert.equal(r.target.route?.pattern ?? null, c.pattern, c.toml);
  }
});

test("target: an environment uses its own routes, else the top-level ones (like wrangler)", async () => {
  const dir = project({
    "wrangler.toml": `name = "api"\nroutes = ["top.example/*"]\n[env.staging]\nroutes = ["st.example/*"]\n[env.qa]\nname = "qa"\n[env.empty]\nroutes = []`,
  });
  const st = await resolveTarget(dir, { env: "staging" });
  assert.ok(st.ok && st.target.url === "https://st.example/");
  const qa = await resolveTarget(dir, { env: "qa" });
  assert.ok(qa.ok && qa.target.url === "https://top.example/");
  const empty = await resolveTarget(dir, { env: "empty" });
  assert.ok(empty.ok && empty.target.url === null);
});

test("target: an unreadable configuration -> config_unreadable", async () => {
  assert.deepEqual(await resolveTarget(project({ "wrangler.json": "{" }), { name: "api" }), { ok: false, state: "config_unreadable" });
});

// --- secret put / secret delete ------------------------------------------------------------------

async function secretSetup(toml = `name = "api"\n[env.staging]\n[env.prod]\nname = "custom"`) {
  const fake = createFakeWrangler();
  fake.file("wrangler.toml", toml);
  const deps = realDeps(baseEnv(), fake);
  const bin = await found(fake, deps);
  return { fake, deps, bin };
}

/** --config with the absolute path of the worker folder's own wrangler.toml. */
const cfg = (fake: FakeWrangler, file = "wrangler.toml") => ["--config", join(resolve(fake.dir), file)];

function jsonLines(deps: TestDeps): Record<string, unknown>[] {
  return deps
    .stdout()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("secret put: argv after the table, K only on stdin without line end, never in argv or env", async () => {
  const { fake, deps, bin } = await secretSetup();
  const k = generateKey("w");
  fake.answer("put", { exit: 0, stdout: `wrangler says ${k} and more\n`, stderr: "warning text\n" });
  const secrets = createSecrets(deps, output(deps));
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "api", env: null }, k), "ok");
  const call = fake.calls().at(-1)!;
  assert.deepEqual(call.argv, ["secret", "put", "OP8X_KEY", "--name", "api", ...cfg(fake)]);
  assert.equal(call.stdin, k);
  assert.equal(call.stdinIsTTY, false);
  assert.ok(!call.argv.some((a) => a.includes(k)));
  assert.ok(!Object.values(call.env).some((v) => v.includes(k)));
  // wrangler's own output never reaches the CLI's output.
  assert.ok(!deps.stdout().includes("wrangler says"));
  assert.ok(!deps.stdout().includes(k));
  assert.equal(deps.stderr(), "");
});

test("secret put with an environment: --name <name> --env <X> so that wrangler builds <name>-<X>", async () => {
  const { fake, deps, bin } = await secretSetup();
  const secrets = createSecrets(deps, output(deps));
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "api-staging", env: "staging" }, generateKey("w")), "ok");
  assert.deepEqual(fake.calls().at(-1)!.argv, ["secret", "put", "OP8X_KEY", "--name", "api", "--env", "staging", ...cfg(fake)]);
});

test("secret put with env.X.name: only --env <X>, after checking the configuration still names it", async () => {
  const { fake, deps, bin } = await secretSetup();
  const secrets = createSecrets(deps, output(deps));
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "custom", env: "prod" }, generateKey("w")), "ok");
  assert.deepEqual(fake.calls().at(-1)!.argv, ["secret", "put", "OP8X_KEY", "--env", "prod", ...cfg(fake)]);
  const n = fake.calls().length;
  fake.file("wrangler.toml", `name = "api"\n[env.prod]\nname = "renamed"`);
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "custom", env: "prod" }, generateKey("w")), "failed");
  fake.file("wrangler.toml", `{`);
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "custom", env: "prod" }, generateKey("w")), "failed");
  assert.equal(fake.calls().length, n);
});

test("secret put: exit code is the only signal", async () => {
  const { fake, deps, bin } = await secretSetup();
  const secrets = createSecrets(deps, output(deps));
  fake.answer("put", { exit: 1, stdout: `{"success":true}` });
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "api", env: null }, generateKey("w")), "failed");
  const rec = recordingExec(() => ({ code: null, stdout: "", stderr: "" }));
  const d2 = testDeps({ exec: rec });
  const s2 = createSecrets(d2, output(d2));
  assert.equal(await s2.put(bin, { dir: fake.dir, name: "api", env: null }, generateKey("w")), "failed");
  assert.equal(rec.calls[0]!.opts.timeoutMs, 120_000);
  assert.equal(rec.calls[0]!.file, process.execPath);
});

test("secret put: notice secret_put_deploys once, before the first put of a run; not for delete", async () => {
  const { fake, deps, bin } = await secretSetup();
  const secrets = createSecrets(deps, output(deps));
  assert.equal(await secrets.remove(bin, { dir: fake.dir, name: "api", env: null }), "ok");
  assert.equal(jsonLines(deps).length, 0);
  await secrets.put(bin, { dir: fake.dir, name: "api", env: null }, generateKey("w"));
  await secrets.put(bin, { dir: fake.dir, name: "api-staging", env: "staging" }, generateKey("w"));
  const notices = jsonLines(deps).filter((l) => l.event === "notice");
  assert.deepEqual(notices, [
    { schema: "op8x.cli/1", command: "init", final: false, event: "notice", id: "secret_put_deploys", text: "wrangler secret put deploys the worker right away." },
  ]);
});

test("secret put: nothing runs once the output guard stopped the output", async () => {
  const { fake, deps, bin } = await secretSetup();
  const secrets = createSecrets(deps, output(deps, () => ["deploys the worker right away"]));
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "api", env: null }, generateKey("w")), "stopped");
  assert.equal(fake.calls().length, 0);
  assert.equal(jsonLines(deps).at(-1)!.state, "internal_error");
  assert.equal(await secrets.remove(bin, { dir: fake.dir, name: "api", env: null }), "stopped");
  assert.equal(fake.calls().length, 0);
});

test("secret put: refused without a start for a value that is no server key, a bad target or another folder", async () => {
  const { fake, deps, bin } = await secretSetup();
  const secrets = createSecrets(deps, output(deps));
  const k = generateKey("w");
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "api", env: null }, generateKey("r")), "failed");
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "api", env: null }, `${k}\n`), "failed");
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "--name", env: null }, k), "failed");
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "api", env: "-x" }, k), "failed");
  assert.equal(await secrets.put(bin, { dir: tempDir(), name: "api", env: null }, k), "failed");
  assert.equal(fake.calls().length, 0);
});

test("secret delete: argv after the table, no stdin data, exit code decides", async () => {
  const { fake, deps, bin } = await secretSetup();
  const secrets = createSecrets(deps, output(deps));
  assert.equal(await secrets.remove(bin, { dir: fake.dir, name: "api", env: null }), "ok");
  assert.equal(await secrets.remove(bin, { dir: fake.dir, name: "api-staging", env: "staging" }), "ok");
  assert.equal(await secrets.remove(bin, { dir: fake.dir, name: "custom", env: "prod" }), "ok");
  const calls = fake.calls();
  assert.deepEqual(
    calls.map((c) => c.argv),
    [
      ["secret", "delete", "OP8X_KEY", "--name", "api", ...cfg(fake)],
      ["secret", "delete", "OP8X_KEY", "--name", "api", "--env", "staging", ...cfg(fake)],
      ["secret", "delete", "OP8X_KEY", "--env", "prod", ...cfg(fake)],
    ],
  );
  assert.ok(calls.every((c) => c.stdin === "" && !c.stdinIsTTY));
  fake.answer("delete", { exit: 1 });
  assert.equal(await secrets.remove(bin, { dir: fake.dir, name: "api", env: null }), "failed");
  const rec = recordingExec();
  const d2 = testDeps({ exec: rec });
  await createSecrets(d2, output(d2)).remove(bin, { dir: fake.dir, name: "api", env: null });
  assert.equal(rec.calls[0]!.opts.input, undefined);
});

// --- fixes after review: pinned configuration file, skipped target keys, linked single files -----

test("secret put/delete: --config pins the folder's own file although a parent folder has a wrangler.json", async () => {
  const parent = tempDir();
  writeFileSync(join(parent, "wrangler.json"), `{"name":"parent","env":{"prod":{"name":"parent-prod"}}}`);
  const child = join(parent, "worker");
  mkdirSync(child);
  const fake = createFakeWrangler({ dir: child });
  fake.file("wrangler.toml", `name = "api"\n[env.prod]\nname = "custom"\n[env.staging]`);
  const deps = realDeps(baseEnv(), fake);
  const bin = await found(fake, deps);
  const secrets = createSecrets(deps, output(deps));
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "custom", env: "prod" }, generateKey("w")), "ok");
  assert.equal(await secrets.remove(bin, { dir: fake.dir, name: "api-staging", env: "staging" }), "ok");
  assert.deepEqual(
    fake.calls().map((c) => c.argv),
    [
      ["secret", "put", "OP8X_KEY", "--env", "prod", "--config", join(resolve(child), "wrangler.toml")],
      ["secret", "delete", "OP8X_KEY", "--name", "api", "--env", "staging", "--config", join(resolve(child), "wrangler.toml")],
    ],
  );
});

test("secret put: without a configuration in the folder no --config (the name is pinned by --name)", async () => {
  const parent = tempDir();
  writeFileSync(join(parent, "wrangler.json"), `{"name":"parent"}`);
  const child = join(parent, "worker");
  mkdirSync(child);
  const fake = createFakeWrangler({ dir: child });
  const deps = realDeps(baseEnv(), fake);
  const bin = await found(fake, deps);
  const secrets = createSecrets(deps, output(deps));
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "api", env: null }, generateKey("w")), "ok");
  assert.deepEqual(fake.calls().at(-1)!.argv, ["secret", "put", "OP8X_KEY", "--name", "api"]);
});

test("secret put/delete: an unreadable configuration in the folder -> failed without a start", async () => {
  const { fake, deps, bin } = await secretSetup();
  fake.file("wrangler.toml", `name = "open`);
  const secrets = createSecrets(deps, output(deps));
  assert.equal(await secrets.put(bin, { dir: fake.dir, name: "api", env: null }, generateKey("w")), "failed");
  assert.equal(await secrets.remove(bin, { dir: fake.dir, name: "api-staging", env: "staging" }), "failed");
  assert.equal(fake.calls().length, 0);
});

test("config: a skipped TOML line that holds a key op8x reads -> config_unreadable", async () => {
  const bad = [
    `name = "api"\n[env.prod]\nname = """custom"""`,
    `name = 1979-05-27`,
    `name = "api"\nworkers_dev = 0.5`,
    `name = "api"\nroutes = [ "a.example/*", 0.5 ]`,
    `name = "api"\nroute = '''a.example/*'''`,
    `name = "api"\n[[routes]]\npattern = """a.example/*"""`,
    `name = "api"\nenv.staging.route = 1979-05-27`,
    `name = "api"\n[env]\nstaging = 1979-05-27`,
    `name = "api"\n[env.staging.routes]\nx = 0.5`,
  ];
  for (const toml of bad) {
    assert.deepEqual(await readWranglerConfig(project({ "wrangler.toml": toml })), { ok: false, state: "config_unreadable" }, toml);
  }
  // Other keys may still be skipped.
  const ok = await readWranglerConfig(project({ "wrangler.toml": `name = "api"\nnotes = """x"""\n[env.prod]\nmain = 1979-05-27\n[vars]\nname = 0.5` }));
  assert.ok(ok.ok && ok.config.name === "api" && Object.keys(ok.config.env).join() === "prod");
});

test("config: TOML literal keys ('…') are read like wrangler reads them", async () => {
  const r = await readWranglerConfig(project({ "wrangler.toml": `'name' = "api"\n[env.'prod']\n'name' = "custom"` }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.config.name, "api");
  assert.equal(r.config.env.prod!.name, "custom");
});

/** A file symlink, or false where the platform refuses it (Windows without the privilege). */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch {
    return false;
  }
}

for (const which of ["bin/wrangler.js", "package.json"] as const) {
  test(`findWrangler: only ${which} linked to a file outside the project -> wrangler_missing (A42)`, async (t) => {
    const outside = createFakeWrangler();
    const inner = createFakeWrangler();
    const path = join(inner.dir, "node_modules", "wrangler", ...which.split("/"));
    rmSync(path);
    if (!trySymlink(join(outside.dir, "node_modules", "wrangler", ...which.split("/")), path)) {
      t.skip("file symlinks are not allowed here");
      return;
    }
    assert.deepEqual(await findWrangler(realDeps(), inner.dir), { ok: false, state: "wrangler_missing" });
  });
}
