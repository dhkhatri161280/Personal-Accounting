import assert from "node:assert/strict";
import test from "node:test";
import { voucherEntrySchema } from "../lib/voucher-entry-schema.ts";

const TYPES = ["Payment", "Receipt", "Contra", "Journal"];
const valid = { type: "Payment", date: "2026-08-15", narration: "Test" };

test("accepts a valid type/date/narration", () => {
  assert.equal(voucherEntrySchema(TYPES).safeParse(valid).success, true);
});

test("rejects an empty type", () => {
  assert.equal(voucherEntrySchema(TYPES).safeParse({ ...valid, type: "" }).success, false);
});

test("rejects a type not in the configured voucher-type list", () => {
  assert.equal(voucherEntrySchema(TYPES).safeParse({ ...valid, type: "Sales" }).success, false);
});

test("rejects a malformed date", () => {
  assert.equal(voucherEntrySchema(TYPES).safeParse({ ...valid, date: "08/15/2026" }).success, false);
});

test("rejects an empty date", () => {
  assert.equal(voucherEntrySchema(TYPES).safeParse({ ...valid, date: "" }).success, false);
});

test("allows an empty narration", () => {
  assert.equal(voucherEntrySchema(TYPES).safeParse({ ...valid, narration: "" }).success, true);
});
