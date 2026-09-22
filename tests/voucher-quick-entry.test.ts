import assert from "node:assert/strict";
import test from "node:test";
import { mostRecentlyEnteredVoucher, findVoucherByNarration } from "../lib/vault-accounting.ts";

const balanced = (overrides: any) => ({
  guid: "g1",
  entries: [{ accountId: 1, amount: -10 }, { accountId: 2, amount: 10 }],
  ...overrides,
});

test("mostRecentlyEnteredVoucher picks the highest createdAt, not the latest date", () => {
  const older = balanced({ guid: "a", createdAt: "2026-09-01T10:00:00Z", date: "2026-09-20" });
  const newer = balanced({ guid: "b", createdAt: "2026-09-05T10:00:00Z", date: "2026-08-01" });
  const result = mostRecentlyEnteredVoucher([older, newer] as any);
  assert.equal(result?.guid, "b");
});

test("mostRecentlyEnteredVoucher falls back to id when createdAt is missing", () => {
  const a = balanced({ guid: "a", id: 5 });
  const b = balanced({ guid: "b", id: 9 });
  const result = mostRecentlyEnteredVoucher([a, b] as any);
  assert.equal(result?.guid, "b");
});

test("mostRecentlyEnteredVoucher skips deleted, cancelled, and unbalanced vouchers", () => {
  const deleted = balanced({ guid: "a", id: 9, deleted: true });
  const cancelled = balanced({ guid: "b", id: 8, cancelled: true });
  const unbalanced = { guid: "c", id: 7, entries: [{ accountId: 1, amount: -10 }] };
  const valid = balanced({ guid: "d", id: 1 });
  const result = mostRecentlyEnteredVoucher([deleted, cancelled, unbalanced, valid] as any);
  assert.equal(result?.guid, "d");
});

test("findVoucherByNarration matches case-insensitively and trims whitespace", () => {
  const t = balanced({ guid: "a", id: 1, narration: "Shein order" });
  const result = findVoucherByNarration([t] as any, "  shein order  ");
  assert.equal(result?.guid, "a");
});

test("findVoucherByNarration returns undefined for no match or empty narration", () => {
  const t = balanced({ guid: "a", id: 1, narration: "Shein order" });
  assert.equal(findVoucherByNarration([t] as any, "Amazon order"), undefined);
  assert.equal(findVoucherByNarration([t] as any, ""), undefined);
});

test("findVoucherByNarration excludes the voucher currently being edited", () => {
  const t = balanced({ guid: "a", id: 1, narration: "Shein order" });
  const result = findVoucherByNarration([t] as any, "Shein order", "a");
  assert.equal(result, undefined);
});
