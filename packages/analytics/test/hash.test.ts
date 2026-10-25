import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { hashPayer } from "../src/hash.ts";

const addr = "0xAbC0000000000000000000000000000000000001";

test("hashPayer returns 32 lowercase hex chars", async () => {
  assert.match(await hashPayer("salt", addr), /^[0-9a-f]{32}$/);
});

test("same salt and address in any case give the same hash", async () => {
  const a = await hashPayer("salt", addr);
  assert.equal(await hashPayer("salt", addr.toLowerCase()), a);
  assert.equal(await hashPayer("salt", `  ${addr.toUpperCase()} `), a);
});

test("different salt or address gives a different hash", async () => {
  const a = await hashPayer("salt", addr);
  assert.notEqual(await hashPayer("other", addr), a);
  assert.notEqual(await hashPayer("salt", "0x0000000000000000000000000000000000000002"), a);
});

test("matches node:crypto HMAC-SHA-256 truncated to 32 hex chars", async () => {
  const expected = createHmac("sha256", "key").update("the quick brown fox").digest("hex").slice(0, 32);
  assert.equal(await hashPayer("key", "The Quick Brown Fox"), expected);
});
