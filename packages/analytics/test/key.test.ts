import { beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { ExecutionContext } from "hono";
import { analytics } from "../src/hono.ts";
import { createTransport } from "../src/transport.ts";
import type { AnalyticsOptions, AnalyticsRecord } from "../src/types.ts";
import { resetWarnings } from "../src/warnings.ts";
import { VERSION } from "../src/version.ts";

beforeEach(() => resetWarnings());

// Built at runtime so no key-shaped literal sits in the source.
const SENTINEL = "op8x_w_" + "S".repeat(43);
const PLAIN = "plain-" + "P".repeat(30);
const OTHER_SENTINEL = "op8x_w_" + "T".repeat(43);
const OP8X = "https://ingest.op8x.com/v1/events";
const ELSEWHERE = "https://collector.example/v1/events";
const MISSING = "op8x.analytics: OP8X_KEY missing, sending disabled";
const INVALID = "op8x.analytics: invalid key, sending disabled";

const CONSOLE_METHODS = ["log", "warn", "error", "info", "debug", "trace", "dir", "table"] as const;

interface Captured {
  lines: string[];
  warnings(): string[];
}

/** Replaces every console method for the test; each call is stored as one joined string. */
function captureConsole(t: TestContext): Captured {
  const lines: string[] = [];
  const warns: string[] = [];
  for (const m of CONSOLE_METHODS) {
    t.mock.method(console, m, (...a: unknown[]) => {
      const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
      lines.push(s);
      if (m === "warn") warns.push(s);
    });
  }
  return { lines, warnings: () => warns };
}

function noSentinel(where: string[], ...keys: string[]): void {
  for (const line of where) {
    // Values too short to be recognisable (empty, blank, "123") cannot be checked by substring.
    for (const k of [SENTINEL, OTHER_SENTINEL, ...keys].filter((x) => x.trim().length >= 8)) {
      assert.ok(!line.includes(k), `key leaked in a console line of ${line.length} chars`);
    }
  }
}

interface FetchCall {
  url: string;
  init: RequestInit;
  headers: Headers;
  body: string;
}

function stubFetch(t: TestContext, status = 202): FetchCall[] {
  const calls: FetchCall[] = [];
  t.mock.method(globalThis, "fetch", async (u: unknown, i?: RequestInit) => {
    const init = i ?? {};
    calls.push({ url: String(u), init, headers: new Headers(init.headers), body: String(init.body) });
    return new Response(null, { status });
  });
  return calls;
}

function fakeCtx(): { ctx: ExecutionContext; promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      promises.push(p);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, promises };
}

function app(options: AnalyticsOptions): Hono {
  const a = new Hono();
  a.use(analytics(options));
  a.get("/x", (c) => c.text("seller", 200, { "x-seller": "1" }));
  return a;
}

/** Runs one request with the given env and waits for the background work. */
async function hit(a: Hono, env: unknown): Promise<{ res: Response; background: number }> {
  const { ctx, promises } = fakeCtx();
  const res = await a.request("/x", undefined, env as never, ctx);
  await res.arrayBuffer();
  await Promise.allSettled(promises);
  return { res, background: promises.length };
}

test("op8x endpoint: OP8X_KEY from the environment is sent as a bearer header", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  const { res } = await hit(app({ endpoint: OP8X }), { OP8X_KEY: SENTINEL });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, OP8X);
  assert.equal(call.headers.get("authorization"), `Bearer ${SENTINEL}`);
  assert.equal(call.headers.get("content-type"), "application/json");
  assert.equal(call.headers.get("user-agent"), `op8x-analytics/${VERSION}`);
  assert.equal(call.init.redirect, "manual");
  assert.ok(!call.body.includes(SENTINEL), "record contains the key");
  assert.deepEqual(out.lines, []);
});

test("the environment is read on every request, so a new secret takes effect", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  const a = app({ endpoint: OP8X });
  await hit(a, { OP8X_KEY: SENTINEL });
  await hit(a, { OP8X_KEY: OTHER_SENTINEL });
  await hit(a, {});
  await hit(a, { OP8X_KEY: SENTINEL });
  assert.deepEqual(
    calls.map((c) => c.headers.get("authorization")),
    [`Bearer ${SENTINEL}`, `Bearer ${OTHER_SENTINEL}`, `Bearer ${SENTINEL}`],
  );
  assert.deepEqual(out.warnings(), [MISSING]);
  noSentinel(out.lines);
});

test("an explicit key wins over the environment", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  await hit(app({ endpoint: OP8X, key: OTHER_SENTINEL }), { OP8X_KEY: SENTINEL });
  await hit(app({ endpoint: OP8X, key: OTHER_SENTINEL }), {});
  assert.deepEqual(
    calls.map((c) => c.headers.get("authorization")),
    [`Bearer ${OTHER_SENTINEL}`, `Bearer ${OTHER_SENTINEL}`],
  );
  noSentinel(out.lines);
});

test("an invalid explicit key does not fall back to the environment", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  await hit(app({ endpoint: OP8X, key: "" }), { OP8X_KEY: SENTINEL });
  assert.equal(calls.length, 0);
  assert.deepEqual(out.warnings(), [INVALID]);
});

const notOp8x = [
  ELSEWHERE,
  "https://ingest.op8x.com.evil.example/v1/events",
  "https://ingest.op8x.com:8443/v1/events",
  "https://evil.example/v1/events?u=https://ingest.op8x.com",
  "https://op8x.com/v1/events",
  "https://x.ingest.op8x.com/v1/events",
  "http://127.0.0.1:9/v1/events",
];

for (const endpoint of notOp8x) {
  test(`the environment key is never sent to another origin (${endpoint})`, async (t) => {
    const out = captureConsole(t);
    const calls = stubFetch(t);
    await hit(app({ endpoint }), { OP8X_KEY: SENTINEL });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers.get("authorization"), null);
    assert.ok(!calls[0]!.body.includes(SENTINEL));
    assert.deepEqual(out.warnings(), [], "other endpoints without key: unchanged behaviour");
    noSentinel(out.lines);
  });
}

test("the op8x origin is matched after URL normalisation", async (t) => {
  captureConsole(t);
  const calls = stubFetch(t);
  await hit(app({ endpoint: "https://INGEST.op8x.com:443/v1/events" }), { OP8X_KEY: SENTINEL });
  assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${SENTINEL}`);
});

test("another endpoint with an explicit key gets the header; no prefix is required there", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  const custom = "custom-" + "k".repeat(20);
  await hit(app({ endpoint: ELSEWHERE, key: custom }), { OP8X_KEY: SENTINEL });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${custom}`);
  assert.deepEqual(out.warnings(), []);
  noSentinel(out.lines, custom);
});

for (const [name, env] of [
  ["no env", undefined],
  ["null env", null],
  ["string env", "OP8X_KEY"],
  ["empty env", {}],
  ["undefined value", { OP8X_KEY: undefined }],
] as Array<[string, unknown]>) {
  test(`op8x endpoint without key (${name}): no send, no background work, one warning`, async (t) => {
    const out = captureConsole(t);
    const calls = stubFetch(t);
    const a = app({ endpoint: OP8X });
    const cloned = t.mock.method(Response.prototype, "clone");
    for (let i = 0; i < 3; i++) {
      const { res, background } = await hit(a, env);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-seller"), "1");
      assert.equal(background, 0);
    }
    assert.equal(cloned.mock.callCount(), 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(out.warnings(), [MISSING]);
  });
}

test("a throwing env getter is treated as a missing key and never breaks the request", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  const env = {
    get OP8X_KEY(): string {
      throw new Error("hostile env");
    },
  };
  const { res } = await hit(app({ endpoint: OP8X }), env);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
  assert.equal(out.warnings().length, 1);
});

test("missing key with log: true still logs the record, without a send", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  await hit(app({ endpoint: OP8X, log: true }), {});
  assert.equal(calls.length, 0);
  const logged = out.lines.filter((l) => l.startsWith("op8x.analytics {"));
  assert.equal(logged.length, 1);
  assert.deepEqual(out.warnings(), [MISSING]);
});

test("log: true output never contains the key", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  await hit(app({ endpoint: OP8X, log: true }), { OP8X_KEY: SENTINEL });
  await hit(app({ endpoint: ELSEWHERE, log: true, key: PLAIN }), {});
  assert.equal(calls.length, 2);
  const logged = out.lines.filter((l) => l.startsWith("op8x.analytics {"));
  assert.equal(logged.length, 2);
  for (const l of logged) {
    const record = JSON.parse(l.slice("op8x.analytics ".length)) as Record<string, unknown>;
    assert.ok(!("key" in record));
  }
  noSentinel(out.lines, PLAIN);
  for (const c of calls) noSentinel([c.body], PLAIN);
});

const long = "op8x_w_" + "a".repeat(250);
const invalidKeys: Array<[string, unknown]> = [
  ["number", 123],
  ["object", { toString: () => SENTINEL }],
  ["empty", ""],
  ["blank", "   "],
  ["257 characters", long],
  ["newline", `op8x_w_${"a".repeat(20)}\nx`],
  ["tab", `op8x_w_${"a".repeat(20)}\tx`],
  ["DEL", `op8x_w_${"a".repeat(20)}\x7f`],
  ["non-ASCII", `op8x_w_${"a".repeat(20)}é`],
  ["NUL", `op8x_w_${"a".repeat(20)}\0`],
];

for (const [name, key] of invalidKeys) {
  for (const endpoint of [OP8X, ELSEWHERE]) {
    test(`invalid explicit key (${name}) for ${endpoint}: no send, one warning without the value`, async (t) => {
      const out = captureConsole(t);
      const calls = stubFetch(t);
      const a = app({ endpoint, key: key as string });
      await hit(a, {});
      await hit(a, {});
      assert.equal(calls.length, 0);
      assert.deepEqual(out.warnings(), [INVALID]);
      noSentinel(out.lines, String(key));
    });
  }
  test(`invalid env key (${name}): no send, one warning without the value`, async (t) => {
    const out = captureConsole(t);
    const calls = stubFetch(t);
    const a = app({ endpoint: OP8X });
    await hit(a, { OP8X_KEY: key });
    await hit(a, { OP8X_KEY: key });
    assert.equal(calls.length, 0);
    assert.deepEqual(out.warnings(), [INVALID]);
    noSentinel(out.lines, String(key));
  });
}

test("op8x endpoint requires the op8x_w_ prefix, for the env and for an explicit key", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  const bare = "S".repeat(50);
  await hit(app({ endpoint: OP8X }), { OP8X_KEY: bare });
  await hit(app({ endpoint: OP8X, key: bare }), {});
  await hit(app({ endpoint: OP8X, key: "OP8X_W_" + "S".repeat(43) }), {});
  assert.equal(calls.length, 0);
  assert.deepEqual(out.warnings(), [INVALID]);
  noSentinel(out.lines, bare);
});

test("256 characters is still a valid key", async (t) => {
  captureConsole(t);
  const calls = stubFetch(t);
  const k = "op8x_w_" + "a".repeat(249);
  assert.equal(k.length, 256);
  await hit(app({ endpoint: OP8X }), { OP8X_KEY: k });
  assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${k}`);
});

test("surrounding whitespace is trimmed before the key is sent", async (t) => {
  captureConsole(t);
  const calls = stubFetch(t);
  await hit(app({ endpoint: OP8X }), { OP8X_KEY: `  ${SENTINEL}  ` });
  assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${SENTINEL}`);
});

test("a key on an app without endpoint is ignored: nothing sent, no key warning", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  await hit(app({ log: true, key: "" }), { OP8X_KEY: SENTINEL });
  assert.equal(calls.length, 0);
  assert.deepEqual(out.warnings(), []);
  noSentinel(out.lines);
});

test("a 401 from the collector leaves the seller's response unchanged and the warning carries no key", async (t) => {
  const out = captureConsole(t);
  stubFetch(t, 401);
  const { res } = await hit(app({ endpoint: OP8X }), { OP8X_KEY: SENTINEL });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-seller"), "1");
  assert.deepEqual(out.warnings(), ["op8x.analytics: send failed (status 401)"]);
  noSentinel(out.lines);
});

test("a fetch error mentioning the key never reaches the console", async (t) => {
  const out = captureConsole(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError(`bad header ${SENTINEL}`);
  });
  await hit(app({ endpoint: OP8X }), { OP8X_KEY: SENTINEL });
  assert.deepEqual(out.warnings(), ["op8x.analytics: send failed (network)"]);
  noSentinel(out.lines);
});

// Transport

const record: AnalyticsRecord = {
  v: 1,
  id: "11111111-1111-4111-8111-111111111111",
  ts: "2026-10-28T10:00:00.000Z",
  ms: 3,
  method: "GET",
  route: "/x",
  status: 200,
  ua: "curl",
  type: "request.unpaid",
};

function recordingFetch(): { calls: Headers[]; inits: RequestInit[]; fetch: typeof fetch } {
  const calls: Headers[] = [];
  const inits: RequestInit[] = [];
  const f = (async (_u: unknown, i?: RequestInit) => {
    inits.push(i ?? {});
    calls.push(new Headers(i?.headers));
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  return { calls, inits, fetch: f };
}

test("transport: authorization header only when a key is given", async () => {
  const warns: unknown[][] = [];
  const r = recordingFetch();
  const tr = createTransport({ endpoint: ELSEWHERE }, { fetch: r.fetch, warn: (...a) => void warns.push(a) });
  await tr.send(record);
  await tr.send(record, PLAIN);
  assert.equal(r.calls[0]!.get("authorization"), null);
  assert.equal(r.calls[1]!.get("authorization"), `Bearer ${PLAIN}`);
  assert.deepEqual([...r.calls[1]!.keys()].sort(), ["authorization", "content-type", "user-agent"]);
  assert.equal(r.inits[1]!.redirect, "manual");
  assert.equal(warns.length, 0);
});

test("transport: op8x endpoint without key does not send and warns once", async (t) => {
  const out = captureConsole(t);
  const r = recordingFetch();
  const tr = createTransport({ endpoint: OP8X }, { fetch: r.fetch });
  await tr.send(record);
  await tr.send(record);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(out.warnings(), [NO_KEY_TRANSPORT]);
});

test("transport: an invalid key is not sent", async (t) => {
  const out = captureConsole(t);
  const r = recordingFetch();
  await createTransport({ endpoint: OP8X }, { fetch: r.fetch }).send(record, "S".repeat(50));
  await createTransport({ endpoint: ELSEWHERE }, { fetch: r.fetch }).send(record, `${SENTINEL}\n`.repeat(2));
  assert.equal(r.calls.length, 0);
  assert.deepEqual(out.warnings(), [INVALID]);
  noSentinel(out.lines);
});

test("transport: options.key is used when send() gets no key", async () => {
  const r = recordingFetch();
  await createTransport({ endpoint: OP8X, key: SENTINEL }, { fetch: r.fetch }).send(record);
  assert.equal(r.calls[0]!.get("authorization"), `Bearer ${SENTINEL}`);
});

async function redirectServer(): Promise<{ base: string; hits: Array<{ url: string; auth: string | undefined }>; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const hits: Array<{ url: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push({ url: req.url ?? "", auth: req.headers.authorization });
      if (req.url === "/away") res.writeHead(307, { location: "/elsewhere" });
      else res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test("transport: a redirect is not followed, so the key reaches exactly one URL", async () => {
  const srv = await redirectServer();
  try {
    const warns: unknown[][] = [];
    await createTransport({ endpoint: `${srv.base}/away`, timeoutMs: 500 }, { warn: (...a) => void warns.push(a) }).send(
      record,
      PLAIN,
    );
    assert.deepEqual(srv.hits, [{ url: "/away", auth: `Bearer ${PLAIN}` }]);
    assert.equal(warns.length, 1);
    assert.ok(!String(warns[0]![0]).includes(PLAIN));
  } finally {
    await srv.close();
  }
});

// --- red-team fixes ---

const REFUSED = "op8x.analytics: op8x write key refused for a non-op8x endpoint";
const NO_KEY_TRANSPORT =
  "op8x.analytics: no key for the op8x endpoint (set the key option or OP8X_KEY), sending disabled";

test("an explicit op8x_w_ key is refused for a non-op8x endpoint (hono)", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  const { res } = await hit(app({ endpoint: ELSEWHERE, key: SENTINEL }), {});
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
  assert.deepEqual(out.warnings(), [REFUSED]);
  noSentinel(out.lines);
});

test("an explicit op8x_w_ key is refused for a non-op8x endpoint (transport)", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  await createTransport({ endpoint: "https://ingest.op8x.com.evil.example/v1/events", key: SENTINEL }).send(record);
  assert.equal(calls.length, 0);
  assert.deepEqual(out.warnings(), [REFUSED]);
  noSentinel(out.lines);
});

test("an explicit key without the prefix still works for another endpoint", async (t) => {
  captureConsole(t);
  const calls = stubFetch(t);
  const other = "collector-" + "k".repeat(20);
  await hit(app({ endpoint: ELSEWHERE, key: other }), {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${other}`);
});

test("key warnings repeat after 60 s but never more than once per minute (transport)", async (t) => {
  const warns: unknown[][] = [];
  let now = 1_000_000;
  const tr = createTransport(
    { endpoint: OP8X },
    { warn: (...a) => warns.push(a), now: () => now, fetch: async () => new Response(null, { status: 202 }) },
  );
  await tr.send(record);
  await tr.send(record);
  now += 30_000;
  await tr.send(record);
  assert.deepEqual(warns, [[NO_KEY_TRANSPORT]]);
  now += 31_000;
  await tr.send(record);
  assert.deepEqual(warns, [[NO_KEY_TRANSPORT], [NO_KEY_TRANSPORT]]);
});

test("key warnings repeat after 60 s but never more than once per minute (hono)", async (t) => {
  const out = captureConsole(t);
  stubFetch(t);
  let now = 5_000_000;
  t.mock.method(Date, "now", () => now);
  const a = app({ endpoint: OP8X });
  await hit(a, {});
  await hit(a, {});
  assert.deepEqual(out.warnings(), [MISSING]);
  now += 61_000;
  await hit(a, {});
  assert.deepEqual(out.warnings(), [MISSING, MISSING]);
});

test("createTransport without a key on the op8x endpoint uses the transport wording", async (t) => {
  const out = captureConsole(t);
  const calls = stubFetch(t);
  await createTransport({ endpoint: OP8X }).send(record);
  assert.equal(calls.length, 0);
  assert.deepEqual(out.warnings(), [NO_KEY_TRANSPORT]);
});

for (const endpoint of [
  "https://u:p@collector.example/v1/events",
  "https://evil.example@ingest.op8x.com/v1/events",
  "https://user@ingest.op8x.com/v1/events",
  "http://u:p@127.0.0.1:9/v1/events",
]) {
  test(`an endpoint with userinfo is invalid (${endpoint.replace(/:[^:@/]*@/, ":***@")})`, async (t) => {
    const out = captureConsole(t);
    const calls = stubFetch(t);
    await hit(app({ endpoint, key: SENTINEL }), { OP8X_KEY: SENTINEL });
    await createTransport({ endpoint, key: SENTINEL }).send(record);
    assert.equal(calls.length, 0);
    assert.ok(out.warnings().every((w) => w === "op8x.analytics: invalid endpoint, sending disabled"));
    assert.ok(out.warnings().length >= 1);
    noSentinel(out.lines);
  });
}
