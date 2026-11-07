import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRecord, type RecordInput } from "../src/record.ts";
import { hashPayer, parseSalt, saltId } from "../src/hash.ts";
import type { PayerHasher } from "../src/types.ts";
import {
  b64,
  PAYER,
  TX,
  v1Challenge,
  v1Payment,
  v1Receipt,
  v2Challenge,
  v2Payment,
  v2Receipt,
} from "./fixtures.ts";

type Over = Partial<RecordInput> & { req?: Record<string, string>; res?: Record<string, string> };

function input(over: Over = {}): RecordInput {
  const { req, res, ...rest } = over;
  return {
    id: "id-1",
    ts: "2026-10-25T10:00:00.000Z",
    ms: 12,
    method: "GET",
    route: "/posts/:id",
    status: 200,
    requestHeaders: new Headers(req ?? {}),
    responseHeaders: new Headers(res ?? {}),
    ...rest,
  };
}

const fakeHash: PayerHasher = { hash: async (a: string) => `h(${a})`, saltId: "abcd1234" };

test("type table and base fields", async () => {
  const unpaid = await buildRecord(input({ req: { "user-agent": "curl/8" } }));
  assert.equal(unpaid.type, "request.unpaid");
  assert.equal(unpaid.v, 1);
  assert.equal(unpaid.ua, "curl");
  assert.equal(unpaid.route, "/posts/:id");
  assert.equal(unpaid.challenge, undefined);
  assert.equal(unpaid.payment, undefined);
  assert.equal(unpaid.delivery, undefined);

  const challenge = await buildRecord(input({ status: 402 }));
  assert.equal(challenge.type, "challenge.issued");
  assert.deepEqual(challenge.challenge, { location: "none" });

  for (const status of [200, 402, 500]) {
    const paid = await buildRecord(input({ status, req: { "payment-signature": b64(v2Payment) } }));
    assert.equal(paid.type, "payment.received");
  }
  const legacy = await buildRecord(input({ req: { "x-payment": b64(v1Payment) } }));
  assert.equal(legacy.type, "payment.received");
});

test("challenge v2 header", async () => {
  const r = await buildRecord(input({ status: 402, res: { "payment-required": b64(v2Challenge) } }));
  assert.deepEqual(r.challenge, {
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
});

test("challenge v1 body, amount from maxAmountRequired", async () => {
  const r = await buildRecord(input({ status: 402, body: JSON.stringify(v1Challenge) }));
  assert.equal(r.challenge?.location, "body");
  assert.equal(r.challenge?.version, 1);
  assert.equal(r.challenge?.accepts?.[0]?.amount, "1000");
  assert.equal(r.challenge?.accepts?.[0]?.network, "base-sepolia");
  assert.equal(r.challenge?.drift, undefined);
});

test("challenge both: drift false when equal regardless of key order, true when different", async () => {
  const reordered = JSON.stringify({
    accepts: v2Challenge.accepts,
    error: v2Challenge.error,
    resource: v2Challenge.resource,
    x402Version: 2,
  });
  const same = await buildRecord(
    input({ status: 402, res: { "payment-required": b64(v2Challenge) }, body: reordered }),
  );
  assert.equal(same.challenge?.location, "both");
  assert.equal(same.challenge?.drift, false);
  const diff = await buildRecord(
    input({ status: 402, res: { "payment-required": b64(v2Challenge) }, body: JSON.stringify(v1Challenge) }),
  );
  assert.equal(diff.challenge?.location, "both");
  assert.equal(diff.challenge?.drift, true);
  assert.equal(diff.challenge?.version, 2);
});

test("empty or non-challenge body next to header gives header; garbage gives none", async () => {
  const a = await buildRecord(input({ status: 402, res: { "payment-required": b64(v2Challenge) }, body: "{}" }));
  assert.equal(a.challenge?.location, "header");
  const b = await buildRecord(input({ status: 402, body: "{}" }));
  assert.equal(b.challenge?.location, "none");
  const c = await buildRecord(input({ status: 402, body: "not json", res: { "payment-required": "%%%" } }));
  assert.deepEqual(c.challenge, { location: "none" });
});

test("challenge error capped at 256, accepts capped at 5 with four fields", async () => {
  const many = {
    x402Version: 2,
    error: "e".repeat(500),
    accepts: Array.from({ length: 9 }, (_, i) => ({
      scheme: "exact",
      network: `n${i}`,
      amount: "1",
      asset: "a",
      payTo: "0xsecret",
      extra: { x: 1 },
    })),
  };
  const r = await buildRecord(input({ status: 402, res: { "payment-required": b64(many) } }));
  assert.equal(r.challenge?.error?.length, 256);
  assert.equal(r.challenge?.accepts?.length, 5);
  assert.deepEqual(Object.keys(r.challenge?.accepts?.[0] ?? {}).sort(), ["amount", "asset", "network", "scheme"]);
  assert.ok(!JSON.stringify(r).includes("0xsecret"));
});

test("challenge ignores non-string fields and bad version", async () => {
  const odd = { x402Version: 3, error: 5, accepts: [{ scheme: 1, network: {}, amount: 10 }, "x", null] };
  const r = await buildRecord(input({ status: 402, res: { "payment-required": b64(odd) } }));
  assert.equal(r.challenge?.version, undefined);
  assert.equal(r.challenge?.error, undefined);
});

test("payment v2 and v1", async () => {
  const v2 = await buildRecord(input({ req: { "payment-signature": b64(v2Payment) } }));
  assert.deepEqual(v2.payment, {
    header: "PAYMENT-SIGNATURE",
    decodable: true,
    version: 2,
    scheme: "exact",
    network: "eip155:84532",
    amount: "1000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  });
  const v1 = await buildRecord(input({ req: { "x-payment": b64(v1Payment) } }));
  assert.deepEqual(v1.payment, {
    header: "X-PAYMENT",
    decodable: true,
    version: 1,
    scheme: "exact",
    network: "base-sepolia",
  });
});

test("PAYMENT-SIGNATURE wins over X-PAYMENT", async () => {
  const r = await buildRecord(input({ req: { "payment-signature": b64(v2Payment), "x-payment": b64(v1Payment) } }));
  assert.equal(r.payment?.header, "PAYMENT-SIGNATURE");
});

test("undecodable payment header", async () => {
  const r = await buildRecord(input({ req: { "x-payment": "!!!notbase64" } }));
  assert.deepEqual(r.payment, { header: "X-PAYMENT", decodable: false });
  assert.equal(r.type, "payment.received");
  assert.equal(r.delivery, "ok");
});

test("receipt v2 and v1, failure fields", async () => {
  const v2 = await buildRecord(
    input({ res: { "payment-response": b64(v2Receipt) }, req: { "payment-signature": b64(v2Payment) } }),
  );
  assert.deepEqual(v2.receipt, {
    header: "PAYMENT-RESPONSE",
    decodable: true,
    success: true,
    hasTransaction: true,
    network: "eip155:84532",
  });
  const v1 = await buildRecord(input({ res: { "x-payment-response": b64(v1Receipt) } }));
  assert.equal(v1.receipt?.header, "X-PAYMENT-RESPONSE");
  assert.equal(v1.receipt?.network, "base-sepolia");
  const failed = await buildRecord(
    input({ res: { "payment-response": b64({ success: false, errorReason: "r".repeat(400) }) } }),
  );
  assert.equal(failed.receipt?.success, false);
  assert.equal(failed.receipt?.errorReason?.length, 256);
  assert.equal(failed.receipt?.transaction, undefined);
  const bad = await buildRecord(input({ res: { "payment-response": "%%" } }));
  assert.deepEqual(bad.receipt, { header: "PAYMENT-RESPONSE", decodable: false });
  const both = await buildRecord(
    input({ res: { "payment-response": b64(v2Receipt), "x-payment-response": b64(v1Receipt) } }),
  );
  assert.equal(both.receipt?.header, "PAYMENT-RESPONSE");
});

test("delivery by status", async () => {
  const req = { "payment-signature": b64(v2Payment) };
  assert.equal((await buildRecord(input({ status: 200, req }))).delivery, "ok");
  assert.equal((await buildRecord(input({ status: 399, req }))).delivery, "ok");
  assert.equal((await buildRecord(input({ status: 402, req }))).delivery, "failed");
  assert.equal((await buildRecord(input({ status: 500, req }))).delivery, "failed");
});

test("payer: receipt first, else authorization.from, passed on as is; no hasher means none", async () => {
  const req = { "payment-signature": b64(v2Payment) };
  const none = await buildRecord(input({ req }));
  assert.equal(none.payment?.payer, undefined);
  const fromReceipt = await buildRecord(
    input({
      req: { "payment-signature": b64({ ...v2Payment, payload: { authorization: { from: "0xFROMAUTH" } } }) },
      res: { "payment-response": b64({ ...v2Receipt, payer: "0xABCDEF" }) },
    }),
    fakeHash,
  );
  assert.equal(fromReceipt.payment?.payer, "h(0xABCDEF)");
  const fromAuth = await buildRecord(
    input({ req: { "payment-signature": b64({ ...v2Payment, payload: { authorization: { from: "0xAAbb" } } }) } }),
    fakeHash,
  );
  assert.equal(fromAuth.payment?.payer, "h(0xAAbb)");
  const noPayment = await buildRecord(input({ res: { "payment-response": b64(v2Receipt) } }), fakeHash);
  assert.equal(noPayment.payment, undefined);
});

test("hashPayer failure omits payer, never rejects", async () => {
  const req = { "payment-signature": b64(v2Payment) };
  const rejecting = await buildRecord(input({ req }), {
    hash: async () => {
      throw new Error("boom");
    },
    saltId: "abcd1234",
  });
  assert.equal(rejecting.payment?.payer, undefined);
  assert.equal(rejecting.payment?.payer_alg, undefined);
  assert.equal(rejecting.payment?.payer_salt_id, undefined);
  const throwing = await buildRecord(input({ req }), {
    hash: (() => {
      throw new Error("boom");
    }) as unknown as (a: string) => Promise<string>,
    saltId: "abcd1234",
  });
  assert.equal(throwing.payment?.payer, undefined);
  assert.equal(throwing.payment?.payer_salt_id, undefined);
  const empty = await buildRecord(input({ req }), { hash: async () => "", saltId: "abcd1234" });
  assert.equal(empty.payment?.payer, undefined);
  assert.equal(empty.payment?.payer_alg, undefined);
});

test("__proto__ keys do not pollute or leak", async () => {
  const evil = `{"x402Version":2,"__proto__":{"polluted":true},"accepts":[{"__proto__":{"scheme":"x"},"scheme":"exact"}]}`;
  const r = await buildRecord(input({ status: 402, res: { "payment-required": btoa(evil) } }));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(r.challenge?.accepts?.[0]?.scheme, "exact");
  assert.ok(!JSON.stringify(r).includes("polluted"));
});

test("control characters and long strings are cleaned", async () => {
  const r = await buildRecord(
    input({
      method: "GE\u0000T",
      route: `/${"x".repeat(300)}`,
      status: 402,
      res: { "payment-required": b64({ x402Version: 2, error: "a\u0007b" }) },
    }),
  );
  assert.equal(r.method, "GET");
  assert.equal(r.route.length, 128);
  assert.equal(r.challenge?.error, "ab");
});

test("privacy: serialised record contains no forbidden value", async () => {
  const secrets = ["203.0.113.9", "10.1.2.3", "SECRETCOOKIE", "SECRETTOKEN", "0xdeadbeef", "0xsecretpayto"];
  const signed = {
    ...v2Payment,
    payload: { signature: "0xdeadbeef", authorization: { from: PAYER, to: "0xsecretpayto" } },
  };
  const r = await buildRecord(
    input({
      status: 402,
      req: {
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "10.1.2.3",
        cookie: "session=SECRETCOOKIE",
        authorization: "Bearer SECRETTOKEN",
        "payment-signature": b64(signed),
        "user-agent": "Mozilla/5.0 SECRETUA",
      },
      res: {
        "payment-required": b64({
          ...v2Challenge,
          accepts: [{ ...v2Challenge.accepts[0], payTo: "0xsecretpayto" }],
        }),
      },
    }),
    { hash: async () => "abcd1234", saltId: "ffff0000" },
  );
  const json = JSON.stringify(r);
  for (const s of secrets) assert.ok(!json.includes(s), `leaked ${s}`);
  assert.ok(!json.includes("SECRETUA"));
  assert.ok(!json.includes(PAYER));
});

test("empty or whitespace receipt payer falls back to authorization.from", async () => {
  const req = { "payment-signature": b64({ ...v2Payment, payload: { authorization: { from: "0xFROMAUTH" } } }) };
  for (const payer of ["", "   "]) {
    const r = await buildRecord(input({ req, res: { "payment-response": b64({ ...v2Receipt, payer }) } }), fakeHash);
    assert.equal(r.payment?.payer, "h(0xFROMAUTH)");
  }
});

test("deeply nested header and body do not make buildRecord throw", async () => {
  const depth = 8000;
  const nested = `{"x402Version":2,"a":${"[".repeat(depth)}${"]".repeat(depth)}}`;
  const r = await buildRecord(input({ status: 402, res: { "payment-required": btoa(nested) }, body: nested }));
  assert.equal(r.challenge?.location, "both");
});

test("__proto__ keys in payment and receipt payloads are harmless", async () => {
  const pay = btoa(
    `{"x402Version":2,"__proto__":{"scheme":"evil"},"accepted":{"__proto__":{"network":"evil"},"scheme":"exact"},"payload":{"__proto__":{"authorization":{"from":"0xevil"}}}}`,
  );
  const rec = btoa(`{"__proto__":{"success":true,"transaction":"evil"},"network":"n"}`);
  const r = await buildRecord(
    input({ req: { "payment-signature": pay }, res: { "payment-response": rec } }),
    fakeHash,
  );
  assert.equal(r.payment?.scheme, "exact");
  assert.equal(r.payment?.network, undefined);
  assert.equal(r.payment?.payer, undefined);
  assert.equal(r.receipt?.success, undefined);
  assert.equal(r.receipt?.transaction, undefined);
  assert.equal(r.receipt?.network, "n");
  assert.ok(!JSON.stringify(r).includes("evil"));
});

test("undecodable payment header still hashes the receipt payer (only with a hash fn)", async () => {
  const over: Over = { req: { "x-payment": "!!!notbase64" }, res: { "payment-response": b64(v2Receipt) } };
  const hashed = await buildRecord(input(over), fakeHash);
  assert.deepEqual(hashed.payment, {
    header: "X-PAYMENT",
    decodable: false,
    payer: `h(${PAYER})`,
    payer_alg: "op8x.payer.v1",
    payer_salt_id: "abcd1234",
  });
  const plain = await buildRecord(input(over));
  assert.deepEqual(plain.payment, { header: "X-PAYMENT", decodable: false });
});

test("receipt transaction only with chainCheck; never serialised by default", async () => {
  const over: Over = { res: { "payment-response": b64(v2Receipt) }, req: { "payment-signature": b64(v2Payment) } };
  for (const opts of [undefined, {}, { chainCheck: false }]) {
    const r = await buildRecord(input(over), fakeHash, opts);
    assert.equal(r.receipt?.transaction, undefined);
    assert.ok(!JSON.stringify(r).includes(TX), "transaction hash leaked");
    assert.equal(r.receipt?.success, true);
    assert.equal(r.receipt?.hasTransaction, true);
  }
  const checked = await buildRecord(input(over), undefined, { chainCheck: true });
  assert.equal(checked.receipt?.transaction, TX);
});

const HASH = "0x" + "ab".repeat(32);
const ADDR = "0x" + "11".repeat(20);
const NET = "eip155:84532";

async function receiptOf(res: Record<string, string>, opts?: { chainCheck?: boolean }) {
  return buildRecord(input({ status: 402, res }), undefined, opts);
}

const settlementCases: Array<[string, Record<string, unknown>, boolean]> = [
  [
    "M1 settle ok, hook aborts with a reason",
    {
      success: false,
      transaction: HASH,
      network: NET,
      payer: ADDR,
      amount: "1000",
      errorReason: "fulfilment_failed",
      errorMessage: "probe abort",
    },
    true,
  ],
  [
    "M2 settle ok, hook aborts with an empty reason",
    { success: false, transaction: HASH, network: NET, payer: ADDR, errorReason: "", errorMessage: "probe abort" },
    true,
  ],
  [
    "M3 facilitator failure with a hash",
    {
      success: false,
      errorReason: "invalid_exact_evm_transaction_failed",
      transaction: HASH,
      network: NET,
      payer: ADDR,
    },
    true,
  ],
  [
    "M4 rejected before broadcast",
    {
      success: false,
      errorReason: "invalid_exact_evm_payload_signature",
      transaction: "",
      network: NET,
      payer: ADDR,
    },
    false,
  ],
  ["M5 settle ok", { success: true, transaction: HASH, network: NET, payer: ADDR }, true],
];

for (const [name, receipt, expected] of settlementCases) {
  test(`hasTransaction ${name}: ${expected}`, async () => {
    const r = await receiptOf({ "payment-response": b64(receipt) });
    assert.equal(r.receipt?.decodable, true);
    assert.equal(r.receipt?.success, receipt.success);
    assert.equal(r.receipt?.hasTransaction, expected);
    assert.equal(r.receipt?.transaction, undefined);
    assert.ok(!JSON.stringify(r).includes(HASH), "transaction hash leaked");
  });
}

test("hasTransaction is false for missing, empty, blank, control-only, invisible-only, numeric and null transaction", async () => {
  const values: Array<[string, Record<string, unknown>]> = [
    ["missing", { success: false }],
    ["empty", { success: false, transaction: "" }],
    ["blank", { success: false, transaction: "   " }],
    ["control characters only", { success: false, transaction: "\u0000\u200e" }],
    ["arabic letter mark only", { success: false, transaction: "\u061c" }],
    ["zero width space and word joiner only", { success: false, transaction: "\u200b\u2060" }],
    ["number", { success: false, transaction: 12345 }],
    ["null", { success: false, transaction: null }],
  ];
  for (const [label, receipt] of values) {
    const r = await receiptOf({ "payment-response": b64(receipt) });
    assert.equal(r.receipt?.hasTransaction, false, label);
    assert.equal(r.receipt?.transaction, undefined, label);
    assert.ok(!JSON.stringify(r).includes(HASH), label);
  }
});

test("hasTransaction is false for success true with an empty transaction", async () => {
  const r = await receiptOf({ "payment-response": b64({ success: true, transaction: "" }) });
  assert.equal(r.receipt?.success, true);
  assert.equal(r.receipt?.hasTransaction, false);
  assert.ok(!JSON.stringify(r).includes(HASH));
});

test("hasTransaction is absent when the receipt does not decode", async () => {
  const r = await receiptOf({ "payment-response": "%%" });
  assert.deepEqual(r.receipt, { header: "PAYMENT-RESPONSE", decodable: false });
});

test("hasTransaction ignores a __proto__ transaction", async () => {
  const rec = btoa(`{"__proto__":{"transaction":"${HASH}"},"success":false,"network":"n"}`);
  const r = await receiptOf({ "payment-response": rec });
  assert.equal(r.receipt?.hasTransaction, false);
  assert.equal(r.receipt?.transaction, undefined);
  assert.ok(!JSON.stringify(r).includes(HASH));
});

test("chainCheck adds the transaction next to hasTransaction", async () => {
  const r = await receiptOf(
    { "payment-response": b64({ success: false, transaction: HASH, network: NET }) },
    { chainCheck: true },
  );
  assert.equal(r.receipt?.transaction, HASH);
  assert.equal(r.receipt?.hasTransaction, true);
});

test("hasTransaction works for the v1 X-PAYMENT-RESPONSE header", async () => {
  const r = await receiptOf({ "x-payment-response": b64({ success: true, transaction: HASH, network: "base-sepolia" }) });
  assert.equal(r.receipt?.header, "X-PAYMENT-RESPONSE");
  assert.equal(r.receipt?.hasTransaction, true);
  assert.equal(r.receipt?.transaction, undefined);
  assert.ok(!JSON.stringify(r).includes(HASH));
});

// Nonces are built at runtime so no key-shaped literal sits in the source.
const NONCE = Buffer.alloc(32, 7).toString("base64url");

function withTest(value: string, name = "op8x-test"): RecordInput {
  const requestHeaders = new Headers();
  requestHeaders.set(name, value);
  return input({ requestHeaders });
}

test("test_nonce: a valid 43-character value is set", async () => {
  assert.equal(NONCE.length, 43);
  assert.equal((await buildRecord(withTest(NONCE))).test_nonce, NONCE);
  const edge = "_".repeat(42) + "-";
  assert.equal((await buildRecord(withTest(edge))).test_nonce, edge);
  const letters = "A".repeat(43);
  assert.equal((await buildRecord(withTest(letters))).test_nonce, letters);
});

test("test_nonce: the header name is case-insensitive", async () => {
  assert.equal((await buildRecord(withTest(NONCE, "OP8X-Test"))).test_nonce, NONCE);
});

test("test_nonce: missing header sets no field", async () => {
  const r = await buildRecord(input());
  assert.equal("test_nonce" in r, false);
});

test("test_nonce: empty value sets no field", async () => {
  const r = await buildRecord(withTest(""));
  assert.equal("test_nonce" in r, false);
});

test("test_nonce: 42 characters set no field", async () => {
  const r = await buildRecord(withTest(NONCE.slice(0, 42)));
  assert.equal("test_nonce" in r, false);
});

test("test_nonce: 44 characters set no field", async () => {
  const r = await buildRecord(withTest(NONCE + "A"));
  assert.equal("test_nonce" in r, false);
});

test("test_nonce: base64 padding with = sets no field", async () => {
  const r = await buildRecord(withTest(NONCE.slice(0, 42) + "="));
  assert.equal("test_nonce" in r, false);
});

test("test_nonce: + and / (standard base64) set no field", async () => {
  for (const bad of ["+", "/"]) {
    const r = await buildRecord(withTest(NONCE.slice(0, 42) + bad));
    assert.equal("test_nonce" in r, false, bad);
  }
});

test("test_nonce: a header set twice sets no field", async () => {
  const requestHeaders = new Headers();
  requestHeaders.append("op8x-test", NONCE);
  requestHeaders.append("op8x-test", NONCE);
  const r = await buildRecord(input({ requestHeaders }));
  assert.equal("test_nonce" in r, false);
});

test("test_nonce: a 16 KB value sets no field", async () => {
  const r = await buildRecord(withTest("A".repeat(16 * 1024)));
  assert.equal("test_nonce" in r, false);
});

test("test_nonce: the value appears in no other field", async () => {
  const r = await buildRecord(withTest(NONCE));
  const { test_nonce, ...rest } = r;
  assert.equal(test_nonce, NONCE);
  assert.ok(!JSON.stringify(rest).includes(NONCE));
});

test("pseudonym fields come together, only on payment events", async () => {
  const paid = await buildRecord(input({ req: { "payment-signature": b64(v2Payment) } }), fakeHash);
  assert.equal(paid.payment?.payer, `h(${PAYER})`);
  assert.equal(paid.payment?.payer_alg, "op8x.payer.v1");
  assert.equal(paid.payment?.payer_salt_id, "abcd1234");
  const challenge = await buildRecord(input({ status: 402 }), fakeHash);
  assert.equal(challenge.payment, undefined);
  const unpaid = await buildRecord(input(), fakeHash);
  assert.ok(!JSON.stringify(unpaid).includes("payer"));
  const noAddress = await buildRecord(input({ req: { "payment-signature": b64({ x402Version: 2 }) } }), fakeHash);
  assert.equal(noAddress.payment?.payer, undefined);
  assert.equal(noAddress.payment?.payer_alg, undefined);
  assert.equal(noAddress.payment?.payer_salt_id, undefined);
});

interface VectorFile {
  salts: { salt: string; salt_id: string; payers: { note: string; address: string; payer: string }[] }[];
}
const vectorFile = JSON.parse(readFileSync(new URL("../docs/payer-hash-vectors.json", import.meta.url), "utf8")) as VectorFile;

test("buildRecord yields exactly the published vectors, for payment-header and receipt payers", async () => {
  for (const v of vectorFile.salts) {
    const bytes = parseSalt(v.salt)!;
    const hasher: PayerHasher = { hash: (a) => hashPayer(bytes, a), saltId: await saltId(bytes) };
    for (const p of v.payers) {
      const viaAuth = await buildRecord(
        input({ req: { "payment-signature": b64({ ...v2Payment, payload: { authorization: { from: p.address } } }) } }),
        hasher,
      );
      // An all-whitespace address is not an address; the vectors have none.
      assert.equal(viaAuth.payment?.payer, p.payer, p.note);
      assert.equal(viaAuth.payment?.payer_alg, "op8x.payer.v1");
      assert.equal(viaAuth.payment?.payer_salt_id, v.salt_id);
      const viaReceipt = await buildRecord(
        input({
          req: { "payment-signature": b64(v2Payment) },
          res: { "payment-response": b64({ ...v2Receipt, payer: p.address }) },
        }),
        hasher,
      );
      assert.equal(viaReceipt.payment?.payer, p.payer, p.note);
    }
  }
});

test("buildRecord stays fast for an address with long inner whitespace, with and without a salt", async () => {
  const bytes = parseSalt(vectorFile.salts[0]!.salt)!;
  const hasher: PayerHasher = { hash: (a) => hashPayer(bytes, a), saltId: await saltId(bytes) };
  for (const ws of [" ", "\t"]) {
    // A tab is two bytes in the JSON header, which is capped at 16 KiB.
    const address = "a" + ws.repeat(ws === "	" ? 8000 : 16000) + "a";
    const req = { "payment-signature": b64({ payload: { authorization: { from: address } } }) };
    const start = performance.now();
    const unsalted = await buildRecord(input({ req }));
    const salted = await buildRecord(input({ req }), hasher);
    assert.ok(performance.now() - start < 50, "both records under 50 ms");
    assert.equal(unsalted.payment?.payer, undefined);
    assert.equal(salted.payment?.payer, await hashPayer(bytes, address));
  }
});
