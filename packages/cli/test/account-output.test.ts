import assert from "node:assert/strict";
import { test } from "node:test";
import { CLI_SCHEMA, EXIT_CODES, NOTICES, agentHint, createOutput, textTime } from "../src/account/output.ts";
import type { CommandName, FinalState, Output } from "../src/account/output.ts";
import { generateKey } from "../src/account/keys.ts";
import { TEST_NOW, testDeps } from "./account-deps.ts";

type Line = Record<string, unknown>;

function setup(opts: { json?: boolean; command?: CommandName; steps?: number; env?: Record<string, string>; secrets?: (string | null)[] } = {}) {
  let clock = TEST_NOW;
  const deps = testDeps({ now: () => clock, env: opts.env ?? {} });
  const secrets = opts.secrets ?? [];
  const out: Output = createOutput({
    command: opts.command ?? "init",
    json: opts.json ?? true,
    deps,
    steps: opts.steps ?? 0,
    secrets: () => secrets,
  });
  const lines = () => deps.stdout().split("\n").filter((l) => l !== "");
  const parsed = () => lines().map((l) => JSON.parse(l) as Line);
  return { out, deps, lines, parsed, secrets, tick: (ms: number) => (clock += ms) };
}

// The catalog, verbatim (worker_not_deployed is no state).
const CATALOG: [FinalState, number, string | null, Parameters<typeof agentHint>[1]?][] = [
  [
    "connected",
    0,
    "op8x is connected to account t-k7m2p4q3xa (a***@acme.example). Tell your human which address this account belongs to; if it is not theirs, run op8x logout.",
    { account: "t-k7m2p4q3xa", contact_hint: "a***@acme.example" },
  ],
  ["key_rotated", 0, "The new server key is in 2 workers; the old key works until 2026-11-04T14:05:00Z.", { n: 2, time: "2026-11-04T14:05:00Z" }],
  ["old_key_stopped", 0, "The old server key is stopped. The new key is in 3 workers.", { n: 3 }],
  ["deleted", 0, "The account is deleted. Receipt: 0b4e2f1a-1111-4222-8333-444455556666.", { action_id: "0b4e2f1a-1111-4222-8333-444455556666" }],
  ["logged_out", 0, "This computer is signed out."],
  ["imported", 0, "The server key is on this computer now. Run op8x init in a worker folder."],
  ["cloudflare_login_needed", 1, "Ask your human to run npx wrangler login, then run op8x init again."],
  ["wrangler_missing", 1, "Run npm i -D wrangler in this project, then run op8x init again."],
  ["wrangler_too_old", 1, "This needs wrangler 4.152.0 or newer and Node.js 22 or newer. Update them, then run the command again."],
  ["env_required", 1, "This worker has several environments. Run op8x init --env <name>."],
  ["url_required", 1, "Pass --url https://… with a path the op8x module handles."],
  [
    "deployed_unverified",
    1,
    "The key is stored, but no test event arrived. Check that the module is mounted on that path and has the endpoint option; that it is @op8x/analytics 0.0.2 or later (older versions do not send the test event); or pass --url.",
  ],
  ["denied", 1, "The request was denied. Run op8x init again when your human is ready."],
  ["expired", 1, "The link expired. Run op8x init again when your human is ready."],
  ["no_account", 1, "There is no op8x account for this address. Run op8x init to create one."],
  ["terms_draft", 1, "op8x accounts are not open yet."],
  ["granted_lost", 1, "The sign-in finished but this computer missed the answer. Run op8x login."],
  [
    "server_key_missing",
    1,
    "This computer has no server key. Run op8x import-key <path to the op8x file of your other computer>, or run op8x rotate and then op8x init in every worker folder within 24 hours.",
  ],
  ["key_mismatch", 1, "The key on this computer is not the account's current key. Run op8x rotate."],
  ["key_previous", 1, "This key is the old one. Run op8x rotate."],
  ["partial", 1, "The new key is not in every worker: api, shop. Fix them and run the command again; nothing was stopped.", { names: ["api", "shop"] }],
  [
    "old_key_still_used",
    1,
    "A worker this computer does not know still uses the old key (last seen 2026-11-03T14:01:00.000Z). Run op8x init in its folder, then run op8x rotate --now again. If the key leaked, run op8x rotate --now --force-stop.",
    { time: "2026-11-03T14:01:00.000Z" },
  ],
  ["rotation_pending", 1, "A rotation is still running until 2026-11-04T14:05:00Z. Run op8x rotate --now to finish it early.", { time: "2026-11-04T14:05:00Z" }],
  ["nothing_to_stop", 1, "The old key is already stopped."],
  ["step_up_needed", 1, "Ask your human for the code from the mail, then run the same command with --code-stdin and pass the code on stdin."],
  ["code_invalid", 1, "The code is not right. 3 tries left. Ask your human for the newest code.", { attempts_left: 3 }],
  ["code_expired", 1, "The code expired. Run the command again for a new code."],
  ["code_exhausted", 1, "Too many wrong codes. Run the command again for a new code."],
  ["rate_limited", 1, "Too many requests. Try again after 2026-11-04T00:00:00Z.", { retry_at: "2026-11-04T00:00:00Z" }],
  ["key_conflict", 1, "Run the command again."],
  ["deleted_partial", 1, "The account is deleted. Remove OP8X_KEY by hand from: api.", { names: ["api"] }],
  ["not_logged_in", 1, "This computer is not signed in. Run op8x init or op8x login."],
  ["key_auth", 1, "This computer's access is no longer valid. Run op8x login."],
  ["import_failed", 1, "The file could not be read as an op8x file."],
  ["config_unreadable", 1, "The wrangler configuration could not be read."],
  ["permissions_failed", 1, "The op8x file could not be protected; nothing was written."],
  ["not_available_yet", 1, "Numbers are not available in this version yet."],
  ["network_error", 2, "Check the connection and run the command again."],
  ["busy", 2, "The service is busy; try again in a minute."],
  [
    "unexpected_response",
    2,
    "op8x got an answer it does not expect (status 404, code not_found). Update op8x and run the command again; if it stays, please report it.",
    { status: 404, code: "not_found" },
  ],
  ["internal_error", 2, "op8x stopped because of an internal error. Please report this."],
  ["usage_error", 4, null],
  ["invalid_input", 4, "The code must be 8 letters or digits. Ask your human for the code from the mail and pass it again."],
  ["code_missing", 4, "Internal error: the code was not sent. Please report this."],
  ["no_pending_step", 4, "There is no step waiting for a code. Run the command without --code-stdin."],
  ["env_file_not_ignored", 4, "Use a file that git ignores (and not .dev.vars)."],
  ["collector_url_not_allowed", 4, "OP8X_COLLECTOR_URL may only point to 127.0.0.1, localhost or [::1]."],
  [
    "collector_mismatch",
    4,
    "The op8x file on this computer was made for a different service address. Unset OP8X_COLLECTOR_URL, or set it to the address the file was made for.",
  ],
];

test("every state of the catalog has its exit code and its agent_hint verbatim", () => {
  assert.equal(Object.keys(EXIT_CODES).length, CATALOG.length);
  assert.equal("worker_not_deployed" in EXIT_CODES, false);
  for (const [state, exit, hint, vars] of CATALOG) {
    assert.equal(EXIT_CODES[state], exit, state);
    assert.equal(agentHint(state, vars ?? {}, "json"), hint, state);
  }
});

test("hint variants: no contact, no workers, signed out with key, rotate --now without URLs, running rotation, other command, never seen", () => {
  assert.equal(
    agentHint("connected", { account: "t-k7m2p4q3xa", contact_hint: null }, "json"),
    "op8x is connected to account t-k7m2p4q3xa. This computer does not know the account's address; ask your human to check that it is theirs, and if not, run op8x logout.",
  );
  assert.equal(agentHint("key_rotated", { n: 0, time: "2026-11-04T14:05:00Z" }, "json"), "No worker is known on this computer. Run op8x init in every worker folder within 24 hours.");
  assert.equal(agentHint("logged_out", { with_key: true }, "json"), "This computer is signed out. The server key on this computer is removed too.");
  assert.equal(
    agentHint("url_required", { rotate_now: true, names: ["api", "shop"] }, "json"),
    "These workers have no test address: api, shop. Run op8x init --url https://… in their folders, or run op8x rotate --now --force-stop.",
  );
  assert.equal(
    agentHint("server_key_missing", { rotation_running: true }, "json"),
    "This computer has no server key. Run op8x import-key <path to the op8x file of your other computer>, or run op8x rotate --now.",
  );
  assert.equal(
    agentHint("no_pending_step", { command: "rotate" }, "json"),
    "The waiting step belongs to op8x rotate. Run that same command with --code-stdin, or run this one without --code-stdin.",
  );
  assert.equal(
    agentHint("old_key_still_used", { time: null }, "json"),
    "A worker this computer does not know still uses the old key (last seen never). Run op8x init in its folder, then run op8x rotate --now again. If the key leaked, run op8x rotate --now --force-stop.",
  );
  assert.equal(agentHint("unexpected_response", { status: 404, code: null }, "json"), "op8x got an answer it does not expect (status 404, code null). Update op8x and run the command again; if it stays, please report it.");
});

test("times: ISO 8601 UTC in JSON, YYYY-MM-DD HH:MM UTC in text", () => {
  assert.equal(textTime("2026-11-04T00:00:00Z"), "2026-11-04 00:00 UTC");
  assert.equal(textTime("2026-11-03T14:05:59.999Z"), "2026-11-03 14:05 UTC");
  assert.equal(agentHint("rate_limited", { retry_at: "2026-11-04T00:00:00Z" }, "text"), "Too many requests. Try again after 2026-11-04 00:00 UTC.");
  const json = setup();
  json.out.final("rate_limited", { extra: { retry_after_s: 34_440, retry_at: "2026-11-04T00:00:00Z" } });
  assert.equal(json.parsed()[0]?.agent_hint, "Too many requests. Try again after 2026-11-04T00:00:00Z.");
  assert.equal(json.parsed()[0]?.retry_at, "2026-11-04T00:00:00Z");
  const text = setup({ json: false });
  text.out.final("rate_limited", { extra: { retry_after_s: 34_440, retry_at: "2026-11-04T00:00:00Z" } });
  assert.deepEqual(text.lines(), ["Too many requests. Try again after 2026-11-04 00:00 UTC."]);
});

test("JSON Lines: step events, a link event, notices and one final line with the envelope", () => {
  const s = setup({ steps: 3 });
  s.out.start("browser");
  s.out.link({ link: "https://analytics.op8x.com/link/" + "a".repeat(32), words: "amber tiger 42", expires_at: "2026-11-03T14:10:00.000Z" });
  s.tick(812);
  s.out.end("ok");
  s.out.notice("secret_put_deploys");
  s.out.start("key");
  s.tick(40);
  s.out.end("failed");
  s.out.skip("test");
  const exit = s.out.final("connected", { extra: { account: "t-k7m2p4q3xa", contact_hint: "a***@acme.example", workers: [] } });
  assert.equal(exit, 0);
  const base = { schema: CLI_SCHEMA, command: "init", final: false };
  assert.deepEqual(s.parsed(), [
    { ...base, event: "step", n: 1, of: 3, name: "browser", status: "start" },
    {
      ...base,
      event: "link",
      state: "waiting_for_human",
      agent_hint: "Ask your human to open the link and click Allow. Their screen shows amber tiger 42.",
      link: "https://analytics.op8x.com/link/" + "a".repeat(32),
      words: "amber tiger 42",
      expires_at: "2026-11-03T14:10:00.000Z",
    },
    { ...base, event: "step", n: 1, of: 3, name: "browser", status: "ok", elapsed_ms: 812 },
    { ...base, event: "notice", id: "secret_put_deploys", text: "wrangler secret put deploys the worker right away." },
    { ...base, event: "step", n: 2, of: 3, name: "key", status: "start" },
    { ...base, event: "step", n: 2, of: 3, name: "key", status: "failed", elapsed_ms: 40 },
    { ...base, event: "step", n: 3, of: 3, name: "test", status: "skipped", elapsed_ms: 0 },
    {
      schema: CLI_SCHEMA,
      command: "init",
      final: true,
      state: "connected",
      exit_code: 0,
      agent_hint:
        "op8x is connected to account t-k7m2p4q3xa (a***@acme.example). Tell your human which address this account belongs to; if it is not theirs, run op8x logout.",
      steps: [
        { n: 1, name: "browser", status: "ok", elapsed_ms: 812 },
        { n: 2, name: "key", status: "failed", elapsed_ms: 40 },
        { n: 3, name: "test", status: "skipped", elapsed_ms: 0 },
      ],
      account: "t-k7m2p4q3xa",
      contact_hint: "a***@acme.example",
      workers: [],
    },
  ]);
  // Exactly one final line, and it is the last.
  assert.equal(s.parsed().filter((l) => l.final === true).length, 1);
});

test("every notice text verbatim, in JSON and in text; test_host carries the cleaned host", () => {
  assert.deepEqual(NOTICES, {
    code_already_sent: "A code was already sent in the last 10 minutes. Check your mail for it.",
    contact_unknown: "This computer does not know the contact address of this account.",
    secret_put_deploys: "wrangler secret put deploys the worker right away.",
    test_host: "Sending one test request to {host}.",
    logout_removes_key: "This computer holds the server key. It is deleted with the op8x file; your workers keep their copy.",
    logout_removes_salt:
      "This computer holds the account's salt. It is deleted with the op8x file; your workers keep their copy. A later op8x init here makes a new salt unless op8x import-key brings it back, and returning-buyer counts restart after a new salt.",
  });
  const j = setup();
  j.out.notice("test_host", { host: "api.example\u001b[2J\n.com" });
  assert.deepEqual(j.parsed()[0], {
    schema: CLI_SCHEMA,
    command: "init",
    final: false,
    event: "notice",
    id: "test_host",
    text: "Sending one test request to api.example[2J.com.",
    host: "api.example[2J.com",
  });
  const t = setup({ json: false });
  for (const id of Object.keys(NOTICES) as (keyof typeof NOTICES)[]) t.out.notice(id, { host: "api.example" });
  assert.deepEqual(t.lines(), [
    "A code was already sent in the last 10 minutes. Check your mail for it.",
    "This computer does not know the contact address of this account.",
    "wrangler secret put deploys the worker right away.",
    "Sending one test request to api.example.",
    "This computer holds the server key. It is deleted with the op8x file; your workers keep their copy.",
    "This computer holds the account's salt. It is deleted with the op8x file; your workers keep their copy. A later op8x init here makes a new salt unless op8x import-key brings it back, and returning-buyer counts restart after a new salt.",
  ]);
});

test("text mode: Step n of N, the link with words and time, the hint as the last line, workers listed", () => {
  const s = setup({ json: false, steps: 2 });
  s.out.start("browser");
  s.out.link({ link: "https://analytics.op8x.com/link/" + "a".repeat(32), words: "amber tiger 42", expires_at: "2026-11-03T14:10:00.000Z" });
  s.tick(1500);
  s.out.end("ok");
  s.out.skip("test");
  s.out.final("url_required", { extra: { workers: [{ name: "api", env: "staging", env_file: null, status: "no_url" }] } });
  assert.deepEqual(s.lines(), [
    "Step 1 of 2: browser",
    // Words and link escaped and quoted in text (look-alike characters stay visible).
    'Ask your human to open the link and click Allow. Their screen shows "amber tiger 42".',
    'Link: "https://analytics.op8x.com/link/' + "a".repeat(32) + '"',
    "The link is valid until 2026-11-03 14:10 UTC.",
    "Step 1 of 2: browser ok (1500 ms)",
    "Step 2 of 2: test skipped",
    "Worker api (env staging): no_url",
    "Pass --url https://… with a path the op8x module handles.",
  ]);
});

test("control characters are removed from server fields in JSON and in text", () => {
  const hostile = "a***@acme.example\u001b]0;pwned\u0007\u202e\r\n";
  const j = setup();
  j.out.link({ link: "https://analytics.op8x.com/link/" + "a".repeat(32), words: "amber\u0000 tiger\u2028 42", expires_at: "2026-11-03T14:10:00.000Z" });
  j.out.final("connected", { extra: { account: "t-k7m2p4q3xa", contact_hint: hostile, receipt: { action_id: "x\u001by" } } });
  const raw = j.deps.stdout();
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f\u202e\u2028]/.test(raw.replace(/\n/g, "")), false);
  assert.equal(raw.includes("\\u001b"), false);
  const lines = j.parsed();
  assert.equal(lines[0]?.words, "amber tiger 42");
  assert.equal(lines[1]?.contact_hint, "a***@acme.example]0;pwned");
  assert.deepEqual(lines[1]?.receipt, { action_id: "xy" });
  const t = setup({ json: false });
  t.out.final("connected", { extra: { account: "t-k7m2p4q3xa", contact_hint: hostile } });
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f\u202e]/.test(t.deps.stdout()), false);
  assert.equal(t.lines().length, 1);
});

test("output guard: a line with R, K, the next K, D or OP8X_TEST_TOKEN becomes the internal_error final line, nothing else", () => {
  const r = generateKey("r");
  const k = generateKey("w");
  const next = generateKey("w");
  const d = generateKey("d");
  const testToken = "op8x_t_" + generateKey("w").slice(7);
  for (const json of [true, false]) {
    for (const secret of [r, k, next, d, testToken]) {
      const s = setup({ json, env: { OP8X_TEST_TOKEN: testToken }, secrets: [r, k, null], steps: 2 });
      s.out.start("key");
      // The next K is known only from now on: the guard asks for the secrets before every line.
      s.secrets.push(next, d);
      s.out.notice("test_host", { host: `api.example/${secret}` });
      s.out.end("ok");
      s.out.notice("secret_put_deploys");
      const exit = s.out.final("connected", { extra: { account: "t-k7m2p4q3xa", contact_hint: secret } });
      assert.equal(exit, 2);
      assert.equal(s.out.stopped, true);
      const all = s.deps.stdout() + s.deps.stderr();
      assert.equal(all.includes(secret), false);
      assert.equal(s.deps.stderr(), "");
      if (json) {
        const lines = s.parsed();
        assert.equal(lines.length, 2);
        assert.deepEqual(lines[1], {
          schema: CLI_SCHEMA,
          command: "init",
          final: true,
          state: "internal_error",
          exit_code: 2,
          agent_hint: "op8x stopped because of an internal error. Please report this.",
        });
      } else {
        assert.deepEqual(s.lines(), ["Step 1 of 2: key", "op8x stopped because of an internal error. Please report this."]);
      }
    }
  }
});

test("output guard: the final line itself is guarded", () => {
  const k = generateKey("w");
  const s = setup({ secrets: [k] });
  assert.equal(s.out.final("unexpected_response", { extra: { status: 400, code: null, note: `x${k}` } }), 2);
  assert.equal(s.deps.stdout().includes(k), false);
  assert.equal(s.parsed()[0]?.state, "internal_error");
});

test("output guard: short or empty secret values never trip it", () => {
  const s = setup({ env: { OP8X_TEST_TOKEN: "" }, secrets: ["", null] });
  assert.equal(s.out.final("logged_out"), 0);
  assert.equal(s.parsed()[0]?.state, "logged_out");
});

test("error() turns an API error into its final line with the state's fields", () => {
  const cases: [Parameters<Output["error"]>[0], Line][] = [
    [{ state: "network_error" }, { state: "network_error", exit_code: 2 }],
    [{ state: "busy" }, { state: "busy", exit_code: 2 }],
    [{ state: "unexpected_response", status: 410, code: "flow_moved" }, { state: "unexpected_response", exit_code: 2, status: 410, code: "flow_moved" }],
    [{ state: "code_invalid", attempts_left: 2 }, { state: "code_invalid", exit_code: 1, attempts_left: 2 }],
    [
      { state: "rate_limited", retry_after_s: 60, retry_at: "2026-11-03T14:06:00Z" },
      { state: "rate_limited", exit_code: 1, retry_after_s: 60, retry_at: "2026-11-03T14:06:00Z" },
    ],
    [
      { state: "rotation_pending", retry_after_s: 60, retry_at: "2026-11-03T14:06:00Z" },
      { state: "rotation_pending", exit_code: 1, retry_after_s: 60, retry_at: "2026-11-03T14:06:00Z" },
    ],
    [{ state: "code_missing" }, { state: "code_missing", exit_code: 4 }],
    [{ state: "key_auth" }, { state: "key_auth", exit_code: 1 }],
  ];
  for (const [error, expected] of cases) {
    const s = setup({ command: "rotate" });
    const exit = s.out.error(error);
    const line = s.parsed()[0] ?? {};
    assert.equal(exit, expected.exit_code);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(line[key], value, `${error.state}.${key}`);
    assert.equal(line.command, "rotate");
  }
  const s = setup();
  s.out.error({ state: "unexpected_response", status: 410, code: "flow_moved" });
  assert.equal(
    s.parsed()[0]?.agent_hint,
    "op8x got an answer it does not expect (status 410, code flow_moved). Update op8x and run the command again; if it stays, please report it.",
  );
});

test("after the final line nothing more is written", () => {
  const s = setup();
  s.out.final("logged_out");
  s.out.notice("secret_put_deploys");
  assert.equal(s.out.final("busy"), 0);
  assert.equal(s.lines().length, 1);
});

test("final() ends a step that is still running as failed, so it appears in steps", () => {
  const s = setup({ steps: 2 });
  s.out.start("key");
  s.tick(25);
  assert.equal(s.out.final("network_error"), 2);
  const [start, end, last] = s.parsed();
  const base = { schema: CLI_SCHEMA, command: "init", final: false };
  assert.deepEqual(start, { ...base, event: "step", n: 1, of: 2, name: "key", status: "start" });
  assert.deepEqual(end, { ...base, event: "step", n: 1, of: 2, name: "key", status: "failed", elapsed_ms: 25 });
  assert.deepEqual(last?.steps, [{ n: 1, name: "key", status: "failed", elapsed_ms: 25 }]);
  assert.equal(s.parsed().length, 3);

  const text = setup({ json: false, steps: 1 });
  text.out.start("browser");
  text.out.final("denied");
  assert.deepEqual(text.lines(), ["Step 1 of 1: browser", "Step 1 of 1: browser failed (0 ms)", "The request was denied. Run op8x init again when your human is ready."]);
});

test("end() without a running step is a programming error", () => {
  const s = setup({ steps: 1 });
  assert.throws(() => s.out.end("ok"));
  s.out.start("key");
  s.out.end("ok");
  assert.throws(() => s.out.end("failed"));
});
