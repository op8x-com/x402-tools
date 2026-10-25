import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, decodeBase64Json, parseJson } from "../src/decode.ts";
import { b64, v1Challenge, v2Challenge } from "./fixtures.ts";

test("decodeBase64Json decodes a v2 challenge", () => {
  assert.deepEqual(decodeBase64Json(b64(v2Challenge)), v2Challenge);
});

test("decodeBase64Json decodes a v1 challenge", () => {
  assert.deepEqual(decodeBase64Json(b64(v1Challenge)), v1Challenge);
});

test("decodeBase64Json rejects base64url characters", () => {
  assert.equal(decodeBase64Json("eyJh-_"), undefined);
});

test("decodeBase64Json rejects whitespace", () => {
  assert.equal(decodeBase64Json("eyJh Ijox"), undefined);
  assert.equal(decodeBase64Json(b64({ a: 1 }) + "\n"), undefined);
});

test("decodeBase64Json rejects invalid UTF-8", () => {
  const bad = btoa(String.fromCharCode(0x7b, 0xff, 0xfe, 0x7d));
  assert.equal(decodeBase64Json(bad), undefined);
});

test("decodeBase64Json rejects non-object JSON", () => {
  assert.equal(decodeBase64Json(b64([])), undefined);
  assert.equal(decodeBase64Json(b64("x")), undefined);
  assert.equal(decodeBase64Json(b64(1)), undefined);
  assert.equal(decodeBase64Json(b64(null)), undefined);
});

test("decodeBase64Json handles null, undefined, empty and malformed padding", () => {
  assert.equal(decodeBase64Json(null), undefined);
  assert.equal(decodeBase64Json(undefined), undefined);
  assert.equal(decodeBase64Json(""), undefined);
  assert.equal(decodeBase64Json("abc"), undefined);
});

test("decodeBase64Json returns undefined for 1 MB input without decoding", () => {
  const original = globalThis.atob;
  let called = false;
  globalThis.atob = ((s: string) => {
    called = true;
    return original(s);
  }) as typeof atob;
  try {
    assert.equal(decodeBase64Json("A".repeat(1024 * 1024)), undefined);
  } finally {
    globalThis.atob = original;
  }
  assert.equal(called, false);
});

test("decodeBase64Json honours a custom maxBytes", () => {
  const value = b64({ a: "x".repeat(100) });
  assert.equal(decodeBase64Json(value, 50), undefined);
  assert.ok(decodeBase64Json(value, 1000));
});

test("parseJson does not pollute Object.prototype", () => {
  const parsed = parseJson('{"__proto__":{"x":1}}');
  assert.ok(parsed);
  assert.equal(({} as Record<string, unknown>).x, undefined);
  assert.equal((Object.prototype as Record<string, unknown>).x, undefined);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(parsed.x, undefined);
});

test("parseJson rejects invalid JSON and non-objects", () => {
  assert.equal(parseJson("{"), undefined);
  assert.equal(parseJson("[]"), undefined);
  assert.equal(parseJson('"x"'), undefined);
  assert.equal(parseJson("1"), undefined);
  assert.equal(parseJson("null"), undefined);
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
});

test("clean strips control characters", () => {
  assert.equal(clean("\u001b[31mred\u001b[0m"), "[31mred[0m");
  assert.equal(clean("a\u0000b\u0085c\u009fd\u007fe"), "abcde");
});

test("clean trims, caps length, and rejects non-strings and empties", () => {
  assert.equal(clean("  hi  "), "hi");
  assert.equal(clean("x".repeat(500))?.length, 128);
  assert.equal(clean("x".repeat(500), 256)?.length, 256);
  assert.equal(clean(""), undefined);
  assert.equal(clean("   "), undefined);
  assert.equal(clean("\u001b\u0000"), undefined);
  assert.equal(clean(5), undefined);
  assert.equal(clean(null), undefined);
  assert.equal(clean({}), undefined);
});
