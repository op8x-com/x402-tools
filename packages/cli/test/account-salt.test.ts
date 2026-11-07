import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isSalt, newSalt } from "../src/account/salt.ts";

// The public test vectors of the analytics module, read as data: the CLI must accept exactly the
// salts the module accepts, without importing the module's source.
const vectors = JSON.parse(readFileSync(new URL("../../analytics/docs/payer-hash-vectors.json", import.meta.url), "utf8")) as {
  salts: { salt: string }[];
  invalid_salts: { note: string; salt: string }[];
};

test("newSalt gives 1,000 valid, canonical and distinct salts of 32 bytes", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const salt = newSalt();
    assert.match(salt, /^op8x_s_[A-Za-z0-9_-]{43}$/);
    const bytes = Buffer.from(salt.slice(7), "base64url");
    assert.equal(bytes.length, 32);
    assert.equal(bytes.toString("base64url"), salt.slice(7), "canonical");
    assert.equal(isSalt(salt), true);
    seen.add(salt);
  }
  assert.equal(seen.size, 1000);
});

test("isSalt accepts the valid salts of the public test vectors", () => {
  assert.ok(vectors.salts.length >= 2);
  for (const v of vectors.salts) assert.equal(isSalt(v.salt), true, v.salt.length.toString());
});

test("isSalt rejects every invalid salt of the public test vectors", () => {
  assert.ok(vectors.invalid_salts.length > 0);
  for (const v of vectors.invalid_salts) assert.equal(isSalt(v.salt), false, v.note);
});

test("isSalt rejects values that are no string", () => {
  for (const v of [null, undefined, 42, {}, [], Buffer.alloc(32)]) assert.equal(isSalt(v), false);
});
