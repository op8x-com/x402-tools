#!/usr/bin/env node
import { run } from "./cli.ts";

process.exitCode = await run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
});
