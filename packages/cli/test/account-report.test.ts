import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { generateKey } from "../src/account/keys.ts";
import { DOCS_BASE, renderReportView } from "../src/account/report-view.ts";
import { writeAccount } from "../src/account/store.ts";
import type { ActiveAccount } from "../src/account/store.ts";
import { run } from "../src/cli.ts";
import { testDeps } from "./account-deps.ts";
import type { RecordingExec } from "./account-deps.ts";
import { busyAnswer, startFakeCollector } from "./fake-collector.ts";
import type { FakeCollector } from "./fake-collector.ts";

// Fixtures in test/metrics/: metrics-example.json and metrics-injection.json are example
// op8x.metrics/1 documents produced by the op8x collector (copied unchanged); metrics-unknown.json
// is made for these tests (unknown values, extra fields, escapes and control characters).
// The .txt files next to them are the expected terminal views, compared byte for byte.

type Line = Record<string, unknown>;

const fixture = (name: string) => readFileSync(new URL(`./metrics/${name}`, import.meta.url), "utf8");
const doc = (name: string) => JSON.parse(fixture(name)) as Record<string, unknown>;
/** The compact JSON the collector sends. */
const compact = (name: string) => JSON.stringify(doc(name));
const ESC = String.fromCodePoint(0x1b);
const BACKSLASH = String.fromCodePoint(0x5c);

async function setup(t: TestContext, o: { collector?: string; signedIn?: boolean } = {}) {
  const fake: FakeCollector = await startFakeCollector();
  t.after(() => fake.close());
  const deps = testDeps({
    now: () => fake.now(),
    sleep: async (ms) => {
      deps.sleeps.push(ms);
      fake.advance(ms);
    },
    env: { OP8X_COLLECTOR_URL: fake.url },
  });
  const r = generateKey("r");
  const k = generateKey("w");
  const t0 = fake.addTenant({ readKey: r, writeKey: k });
  const file: ActiveAccount = {
    schema: "op8x.account/1",
    collector: o.collector ?? fake.url,
    account: t0.name,
    contact_hint: "a***@acme.example",
    read_token: r,
    write_key: k,
    write_key_next: null,
    salt: null,
    pending_step_up: null,
    deleted: null,
    workers: [],
  };
  if (o.signedIn !== false) await writeAccount(deps, file);
  const lines = () =>
    deps
      .stdout()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Line);
  const reports = () => fake.requests.filter((x) => x.route === "report");
  return { fake, deps, file, lines, reports };
}

/** Asserts the one JSON line of a failed run with --json and returns it. */
function oneCliLine(s: Awaited<ReturnType<typeof setup>>, state: string, exit: number): Line {
  const lines = s.lines();
  assert.equal(lines.length, 1, s.deps.stdout());
  const line = lines[0] as Line;
  assert.equal(line.schema, "op8x.cli/1");
  assert.equal(line.command, "report");
  assert.equal(line.final, true);
  assert.equal(line.state, state);
  assert.equal(line.exit_code, exit);
  return line;
}

// --- period ----------------------------------------------------------------------------------

test("report asks for the last 7 days by default; --days 1..30, --week and --month pick the period", async (t) => {
  const cases: [string[], number][] = [
    [[], 7],
    [["--days", "1"], 1],
    [["--days", "30"], 30],
    [["--days=12"], 12],
    [["--days", "07"], 7],
    [["--week"], 7],
    [["--month"], 30],
  ];
  for (const [args, days] of cases) {
    const s = await setup(t);
    s.fake.reportBody = compact("metrics-example.json");
    assert.equal(await run(["report", ...args, "--json"], s.deps), 0, args.join(" "));
    const reqs = s.reports();
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0]?.method, "GET");
    assert.equal(reqs[0]?.path, `/api/v1/tenant/report?days=${days}`);
    assert.equal(reqs[0]?.headers.authorization, `Bearer ${s.file.read_token}`);
    assert.deepEqual(s.fake.violations, []);
  }
});

test("report: an invalid period, more than one period option, another option or a positional is a usage error (exit 4)", async (t) => {
  const bad = [
    ["--days", "0"],
    ["--days", "31"],
    ["--days", "7.5"],
    ["--days", "abc"],
    ["--days", "-1"],
    ["--days="],
    ["--days", " 7"],
    ["--days", "1e1"],
    ["--days", "3", "--week"],
    ["--days", "3", "--month"],
    ["--week", "--month"],
    ["--days", "3", "--days", "4"],
    ["--week", "--week"],
    ["--code-stdin"],
    ["week"],
  ];
  for (const args of bad) {
    const s = await setup(t);
    assert.equal(await run(["report", ...args, "--json"], s.deps), 4, args.join(" "));
    assert.match(s.deps.stderr(), /^Usage: op8x report \[--days <n> \| --week \| --month\] \[--json\]/);
    const line = oneCliLine(s, "usage_error", 4);
    assert.equal("agent_hint" in line, false);
    assert.equal(s.fake.requests.length, 0);
  }
});

// --- --json -----------------------------------------------------------------------------------

test("report --json prints the collector's document unchanged, as the only line on stdout", async (t) => {
  const s = await setup(t);
  // Key order and spacing as sent; the CLI checks only the schema and passes the text on.
  const body = `{"schema":"op8x.metrics/1", "zeta":1,"alpha" : {"b":2,"a":1},"data":{"routes":{"r1":"GET /x"}}}`;
  s.fake.reportBody = body;
  assert.equal(await run(["report", "--json"], s.deps), 0);
  assert.equal(s.deps.stdout(), `${body}\n`);
  assert.equal(s.deps.stderr(), "");
});

test("report --json with the example document: exactly one op8x.metrics/1 document", async (t) => {
  const s = await setup(t);
  s.fake.reportBody = compact("metrics-example.json");
  assert.equal(await run(["--json", "report", "--week"], s.deps), 0);
  const lines = s.lines();
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], doc("metrics-example.json"));
  assert.equal(s.deps.stdout().includes(s.file.read_token), false);
});

test("report: a document of another schema is schema_unsupported (exit 2, update @op8x/cli)", async (t) => {
  const hint = "The report has a format this version of op8x cannot read. Update @op8x/cli (npx @op8x/cli@latest report) and run the command again.";
  for (const body of [`{"schema":"op8x.metrics/2","window":{}}`, `{"window":{}}`, `{"schema":1}`]) {
    const s = await setup(t);
    s.fake.reportBody = body;
    assert.equal(await run(["report", "--json"], s.deps), 2, body);
    const line = oneCliLine(s, "schema_unsupported", 2);
    assert.equal(line.agent_hint, hint);
  }
  const s = await setup(t);
  s.fake.reportBody = `{"schema":"op8x.metrics/2"}`;
  assert.equal(await run(["report"], s.deps), 2);
  assert.equal(s.deps.stdout(), `${hint}\n`);
});

test("report: a body that is not a JSON object is unexpected_response (exit 2)", async (t) => {
  for (const body of ["<html>maintenance</html>", "[1,2]", `"op8x.metrics/1"`, "null", ""]) {
    const s = await setup(t);
    s.fake.reportBody = body;
    assert.equal(await run(["report", "--json"], s.deps), 2, body);
    const line = oneCliLine(s, "unexpected_response", 2);
    assert.equal(line.status, 200);
    assert.equal(line.code, null);
  }
});

test("report: every error with --json is one op8x.cli/1 line; network and server errors exit 2", async (t) => {
  const problem = (status: number, body: string) => ({ status, headers: { "content-type": "application/problem+json" }, body });
  const cases: [Parameters<FakeCollector["respond"]>[1], string, number][] = [
    ["drop", "network_error", 2],
    ["server_error", "network_error", 2],
    [{ status: 500 }, "network_error", 2],
    ["redirect", "network_error", 2],
    [problem(401, `{"code":"key_auth","status":401}`), "key_auth", 1],
    ["wrong_secret_kind", "unexpected_response", 2],
    [problem(400, `{"code":"invalid_field","fields":["days"]}`), "unexpected_response", 2],
    ["huge", "unexpected_response", 2],
  ];
  for (const [answer, state, exit] of cases) {
    const s = await setup(t);
    s.fake.respond("report", answer);
    assert.equal(await run(["report", "--json"], s.deps), exit, state);
    oneCliLine(s, state, exit);
    assert.equal(s.deps.stdout().includes(s.file.read_token), false);
  }
});

test("report: an R the collector no longer knows is key_auth from the route itself", async (t) => {
  const s = await setup(t);
  s.fake.tenant(s.file.account).read = null;
  assert.equal(await run(["report", "--json"], s.deps), 1);
  const line = oneCliLine(s, "key_auth", 1);
  assert.equal(line.agent_hint, "This computer's access is no longer valid. Run op8x login.");
});

test("the fake report route takes R only: the current server key gets 403 wrong_secret_kind", async (t) => {
  const s = await setup(t);
  const res = await fetch(`${s.fake.url}/api/v1/tenant/report?days=7`, {
    headers: { authorization: `Bearer ${s.file.write_key}`, "user-agent": "op8x-cli/0.0.0 (+https://op8x.com)" },
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as Line).code, "wrong_secret_kind");
  for (const q of ["days=0", "days=31", "days=07", "days=7.5", "days=", "days", "days=7&days=7", "days=%2B7"]) {
    const bad = await fetch(`${s.fake.url}/api/v1/tenant/report?${q}`, {
      headers: { authorization: `Bearer ${s.file.read_token}`, "user-agent": "op8x-cli/0.0.0 (+https://op8x.com)" },
    });
    assert.equal(bad.status, 400, q);
    assert.deepEqual(((await bad.json()) as Line).fields, ["days"], q);
  }
});

// --- busy and Retry-After ---------------------------------------------------------------------

test("report: 503 busy waits as long as Retry-After says, then the answer counts", async (t) => {
  const s = await setup(t);
  s.fake.reportBody = compact("metrics-example.json");
  s.fake.respond("report", busyAnswer("5"), 2);
  assert.equal(await run(["report", "--json"], s.deps), 0);
  assert.deepEqual(s.deps.sleeps, [5_000, 5_000]);
  assert.equal(s.reports().length, 3);
});

test("report: Retry-After is clamped to 1..60 seconds; absent or not an integer falls back to 10 seconds", async (t) => {
  const cases: [string | null, number][] = [
    ["0", 1_000],
    ["1", 1_000],
    ["60", 60_000],
    ["120", 60_000],
    ["99999999999999999999", 60_000],
    [null, 10_000],
    ["abc", 10_000],
    ["5.5", 10_000],
    ["-3", 10_000],
    ["", 10_000],
    ["Fri, 07 Nov 2026 12:00:00 GMT", 10_000],
  ];
  for (const [header, ms] of cases) {
    const s = await setup(t);
    s.fake.reportBody = compact("metrics-example.json");
    s.fake.respond("report", busyAnswer(header));
    assert.equal(await run(["report", "--json"], s.deps), 0, String(header));
    assert.deepEqual(s.deps.sleeps, [ms], String(header));
  }
});

test("report: busy for longer than 2 minutes ends as busy (exit 2), Retry-After or not", async (t) => {
  const cases: [string | null, number[]][] = [
    ["60", [60_000, 60_000]],
    ["5", Array(24).fill(5_000)],
    [null, Array(12).fill(10_000)],
  ];
  for (const [header, sleeps] of cases) {
    const s = await setup(t);
    s.fake.respond("report", busyAnswer(header), 1000);
    assert.equal(await run(["report", "--json"], s.deps), 2);
    assert.deepEqual(s.deps.sleeps, sleeps, String(header));
    const line = oneCliLine(s, "busy", 2);
    assert.equal(line.agent_hint, "The service is busy; try again in a minute.");
  }
});

test("Retry-After counts only on the report route: other routes keep the 10 s step", async (t) => {
  const s = await setup(t);
  s.fake.respond("sign_out", busyAnswer("2"));
  assert.equal(await run(["logout", "--json"], s.deps), 0);
  assert.deepEqual(s.deps.sleeps, [10_000]);
});

// --- signed in --------------------------------------------------------------------------------

test("report without an op8x file: not_logged_in, nothing is sent", async (t) => {
  const s = await setup(t, { signedIn: false });
  assert.equal(await run(["report", "--json"], s.deps), 1);
  const line = oneCliLine(s, "not_logged_in", 1);
  assert.equal(line.agent_hint, "This computer is not signed in. Run op8x init or op8x login.");
  assert.equal(s.fake.requests.length, 0);
  assert.deepEqual((s.deps.exec as RecordingExec).calls, []);
});

test("report with an op8x file of another service address: collector_mismatch, nothing is sent", async (t) => {
  const s = await setup(t, { collector: "http://127.0.0.1:1" });
  assert.equal(await run(["report", "--json"], s.deps), 4);
  oneCliLine(s, "collector_mismatch", 4);
  assert.equal(s.fake.requests.length, 0);
});

test("report never prints R: a document that holds it is replaced by internal_error", async (t) => {
  for (const json of [true, false]) {
    const s = await setup(t);
    const d = doc("metrics-example.json");
    s.fake.reportBody = JSON.stringify({ ...d, data: { ...(d.data as Line), routes: { r1: s.file.read_token, r2: "POST /alerts" } } });
    assert.equal(await run(json ? ["report", "--json"] : ["report"], s.deps), 2);
    assert.equal(s.deps.stdout().includes(s.file.read_token), false);
    assert.equal(s.deps.stderr().includes(s.file.read_token), false);
    if (json) assert.equal(oneCliLine(s, "internal_error", 2).agent_hint, "op8x stopped because of an internal error. Please report this.");
    else assert.equal(s.deps.stdout(), "op8x stopped because of an internal error. Please report this.\n");
  }
});

// --- the terminal view ------------------------------------------------------------------------

test("report in text mode prints the view of the example document and exits 0", async (t) => {
  const s = await setup(t);
  s.fake.reportBody = compact("metrics-example.json");
  assert.equal(await run(["report"], s.deps), 0);
  assert.equal(s.deps.stdout(), fixture("metrics-example.txt"));
  assert.equal(s.deps.stderr(), "");
});

for (const name of ["metrics-example", "metrics-injection", "metrics-unknown"]) {
  test(`terminal view of ${name}.json matches ${name}.txt exactly`, () => {
    assert.equal(renderReportView(doc(`${name}.json`)), fixture(`${name}.txt`));
  });
}

test("the view names what op8x cannot see, op8x outages included, and links the definitions", () => {
  const view = renderReportView(doc("metrics-example.json"));
  assert.equal(DOCS_BASE, "https://docs.op8x.com");
  assert.ok(view.includes("op8x outages are not included"));
  assert.ok(view.includes("Definitions: https://docs.op8x.com/metrics/ (definitions 2026-11-06)\n"));
  assert.ok(view.includes("https://docs.op8x.com/findings/funnel.possibly_paid/\n"));
});

test("the view prints every hint text in full", () => {
  const d = doc("metrics-example.json");
  const view = renderReportView(d).replace(/\n {4}/g, " ");
  const routes = (d.funnel as { routes: { hints: { text: string }[] }[] }).routes;
  for (const h of routes.flatMap((r) => r.hints)) assert.ok(view.includes(h.text), h.text);
});

test("the view shows strings from the report escaped: no control, ANSI or bidi character reaches the terminal", () => {
  for (const name of ["metrics-injection.json", "metrics-unknown.json"]) {
    const view = renderReportView(doc(name));
    // Only printable ASCII, the newline and the view's own characters (middle dot, ellipsis, the quotes of hint texts).
    const stray = Array.from(view).filter((c) => !(c === "\n" || (c >= " " && c <= "~") || "·…“”".includes(c)));
    assert.deepEqual(stray, [], name);
    assert.equal(view.includes(ESC), false, name);
  }
  const view = renderReportView(doc("metrics-unknown.json"));
  assert.ok(view.includes(String.raw`"\u{001B}[2J\u{001B}[31mGET /pwn\u{0007}\u{000D}\u{000A}OK \u{202E}evil\u{202C} \u{009B}31m"`));
  assert.ok(view.includes(String.raw`\u{001B}]8;;https://evil.example\u{0007}link`));
  // A data string longer than 100 printed characters is cut and marked.
  assert.match(view, /"a{100}…"/);
});

test("the view keeps working with unknown values: unknown statuses and codes show raw and escaped", () => {
  const view = renderReportView(doc("metrics-unknown.json"));
  assert.ok(view.includes(`status "hibernating"`));
  assert.ok(view.includes(`"sidechain"`));
  assert.ok(view.includes("! ingest.brand_new"));
  assert.ok(view.includes(`${DOCS_BASE}/findings/ingest.brand_new/`));
  // An id that is not a plain id gets no link.
  assert.equal(view.includes(`${DOCS_BASE}/findings/x`), false);
});

test("the view survives a document with missing blocks", () => {
  const view = renderReportView({ schema: "op8x.metrics/1" });
  assert.ok(view.startsWith("op8x report"));
  assert.ok(view.endsWith(`Definitions: ${DOCS_BASE}/metrics/ (definitions (missing))\n`));
});

// --- robustness of the view -------------------------------------------------------------------

test("the view never converts a value of the document to text: a reason or status with its own toString is shown as a type", () => {
  const cases = [
    `{"schema":"op8x.metrics/1","liveness":{"status":"ok","reason":{"toString":1}}}`,
    `{"schema":"op8x.metrics/1","wallets":{"status":"partial","reason":{"toString":{},"valueOf":{}}}}`,
    `{"schema":"op8x.metrics/1","liveness":{"status":{"toString":1},"reason":"x"}}`,
  ];
  const views = cases.map((c) => renderReportView(JSON.parse(c) as Record<string, unknown>));
  assert.ok(views[0]?.includes("Is my API sending data?                                 ok (reason (object))"), views[0]);
  assert.ok(views[1]?.includes("Wallets                                                 partial (reason (object))"), views[1]);
  assert.ok(views[2]?.includes(`status (object) (reason "x")`), views[2]);
});

test("the view prints non-string values as a type, never serialized: deep nesting cannot overflow the stack", () => {
  const deep = "[".repeat(200_000) + "]".repeat(200_000);
  const view = renderReportView(JSON.parse(`{"schema":"op8x.metrics/1","window":{"days":${deep}}}`) as Record<string, unknown>);
  assert.ok(view.startsWith("op8x report · last (array) days"), view.slice(0, 80));
  const types = renderReportView({
    schema: "op8x.metrics/1",
    liveness: { events_today: -1, events_last_24h: { a: 1 }, active_days_prev_7: true, last_event_at: 5 },
    wallets: { since: null },
  });
  assert.ok(types.includes("  Events today               (number)\n"), types);
  assert.ok(types.includes("  Events last 24 hours       (object)\n"), types);
  assert.ok(types.includes("  Active days (previous 7)   (boolean) of 7\n"), types);
  assert.ok(types.includes("  Last event                 (number)\n"), types);
  assert.ok(types.includes("since (null)"), types);
});

test("an unknown status keeps its reason, both escaped", () => {
  const view = renderReportView({ schema: "op8x.metrics/1", liveness: { status: "x\u001b", reason: "y\u202e" } });
  assert.ok(view.includes(String.raw`status "x\u{001B}" (reason "y\u{202E}")`), view);
});

test("the view's labels: not enough data, a new price offer, error texts, no amounts", () => {
  const view = renderReportView({
    schema: "op8x.metrics/1",
    wallets: { status: "insufficient_data" },
    revenue_reported: { status: "ok", by_asset: [] },
    data: { texts: { t: "boom" } },
    funnel: { routes: [{ route_ref: "r", by_network: [{ kind: "mainnet", no_confirmation_402: 2 }], text_refs: ["t"] }] },
  });
  assert.ok(view.includes("Wallets                                                 not enough data\n"), view);
  assert.ok(view.includes("(with a new price offer: 2)"), view);
  assert.ok(view.includes(`    Error texts              "boom"\n`), view);
  assert.ok(view.includes("Revenue (as reported by payments)\n  Amounts                    none\n"), view);
  assert.equal(view.includes("too few data"), false);
  assert.equal(view.includes("from buyers"), false);
});

test("report: an error inside the view ends as internal_error (exit 2), never as an unhandled rejection", async (t) => {
  const s = await setup(t);
  s.fake.reportBody = compact("metrics-example.json");
  // The view is the only part of a report run that pads text.
  const padEnd = String.prototype.padEnd;
  String.prototype.padEnd = () => {
    throw new Error("view broke");
  };
  let code: number;
  try {
    code = await run(["report"], s.deps);
  } finally {
    String.prototype.padEnd = padEnd;
  }
  assert.equal(code, 2);
  assert.equal(s.deps.stdout(), "op8x stopped because of an internal error. Please report this.\n");
});

// --- the output guard on the document ---------------------------------------------------------

const INTERNAL = "op8x stopped because of an internal error. Please report this.\n";

test("report in text mode refuses a document that holds a secret anywhere, even past the 100 characters the view prints", async (t) => {
  const s = await setup(t);
  const k = s.file.write_key as string;
  const text = `${"x".repeat(60)}${k}`;
  s.fake.reportBody = JSON.stringify({
    schema: "op8x.metrics/1",
    data: { routes: { r: "GET /a" }, texts: { t: text } },
    funnel: { routes: [{ route_ref: "r", text_refs: ["t"] }] },
  });
  assert.equal(await run(["report"], s.deps), 2);
  assert.equal(s.deps.stdout(), INTERNAL);
  assert.equal(s.deps.stdout().includes(k.slice(0, 12)), false);
});

test("report refuses a secret that is only visible after JSON decoding (an escaped underscore), with and without --json", async (t) => {
  for (const json of [true, false]) {
    const s = await setup(t);
    const r = s.file.read_token;
    const escaped = r.replace("_", `${BACKSLASH}u005f`);
    assert.notEqual(escaped, r);
    s.fake.reportBody = `{"schema":"op8x.metrics/1","x":"${escaped}"}`;
    assert.equal(await run(json ? ["report", "--json"] : ["report"], s.deps), 2);
    if (json) oneCliLine(s, "internal_error", 2);
    else assert.equal(s.deps.stdout(), INTERNAL);
    assert.equal(s.deps.stdout().includes(escaped), false);
  }
});

test("report refuses a secret in a key of the document", async (t) => {
  const s = await setup(t);
  s.fake.reportBody = JSON.stringify({ schema: "op8x.metrics/1", data: { routes: { [s.file.read_token]: "GET /a" } } });
  assert.equal(await run(["report"], s.deps), 2);
  assert.equal(s.deps.stdout(), INTERNAL);
});

test("report --json prints a document with line breaks or unsafe characters as one equivalent line, those characters escaped", async (t) => {
  const s = await setup(t);
  const c = (cp: number) => String.fromCodePoint(cp);
  s.fake.reportBody = `{"schema":"op8x.metrics/1",${c(0x0a)}${c(0x09)}"data":{"routes":{"a":"${c(0x9b)}31m${c(0x9d)}8;;https://evil/${c(0x9c)}${c(0x202e)}abc${c(0x2028)}${c(0x2029)}${c(0x200b)}"}}}`;
  assert.equal(await run(["report", "--json"], s.deps), 0);
  const out = s.deps.stdout();
  assert.equal(out.endsWith("\n"), true);
  assert.equal(out.split("\n").length, 2);
  assert.deepEqual(JSON.parse(out), JSON.parse(s.fake.reportBody));
  assert.deepEqual(
    Array.from(out).filter((c) => !(c === "\n" || (c >= " " && c <= "~"))),
    [],
  );
  assert.ok(out.includes(String.raw`\u009b31m`));
  assert.ok(out.includes(String.raw`\u202e`));
});

test("report --json escapes unsafe characters outside the Basic Multilingual Plane as surrogate pairs", async (t) => {
  const s = await setup(t);
  // U+E0041 TAG LATIN CAPITAL LETTER A is a format character.
  s.fake.reportBody = `{"schema":"op8x.metrics/1","x":"a${String.fromCodePoint(0xe0041)}b"}`;
  assert.equal(await run(["report", "--json"], s.deps), 0);
  assert.equal(s.deps.stdout(), `{"schema":"op8x.metrics/1","x":"a\\udb40\\udc41b"}${"\n"}`);
});

test("report: a deeply nested document is checked without overflowing the stack", async (t) => {
  const deep = "[".repeat(200_000) + "]".repeat(200_000);
  for (const json of [false, true]) {
    const s = await setup(t);
    // In --json mode the line break forces the one-line form, which cannot be built: internal_error.
    s.fake.reportBody = `{"schema":"op8x.metrics/1",${json ? "\n" : ""}"window":{"days":${deep}}}`;
    const code = await run(json ? ["report", "--json"] : ["report"], s.deps);
    if (json) {
      assert.equal(code, 2);
      oneCliLine(s, "internal_error", 2);
    } else {
      assert.equal(code, 0);
      assert.ok(s.deps.stdout().startsWith("op8x report · last (array) days"));
    }
  }
});
