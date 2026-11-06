import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps, ExecOptions, ExecResult } from "../src/cli.ts";

// Test helpers for account commands (not a test file itself, like fixtures.ts).

export interface ExecCall {
  file: string;
  args: string[];
  opts: ExecOptions;
}

export type ExecHandler = (file: string, args: readonly string[], opts: ExecOptions) => ExecResult | Promise<ExecResult>;

export type RecordingExec = Deps["exec"] & { calls: ExecCall[] };

/** An exec that records every call and answers with `handler` (default: exit 0, no output). */
export function recordingExec(handler: ExecHandler = () => ({ code: 0, stdout: "", stderr: "" })): RecordingExec {
  const calls: ExecCall[] = [];
  const exec = async (file: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> => {
    calls.push({ file, args: [...args], opts });
    return handler(file, args, opts);
  };
  return Object.assign(exec, { calls });
}

const tempDirs: string[] = [];
process.on("exit", () => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** A new temporary directory, removed when the test process exits. */
export function tempDir(prefix = "op8x-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Fixed clock for tests: 2026-11-03T14:05:00Z. */
export const TEST_NOW = Date.UTC(2026, 10, 3, 14, 5, 0);

export interface TestDeps extends Deps {
  stdout: () => string;
  stderr: () => string;
  sleeps: number[];
}

/**
 * Deps for tests: recording exec, fixed clock, sleep without waiting (recorded in `sleeps`),
 * lookup from a table (unknown hosts fail), a fresh temporary configDir. Never the real config folder.
 */
export function testDeps(overrides: Partial<Deps> & { lookupTable?: Record<string, string[]> } = {}): TestDeps {
  let out = "";
  let err = "";
  const sleeps: number[] = [];
  const { lookupTable = {}, ...rest } = overrides;
  const root = tempDir();
  const deps: TestDeps = {
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
    color: false,
    env: {},
    platform: "linux",
    nodeVersion: "24.0.0",
    cwd: root,
    configDir: join(root, "config", "op8x"),
    stdinIsTTY: false,
    readStdin: async () => "",
    readHidden: async () => "",
    exec: recordingExec(),
    lookup: async (host) => {
      const found = lookupTable[host];
      if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return found;
    },
    now: () => TEST_NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    stdout: () => out,
    stderr: () => err,
    sleeps,
    ...rest,
  };
  return deps;
}
