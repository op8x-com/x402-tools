import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { testDeps } from "./account-deps.ts";
import type { RecordingExec } from "./account-deps.ts";

type Line = Record<string, unknown>;

const lastLine = (out: string) => JSON.parse(out.trimEnd().split("\n").at(-1) ?? "") as Line;

test("report is a placeholder: not_available_yet (exit 1), with --week or --month too", async () => {
  for (const argv of [["report", "--json"], ["report", "--week", "--json"], ["--json", "report", "--month"]]) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 1, argv.join(" "));
    assert.deepEqual(lastLine(deps.stdout()), {
      schema: "op8x.cli/1",
      command: "report",
      final: true,
      state: "not_available_yet",
      exit_code: 1,
      agent_hint: "Numbers are not available in this version yet.",
      steps: [],
    });
    assert.equal(deps.stdout().trimEnd().split("\n").length, 1);
    assert.equal(deps.stderr(), "");
  }
});

test("report in text mode prints the hint only", async () => {
  const deps = testDeps();
  assert.equal(await run(["report"], deps), 1);
  assert.equal(deps.stdout(), "Numbers are not available in this version yet.\n");
});

test("report: --week with --month, another option or a positional is a usage error", async () => {
  for (const argv of [["report", "--week", "--month", "--json"], ["report", "--code-stdin", "--json"], ["report", "week", "--json"]]) {
    const deps = testDeps();
    assert.equal(await run(argv, deps), 4, argv.join(" "));
    assert.match(deps.stderr(), /^Usage: op8x report \[--week \| --month\] \[--json\]/);
    const final = lastLine(deps.stdout());
    assert.equal(final.command, "report");
    assert.equal(final.state, "usage_error");
    assert.equal(final.exit_code, 4);
  }
});

test("report needs no op8x file and sends nothing", async () => {
  let fetched = false;
  const deps = testDeps({
    fetchImpl: async () => {
      fetched = true;
      throw new Error("no request expected");
    },
  });
  assert.equal(await run(["report", "--json"], deps), 1);
  assert.equal(fetched, false);
  assert.deepEqual((deps.exec as RecordingExec).calls, []);
});
