import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKey, isKey, keyFingerprint, keyHash } from "../src/account/keys.ts";

test("fixed test vector: hash and fingerprint over the whole key including the prefix", () => {
  // Built at runtime so no finished key string sits in a file.
  const key = "op8x_r_" + "A".repeat(43);
  assert.equal(keyHash(key), "c9d341695c847c4d00d6489d62a3e3a047ff5d1e98efd6f7b305cf3a2aa04867");
  assert.equal(keyFingerprint(key), "c9d34169");
});

test("generated keys have the prefix and 43 base64url characters from 32 bytes", () => {
  for (const kind of ["w", "r", "d"] as const) {
    const key = generateKey(kind);
    assert.match(key, new RegExp(`^op8x_${kind}_[A-Za-z0-9_-]{43}$`));
    assert.equal(key.length, 7 + 43);
    assert.equal(isKey(key, kind), true);
    assert.equal(Buffer.from(key.slice(7), "base64url").length, 32);
  }
});

test("generated keys differ", () => {
  const seen = new Set(Array.from({ length: 50 }, () => generateKey("w")));
  assert.equal(seen.size, 50);
});

test("isKey checks kind, length and alphabet", () => {
  const body = "B".repeat(43);
  assert.equal(isKey("op8x_w_" + body, "w"), true);
  assert.equal(isKey("op8x_w_" + body, "r"), false);
  assert.equal(isKey("op8x_w_" + body.slice(1), "w"), false);
  assert.equal(isKey("op8x_w_" + body + "B", "w"), false);
  assert.equal(isKey("op8x_w_" + body.slice(1) + "+", "w"), false);
  assert.equal(isKey("op8x_w_" + body + "\n", "w"), false);
  assert.equal(isKey(42, "w"), false);
});

test("hash is lowercase hex of SHA-256 and fingerprint its first 8 characters", () => {
  const key = generateKey("d");
  assert.match(keyHash(key), /^[0-9a-f]{64}$/);
  assert.equal(keyFingerprint(key), keyHash(key).slice(0, 8));
});
