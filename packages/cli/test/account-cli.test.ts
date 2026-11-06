import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeps, run } from "../src/cli.ts";
import { testDeps } from "./account-deps.ts";

const ENV_FILE = ".env" + ".op8x";

function lastLine(s: string): Record<string, unknown> {
  const lines = s.trimEnd().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

test("testDeps is complete Deps; a plain Io is not", () => {
  assert.equal(isDeps(testDeps()), true);
  assert.equal(isDeps({ out: () => {}, err: () => {}, color: false }), false);
  const partial: Record<string, unknown> = { ...testDeps() };
  delete partial.sleep;
  assert.equal(isDeps(partial as never), false);
});

test("--json init reaches init (stub until the command is built)", async () => {
  for (const argv of [["--json", "init"], ["init", "--json"]]) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 1, argv.join(" "));
    const final = lastLine(deps.stdout());
    assert.equal(final.schema, "op8x.cli/1");
    assert.equal(final.command, "init");
    assert.equal(final.final, true);
    assert.equal(final.state, "not_available_yet");
    assert.equal(final.exit_code, 1);
    assert.equal(deps.stderr(), "");
  }
});

test("init without --json prints the state as text on stdout", async () => {
  const deps = testDeps();
  assert.equal(await run(["init"], deps), 1);
  assert.match(deps.stdout(), /not available in this version yet/);
  assert.equal(deps.stdout().includes("{"), false);
});

test("init accepts every option of its table row", async () => {
  for (const argv of [
    ["init", "--env", "staging-2"],
    ["init", "--name", "api"],
    ["init", "--env", "prod", "--name", "api", "--url", "https://api.example/paid"],
    ["init", "--url", "http://127.0.0.1:8787/paid"],
    ["init", "--url", "http://localhost:8787/paid"],
    ["init", "--url", "http://[::1]:8787/paid"],
    ["init", "--env-file", ENV_FILE],
    ["init", "--env-file", ENV_FILE, "--url", "https://api.example/paid"],
    ["init", "--env=prod"],
  ]) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 1, argv.join(" "));
    assert.equal(deps.stderr(), "", argv.join(" "));
  }
});

const INIT_USAGE_ERRORS: string[][] = [
  ["init", "--bogus"], // unknown option
  ["init", "--payer", "0x1111111111111111111111111111111111111111"], // option of another command
  ["init", "--now"],
  ["init", "--env"], // missing value
  ["init", "--url"],
  ["init", "--name"],
  ["init", "--env-file"],
  ["init", "--env", "Prod"], // pattern
  ["init", "--env", "a_b"],
  ["init", "--env", ""],
  ["init", "--env", "a".repeat(64)],
  ["init", "--name", "API"],
  ["init", "--name", "a.b"],
  ["init", "--url", "not a url"],
  ["init", "--url", "http://api.example/paid"], // http only on loopback
  ["init", "--url", "ftp://api.example/paid"],
  ["init", "--env", "prod", "--env-file", ENV_FILE], // exclusions
  ["init", "--name", "api", "--env-file", ENV_FILE],
  ["init", "extra"], // no positional
  ["init", "--json=yes"],
];

test("init usage errors exit 4 with help on stderr and nothing on stdout", async () => {
  for (const argv of INIT_USAGE_ERRORS) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 4, argv.join(" "));
    assert.match(deps.stderr(), /Usage: op8x init/, argv.join(" "));
    assert.equal(deps.stdout(), "", argv.join(" "));
  }
});

test("init usage errors with --json add the final line on stdout", async () => {
  for (const argv of INIT_USAGE_ERRORS) {
    if (argv.some((a) => a.startsWith("--json"))) continue;
    const deps = testDeps();
    assert.equal(await run(["--json", ...argv], deps), 4, argv.join(" "));
    assert.match(deps.stderr(), /Usage: op8x init/);
    assert.deepEqual(JSON.parse(deps.stdout()), {
      schema: "op8x.cli/1",
      command: "init",
      final: true,
      state: "usage_error",
      exit_code: 4,
    });
  }
});

test("a usage error never echoes the rejected value", async () => {
  const value = "op8x_w_" + "Q".repeat(43);
  for (const argv of [["init", "--url", value], ["init", "--env", value], ["init", value]]) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 4);
    assert.equal((deps.stdout() + deps.stderr()).includes(value), false, argv.join(" "));
  }
});

test("init with an incomplete Deps ends with internal_error (exit 2)", async () => {
  let out = "";
  const io = {
    out: (s: string) => {
      out += s;
    },
    err: () => {},
    color: false,
  };
  assert.equal(await run(["--json", "init"], io), 2);
  const final = lastLine(out);
  assert.equal(final.state, "internal_error");
  assert.equal(final.exit_code, 2);
});

test("the global help lists the account commands built so far", async () => {
  const deps = testDeps();
  assert.equal(await run(["--help"], deps), 0);
  const help = deps.stdout();
  assert.ok(help.includes("\n  op8x login "), help);
  assert.ok(help.includes("\n  op8x logout "), help);
  assert.ok(help.includes("\n  op8x import-key <path> "), help);
  assert.ok(help.includes("\n  --payer <address>      your own paying wallet; warns if it is a payTo\n"));
  // init is still a placeholder.
  assert.equal(help.includes("op8x init"), false);
});

test("login, logout and import-key reach their commands (options before the word too)", async () => {
  for (const argv of [["--json", "login", "extra"], ["--json", "logout", "x"], ["--json", "import-key"]]) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 4, argv.join(" "));
    assert.equal(lastLine(deps.stdout()).command, argv[1]);
  }
});
