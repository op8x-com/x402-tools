import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createTransport } from "../src/transport.ts";
import { resetWarnings } from "../src/warnings.ts";
import { startCollector } from "./collector.ts";
import type { AnalyticsRecord } from "../src/types.ts";

beforeEach(() => resetWarnings());

const SECRET = "SECRET-ROUTE-/posts/:id";
const record: AnalyticsRecord = {
  v: 1,
  id: "11111111-1111-4111-8111-111111111111",
  ts: "2026-10-25T10:00:00.000Z",
  ms: 3,
  method: "GET",
  route: SECRET,
  status: 402,
  ua: "curl",
  type: "challenge.issued",
};

function spies() {
  const logs: unknown[][] = [];
  const warns: unknown[][] = [];
  return {
    logs,
    warns,
    log: (...a: unknown[]) => void logs.push(a),
    warn: (...a: unknown[]) => void warns.push(a),
  };
}

function noLeak(lines: unknown[][]) {
  for (const l of lines) {
    const s = l.map(String).join(" ");
    assert.ok(!s.includes(SECRET), "line leaks record data");
    assert.ok(!s.includes(record.id), "line leaks record id");
    assert.ok(!s.includes("127.0.0.1") && !s.includes("/ingest"), "line leaks endpoint");
  }
}

const okFetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

test("sends the record with json content-type and op8x user-agent", async () => {
  const c = await startCollector("ok");
  try {
    const s = spies();
    await createTransport({ endpoint: c.url }, s).send(record);
    assert.equal(c.records.length, 1);
    assert.deepEqual(c.records[0], record);
    const r = c.requests[0]!;
    assert.equal(r.method, "POST");
    assert.equal(r.headers["content-type"], "application/json");
    assert.equal(r.headers["user-agent"], "op8x-analytics/0.0.1");
    assert.equal(s.warns.length, 0);
    assert.equal(s.logs.length, 0);
  } finally {
    await c.close();
  }
});

test("log: true writes one line per record and nothing else", async () => {
  const s = spies();
  const t = createTransport({ log: true }, s);
  await t.send(record);
  await t.send(record);
  assert.equal(s.logs.length, 2);
  assert.equal(s.logs[0]![0], "op8x.analytics");
  assert.deepEqual(JSON.parse(String(s.logs[0]![1])), record);
  assert.equal(s.warns.length, 0);
});

test("no endpoint and no log is a no-op", async () => {
  let called = false;
  const s = spies();
  const f = (async () => {
    called = true;
    return new Response();
  }) as typeof fetch;
  await createTransport({}, { ...s, fetch: f }).send(record);
  assert.equal(called, false);
  assert.equal(s.logs.length + s.warns.length, 0);
});

test("500 response resolves and warns once without record data", async () => {
  const c = await startCollector("fail");
  try {
    const s = spies();
    await createTransport({ endpoint: c.url }, s).send(record);
    assert.equal(s.warns.length, 1);
    assert.match(String(s.warns[0]![0]), /status 500/);
    noLeak(s.warns);
  } finally {
    await c.close();
  }
});

test("hanging collector resolves within timeoutMs + 500 ms", async () => {
  const c = await startCollector("hang");
  try {
    const s = spies();
    const t0 = Date.now();
    await createTransport({ endpoint: c.url, timeoutMs: 200 }, s).send(record);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 700, `took ${elapsed} ms`);
    assert.equal(s.warns.length, 1);
    assert.match(String(s.warns[0]![0]), /timeout/);
    noLeak(s.warns);
  } finally {
    await c.close();
  }
});

test("unreachable port resolves and warns", async () => {
  const c = await startCollector("ok");
  const url = c.url;
  await c.close();
  const s = spies();
  await createTransport({ endpoint: url }, s).send(record);
  assert.equal(s.warns.length, 1);
  noLeak(s.warns);
});

test("timeoutMs is clamped to 100..10000 and defaults to 2000", async () => {
  const seen: number[] = [];
  const orig = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => (seen.push(ms), orig.call(AbortSignal, ms))) as typeof AbortSignal.timeout;
  try {
    for (const timeoutMs of [1, 999999, undefined, Number.NaN, 500]) {
      await createTransport({ endpoint: "https://collector.example/x", timeoutMs }, { ...spies(), fetch: okFetch }).send(record);
    }
  } finally {
    AbortSignal.timeout = orig;
  }
  assert.deepEqual(seen, [100, 10000, 2000, 2000, 500]);
});

test("endpoint validation: https and loopback http are valid", async () => {
  for (const endpoint of ["https://collector.example/x", "http://localhost:8787/x", "http://127.0.0.1/x"]) {
    const s = spies();
    let fetched = 0;
    const f = (async () => (fetched++, new Response(null, { status: 204 }))) as typeof fetch;
    await createTransport({ endpoint }, { ...s, fetch: f }).send(record);
    assert.equal(fetched, 1, endpoint);
    assert.equal(s.warns.length, 0, endpoint);
  }
});

test("invalid endpoints never throw and warn exactly once", async () => {
  for (const endpoint of ["ftp://collector.example/x", "http://example.com/x", "not a url"]) {
    resetWarnings(); // the rate limit is shared per isolate
    const s = spies();
    let fetched = false;
    const f = (async () => {
      fetched = true;
      return new Response();
    }) as typeof fetch;
    const t = createTransport({ endpoint }, { ...s, fetch: f });
    await t.send(record);
    await t.send(record);
    await t.send(record);
    assert.equal(s.warns.length, 1, endpoint);
    assert.equal(fetched, false);
    assert.match(String(s.warns[0]![0]), /invalid endpoint/);
    noLeak(s.warns);
    assert.ok(!String(s.warns[0]![0]).includes("collector.example"));
  }
});

test("invalid endpoint with log: true still logs", async () => {
  const s = spies();
  await createTransport({ endpoint: "nope", log: true }, s).send(record);
  assert.equal(s.logs.length, 1);
  assert.equal(s.warns.length, 1);
});

test("warnings are rate limited to one per 60 s", async () => {
  let now = 1_000_000;
  const s = spies();
  const f = (async () => {
    throw new TypeError("boom");
  }) as typeof fetch;
  const t = createTransport({ endpoint: "https://collector.example/x" }, { ...s, now: () => now, fetch: f });
  await t.send(record);
  await t.send(record);
  assert.equal(s.warns.length, 1);
  now += 59_999;
  await t.send(record);
  assert.equal(s.warns.length, 1);
  now += 1;
  await t.send(record);
  assert.equal(s.warns.length, 2);
  noLeak(s.warns);
});

test("send never rejects when log, warn, fetch throw or the record cannot be serialized", async () => {
  const boom = () => {
    throw new Error("x");
  };
  const t = createTransport({ log: true, endpoint: "bad" }, { log: boom, warn: boom });
  await t.send(record);
  const cyc: Record<string, unknown> = {};
  cyc["self"] = cyc;
  await t.send(cyc as unknown as AnalyticsRecord);
  const t2 = createTransport({ endpoint: "https://collector.example/x" }, { warn: boom, fetch: boom as unknown as typeof fetch });
  await t2.send(record);
  await t2.send(cyc as unknown as AnalyticsRecord);
});

test("uses globals at call time", async () => {
  const origFetch = globalThis.fetch;
  const origLog = console.log;
  let fetched = 0;
  const lines: unknown[][] = [];
  globalThis.fetch = (async () => (fetched++, new Response(null, { status: 204 }))) as typeof fetch;
  console.log = (...a: unknown[]) => void lines.push(a);
  try {
    await createTransport({ endpoint: "https://collector.example/x", log: true }).send(record);
  } finally {
    globalThis.fetch = origFetch;
    console.log = origLog;
  }
  assert.equal(fetched, 1);
  assert.equal(lines.length, 1);
});

async function redirectServer(): Promise<{ base: string; hits: string[]; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const hits: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === "/away") res.writeHead(307, { location: "http://localhost:1/elsewhere" });
      else if (req.url === "/loop") res.writeHead(307, { location: "/loop" });
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

for (const path of ["/away", "/loop"]) {
  test(`redirects are not followed (${path}): exactly one POST, counted as a failure`, async () => {
    const srv = await redirectServer();
    try {
      const s = spies();
      await createTransport({ endpoint: `${srv.base}${path}`, timeoutMs: 500 }, s).send(record);
      assert.deepEqual(srv.hits, [`POST ${path}`]);
      assert.equal(s.warns.length, 1);
      assert.match(String(s.warns[0]![0]), /^op8x\.analytics: send failed \(status \d+\)$/);
    } finally {
      await srv.close();
    }
  });
}

test("fetch is called with redirect: manual", async () => {
  let init: RequestInit | undefined;
  const f = (async (_u: unknown, i?: RequestInit) => {
    init = i;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  await createTransport({ endpoint: "https://collector.example/x" }, { fetch: f }).send(record);
  assert.equal(init?.redirect, "manual");
});

test("the rate limit is shared by transports of one isolate, per warning text", async () => {
  const s = spies();
  const f = (async () => {
    throw new TypeError("boom");
  }) as typeof fetch;
  for (let i = 0; i < 50; i++) {
    await createTransport({ endpoint: "https://collector.example/x" }, { ...s, now: () => 5_000_000, fetch: f }).send(record);
  }
  assert.equal(s.warns.length, 1);
  const bad = (async () => new Response(null, { status: 500 })) as typeof fetch;
  await createTransport({ endpoint: "https://collector.example/x" }, { ...s, now: () => 5_000_000, fetch: bad }).send(record);
  assert.equal(s.warns.length, 2, "a different text is limited separately");
});
