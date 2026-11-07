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

test("--json init reaches init (here: no wrangler in the folder)", async () => {
  for (const argv of [["--json", "init"], ["init", "--json"]]) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 1, argv.join(" "));
    const final = lastLine(deps.stdout());
    assert.equal(final.schema, "op8x.cli/1");
    assert.equal(final.command, "init");
    assert.equal(final.final, true);
    assert.equal(final.state, "wrangler_missing");
    assert.equal(final.exit_code, 1);
    assert.equal(deps.stderr(), "");
  }
});

test("init without --json prints the state as text on stdout", async () => {
  const deps = testDeps();
  assert.equal(await run(["init"], deps), 1);
  assert.match(deps.stdout(), /Run npm i -D wrangler in this project/);
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
    // Accepted options reach the command (no help on stderr); here it stops at the missing wrangler
    // or, for --env-file, at the missing git (env_file_not_ignored).
    const deps = testDeps();
    await run(["--json", ...argv], deps);
    assert.equal(deps.stderr(), "", argv.join(" "));
    assert.notEqual(lastLine(deps.stdout()).state, "usage_error", argv.join(" "));
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
  ["init", "--env=-x"], // flag form (isWranglerName)
  ["init", "--name=-api"],
  ["init", "--url", "https://user:pw@api.example/paid"], // no credentials in the URL
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
  const account = help.slice(help.indexOf("\nAccount commands"));
  assert.equal(
    account,
    [
      "",
      "Account commands (each takes --json for JSON Lines):",
      "  op8x init                connect the worker in this folder to op8x and send one test request",
      "  op8x login               sign this computer in to your op8x account",
      "  op8x logout              sign this computer out and remove its op8x file",
      "  op8x import-key <path>   take the server key and the salt from the op8x file of your other computer",
      "  op8x rotate [--now]      replace the server key in every worker this computer knows",
      "  op8x delete              delete the op8x account and remove the server key and the salt from every worker",
      "  op8x report [--days <n>] the numbers of your op8x account for the last n days (default 7)",
      "",
    ].join("\n"),
  );
  assert.ok(help.includes("\n  --payer <address>      your own paying wallet; warns if it is a payTo\n"));
});

test("login, logout and import-key reach their commands (options before the word too)", async () => {
  for (const argv of [["--json", "login", "extra"], ["--json", "logout", "x"], ["--json", "import-key"]]) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 4, argv.join(" "));
    assert.equal(lastLine(deps.stdout()).command, argv[1]);
  }
});
