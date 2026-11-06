import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";
import type { Deps, Io } from "../cli.ts";
import { finalLine } from "./output.ts";
import type { AccountCommand } from "./output.ts";

type Value = string | boolean | (string | boolean)[] | undefined;
type Values = Record<string, Value>;

interface CommandSpec {
  usage: string;
  options: ParseArgsOptionsConfig;
  /** False if a value breaks a pattern, an exclusion or a condition of the options table. */
  valid: (values: Values) => boolean;
  run: (values: Values, deps: Deps) => Promise<number>;
}

const WORD = /^[a-z0-9-]{1,63}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function word(v: Value): boolean {
  return v === undefined || (typeof v === "string" && WORD.test(v));
}

/** https:, or http: on a loopback host only. */
function testUrl(v: Value): boolean {
  if (v === undefined) return true;
  if (typeof v !== "string") return false;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
}

const INIT_USAGE = `Usage: op8x init [--env <name> | --env-file <path>] [--name <worker>] [--url <url>] [--json]

Options:
  --env <name>         the wrangler environment to set up
  --name <worker>      the worker name, if the wrangler configuration has none
  --url <url>          an https address the op8x module handles, for the test request
  --env-file <path>    write the server key to this git-ignored file instead of wrangler
  --json               print JSON Lines
`;

// Registered are only the commands that exist. `init` is a placeholder for now: it checks its
// options and ends with not_available_yet.
const COMMANDS: Record<AccountCommand, CommandSpec> = {
  init: {
    usage: INIT_USAGE,
    options: {
      json: { type: "boolean" },
      env: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      "env-file": { type: "string" },
    },
    valid: (v) =>
      word(v.env) &&
      word(v.name) &&
      testUrl(v.url) &&
      (v["env-file"] === undefined || (typeof v["env-file"] === "string" && v["env-file"] !== "")) &&
      !(v["env-file"] !== undefined && (v.env !== undefined || v.name !== undefined)),
    run: async (values, deps) => notAvailableYet("init", values.json === true, deps),
  },
};

export function accountCommand(word: string): AccountCommand | undefined {
  return Object.hasOwn(COMMANDS, word) ? (word as AccountCommand) : undefined;
}

/**
 * Runs an account command: strict parse of the whole argv with exactly this command's options
 * (so options may stand before the command word), then the checks of the options table.
 * `deps` is null when the caller passed a plain Io; that is a programming error.
 */
export async function runAccount(command: AccountCommand, argv: string[], io: Io, deps: Deps | null): Promise<number> {
  const spec = COMMANDS[command];
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true, options: spec.options }));
  } catch {
    // The parser message names the rejected input, so it is not shown.
    return usageError(command, io, argv.includes("--json"));
  }
  const json = values.json === true;
  if (positionals.length !== 1 || !spec.valid(values)) return usageError(command, io, json);
  if (!deps) {
    io.out(json ? finalLine(command, "internal_error", 2) : "op8x stopped because of an internal error. Please report this.\n");
    return 2;
  }
  return spec.run(values, deps);
}

function usageError(command: AccountCommand, io: Io, json: boolean): number {
  io.err(COMMANDS[command].usage);
  if (json) io.out(finalLine(command, "usage_error", 4));
  return 4;
}

function notAvailableYet(command: AccountCommand, json: boolean, deps: Deps): number {
  deps.out(json ? finalLine(command, "not_available_yet", 1) : `op8x ${command} is not available in this version yet.\n`);
  return 1;
}
