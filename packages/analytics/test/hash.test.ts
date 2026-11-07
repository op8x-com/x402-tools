import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PAYER_ALG, SALT_PREFIX, hashPayer, parseSalt, saltId, trimAscii } from "../src/hash.ts";

interface Vectors {
  alg: string;
  salts: { salt: string; salt_bytes_hex: string; salt_id: string; payers: { note: string; address: string; payer: string }[] }[];
  invalid_salts: { note: string; salt: unknown }[];
}
const vectors = JSON.parse(readFileSync(new URL("../docs/payer-hash-vectors.json", import.meta.url), "utf8")) as Vectors;

const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const VALID = vectors.salts[0]!.salt;

test("constants", () => {
  assert.equal(PAYER_ALG, "op8x.payer.v1");
  assert.equal(SALT_PREFIX, "op8x_s_");
  assert.equal(vectors.alg, PAYER_ALG);
});

for (const v of vectors.salts) {
  test(`vectors: salt ${v.salt_id}`, async () => {
    const bytes = parseSalt(v.salt);
    assert.ok(bytes !== undefined);
    assert.equal(bytes.length, 32);
    assert.equal(toHex(bytes), v.salt_bytes_hex);
    assert.equal(await saltId(bytes), v.salt_id);
    for (const p of v.payers) {
      assert.equal(await hashPayer(bytes, p.address), p.payer, p.note);
    }
  });
}

test("vectors: independent node:crypto recomputation", async () => {
  for (const v of vectors.salts) {
    const bytes = Buffer.from(v.salt_bytes_hex, "hex");
    assert.equal(createHmac("sha256", bytes).update("op8x.salt-id.v1").digest("hex").slice(0, 8), v.salt_id);
    for (const p of v.payers) {
      const a = p.address.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
      const n = /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a;
      const mac = createHmac("sha256", bytes).update(Buffer.concat([Buffer.from("op8x.payer.v1"), Buffer.from([0]), Buffer.from(n)]));
      assert.equal(mac.digest("hex").slice(0, 32), p.payer);
    }
  }
});

for (const inv of vectors.invalid_salts) {
  test(`invalid salt from vectors: ${inv.note}`, () => {
    assert.equal(parseSalt(inv.salt), undefined);
  });
}

const body = VALID.slice(SALT_PREFIX.length);
const extra: [string, unknown][] = [
  ["no prefix", body],
  ["42 characters", SALT_PREFIX + body.slice(0, 42)],
  ["44 characters", SALT_PREFIX + body + "A"],
  ["plus sign", SALT_PREFIX + "+" + body.slice(1)],
  ["slash", SALT_PREFIX + "/" + body.slice(1)],
  ["leading space", ` ${VALID}`],
  ["trailing newline", `${VALID}\n`],
  ["inner space", `${SALT_PREFIX} ${body.slice(1)}`],
  ["padding", SALT_PREFIX + body.slice(0, 42) + "="],
  ["number", 5],
  ["null", null],
  ["undefined", undefined],
  ["object", {}],
  ["array", [VALID]],
  ["Uint8Array", new Uint8Array(32)],
  ["__proto__ string", "__proto__"],
  ["object with __proto__", JSON.parse('{"__proto__": {"x": 1}}') as unknown],
  ["object with toString", { toString: () => VALID }],
];
for (const [name, value] of extra) {
  test(`parseSalt rejects ${name}`, () => {
    assert.equal(parseSalt(value), undefined);
  });
}

test("parseSalt accepts a url-safe salt with - and _", () => {
  const bytes = new Uint8Array(32).fill(0xfb);
  const s = SALT_PREFIX + Buffer.from(bytes).toString("base64url");
  assert.match(s, /[-_]/);
  assert.deepEqual(parseSalt(s), bytes);
});

test("an error from hashPayer never contains the salt", async () => {
  const bytes = parseSalt(VALID)!;
  try {
    await hashPayer(bytes, undefined as unknown as string);
    assert.fail("expected a throw");
  } catch (e) {
    assert.ok(!String(e instanceof Error ? e.stack : e).includes(VALID));
    assert.ok(!String(e instanceof Error ? e.stack : e).includes(body));
  }
});

test("parseSalt returns a copy-safe fresh array each time", () => {
  const a = parseSalt(VALID)!;
  a[0] = 99;
  assert.equal(parseSalt(VALID)![0], 0);
});

test("hashPayer: 32 lowercase hex, case-insensitive for EVM, case-sensitive otherwise", async () => {
  const salt = parseSalt(VALID)!;
  const evm = "0xAbC0000000000000000000000000000000000001";
  const a = await hashPayer(salt, evm);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(await hashPayer(salt, evm.toLowerCase()), a);
  assert.equal(await hashPayer(salt, `  ${evm}\t`), a);
  assert.notEqual(await hashPayer(salt, "abc"), await hashPayer(salt, "ABC"));
});

test("hashPayer strips only ASCII whitespace at both ends", async () => {
  const salt = parseSalt(VALID)!;
  const sol = "9wzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const plain = await hashPayer(salt, sol);
  for (const ws of [" ", "\t", "\n", "\r", "\f", "\v", " \t\n\r\f\v"]) {
    assert.equal(await hashPayer(salt, `${ws}${sol}${ws}`), plain, JSON.stringify(ws));
  }
  // Not stripped: no-break space, em space, BOM, line separator, NEL.
  for (const code of [0x00a0, 0x2003, 0xfeff, 0x2028, 0x0085]) {
    const ch = String.fromCharCode(code);
    assert.notEqual(await hashPayer(salt, `${ch}${sol}`), plain, `leading U+${code.toString(16)}`);
    assert.notEqual(await hashPayer(salt, `${sol}${ch}`), plain, `trailing U+${code.toString(16)}`);
  }
  // Inner whitespace is kept.
  assert.notEqual(await hashPayer(salt, "9wzD XwBb"), await hashPayer(salt, "9wzDXwBb"));
});

test("different salts give different pseudonyms and ids", async () => {
  const s1 = parseSalt(vectors.salts[0]!.salt)!;
  const s2 = parseSalt(vectors.salts[1]!.salt)!;
  assert.notEqual(await saltId(s1), await saltId(s2));
  assert.notEqual(await hashPayer(s1, "x"), await hashPayer(s2, "x"));
});

test("trimAscii is linear: long inner whitespace runs do not blow up", () => {
  for (const ws of [" ", "\t"]) {
    const value = "a" + ws.repeat(16000) + "a";
    const start = performance.now();
    for (let i = 0; i < 5; i++) assert.equal(trimAscii(value), value);
    assert.ok(performance.now() - start < 250, "five calls under 250 ms");
  }
  assert.equal(trimAscii(" \t\n\r\f\v" + "a b" + " \t\n\r\f\v"), "a b");
  assert.equal(trimAscii(" \t "), "");
  assert.equal(trimAscii(""), "");
  assert.equal(trimAscii("\u00a0a\u00a0"), "\u00a0a\u00a0");
});

test("the README command for a salt by hand makes a valid salt, and a trailing newline makes it invalid", () => {
  // The same command as in the README and in apps/demo-api/README.md.
  const cmd = "console.log('op8x_s_' + require('node:crypto').randomBytes(32).toString('base64url'))";
  const out = execFileSync(process.execPath, ["-e", cmd], { encoding: "utf8" });
  assert.ok(out.endsWith("\n"));
  const salt = out.slice(0, -1);
  assert.ok(parseSalt(salt) !== undefined, salt.length + " characters");
  assert.equal(parseSalt(out), undefined);
});
