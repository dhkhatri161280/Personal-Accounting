import assert from "node:assert/strict";
import test from "node:test";
import { accountFormSchema } from "../lib/account-form-schema.ts";

const valid = { name: "New Ledger", parent: "Bank Accounts", currency: "USD", opening: 100, side: "Dr" as const, active: true };

test("accepts a valid, non-duplicate account", () => {
  const result = accountFormSchema(["Existing Ledger"]).safeParse(valid);
  assert.equal(result.success, true);
});

test("rejects a case-insensitive duplicate name", () => {
  const result = accountFormSchema(["new ledger"]).safeParse(valid);
  assert.equal(result.success, false);
  assert.match(result.error?.issues[0].message || "", /already exists/i);
});

test("rejects an empty name", () => {
  const result = accountFormSchema([]).safeParse({ ...valid, name: "  " });
  assert.equal(result.success, false);
});

test("rejects an empty account group", () => {
  const result = accountFormSchema([]).safeParse({ ...valid, parent: "" });
  assert.equal(result.success, false);
});

test("rejects a negative opening balance", () => {
  const result = accountFormSchema([]).safeParse({ ...valid, opening: -5 });
  assert.equal(result.success, false);
});

test("the account being edited doesn't collide with its own name", () => {
  // Caller excludes the current account's own name from existingNames before calling this.
  const result = accountFormSchema([]).safeParse(valid);
  assert.equal(result.success, true);
});
