import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./account-deps.ts";

// A fake wrangler in a temporary project (not a test file itself, like fixtures.ts). It sits where
// the real package sits (node_modules/wrangler, same `bin` as wrangler 4.152.0) and records every
// start: argv, stdin, the complete environment and the working folder. Each operation answers with
// the exit code and output set by the test. It runs through the real exec, never through a shell.

/** One start of the fake, as the child saw it. */
export interface WranglerCall {
  argv: string[];
  stdin: string;
  env: Record<string, string>;
  cwd: string;
  stdinIsTTY: boolean;
}

export interface FakeAnswer {
  exit: number;
  stdout?: string;
  stderr?: string;
}

export type FakeOp = "whoami" | "put" | "delete" | "list" | "other";

export interface FakeWrangler {
  /** The project folder (the worker folder; cwd of the command). */
  dir: string;
  /** node_modules/wrangler/bin/wrangler.js in the project. */
  script: string;
  /** Every start so far, in order. */
  calls: () => WranglerCall[];
  /** Sets the answer of one operation for the following starts. */
  answer: (op: FakeOp, a: FakeAnswer) => void;
  /** Writes a file into the project folder (a wrangler configuration, for example). */
  file: (name: string, text: string) => void;
}

/** The answer of whoami --json when logged in: pretty JSON with an address and accounts, like wrangler. */
export const LOGGED_IN_EMAIL = "seller-fake@acme.example";
export const LOGGED_IN_ACCOUNT = "fake-account-name-0001";
export const LOGGED_IN = `${JSON.stringify(
  {
    loggedIn: true,
    authType: "OAuth Token",
    email: LOGGED_IN_EMAIL,
    accounts: [{ name: LOGGED_IN_ACCOUNT, id: "f".repeat(32) }],
    tokenPermissions: ["workers:write"],
  },
  null,
  4,
)}\n`;
/** The answer of secret list --format json for these secret names (pretty JSON, like wrangler). */
export const secretList = (names: string[]) => `${JSON.stringify(names.map((name) => ({ name, type: "secret_text" })), null, "  ")}\n`;
/** The answer of whoami --json when not logged in (wrangler writes an empty line first, then exits 1). */
export const LOGGED_OUT = `\n{"loggedIn":false}\n`;

function recorder(log: string, answers: string): string {
  return `"use strict";
const fs = require("node:fs");
const LOG = ${JSON.stringify(log)};
const ANSWERS = ${JSON.stringify(answers)};
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const op = argv[0] === "whoami" ? "whoami" : argv[0] === "secret" && (argv[1] === "put" || argv[1] === "delete" || argv[1] === "list") ? argv[1] : "other";
  fs.appendFileSync(LOG, JSON.stringify({
    argv,
    stdin: Buffer.concat(chunks).toString("utf8"),
    env: { ...process.env },
    cwd: process.cwd(),
    stdinIsTTY: Boolean(process.stdin.isTTY),
  }) + "\\n");
  const all = JSON.parse(fs.readFileSync(ANSWERS, "utf8"));
  const a = all[op] || { exit: 0 };
  if (a.stdout) process.stdout.write(a.stdout);
  if (a.stderr) process.stderr.write(a.stderr);
  process.exitCode = a.exit;
});
`;
}

export interface FakeWranglerOptions {
  /** version in node_modules/wrangler/package.json (default 4.152.0). */
  version?: string;
  /** name in node_modules/wrangler/package.json (default wrangler). */
  name?: string;
  /** Project folder to use instead of a new temporary one. */
  dir?: string;
}

/** A temporary project with a recording fake wrangler; answers default to logged in and exit 0. */
export function createFakeWrangler(o: FakeWranglerOptions = {}): FakeWrangler {
  const dir = o.dir ?? tempDir("op8x-wrangler-");
  const pkg = join(dir, "node_modules", "wrangler");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: o.name ?? "wrangler", version: o.version ?? "4.152.0", bin: { wrangler: "bin/wrangler.js" } }),
  );
  // The log and the answers live outside the project, so a config reader never sees them.
  const side = tempDir("op8x-wrangler-log-");
  const log = join(side, "calls.jsonl");
  const answersPath = join(side, "answers.json");
  const answers: Record<FakeOp, FakeAnswer> = {
    whoami: { exit: 0, stdout: LOGGED_IN },
    put: { exit: 0 },
    delete: { exit: 0 },
    // secret list: the worker still holds OP8X_KEY unless a test says otherwise.
    list: { exit: 0, stdout: secretList(["OP8X_KEY"]) },
    other: { exit: 0 },
  };
  writeFileSync(answersPath, JSON.stringify(answers));
  const script = join(pkg, "bin", "wrangler.js");
  writeFileSync(script, recorder(log, answersPath));
  appendFileSync(log, "");
  return {
    dir,
    script,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as WranglerCall)
        : [],
    answer: (op, a) => {
      answers[op] = a;
      writeFileSync(answersPath, JSON.stringify(answers));
    },
    file: (name, text) => writeFileSync(join(dir, name), text),
  };
}
