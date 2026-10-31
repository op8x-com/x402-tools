import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanReason, decodeHeader, extract, officialClientRead, withBrowserView } from "../src/extract.ts";
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
  assert.equal(e.official.readable, true);
});

test("v1 challenge in body", () => {
  const e = extract(pr("GET", 402, {}, v1));
  assert.equal(e.location, "body");
  assert.equal(e.version, 1);
  assert.equal(e.official.readable, true);
});

test("v2 challenge only in body is unreadable for the official client", () => {
  const e = extract(pr("GET", 402, {}, v2));
  assert.equal(e.location, "body");
  assert.equal(e.version, 2);
  assert.equal(e.official.readable, false);
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
  assert.equal(e.official.readable, false);
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

test("bodyText that still starts with a BOM (a double BOM on the wire) is not parsed", () => {
  // The decoder in probe drops one BOM, like @x402/fetch; a second one makes JSON.parse fail there too.
  const e = extract({ ...pr("GET", 402, {}), bodyText: "\uFEFF" + JSON.stringify(v1) });
  assert.equal(e.location, "none");
  assert.equal(e.body, undefined);
  assert.equal(e.official.readable, false);
});

test("decodeHeader rejects base64 with wrong padding, like atob", () => {
  assert.equal(decodeHeader("eyJhIjoxfQ=").error, "not-base64");
});

test("decodeHeader drops a BOM in the decoded text, like TextDecoder", () => {
  const raw = Buffer.from("\uFEFF" + JSON.stringify(v2), "utf8").toString("base64");
  assert.deepEqual(decodeHeader(raw).value, v2);
});

test("extract keeps the probe's headers", () => {
  const e = extract(pr("GET", 402, { "payment-required": "", "x-other": "1" }, v1));
  assert.equal(e.headers["payment-required"], "");
  assert.equal(e.headers["x-other"], "1");
});

test("empty header with v1 body: treated as absent, readable", () => {
  const e = extract(pr("GET", 402, { "payment-required": "" }, v1));
  assert.equal(e.headerEmpty, true);
  assert.equal(e.headerRaw, undefined);
  assert.equal(e.headerError, undefined);
  assert.equal(e.location, "body");
  assert.equal(e.official.readable, true);
});

test("empty header without body: no challenge, not readable", () => {
  const e = extract(pr("GET", 402, { "payment-required": "" }));
  assert.equal(e.location, "none");
  assert.equal(e.official.readable, false);
  assert.ok(!e.official.readable && e.official.reason.length > 0);
});

test("base64url header: official reason names the header", () => {
  const e = extract(pr("GET", 402, { "payment-required": "eyJh-_" }, {}));
  assert.ok(!e.official.readable && e.official.reason.includes("Invalid payment required header"));
});

test("base64 header that is not JSON: not readable with a reason", () => {
  const e = extract(pr("GET", 402, { "payment-required": Buffer.from("hello").toString("base64") }, {}));
  assert.ok(!e.official.readable && e.official.reason.length > 0);
});

test("wrong padding: not-base64 and not readable", () => {
  const e = extract(pr("GET", 402, { "payment-required": "eyJhIjoxfQ=" }, {}));
  assert.equal(e.headerError, "not-base64");
  assert.equal(e.official.readable, false);
});

test("BOM inside the header: decoded and readable", () => {
  const raw = Buffer.from("\uFEFF" + JSON.stringify(v2), "utf8").toString("base64");
  const e = extract(pr("GET", 402, { "payment-required": raw }, {}));
  assert.equal(e.headerError, undefined);
  assert.equal(e.version, 2);
  assert.equal(e.official.readable, true);
});

test("header that decodes to a non-object is not readable", () => {
  const e = extract(pr("GET", 402, { "payment-required": b64(42) }, {}));
  assert.deepEqual(e.official, { readable: false, reason: "challenge is not a JSON object" });
});

test("cleanReason strips unsafe characters, a trailing period, and caps the length", () => {
  assert.equal(cleanReason(new Error("bad\u0000\u007f\u0085\u200b\u202e\u2028 value.")), "bad value");
  assert.equal(cleanReason(new Error("x".repeat(300))).length, 200);
  assert.equal(cleanReason(new Error("")), "unknown error");
  assert.equal(cleanReason("thrown string"), "unknown error");
  assert.equal(cleanReason(undefined), "unknown error");
});

test("cleanReason removes a lone surrogate", () => {
  assert.equal(cleanReason(new Error("a\ud800b")), "ab");
});

test("cleanReason caps by code points and never splits a surrogate pair", () => {
  const out = cleanReason(new Error("\u{1F600}".repeat(300)));
  assert.equal(Array.from(out).length, 200);
  assert.equal(out, "\u{1F600}".repeat(200));
});

test("cleanReason turns a whitespace-only message into unknown error", () => {
  assert.equal(cleanReason(new Error("   ")), "unknown error");
});

test("a body error with a valid header: the official client is not readable", () => {
  const p = { ...pr("GET", 402, { "payment-required": b64(v2) }), bodyError: "http response body too large: limit 1048576 bytes" };
  const e = extract(p);
  assert.deepEqual(e.official, { readable: false, reason: "http response body too large: limit 1048576 bytes" });
  assert.equal(e.body, undefined);
  assert.equal(e.bodyError, p.bodyError);
});

test("officialClientRead passes a body error through cleanReason before reading", () => {
  const out = officialClientRead({ headers: { "payment-required": b64(v2) }, body: undefined, bodyError: "terminated\u0000." });
  assert.deepEqual(out, { readable: false, reason: "terminated" });
});

test("header that decodes to null is the challenge, as in the official client; the body is ignored", () => {
  const e = extract(pr("GET", 402, { "payment-required": b64(null) }, v1));
  assert.equal(e.challenge, null);
  assert.equal(e.version, undefined);
  assert.equal(e.official.readable, false);
});

test("withBrowserView takes the challenge and version of the repeat", () => {
  const plain = extract(pr("GET", 402, { "payment-required": b64(v2) }, {}));
  const e = withBrowserView(plain, pr("GET", 402, {}, v1));
  assert.deepEqual(e.originChallenge, v1);
  assert.equal(e.originVersion, 1);
});

test("withBrowserView leaves both unset when the repeat has no challenge", () => {
  const plain = extract(pr("GET", 402, { "payment-required": b64(v2) }, {}));
  const e = withBrowserView(plain, pr("GET", 403, {}, { error: "no" }));
  assert.equal("originChallenge" in e, false);
  assert.equal("originVersion" in e, false);
});
