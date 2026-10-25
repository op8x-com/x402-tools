import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN, preflight, probe } from "../src/probe.ts";
import { startServer } from "./server.ts";

let server: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server.close();
});

const opts = { timeoutMs: 5000, version: "0.0.1" };

test("collects status, lower-cased headers and body", async () => {
  const r = await probe(`${server.url}/v2-good`, "GET", opts);
  assert.equal(r.status, 402);
  assert.ok(r.headers["payment-required"]);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.bodyText, "{}");
  assert.equal(r.error, undefined);
});

test("sends user-agent, accept, and JSON body on POST, never payment headers", async () => {
  const r = await probe(`${server.url}/echo-headers`, "POST", opts);
  const echoed = JSON.parse(r.bodyText);
  assert.equal(echoed.method, "POST");
  assert.equal(echoed.headers["user-agent"], "op8x-cli/0.0.1 (+https://op8x.com)");
  assert.equal(echoed.headers["accept"], "application/json");
  assert.equal(echoed.headers["content-type"], "application/json");
  assert.equal(echoed.headers["x-payment"], undefined);
  assert.equal(echoed.headers["payment-signature"], undefined);
});

test("does not follow redirects", async () => {
  const r = await probe(`${server.url}/redirect`, "GET", opts);
  assert.equal(r.status, 302);
  assert.equal(r.headers["location"], "/v2-good");
});

test("network error becomes a result, not an exception", async () => {
  const r = await probe("http://127.0.0.1:9/", "GET", opts);
  assert.equal(r.status, undefined);
  assert.ok(r.error);
});

test("timeout becomes a readable error", async () => {
  const hanging: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  const r = await probe("https://example.invalid/", "GET", { timeoutMs: 50, version: "0.0.1", fetchImpl: hanging });
  assert.equal(r.error, "Timed out after 0.05 s");
});

test("sends an Origin header so CORS servers answer as they would to a browser", async () => {
  const r = await probe(`${server.url}/echo-headers`, "GET", opts);
  assert.equal(JSON.parse(r.bodyText).headers["origin"], ORIGIN);
});

test("preflight sends OPTIONS with Origin and the requested method and headers", async () => {
  const r = await preflight(`${server.url}/echo-preflight`, "POST", "payment-signature,content-type", opts);
  assert.equal(r.method, "OPTIONS");
  assert.equal(r.status, 204);
  assert.equal(r.requestMethod, "POST");
  assert.equal(r.requestHeaders, "payment-signature,content-type");
  assert.equal(r.headers["x-echo-method"], "OPTIONS");
  assert.equal(r.headers["x-echo-origin"], ORIGIN);
  assert.equal(r.headers["x-echo-acrm"], "POST");
  assert.equal(r.headers["x-echo-acrh"], "payment-signature,content-type");
});

test("preflight network error becomes a result", async () => {
  const r = await preflight("http://127.0.0.1:9/", "GET", "payment-signature", opts);
  assert.ok(r.error);
});
