import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { ExecutionContext, MiddlewareHandler } from "hono";
import { analytics } from "../src/hono.ts";
import { hashPayer } from "../src/hash.ts";
import type { AnalyticsOptions, AnalyticsRecord } from "../src/types.ts";
import { resetWarnings } from "../src/warnings.ts";
import { startCollector } from "./collector.ts";
import { b64, PAYER, TX, v1Challenge, v2Challenge, v2Payment, v2Receipt } from "./fixtures.ts";

// One-time warnings are module-scoped; every test starts with a clean slate.
beforeEach(() => resetWarnings());

const BIG = 1024 * 1024;
/** Unusual fixed amount for the streamed 402 route, so a match cannot come from a default. */
const streamSeed = "7319042";
const CHUNK = 16 * 1024;

interface FakeCtx {
  ctx: ExecutionContext;
  promises: Promise<unknown>[];
}

function fakeCtx(): FakeCtx {
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

/** Pull-based stream of `total` bytes in CHUNK pieces; counts how many bytes were pulled. */
function countingStream(total: number, fill = 0x20): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const size = Math.min(CHUNK, total - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(fill));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => sent };
}

interface Hooks {
  errors: unknown[];
  bigPulled?: () => number;
}

function buildApp(middleware: MiddlewareHandler | undefined, hooks: Hooks = { errors: [] }, outer?: MiddlewareHandler) {
  const app = new Hono();
  if (outer) app.use("*", outer);
  if (middleware) app.use("*", middleware);
  app.onError((err, c) => {
    hooks.errors.push(err);
    return c.text(`handled: ${(err as Error).message}`, 500, { "x-handled": "1" });
  });
  app.get("/json", (c) => c.json({ ok: true, items: [1, 2, 3] }, 200, { "x-seller": "a" }));
  app.get("/items/:id", (c) => {
    c.header("PAYMENT-REQUIRED", b64(v2Challenge));
    return c.json({}, 402);
  });
  app.get("/v1", (c) => c.json(v1Challenge, 402));
  app.get("/stream", () => {
    const enc = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= 5) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(`chunk-${i++};`));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
  });
  app.get("/stream402", () => {
    const enc = new TextEncoder();
    const parts = ['{"x402Version":1,', '"error":"pay first",', `"accepts":[{"scheme":"exact","network":"base-sepolia","maxAmountRequired":"${streamSeed}"}]}`];
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[i++];
        if (part === undefined) controller.close();
        else controller.enqueue(enc.encode(part));
      },
    });
    return new Response(stream, { status: 402, headers: { "content-type": "application/json" } });
  });
  app.get("/throw", () => {
    throw new Error("seller boom");
  });
  app.get("/paid", (c) => {
    c.header("PAYMENT-RESPONSE", b64(v2Receipt));
    return c.json({ data: "paid content" });
  });
  app.get("/big", () => {
    const { stream, pulled } = countingStream(BIG);
    hooks.bigPulled = pulled;
    return new Response(stream, { status: 402, headers: { "content-type": "application/json" } });
  });
  return app;
}

async function snapshot(res: Response) {
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const headers = [...res.headers.entries()].sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  const body = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers, body };
}

async function settleWithin(promises: Promise<unknown>[], ms: number): Promise<number> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  const result = await Promise.race([Promise.allSettled(promises).then(() => "done" as const), limit]);
  clearTimeout(timer);
  assert.equal(result, "done", `background did not settle within ${ms} ms`);
  return Date.now() - start;
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const PATHS = ["/json", "/items/abc123", "/v1", "/stream", "/stream402", "/throw"];

for (const path of PATHS) {
  test(`response is byte-identical with and without the middleware: ${path}`, async () => {
    const collector = await startCollector("ok");
    try {
      const plainHooks: Hooks = { errors: [] };
      const withHooks: Hooks = { errors: [] };
      const plain = buildApp(undefined, plainHooks);
      const withMw = buildApp(analytics({ endpoint: collector.url }), withHooks);
      const a = fakeCtx();
      const b = fakeCtx();
      const expected = await snapshot(await plain.request(path, undefined, {}, a.ctx));
      const actual = await snapshot(await withMw.request(path, undefined, {}, b.ctx));
      assert.deepEqual(actual.status, expected.status);
      assert.deepEqual(actual.headers, expected.headers);
      assert.deepEqual(actual.body, expected.body);
      assert.equal(withHooks.errors.length, plainHooks.errors.length);
      await settleWithin(b.promises, 3000);
      assert.equal(b.promises.length, 1);
    } finally {
      await collector.close();
    }
  });
}

test("a thrown seller error reaches app.onError exactly once, unchanged", async (t) => {
  t.mock.method(console, "log", () => {});
  const hooks: Hooks = { errors: [] };
  const app = buildApp(analytics({ log: true }), hooks);
  const { ctx, promises } = fakeCtx();
  const res = await app.request("/throw", undefined, {}, ctx);
  assert.equal(res.status, 500);
  assert.equal(await res.text(), "handled: seller boom");
  assert.equal(hooks.errors.length, 1);
  assert.equal((hooks.errors[0] as Error).message, "seller boom");
  await settleWithin(promises, 1000);
});

test("end to end: unpaid, 402 and paid-with-receipt produce the expected records", async () => {
  const collector = await startCollector("ok");
  try {
    const app = buildApp(analytics({ endpoint: collector.url }));
    const { ctx, promises } = fakeCtx();
    await (await app.request("/json", { headers: { "user-agent": "curl/8.0" } }, {}, ctx)).arrayBuffer();
    await (await app.request("/items/abc123", { headers: { "user-agent": "x402-fetch/1.0" } }, {}, ctx)).arrayBuffer();
    await (
      await app.request(
        "/paid",
        { headers: { "user-agent": "x402-fetch/1.0", "PAYMENT-SIGNATURE": b64(v2Payment) } },
        {},
        ctx,
      )
    ).arrayBuffer();
    await settleWithin(promises, 3000);
    assert.equal(collector.records.length, 3);
    const byType = new Map(collector.records.map((r) => [r.type, r] as const));

    const unpaid = byType.get("request.unpaid") as AnalyticsRecord;
    assert.equal(unpaid.status, 200);
    assert.equal(unpaid.route, "/json");
    assert.equal(unpaid.method, "GET");
    assert.equal(unpaid.ua, "curl");
    assert.equal(unpaid.v, 1);
    assert.match(unpaid.id, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(unpaid.ts)));
    assert.equal(typeof unpaid.ms, "number");
    assert.ok(unpaid.ms >= 0);

    const challenge = byType.get("challenge.issued") as AnalyticsRecord;
    assert.equal(challenge.status, 402);
    assert.equal(challenge.route, "/items/:id");
    assert.equal(challenge.ua, "x402-client");
    assert.deepEqual(challenge.challenge, {
      location: "header",
      version: 2,
      error: "Payment required",
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          amount: "1000",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        },
      ],
    });

    const paid = byType.get("payment.received") as AnalyticsRecord;
    assert.equal(paid.status, 200);
    assert.equal(paid.route, "/paid");
    assert.equal(paid.delivery, "ok");
    assert.equal(paid.payment?.header, "PAYMENT-SIGNATURE");
    assert.equal(paid.payment?.decodable, true);
    assert.equal(paid.payment?.payer, undefined, "no salt, no payer");
    assert.equal(paid.receipt?.header, "PAYMENT-RESPONSE");
    assert.equal(paid.receipt?.success, true);

    const ids = new Set(collector.records.map((r) => r.id));
    assert.equal(ids.size, 3);
  } finally {
    await collector.close();
  }
});

test("v1 body challenge is read from the cloned body", async () => {
  const collector = await startCollector("ok");
  try {
    const app = buildApp(analytics({ endpoint: collector.url }));
    const { ctx, promises } = fakeCtx();
    const res = await app.request("/v1", undefined, {}, ctx);
    assert.deepEqual(await res.json(), v1Challenge);
    await settleWithin(promises, 3000);
    assert.equal(collector.records.length, 1);
    const rec = collector.records[0] as AnalyticsRecord;
    assert.equal(rec.challenge?.location, "body");
    assert.equal(rec.challenge?.version, 1);
    assert.equal(rec.challenge?.accepts?.[0]?.amount, "1000");
  } finally {
    await collector.close();
  }
});

test("route is the pattern, never the concrete path", async () => {
  const collector = await startCollector("ok");
  try {
    const app = buildApp(analytics({ endpoint: collector.url }));
    const { ctx, promises } = fakeCtx();
    await (await app.request("/items/secret-id-987?q=hidden", undefined, {}, ctx)).arrayBuffer();
    await settleWithin(promises, 3000);
    const rec = collector.records[0] as AnalyticsRecord;
    assert.equal(rec.route, "/items/:id");
    const raw = JSON.stringify(collector.requests);
    assert.ok(!raw.includes("secret-id-987"));
    assert.ok(!raw.includes("hidden"));
  } finally {
    await collector.close();
  }
});

for (const mode of ["hang", "fail", "unreachable"] as const) {
  test(`collector ${mode}: response unchanged, background settles within timeoutMs + 500 ms`, async (t) => {
    t.mock.method(console, "warn", () => {});
    const collector = mode === "unreachable" ? undefined : await startCollector(mode);
    try {
      const timeoutMs = 300;
      const endpoint = collector?.url ?? "http://127.0.0.1:1/ingest";
      const plain = buildApp(undefined);
      const app = buildApp(analytics({ endpoint, timeoutMs }));
      const { ctx, promises } = fakeCtx();
      const expected = await snapshot(await plain.request("/items/abc123", undefined, {}, fakeCtx().ctx));
      const actual = await snapshot(await app.request("/items/abc123", undefined, {}, ctx));
      assert.deepEqual(actual, expected);
      assert.equal(promises.length, 1);
      const elapsed = await settleWithin(promises, timeoutMs + 500);
      assert.ok(elapsed <= timeoutMs + 500);
    } finally {
      await collector?.close();
    }
  });
}

test("the response resolves while the background task is still pending", async (t) => {
  t.mock.method(console, "warn", () => {});
  const collector = await startCollector("hang");
  try {
    const timeoutMs = 300;
    const app = buildApp(analytics({ endpoint: collector.url, timeoutMs }));
    const { ctx, promises } = fakeCtx();
    const started = Date.now();
    const res = await app.request("/json", undefined, {}, ctx);
    assert.ok(Date.now() - started < timeoutMs, "response must not wait for the collector");
    assert.equal(res.status, 200);
    assert.equal(promises.length, 1);
    let settled = false;
    void (promises[0] as Promise<unknown>).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(settled, false, "background must still be pending 50 ms after the response");
    await settleWithin(promises, timeoutMs + 500);
  } finally {
    await collector.close();
  }
});

test("background promise never rejects", async (t) => {
  t.mock.method(console, "warn", () => {});
  const app = buildApp(analytics({ endpoint: "http://127.0.0.1:1/ingest", timeoutMs: 100 }));
  const { ctx, promises } = fakeCtx();
  await app.request("/items/abc123", undefined, {}, ctx);
  const results = await Promise.allSettled(promises);
  assert.ok(results.every((r) => r.status === "fulfilled"));
});

test("a 1 MB 402 body is not fully read; the seller still gets all of it", async () => {
  const collector = await startCollector("ok");
  try {
    const hooks: Hooks = { errors: [] };
    const app = buildApp(analytics({ endpoint: collector.url }), hooks);
    const { ctx, promises } = fakeCtx();
    const res = await app.request("/big", undefined, {}, ctx);
    await settleWithin(promises, 3000);
    const pulled = (hooks.bigPulled as () => number)();
    assert.ok(pulled < BIG / 4, `pulled ${pulled} bytes, expected far less than ${BIG}`);
    assert.ok(pulled >= 64 * 1024, "the 64 KB copy was read");
    const body = new Uint8Array(await res.arrayBuffer());
    assert.equal(body.byteLength, BIG);
    assert.equal(res.status, 402);
    assert.equal(collector.records.length, 1);
    assert.equal(collector.records[0]?.challenge?.location, "none");
  } finally {
    await collector.close();
  }
});

test("without an execution context the middleware still works and sends", async () => {
  const collector = await startCollector("ok");
  try {
    const plain = buildApp(undefined);
    const app = buildApp(analytics({ endpoint: collector.url }));
    const expected = await snapshot(await plain.request("/items/abc123"));
    const actual = await snapshot(await app.request("/items/abc123"));
    assert.deepEqual(actual, expected);
    await waitFor(() => collector.records.length === 1);
    assert.equal(collector.records[0]?.type, "challenge.issued");
  } finally {
    await collector.close();
  }
});

test("the transport is created once per analytics() call: one warning for two failed sends", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const collector = await startCollector("fail");
  try {
    const app = buildApp(analytics({ endpoint: collector.url }));
    const { ctx, promises } = fakeCtx();
    await app.request("/json", undefined, {}, ctx);
    await app.request("/json", undefined, {}, ctx);
    await settleWithin(promises, 3000);
    assert.equal(collector.requests.length, 2);
    const failures = warn.mock.calls.filter((c) => String(c.arguments[0]).includes("send failed"));
    assert.equal(failures.length, 1);
  } finally {
    await collector.close();
  }
});

test("salt hashes the payer", async () => {
  const collector = await startCollector("ok");
  try {
    const app = buildApp(analytics({ endpoint: collector.url, salt: "seller-salt" }));
    const { ctx, promises } = fakeCtx();
    await app.request("/paid", { headers: { "PAYMENT-SIGNATURE": b64(v2Payment) } }, {}, ctx);
    await settleWithin(promises, 3000);
    assert.equal(collector.records[0]?.payment?.payer, await hashPayer("seller-salt", PAYER));
  } finally {
    await collector.close();
  }
});

for (const salt of ["", "   ", 5, null, {}] as unknown as string[]) {
  test(`blank or non-string salt ${JSON.stringify(salt)}: no payer, one warning on first request`, async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const collector = await startCollector("ok");
    try {
      const options: AnalyticsOptions = { endpoint: collector.url, salt };
      const mw = analytics(options);
      assert.equal(warn.mock.callCount(), 0, "no warning at construction");
      const app = buildApp(mw);
      const { ctx, promises } = fakeCtx();
      await app.request("/paid", { headers: { "PAYMENT-SIGNATURE": b64(v2Payment) } }, {}, ctx);
      await app.request("/paid", { headers: { "PAYMENT-SIGNATURE": b64(v2Payment) } }, {}, ctx);
      await settleWithin(promises, 3000);
      const salted = warn.mock.calls.filter(
        (c) => c.arguments[0] === "op8x.analytics: salt must be a non-empty string, payer hashing disabled",
      );
      assert.equal(salted.length, 1);
      assert.equal(collector.records.length, 2);
      assert.ok(collector.records.every((r) => r.payment !== undefined && r.payment.payer === undefined));
    } finally {
      await collector.close();
    }
  });
}

test("missing salt: no payer and no salt warning", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const collector = await startCollector("ok");
  try {
    const app = buildApp(analytics({ endpoint: collector.url }));
    const { ctx, promises } = fakeCtx();
    await app.request("/paid", { headers: { "PAYMENT-SIGNATURE": b64(v2Payment) } }, {}, ctx);
    await settleWithin(promises, 3000);
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(collector.records.length, 1);
    assert.equal(collector.records[0]?.payment?.decodable, true);
    assert.equal(collector.records[0]?.payment?.payer, undefined);
  } finally {
    await collector.close();
  }
});

test("header changes by outer middlewares after the response do not leak into the record", async () => {
  const collector = await startCollector("ok");
  try {
    const outer: MiddlewareHandler = async (c, next) => {
      await next();
      c.header("PAYMENT-RESPONSE", b64(v2Receipt));
    };
    const app = buildApp(analytics({ endpoint: collector.url }), { errors: [] }, outer);
    const { ctx, promises } = fakeCtx();
    const res = await app.request("/json", undefined, {}, ctx);
    assert.ok(res.headers.get("payment-response"), "outer middleware did set the header");
    await settleWithin(promises, 3000);
    assert.equal(collector.records.length, 1);
    assert.equal(collector.records[0]?.type, "request.unpaid");
    assert.equal(collector.records[0]?.receipt, undefined);
  } finally {
    await collector.close();
  }
});

test("log option writes one line per record without an endpoint", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const app = buildApp(analytics({ log: true }));
  const { ctx, promises } = fakeCtx();
  await app.request("/json", undefined, {}, ctx);
  await settleWithin(promises, 1000);
  const lines = log.mock.calls.filter((c) => c.arguments[0] === "op8x.analytics");
  assert.equal(lines.length, 1);
  const rec = JSON.parse(String(lines[0]?.arguments[1])) as AnalyticsRecord;
  assert.equal(rec.route, "/json");
});

async function routeOf(app: Hono, path: string): Promise<AnalyticsRecord> {
  const { ctx, promises } = fakeCtx();
  const log = console.log;
  const lines: unknown[][] = [];
  console.log = (...a: unknown[]) => void lines.push(a);
  try {
    await (await app.request(path, undefined, {}, ctx)).arrayBuffer();
    await settleWithin(promises, 1000);
  } finally {
    console.log = log;
  }
  const line = lines.find((l) => l[0] === "op8x.analytics");
  assert.ok(line, "a record was logged");
  return JSON.parse(String(line[1])) as AnalyticsRecord;
}

test("unmatched path: route is empty", async () => {
  const app = buildApp(analytics({ log: true }));
  const rec = await routeOf(app, "/nope");
  assert.equal(rec.status, 404);
  assert.equal(rec.route, "");
});

test("unmatched path with a later catch-all middleware: route is empty", async () => {
  const app = new Hono();
  app.use("*", analytics({ log: true }));
  app.use("*", async (_c, next) => {
    await next();
  });
  app.get("/items/:id", (c) => c.text("item"));
  assert.equal((await routeOf(app, "/nope")).route, "");
  assert.equal((await routeOf(app, "/items/7")).route, "/items/:id");
});

test("payment-style middleware registered after the route still yields the route pattern", async () => {
  const app = new Hono();
  app.use("*", analytics({ log: true }));
  app.use("/items/*", async (c, next) => {
    if (!c.req.header("payment-signature")) return c.json({}, 402);
    await next();
  });
  app.get("/items/:id", (c) => c.text("item"));
  const rec = await routeOf(app, "/items/7");
  assert.equal(rec.status, 402);
  assert.equal(rec.route, "/items/:id");
});

test("streamed 402 body: challenge is read from the clone", async () => {
  const collector = await startCollector("ok");
  try {
    const app = buildApp(analytics({ endpoint: collector.url }));
    const { ctx, promises } = fakeCtx();
    const res = await app.request("/stream402", undefined, {}, ctx);
    assert.equal((await res.json()).accepts[0].maxAmountRequired, streamSeed);
    await settleWithin(promises, 3000);
    assert.equal(collector.records[0]?.challenge?.location, "body");
    assert.equal(collector.records[0]?.challenge?.accepts?.[0]?.amount, streamSeed);
  } finally {
    await collector.close();
  }
});

test("setup failure disables analytics with one fixed warning and leaves the response alone", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const hostile = {
    get endpoint(): string {
      throw new Error("hostile options");
    },
  } as unknown as AnalyticsOptions;
  const mw = analytics(hostile);
  const plain = buildApp(undefined);
  const app = buildApp(mw);
  const { ctx, promises } = fakeCtx();
  const expected = await snapshot(await plain.request("/json"));
  const actual = await snapshot(await app.request("/json", undefined, {}, ctx));
  assert.deepEqual(actual, expected);
  assert.equal(promises.length, 0);
  const setup = warn.mock.calls.filter((c) => c.arguments[0] === "op8x.analytics: setup failed, analytics disabled");
  assert.equal(setup.length, 1);
});

test("neither endpoint nor log: one warning on the first request, no background work", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const mw = analytics({});
  assert.equal(warn.mock.callCount(), 0, "no warning at construction");
  const plain = buildApp(undefined);
  const app = buildApp(mw);
  const { ctx, promises } = fakeCtx();
  for (const path of ["/items/abc123", "/json"]) {
    const expected = await snapshot(await plain.request(path));
    const actual = await snapshot(await app.request(path, undefined, {}, ctx));
    assert.deepEqual(actual, expected);
  }
  assert.equal(promises.length, 0);
  const nothing = warn.mock.calls.filter(
    (c) => c.arguments[0] === "op8x.analytics: no endpoint and log disabled, nothing is recorded",
  );
  assert.equal(nothing.length, 1);
  assert.equal(warn.mock.callCount(), 1);
});

test("a non-finalized context is left untouched and nothing is recorded", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const build = (mw?: MiddlewareHandler) => {
    const app = new Hono();
    app.use(async (c, next) => {
      await next();
      if (!c.finalized) c.res = new Response("fallback", { status: 503 });
    });
    if (mw) app.use(mw);
    app.use(async (c) => {
      // A middleware that forgets to return a response.
      c.header("x-internal-debug", "1");
      c.status(201);
    });
    return app;
  };
  const expected = await snapshot(await build().request("/"));
  const { ctx, promises } = fakeCtx();
  const actual = await snapshot(await build(analytics({ log: true })).request("/", undefined, {}, ctx));
  assert.deepEqual(actual, expected);
  assert.equal(actual.status, 503);
  assert.equal(promises.length, 0);
  assert.equal(log.mock.callCount(), 0);
});

test("decoding runs only after the response has resolved", async (t) => {
  t.mock.method(console, "log", () => {});
  const order: string[] = [];
  const realAtob = globalThis.atob;
  t.mock.method(globalThis, "atob", (s: string) => {
    order.push("decode");
    return realAtob(s);
  });
  const app = buildApp(analytics({ log: true }));
  const { ctx, promises } = fakeCtx();
  const big = { ...v2Payment, payload: { ...v2Payment.payload, pad: "a".repeat(12_000) } };
  await app.request("/json", { headers: { "PAYMENT-SIGNATURE": b64(big) } }, {}, ctx);
  order.push("resolved");
  await settleWithin(promises, 1000);
  assert.deepEqual(order, ["resolved", "decode"]);
});

test("a stalled 402 body: the copy gives up after timeoutMs, so a client cancel reaches the source", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const timeoutMs = 200;
  let sourceCancelled = false;
  const app = new Hono();
  app.use(analytics({ log: true, timeoutMs }));
  app.get(
    "/",
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"x402'));
          },
          pull() {
            return new Promise<void>(() => {}); // never yields again
          },
          cancel() {
            sourceCancelled = true;
          },
        }),
        { status: 402 },
      ),
  );
  const { ctx, promises } = fakeCtx();
  const res = await app.request("/", undefined, {}, ctx);
  let cancelled = false;
  void (res.body as ReadableStream).cancel().then(() => {
    cancelled = true;
  });
  await settleWithin(promises, timeoutMs + 500);
  await waitFor(() => sourceCancelled && cancelled, 500);
  const line = log.mock.calls.find((c) => c.arguments[0] === "op8x.analytics");
  assert.ok(line, "a record was still written");
  assert.equal((JSON.parse(String(line.arguments[1])) as AnalyticsRecord).challenge?.location, "none");
});

test("a non-byte chunk in a 402 body ends the copy", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  let pulls = 0;
  const app = new Hono();
  app.use(analytics({ log: true }));
  app.get(
    "/",
    () =>
      new Response(
        new ReadableStream<unknown>(
          {
            pull(controller) {
              pulls++;
              if (pulls === 1) controller.enqueue("not bytes");
              else if (pulls === 2) controller.enqueue(new TextEncoder().encode(JSON.stringify(v1Challenge)));
              else controller.close();
            },
          },
          { highWaterMark: 0 },
        ) as ReadableStream<Uint8Array>,
        { status: 402 },
      ),
  );
  const { ctx, promises } = fakeCtx();
  const res = await app.request("/", undefined, {}, ctx);
  await settleWithin(promises, 1000);
  await (res.body as ReadableStream).cancel();
  const line = log.mock.calls.find((c) => c.arguments[0] === "op8x.analytics");
  assert.ok(line, "a record was still written");
  assert.equal((JSON.parse(String(line.arguments[1])) as AnalyticsRecord).challenge?.location, "none");
});

/**
 * Simulates a request object from a second hono copy: same public API, but without this copy's
 * module-private Symbol that `matchedRoutes` from "hono/route" reads. `hide` also removes
 * named public members (for the case where the deprecated getter is gone as well).
 */
function foreignRequest(hide: string[] = []): MiddlewareHandler {
  return async (c, next) => {
    const real = c.req;
    const proxy = new Proxy(real, {
      get(target, prop) {
        if (typeof prop === "symbol" || hide.includes(prop)) return undefined;
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, value, target);
      },
    });
    Object.defineProperty(c, "req", { value: proxy, configurable: true });
    await next();
  };
}

test("route falls back to the request's own matchedRoutes when hono/route cannot read it", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const app = new Hono();
  app.use(foreignRequest());
  app.use(analytics({ log: true }));
  app.get("/items/:id", (c) => c.text(`item ${c.req.param("id")}`));
  assert.equal((await routeOf(app, "/items/7")).route, "/items/:id");
  assert.equal(warn.mock.callCount(), 0);
});

test("route unavailable both ways: empty route and one warning", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const app = new Hono();
  app.use(foreignRequest(["matchedRoutes"]));
  app.use(analytics({ log: true }));
  app.get("/items/:id", (c) => c.text("item"));
  assert.equal((await routeOf(app, "/items/7")).route, "");
  assert.equal((await routeOf(app, "/items/8")).route, "");
  const unavailable = warn.mock.calls.filter(
    (c) => c.arguments[0] === "op8x.analytics: route unavailable (duplicate hono copy?)",
  );
  assert.equal(unavailable.length, 1);
  assert.equal(warn.mock.callCount(), 1);
});

for (const chainCheck of [undefined, false, true]) {
  test(`chainCheck ${String(chainCheck)}: receipt transaction ${chainCheck === true ? "included" : "omitted"}`, async () => {
    const collector = await startCollector("ok");
    try {
      const options: AnalyticsOptions = { endpoint: collector.url };
      if (chainCheck !== undefined) options.chainCheck = chainCheck;
      const app = buildApp(analytics(options));
      const { ctx, promises } = fakeCtx();
      await app.request("/paid", { headers: { "PAYMENT-SIGNATURE": b64(v2Payment) } }, {}, ctx);
      await settleWithin(promises, 3000);
      assert.equal(collector.records.length, 1);
      assert.equal(collector.records[0]?.receipt?.success, true);
      const raw = JSON.stringify(collector.requests);
      if (chainCheck === true) {
        assert.equal(collector.records[0]?.receipt?.transaction, TX);
      } else {
        assert.equal(collector.records[0]?.receipt?.transaction, undefined);
        assert.ok(!raw.includes(TX), "transaction hash sent without chainCheck");
      }
    } finally {
      await collector.close();
    }
  });
}

const disabled: Array<[string, () => MiddlewareHandler]> = [
  ["no endpoint and no log", () => analytics({})],
  [
    "failed setup",
    () =>
      analytics({
        get endpoint(): string {
          throw new Error("hostile options");
        },
      } as unknown as AnalyticsOptions),
  ],
];

for (const [name, make] of disabled) {
  test(`disabled middleware (${name}) does not return next()'s value into a non-finalized context`, async (t) => {
    t.mock.method(console, "warn", () => {});
    const build = (mw?: MiddlewareHandler) => {
      const app = new Hono();
      app.use(async (c, next) => {
        await next();
        if (!c.finalized) c.res = new Response("fallback", { status: 503 });
      });
      if (mw) app.use(mw);
      app.use(async (c) => {
        c.status(201);
      });
      return app;
    };
    const expected = await snapshot(await build().request("/"));
    const actual = await snapshot(await build(make()).request("/"));
    assert.deepEqual(actual, expected);
  });
}

test("invalid endpoint without log takes the idle path: one warning, no snapshot, no background work", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const mw = analytics({ endpoint: "ftp://collector.example/x" });
  const plain = buildApp(undefined);
  const app = buildApp(mw);
  const { ctx, promises } = fakeCtx();
  const cloned = t.mock.method(Response.prototype, "clone");
  for (const path of ["/json", "/json", "/items/abc123"]) {
    const expected = await snapshot(await plain.request(path));
    const actual = await snapshot(await app.request(path, undefined, {}, ctx));
    assert.deepEqual(actual, expected);
  }
  assert.equal(promises.length, 0);
  assert.equal(cloned.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /invalid endpoint/);
});

test("per-request analytics() instances warn once per isolate", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  const app = new Hono();
  app.use(async (c, next) => analytics({ salt: "", log: true })(c, next));
  app.get("/json", (c) => c.json({ ok: true }));
  const { ctx, promises } = fakeCtx();
  for (let i = 0; i < 100; i++) await app.request("/json", undefined, {}, ctx);
  await settleWithin(promises, 3000);
  const salted = warn.mock.calls.filter((c) => String(c.arguments[0]).includes("salt must be"));
  assert.equal(salted.length, 1);
  assert.equal(warn.mock.callCount(), 1);
});

test("per-request idle and setup-failure instances warn once per isolate", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const hostile = {
    get endpoint(): string {
      throw new Error("hostile options");
    },
  } as unknown as AnalyticsOptions;
  const app = new Hono();
  app.use(async (c, next) => analytics({})(c, next));
  app.use(async (c, next) => analytics(hostile)(c, next));
  app.get("/json", (c) => c.json({ ok: true }));
  for (let i = 0; i < 20; i++) await app.request("/json");
  assert.equal(warn.mock.callCount(), 2);
});
