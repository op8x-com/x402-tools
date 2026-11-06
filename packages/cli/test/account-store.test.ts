import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import {
  accountPath,
  deleteAccount,
  parseAccount,
  readAccount,
  StoreError,
  systemRootOf,
  workerId,
  writeAccount,
  writeSecureFile,
} from "../src/account/store.ts";
import type { AccountFile } from "../src/account/store.ts";
import type { ExecOptions, ExecResult } from "../src/cli.ts";
import { recordingExec, tempDir, testDeps } from "./account-deps.ts";
import type { ExecHandler } from "./account-deps.ts";

// Keys are built at runtime, never written out in a file.
const R = "op8x_r_" + "R".repeat(43);
const K = "op8x_w_" + "K".repeat(43);
const K2 = "op8x_w_" + "N".repeat(43);
const POSIX = process.platform !== "win32";

function full(): AccountFile {
  return {
    schema: "op8x.account/1",
    collector: "https://analytics.op8x.com",
    account: "t-k7m2p4q3xa",
    contact_hint: "a***@acme.example",
    read_token: R,
    write_key: K,
    write_key_next: K2,
    pending_step_up: {
      purpose: "replace_current",
      command: "rotate",
      case: "c",
      phase: "replace",
      force_stop: true,
      t_check: "2026-11-03T14:05:00Z",
      expires_at: "2026-11-03T14:20:00Z",
    },
    deleted: null,
    workers: [
      {
        dir: "C:/work/api",
        name: "api",
        env: null,
        env_file: null,
        url: "https://api.example/paid",
        deployed_at: "2026-11-03T14:00:00Z",
        verified_at: "2026-11-03T14:01:00Z",
        key_fingerprint: "1a2b3c4d",
      },
      {
        dir: "C:/work/api",
        name: "api-staging",
        env: "staging",
        env_file: null,
        url: null,
        deployed_at: "2026-11-03T14:00:00.123Z",
        verified_at: null,
        key_fingerprint: "1a2b3c4d",
      },
      {
        dir: "C:/work/node-api",
        name: null,
        env: null,
        env_file: "C:/work/node-api/.env" + ".op8x",
        url: null,
        deployed_at: "2026-11-03T14:00:00Z",
        verified_at: null,
        key_fingerprint: "1a2b3c4d",
      },
    ],
  };
}

function remainder(): AccountFile {
  return {
    schema: "op8x.account/1",
    collector: "https://analytics.op8x.com",
    account: null,
    contact_hint: null,
    read_token: null,
    write_key: null,
    write_key_next: null,
    pending_step_up: null,
    deleted: { action_id: "act_123" },
    workers: [full().workers[0]],
  };
}

function storeCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof StoreError, String(e));
    return e.code;
  }
  return "no error";
}

async function storeCodeAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof StoreError, String(e));
    return e.code;
  }
  return "no error";
}

// --- Schema ---------------------------------------------------------------

test("schema: a full account with write_key_next, pending_step_up and both worker kinds round-trips", async () => {
  const deps = testDeps();
  await writeAccount(deps, full());
  assert.deepEqual(await readAccount(deps), full());
  assert.equal(accountPath(deps), join(deps.configDir, "account.json"));
});

test("schema: contact_hint null, write_key null, no pending step and no workers are valid", () => {
  const a = { ...full(), contact_hint: null, write_key: null, write_key_next: null, pending_step_up: null, workers: [] };
  assert.deepEqual(parseAccount(JSON.stringify(a)), a);
  const e2e = { ...full(), account: "e2e-abcd2345" };
  assert.deepEqual(parseAccount(JSON.stringify(e2e)), e2e);
});

test("schema: every pending_step_up row of the continuation table is valid", () => {
  const rows = [
    { purpose: "replace_current", command: "rotate", case: "c", phase: "replace" },
    { purpose: "replace_current", command: "rotate", case: "e", phase: "replace" },
    { purpose: "rotate_now", command: "rotate", case: "a", phase: "stop" },
    { purpose: "rotate_now", command: "rotate", case: "b", phase: "stop" },
    { purpose: "rotate_now", command: "rotate", case: "c", phase: "stop" },
    { purpose: "rotate_now", command: "rotate", case: "e", phase: "stop" },
    { purpose: "delete", command: "delete", case: null, phase: "delete" },
  ];
  for (const row of rows) {
    const a = { ...full(), pending_step_up: { ...row, force_stop: false, t_check: null, expires_at: "2026-11-03T14:20:00Z" } };
    assert.deepEqual(parseAccount(JSON.stringify(a)), a, JSON.stringify(row));
  }
});

test("schema: the remainder file after deleted_partial is accepted", async () => {
  assert.deepEqual(parseAccount(JSON.stringify(remainder())), remainder());
  const empty = { ...remainder(), workers: [] };
  assert.deepEqual(parseAccount(JSON.stringify(empty)), empty);
  const deps = testDeps();
  await writeAccount(deps, remainder());
  assert.deepEqual(await readAccount(deps), remainder());
});

test("schema: wrong files are schema_invalid", () => {
  const bad: [string, unknown][] = [
    ["not JSON", "{"],
    ["array", []],
    ["null", null],
    ["other schema", { ...full(), schema: "op8x.account/2" }],
    ["unknown field", { ...full(), extra: 1 }],
    ["__proto__ field", JSON.parse(JSON.stringify(full()).replace('"schema"', '"__proto__":{},"schema"'))],
    ["missing write_key_next", (({ write_key_next: _, ...rest }) => rest)(full())],
    ["missing deleted", (({ deleted: _, ...rest }) => rest)(full())],
    ["collector not a URL", { ...full(), collector: "analytics" }],
    ["account name", { ...full(), account: "t-K7M2P4Q3XA" }],
    ["account null while active", { ...full(), account: null }],
    ["read token kind", { ...full(), read_token: K }],
    ["read token missing", { ...full(), read_token: null }],
    ["write key kind", { ...full(), write_key: R }],
    ["write key short", { ...full(), write_key: K.slice(0, -1) }],
    ["write_key_next kind", { ...full(), write_key_next: R }],
    ["contact_hint number", { ...full(), contact_hint: 1 }],
    ["pending purpose", { ...full(), pending_step_up: { ...full().pending_step_up!, purpose: "other" } }],
    ["pending field missing", { ...full(), pending_step_up: (({ t_check: _, ...rest }) => rest)(full().pending_step_up!) }],
    ["pending extra field", { ...full(), pending_step_up: { ...full().pending_step_up!, code: "ABCD1234" } }],
    ["pending force_stop string", { ...full(), pending_step_up: { ...full().pending_step_up!, force_stop: "yes" } }],
    ["pending expires_at not a time", { ...full(), pending_step_up: { ...full().pending_step_up!, expires_at: "soon" } }],
    ["pending delete with a case", { ...full(), pending_step_up: { purpose: "delete", command: "delete", case: "a", phase: "delete", force_stop: false, t_check: null, expires_at: "2026-11-03T14:20:00Z" } }],
    ["pending rotate without a case", { ...full(), pending_step_up: { ...full().pending_step_up!, case: null } }],
    ["pending replace_current in phase stop", { ...full(), pending_step_up: { ...full().pending_step_up!, phase: "stop" } }],
    ["pending replace_current with case a", { ...full(), pending_step_up: { ...full().pending_step_up!, case: "a" } }],
    ["deleted while active", { ...full(), deleted: { action_id: "act_1" } }],
    ["remainder with a read token", { ...remainder(), read_token: R }],
    ["remainder with an account", { ...remainder(), account: "t-k7m2p4q3xa" }],
    ["remainder with a pending step", { ...remainder(), pending_step_up: full().pending_step_up }],
    ["remainder without action_id", { ...remainder(), deleted: {} }],
    ["remainder with an extra deleted field", { ...remainder(), deleted: { action_id: "a", x: 1 } }],
    ["workers not an array", { ...full(), workers: {} }],
    ["worker extra field", { ...full(), workers: [{ ...full().workers[0], key: K }] }],
    ["worker missing env_file", { ...full(), workers: [(({ env_file: _, ...rest }) => rest)(full().workers[0])] }],
    ["wrangler worker without name", { ...full(), workers: [{ ...full().workers[0], name: null }] }],
    ["env_file worker with a name", { ...full(), workers: [{ ...full().workers[2], name: "api" }] }],
    ["env_file worker with an env", { ...full(), workers: [{ ...full().workers[2], env: "prod" }] }],
    ["worker env pattern", { ...full(), workers: [{ ...full().workers[0], env: "Prod" }] }],
    ["worker fingerprint", { ...full(), workers: [{ ...full().workers[0], key_fingerprint: "1A2B3C4D" }] }],
    ["worker url scheme", { ...full(), workers: [{ ...full().workers[0], url: "ftp://x/" }] }],
    ["worker verified_at not a time", { ...full(), workers: [{ ...full().workers[0], verified_at: "yesterday" }] }],
    ["duplicate wrangler target", { ...full(), workers: [full().workers[0], { ...full().workers[0], url: null }] }],
    ["duplicate env_file target", { ...full(), workers: [full().workers[2], full().workers[2]] }],
  ];
  for (const [name, value] of bad) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    assert.equal(storeCode(() => parseAccount(text)), "schema_invalid", name);
  }
});

test("schema errors never repeat the file content", () => {
  try {
    parseAccount(JSON.stringify({ ...full(), read_token: "op8x_r_short-but-secret" }));
    assert.fail("expected an error");
  } catch (e) {
    assert.ok(e instanceof StoreError);
    assert.equal(String(e.message).includes("short-but-secret"), false);
    assert.equal(String(e.message).includes(K), false);
  }
});

test("worker identity: dir + name + env for wrangler, env_file alone for an env file", () => {
  const [a, b, c] = full().workers;
  assert.notEqual(workerId(a), workerId(b));
  assert.equal(workerId(a), workerId({ ...a, url: null, verified_at: null }));
  assert.equal(workerId(c), workerId({ ...c, dir: "C:/elsewhere" }));
  assert.notEqual(workerId(c), workerId(a));
});

test("readAccount: no file is null; a broken file is schema_invalid; deleteAccount removes it", async () => {
  const deps = testDeps();
  assert.equal(await readAccount(deps), null);
  assert.equal(await deleteAccount(deps), false);
  mkdirSync(deps.configDir, { recursive: true });
  writeFileSync(accountPath(deps), "{ not json");
  assert.equal(await storeCodeAsync(readAccount(deps)), "schema_invalid");
  assert.equal(await deleteAccount(deps), true);
  assert.equal(existsSync(accountPath(deps)), false);
});

test("writeAccount refuses an invalid account and writes nothing", async () => {
  const deps = testDeps();
  const bad = { ...full(), read_token: K } as AccountFile;
  assert.equal(await storeCodeAsync(writeAccount(deps, bad)), "schema_invalid");
  assert.equal(existsSync(accountPath(deps)), false);
});

// --- POSIX ------------------------------------------------------------------

test("POSIX: the file is 0600 and the op8x folder 0700, also when the folder already existed", async () => {
  const deps = testDeps();
  mkdirSync(deps.configDir, { recursive: true, mode: 0o755 });
  chmodSync(deps.configDir, 0o755);
  writeFileSync(accountPath(deps), "old");
  chmodSync(accountPath(deps), 0o644);
  await writeAccount(deps, full());
  assert.deepEqual(parseAccount(readFileSync(accountPath(deps), "utf8")), full());
  assert.deepEqual(readdirSync(deps.configDir), ["account.json"]);
  if (POSIX) {
    assert.equal(statSync(deps.configDir).mode & 0o777, 0o700);
    assert.equal(statSync(accountPath(deps)).mode & 0o777, 0o600);
  }
});

test("POSIX: a new op8x folder is created with 0700", async () => {
  const deps = testDeps();
  await writeAccount(deps, full());
  if (POSIX) assert.equal(statSync(deps.configDir).mode & 0o777, 0o700);
});

test("POSIX: another target (an env file) is 0600, its folder keeps its mode", async () => {
  const deps = testDeps();
  const dir = tempDir();
  chmodSync(dir, 0o755);
  const target = join(dir, "op8x.env");
  await writeSecureFile(deps, target, "OP8X_KEY=x\n", { ownDir: false });
  assert.equal(readFileSync(target, "utf8"), "OP8X_KEY=x\n");
  assert.deepEqual(readdirSync(dir), ["op8x.env"]);
  if (POSIX) {
    assert.equal(statSync(dir).mode & 0o777, 0o755);
    assert.equal(statSync(target).mode & 0o777, 0o600);
  }
});

test("POSIX: no helper program runs", async () => {
  const exec = recordingExec();
  const deps = testDeps({ exec });
  await writeAccount(deps, full());
  assert.deepEqual(exec.calls, []);
});

// --- Windows (recorded exec) -------------------------------------------------

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

function sddlFile(lines: string): Buffer {
  return Buffer.from(`account.json.tmp\r\n${lines}\r\n`, "utf16le");
}

interface WinOptions {
  whoami?: ExecResult;
  set?: ExecResult;
  save?: ExecResult;
  sddl?: string;
}

/** Answers like whoami.exe and icacls.exe; the /save step writes the SDDL as UTF-16LE. */
function windowsExec(o: WinOptions = {}) {
  const seen: { step: string; tmpContent?: string }[] = [];
  const handler: ExecHandler = (file: string, args: readonly string[], _opts: ExecOptions) => {
    if (file.endsWith("whoami.exe")) {
      seen.push({ step: "whoami" });
      return o.whoami ?? { code: 0, stdout: `"desktop-x\\anna","${SID}"\r\n`, stderr: "" };
    }
    if (args[1] === "/inheritance:r") {
      seen.push({ step: "set", tmpContent: readFileSync(args[0], "utf8") });
      return o.set ?? { code: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "/save") {
      seen.push({ step: "save", tmpContent: readFileSync(args[0], "utf8") });
      const result = o.save ?? { code: 0, stdout: "", stderr: "" };
      if (result.code === 0) writeFileSync(args[2], sddlFile(o.sddl ?? `D:PAI(A;;FA;;;${SID})`));
      return result;
    }
    throw new Error(`unexpected program ${file}`);
  };
  return { exec: recordingExec(handler), seen };
}

function windowsDeps(env: Record<string, string> = { SystemRoot: "C:\\Windows" }, o: WinOptions = {}) {
  const w = windowsExec(o);
  return { deps: testDeps({ platform: "win32", env, exec: w.exec }), exec: w.exec, seen: w.seen };
}

test("systemRootOf: case-insensitive and absolute only", () => {
  assert.equal(systemRootOf({ SystemRoot: "C:\\Windows" }), "C:\\Windows");
  assert.equal(systemRootOf({ SYSTEMROOT: "D:\\Win" }), "D:\\Win");
  assert.equal(systemRootOf({ systemroot: "C:\\Windows" }), "C:\\Windows");
  assert.equal(systemRootOf({}), undefined);
  assert.equal(systemRootOf({ SystemRoot: "Windows" }), undefined);
  assert.equal(systemRootOf({ SystemRoot: "" }), undefined);
  assert.equal(systemRootOf({ SystemRoot: undefined }), undefined);
});

test("Windows: SID, set ACL, check ACL, write, rename, each helper by its absolute path", async () => {
  const { deps, exec, seen } = windowsDeps();
  await writeAccount(deps, full());
  assert.deepEqual(seen.map((s) => s.step), ["whoami", "set", "save"]);
  // The content is written only after the ACL is set and checked.
  assert.deepEqual(seen.map((s) => s.tmpContent ?? ""), ["", "", ""]);
  const [who, set, save] = exec.calls;
  assert.equal(who.file, win32.join("C:\\Windows", "System32", "whoami.exe"));
  assert.deepEqual(who.args, ["/user", "/fo", "csv", "/nh"]);
  const icacls = win32.join("C:\\Windows", "System32", "icacls.exe");
  assert.equal(set.file, icacls);
  assert.equal(dirname(set.args[0]), deps.configDir);
  assert.deepEqual(set.args.slice(1), ["/inheritance:r", "/grant:r", `*${SID}:F`]);
  assert.equal(save.file, icacls);
  assert.equal(save.args[0], set.args[0]);
  assert.equal(save.args[1], "/save");
  assert.equal(dirname(save.args[2]), deps.configDir);
  for (const c of exec.calls) {
    assert.ok(!Object.keys(c.opts.env).some((k) => k.toUpperCase() === "PATH"), "no PATH lookup is needed");
    assert.ok(c.opts.timeoutMs > 0);
  }
  assert.deepEqual(parseAccount(readFileSync(accountPath(deps), "utf8")), full());
  // Neither the temp file nor the saved ACL is left behind.
  assert.deepEqual(readdirSync(deps.configDir), ["account.json"]);
});

test("Windows: works with lower-case systemroot and Path instead of PATH", async () => {
  const { deps, exec } = windowsDeps({ systemroot: "E:\\WINDOWS", Path: "C:\\evil;C:\\Windows" });
  await writeAccount(deps, full());
  assert.deepEqual(
    exec.calls.map((c) => c.file),
    [win32.join("E:\\WINDOWS", "System32", "whoami.exe"), ...Array(2).fill(win32.join("E:\\WINDOWS", "System32", "icacls.exe"))],
  );
});

test("Windows: SystemRoot missing or not absolute is permissions_failed, nothing runs or is written", async () => {
  const envs: Record<string, string>[] = [{}, { Path: "C:\\Windows" }, { SystemRoot: "Windows" }, { SystemRoot: "\\\\?\\" }, { SystemRoot: "" }];
  for (const env of envs) {
    const { deps, exec } = windowsDeps(env);
    assert.equal(await storeCodeAsync(writeAccount(deps, full())), "permissions_failed", JSON.stringify(env));
    assert.deepEqual(exec.calls, []);
    assert.equal(existsSync(accountPath(deps)), false);
  }
});

const WIN_FAILURES: [string, WinOptions][] = [
  ["whoami fails", { whoami: { code: 1, stdout: "", stderr: "x" } }],
  ["whoami times out", { whoami: { code: null, stdout: "", stderr: "" } }],
  ["whoami prints no SID", { whoami: { code: 0, stdout: `"desktop-x\\anna","anna"\r\n`, stderr: "" } }],
  ["whoami SID with spaces", { whoami: { code: 0, stdout: `"desktop-x\\anna","S-1-5 21"\r\n`, stderr: "" } }],
  ["icacls set fails", { set: { code: 5, stdout: "", stderr: "Access is denied." } }],
  ["icacls save fails", { save: { code: 1, stdout: "", stderr: "" } }],
  ["DACL not protected", { sddl: `D:AI(A;;FA;;;${SID})` }],
  ["inherited ACE left", { sddl: `D:PAI(A;;FA;;;${SID})(A;ID;FA;;;S-1-5-18)` }],
  ["second ACE", { sddl: `D:PAI(A;;FA;;;${SID})(A;;FA;;;S-1-5-32-544)` }],
  ["other SID", { sddl: "D:PAI(A;;FA;;;S-1-5-18)" }],
  ["not full access", { sddl: `D:PAI(A;;0x1200a9;;;${SID})` }],
  ["deny ACE", { sddl: `D:PAI(D;;FA;;;${SID})` }],
  ["no access control", { sddl: "D:PNO_ACCESS_CONTROL" }],
  ["empty file", { sddl: "" }],
];

test("Windows: every failure of a helper or the ACL check is permissions_failed, the old file stays", async () => {
  for (const [name, o] of WIN_FAILURES) {
    const { deps } = windowsDeps(undefined, o);
    mkdirSync(deps.configDir, { recursive: true });
    writeFileSync(accountPath(deps), "old");
    assert.equal(await storeCodeAsync(writeAccount(deps, full())), "permissions_failed", name);
    assert.equal(readFileSync(accountPath(deps), "utf8"), "old", name);
    assert.deepEqual(readdirSync(deps.configDir), ["account.json"], name);
  }
});

test("Windows: rename with EPERM or EBUSY is retried three times with 200 ms pauses", async () => {
  for (const code of ["EPERM", "EBUSY"]) {
    const { deps } = windowsDeps();
    let failures = 2;
    const { rename } = await import("node:fs/promises");
    await writeAccount(deps, full(), {
      rename: async (from, to) => {
        if (failures-- > 0) throw Object.assign(new Error(code), { code });
        await rename(from, to);
      },
    });
    assert.deepEqual(deps.sleeps, [200, 200], code);
    assert.deepEqual(parseAccount(readFileSync(accountPath(deps), "utf8")), full());
  }
});

test("Windows: rename failing after three retries is permissions_failed and the temp file is removed", async () => {
  const { deps } = windowsDeps();
  let attempts = 0;
  const result = await storeCodeAsync(
    writeAccount(deps, full(), {
      rename: async () => {
        attempts++;
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      },
    }),
  );
  assert.equal(result, "permissions_failed");
  assert.equal(attempts, 4);
  assert.deepEqual(deps.sleeps, [200, 200, 200]);
  assert.deepEqual(readdirSync(deps.configDir), []);
});

test("rename: other errors, and any error off Windows, are not retried", async () => {
  const win = windowsDeps().deps;
  let attempts = 0;
  const fail = (code: string) => async () => {
    attempts++;
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(await storeCodeAsync(writeAccount(win, full(), { rename: fail("EACCES") })), "permissions_failed");
  assert.equal(attempts, 1);
  assert.deepEqual(win.sleeps, []);
  attempts = 0;
  const posix = testDeps();
  assert.equal(await storeCodeAsync(writeAccount(posix, full(), { rename: fail("EPERM") })), "permissions_failed");
  assert.equal(attempts, 1);
  assert.deepEqual(posix.sleeps, []);
  assert.deepEqual(readdirSync(posix.configDir), []);
});

// --- Windows (real icacls and whoami) ------------------------------------------

test("Windows for real: icacls and whoami protect the file, and the saved SDDL has exactly one ACE", { skip: process.platform !== "win32" }, async () => {
  const { exec } = await import("../src/account/system.ts");
  const env = { SystemRoot: systemRootOf(process.env) ?? "" };
  const deps = testDeps({ platform: "win32", env, exec });
  await writeAccount(deps, full());
  assert.deepEqual(parseAccount(readFileSync(accountPath(deps), "utf8")), full());
  assert.deepEqual(readdirSync(deps.configDir), ["account.json"]);

  // Check independently of store.ts: whoami for the SID, icacls /save for the DACL.
  const root = env.SystemRoot;
  const who = await exec(win32.join(root, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { cwd: deps.configDir, env, timeoutMs: 10_000 });
  assert.equal(who.code, 0);
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(who.stdout)?.[1];
  assert.ok(sid);
  const saved = join(deps.configDir, "check.acl");
  const save = await exec(win32.join(root, "System32", "icacls.exe"), [accountPath(deps), "/save", saved], { cwd: deps.configDir, env, timeoutMs: 10_000 });
  assert.equal(save.code, 0);
  const lines = readFileSync(saved).toString("utf16le").split(/\r?\n/).filter((l) => l !== "");
  assert.equal(lines.length, 2);
  assert.match(lines[1], new RegExp(`^D:P[A-Z]*\\(A;;FA;;;${sid}\\)$`));
});
