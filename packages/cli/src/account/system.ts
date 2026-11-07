import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Deps, ExecOptions, ExecResult, Io } from "../cli.ts";

const MAX_OUTPUT = 1024 * 1024;
const MAX_STDIN = 4 * 1024;

/**
 * Runs a program without a shell, hidden on Windows, with exactly `opts.env` as its environment.
 * stdin is a pipe: `input` is written to it, otherwise it is closed at once. stdout and stderr keep
 * at most 1 MiB each. A timeout kills the child and gives code null; a start failure gives code null too.
 * With `detach` the child runs on its own (see launch).
 */
export function exec(file: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
  if (opts.detach === true) return launch(file, args, opts);
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const collect = () => {
      const chunks: Buffer[] = [];
      let size = 0;
      return {
        add(chunk: Buffer) {
          if (size >= MAX_OUTPUT) return;
          const part = chunk.subarray(0, MAX_OUTPUT - size);
          chunks.push(part);
          size += part.length;
        },
        text: () => Buffer.concat(chunks).toString("utf8"),
      };
    };
    const out = collect();
    const err = collect();
    let timedOut = false;
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout: out.text(), stderr: err.text() });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    child.stdout.on("data", (c: Buffer) => out.add(c));
    child.stderr.on("data", (c: Buffer) => err.add(c));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    // A child that exits before reading its stdin must not crash the CLI with EPIPE.
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * Starts a program that is never waited for (a browser opener: xdg-open, for example, may wait
 * until the browser closes): detached, no stdio, unref'd, without a shell, hidden on Windows, with
 * exactly `opts.env`. Code 0 once it has started; null if it could not start, or if neither
 * happened within `opts.timeoutMs`. Its output and exit code are never seen.
 */
function launch(file: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: "", stderr: "" });
    };
    const timer = setTimeout(() => finish(null), opts.timeoutMs);
    let child;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, detached: true, stdio: "ignore" });
    } catch {
      finish(null);
      return;
    }
    child.once("spawn", () => finish(0));
    child.once("error", () => finish(null));
    child.unref();
  });
}

/** All of stdin as UTF-8, cut at 4 KiB. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    const part = chunk.subarray(0, MAX_STDIN - size);
    chunks.push(part);
    size += part.length;
    if (size >= MAX_STDIN) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One line from `input` without echo: readline writes its echo into a sink that drops it (and puts
 * a TTY into raw mode, so the terminal does not echo either); only the prompt and the final line
 * break reach `prompts`. Settles with "" when the input ends or on Ctrl+C before a line arrives,
 * so a closed stdin never hangs the command (the caller treats "" as invalid_input).
 */
export function readHiddenFrom(prompt: string, input: NodeJS.ReadableStream, prompts: { write: (s: string) => unknown }): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: string) => {
      if (settled) return;
      settled = true;
      prompts.write("\n");
      resolve(answer);
    };
    prompts.write(prompt);
    const silent = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const rl = createInterface({ input, output: silent, terminal: true });
    rl.on("close", () => settle(""));
    rl.on("SIGINT", () => rl.close());
    rl.question("", (answer) => {
      settle(answer);
      rl.close();
    });
  });
}

/** One line from the terminal without echo; the prompt goes to stderr. */
export function readHidden(prompt: string): Promise<string> {
  return readHiddenFrom(prompt, process.stdin, process.stderr);
}

/**
 * The op8x config folder: %APPDATA%\op8x on Windows, else $XDG_CONFIG_HOME/op8x or ~/.config/op8x.
 * A relative XDG_CONFIG_HOME is ignored, as the XDG Base Directory spec says (it would put the op8x
 * file into whatever folder the command runs in).
 */
export function configDirFor(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, home: string): string {
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "op8x");
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg !== undefined && posix.isAbsolute(xdg) ? xdg : join(home, ".config"), "op8x");
}

/** The real side effects, wired in bin.ts. */
export function systemDeps(io: Io): Deps {
  const env = process.env;
  return {
    ...io,
    env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    cwd: process.cwd(),
    configDir: configDirFor(process.platform, env, homedir()),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin,
    readHidden,
    exec,
    lookup: async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
