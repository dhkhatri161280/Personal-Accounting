import assert from "node:assert/strict";
import test from "node:test";
import { diffFields, summarize, appendAuditEntry } from "../lib/audit.ts";

test("diffFields only reports fields that actually changed", () => {
  const before = { name: "Groceries", parent: "Indirect Expenses", active: true };
  const after = { name: "Groceries", parent: "Direct Expenses", active: true };
  const changes = diffFields(before, after, ["name", "parent", "active"]);
  assert.deepEqual(changes, [{ field: "parent", before: "Indirect Expenses", after: "Direct Expenses" }]);
});

test("diffFields treats an undefined `before` as everything-new (no changes list, since there's nothing to compare)", () => {
  const after = { name: "New Account", parent: "Bank Accounts" };
  const changes = diffFields(undefined, after, ["name", "parent"]);
  assert.deepEqual(changes, [
    { field: "name", before: undefined, after: "New Account" },
    { field: "parent", before: undefined, after: "Bank Accounts" },
  ]);
});

test("summarize prefers an explicit createdLabel over the diff", () => {
  const changes = [{ field: "name", before: undefined, after: "New Account" }];
  assert.equal(summarize(changes, "Ledger created: New Account"), "Ledger created: New Account");
});

test("summarize formats a human-readable line from field changes", () => {
  const changes = [{ field: "Amount", before: 100, after: 150.5 }];
  assert.equal(summarize(changes), "Amount changed from 100.00 to 150.50");
});

test("summarize handles no changes gracefully", () => {
  assert.equal(summarize([]), "No field changes.");
});

test("appendAuditEntry appends with a fresh id/timestamp and preserves existing entries", () => {
  const ledger = { auditLog: [{ id: "e1", at: "2026-01-01T00:00:00.000Z", entity: "account" as const, entityId: "1", action: "created" as const, summary: "x" }] };
  const next = appendAuditEntry(ledger, { entity: "voucher", entityId: "v1", action: "created", summary: "Voucher created" });
  assert.equal(next.auditLog.length, 2);
  assert.equal(next.auditLog[1].summary, "Voucher created");
  assert.ok(next.auditLog[1].id);
  assert.ok(next.auditLog[1].at);
  // Original object untouched (spread, not mutated)
  assert.equal(ledger.auditLog.length, 1);
});

test("appendAuditEntry trims the oldest entries beyond the 5000-entry cap", () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({
    id: `e${i}`, at: "2026-01-01T00:00:00.000Z", entity: "account" as const, entityId: String(i), action: "created" as const, summary: `entry ${i}`,
  }));
  const ledger = { auditLog: many };
  const next = appendAuditEntry(ledger, { entity: "voucher", entityId: "new", action: "created", summary: "newest" });
  assert.equal(next.auditLog.length, 5000);
  assert.equal(next.auditLog[next.auditLog.length - 1].summary, "newest");
  assert.equal(next.auditLog[0].summary, "entry 1"); // "entry 0" was trimmed off
});
