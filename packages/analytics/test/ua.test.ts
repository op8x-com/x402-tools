import { test } from "node:test";
import assert from "node:assert/strict";
import { uaClass } from "../src/ua.ts";

const cases: Array<[string | null | undefined, string]> = [
  ["op8x-analytics/0.0.1", "op8x"],
  ["OP8X-check x402", "op8x"],
  ["x402-fetch/2.0 node", "x402-client"],
  ["axios/1.7.0", "axios"],
  ["python-requests/2.32", "python"],
  ["Go-http-client/2.0", "go"],
  ["curl/8.5.0", "curl"],
  ["Mozilla/5.0 (X11; Linux) AppleWebKit", "browser"],
  ["node", "node"],
  ["undici", "node"],
  ["", "none"],
  [null, "none"],
  [undefined, "none"],
  ["   ", "none"],
  ["SomethingElse/1.0", "other"],
];

for (const [header, expected] of cases) {
  test(`uaClass(${JSON.stringify(header)}) = ${expected}`, () => {
    assert.equal(uaClass(header), expected);
  });
}

test("uaClass follows the documented order", () => {
  assert.equal(uaClass("Mozilla/5.0 curl"), "curl");
  assert.equal(uaClass("axios node"), "axios");
  assert.equal(uaClass("python-httpx node"), "python");
});
