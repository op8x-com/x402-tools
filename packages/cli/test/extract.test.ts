import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeHeader, extract, officialClientCanRead } from "../src/extract.ts";
import { b64, pr, v1, v2 } from "./fixtures.ts";

test("decodeHeader decodes standard base64 JSON", () => {
  assert.deepEqual(decodeHeader(b64(v2)).value, v2);
});

test("decodeHeader rejects base64url characters", () => {
  assert.equal(decodeHeader("eyJh-_").error, "not-base64");
});

test("decodeHeader rejects whitespace", () => {
  assert.equal(decodeHeader("eyJh Ijox").error, "not-base64");
});

test("decodeHeader rejects base64 that is not JSON", () => {
  assert.equal(decodeHeader(Buffer.from("hello").toString("base64")).error, "not-json");
});

test("v2 challenge in header", () => {
  const e = extract(pr("GET", 402, { "payment-required": b64(v2) }, {}));
  assert.equal(e.location, "header");
  assert.equal(e.version, 2);
  assert.deepEqual(e.challenge, v2);
  assert.equal(officialClientCanRead(e), true);
});

test("v1 challenge in body", () => {
  const e = extract(pr("GET", 402, {}, v1));
  assert.equal(e.location, "body");
  assert.equal(e.version, 1);
  assert.equal(officialClientCanRead(e), true);
});

test("v2 challenge only in body is unreadable for the official client", () => {
  const e = extract(pr("GET", 402, {}, v2));
  assert.equal(e.location, "body");
  assert.equal(e.version, 2);
  assert.equal(officialClientCanRead(e), false);
});

test("challenge in header and body", () => {
  const e = extract(pr("GET", 402, { "payment-required": b64(v2) }, v2));
  assert.equal(e.location, "both");
  assert.deepEqual(e.header, e.bodyChallenge);
});

test("broken header counts as header location and is unreadable", () => {
  const e = extract(pr("GET", 402, { "payment-required": "not base64!" }, {}));
  assert.equal(e.location, "header");
  assert.equal(e.headerError, "not-base64");
  assert.equal(officialClientCanRead(e), false);
});

test("empty JSON body is not a challenge", () => {
  const e = extract(pr("GET", 402, {}, {}));
  assert.equal(e.location, "none");
  assert.equal(e.challenge, undefined);
});

test("string version is not recognised as a version", () => {
  const e = extract(pr("GET", 402, { "payment-required": b64({ ...v2, x402Version: "2" }) }));
  assert.equal(e.version, undefined);
});

test("copies status, cache-control, location and network error", () => {
  const e = extract({ ...pr("GET", 302, { "cache-control": "no-store", location: "/x" }) });
  assert.equal(e.status, 302);
  assert.equal(e.cacheControl, "no-store");
  assert.equal(e.redirectTo, "/x");
  const failed = extract({ method: "GET", url: "u", headers: {}, bodyText: "", ms: 1, error: "boom" });
  assert.equal(failed.error, "boom");
});

test("extract keeps the CORS response headers", () => {
  const e = extract(
    pr("GET", 402, {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "PAYMENT-REQUIRED",
      "access-control-allow-credentials": "true",
    }),
  );
  assert.equal(e.allowOrigin, "*");
  assert.equal(e.exposeHeaders, "PAYMENT-REQUIRED");
  assert.equal(e.allowCredentials, "true");
});

test("body with a leading UTF-8 BOM is parsed like fetch().json() does", () => {
  const e = extract({ ...pr("GET", 402, {}), bodyText: "﻿" + JSON.stringify(v1) });
  assert.equal(e.location, "body");
  assert.equal(e.version, 1);
  assert.deepEqual(e.bodyChallenge, v1);
});
