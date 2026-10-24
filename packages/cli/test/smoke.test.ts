import { test } from "node:test";
import assert from "node:assert/strict";
import { PaymentRequiredV1Schema, PaymentRequiredV2Schema } from "@x402/core/schemas";
import { v1, v2 } from "./fixtures.ts";
import { VERSION } from "../src/version.ts";
import pkg from "../package.json" with { type: "json" };

test("v2 fixture is valid per @x402/core", () => {
  assert.equal(PaymentRequiredV2Schema.safeParse(v2).success, true);
});

test("v1 fixture is valid per @x402/core", () => {
  assert.equal(PaymentRequiredV1Schema.safeParse(v1).success, true);
});

test("VERSION matches package.json", () => {
  assert.equal(VERSION, pkg.version);
});
