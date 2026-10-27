import { parseArgs } from "node:util";
import { extract, withBrowserView } from "./extract.ts";
import { preflight, probe } from "./probe.ts";
import { buildReport, renderJson, renderText } from "./report.ts";
import { is402, preflightPlan, runRules } from "./rules.ts";
import type { Method, ProbeResult } from "./types.ts";
import { VERSION } from "./version.ts";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  color: boolean;
  fetchImpl?: typeof fetch;
}

const USAGE = `Usage: op8x check <url> [options]

Checks an x402 endpoint from the outside with unpaid requests.

Options:
  --method <GET|POST>    probe only this method (default: both)
  --json                 print a JSON report
  --timeout <seconds>    per-request timeout (default: 10)
  -v, --version          print the version
  -h, --help             print this help
`;

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      method: { type: "string" },
      json: { type: "boolean" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    io.out(`${VERSION}\n`);
    return 0;
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (positionals[0] !== "check" || positionals.length !== 2) {
    io.err(USAGE);
    return 2;
  }

  let url: URL;
  try {
    url = new URL(positionals[1]);
  } catch {
    io.err(`Not a valid URL: ${positionals[1]}\n`);
    return 2;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    io.err(`Only http and https URLs are supported: ${url.href}\n`);
    return 2;
  }

  const method = values.method?.toUpperCase();
  if (method !== undefined && method !== "GET" && method !== "POST") {
    io.err("--method must be GET or POST\n");
    return 2;
  }
  const methods: Method[] = method === "GET" || method === "POST" ? [method] : ["GET", "POST"];

  const timeout = values.timeout === undefined ? 10 : Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    io.err("--timeout must be a positive number of seconds\n");
    return 2;
  }

  const opts = { timeoutMs: timeout * 1000, version: VERSION, fetchImpl: io.fetchImpl };
  const probes: ProbeResult[] = [];
  for (const m of methods) {
    probes.push(await probe(url.href, m, opts));
  }
  // Repeat each 402 as a browser would (with Origin); the plain probes stay origin-free
  // so a server that refuses browser origins is still diagnosed correctly.
  const browserProbes: ProbeResult[] = [];
  const extracted = [];
  for (const e of probes.map(extract)) {
    if (e.error || !is402(e)) {
      extracted.push(e);
      continue;
    }
    const b = await probe(url.href, e.method, opts, true);
    browserProbes.push(b);
    extracted.push(withBrowserView(e, b));
  }
  const plan = preflightPlan(extracted);
  const pre = plan ? await preflight(url.href, plan.method, plan.headers, opts) : undefined;
  const findings = runRules(extracted, pre, url.href);
  const sent = [...probes, ...browserProbes, ...(pre ? [pre] : [])];
  const report = buildReport(url.href, VERSION, sent, findings);
  io.out(values.json ? renderJson(report) : renderText(report, io.color));

  if (probes.every((p) => p.error)) return 2;
  return report.summary.errors > 0 ? 1 : 0;
}
