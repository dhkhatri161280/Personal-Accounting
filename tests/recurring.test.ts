import assert from "node:assert/strict";
import test from "node:test";
import {
  currentPeriodKey,
  dueTemplates,
  buildVoucherFromTemplate,
  matchRecurringTemplate,
} from "../lib/recurring.ts";
import type { Account, RecurringTemplate } from "../lib/vault-types.ts";

function template(overrides: Partial<RecurringTemplate> = {}): RecurringTemplate {
  return {
    id: "t1",
    label: "Netflix",
    active: true,
    frequency: "monthly",
    voucherType: "Payment",
    narrationTemplate: "{month} Netflix",
    entries: [
      { accountId: 9, amount: -15.99 },
      { accountId: 1, amount: 15.99 },
    ],
    postings: [],
    ...overrides,
  };
}

test("currentPeriodKey is YYYY-MM for monthly, YYYY for yearly", () => {
  assert.equal(currentPeriodKey(template({ frequency: "monthly" }), "2026-09-15"), "2026-09");
  assert.equal(currentPeriodKey(template({ frequency: "yearly" }), "2026-09-15"), "2026");
});

test("dueTemplates excludes inactive templates and ones already posted this period", () => {
  const active = template();
  const inactive = template({ id: "t2", active: false });
  const posted = template({ id: "t3", postings: [{ periodKey: "2026-09", txGuid: "v1", postedAt: "2026-09-01" }] });
  const due = dueTemplates([active, inactive, posted], "2026-09-15");
  assert.deepEqual(due.map((d) => d.template.id), ["t1"]);
  assert.equal(due[0].periodKey, "2026-09");
  assert.equal(due[0].periodLabel, "September 2026");
});

test("dueTemplates is due again once a new period starts", () => {
  const t = template({ postings: [{ periodKey: "2026-08", txGuid: "v1", postedAt: "2026-08-01" }] });
  const due = dueTemplates([t], "2026-09-15");
  assert.equal(due.length, 1);
});

test("buildVoucherFromTemplate interpolates {month}/{year} and resolves account names", () => {
  const accountById = new Map<number, Account>([
    [9, { id: 9, name: "Subscriptions", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 }],
    [1, { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 }],
  ]);
  const built = buildVoucherFromTemplate(template(), "2026-09-15", accountById);
  assert.equal(built.narration, "September Netflix");
  assert.equal(built.voucherType, "Payment");
  assert.deepEqual(built.entries, [
    { accountId: 9, accountName: "Subscriptions", amount: -15.99 },
    { accountId: 1, accountName: "Bank Of America", amount: 15.99 },
  ]);
});

test("matchRecurringTemplate matches institution + amount within tolerance, ignores templates without plaidMatch", () => {
  const withPlaid = template({ plaidMatch: { institutionPattern: "Bank of America", amountTolerance: 1 } });
  const withoutPlaid = template({ id: "t2" });
  const match = matchRecurringTemplate("Bank of America", 15.5, "2026-09-15", [withoutPlaid, withPlaid]);
  assert.ok(match);
  assert.equal(match!.template.id, "t1");
  assert.equal(match!.periodKey, "2026-09");
});

test("matchRecurringTemplate rejects an amount outside tolerance or a non-matching institution", () => {
  const t = template({ plaidMatch: { institutionPattern: "Bank of America", amountTolerance: 1 } });
  assert.equal(matchRecurringTemplate("Bank of America", 20, "2026-09-15", [t]), null);
  assert.equal(matchRecurringTemplate("Citi", 15.99, "2026-09-15", [t]), null);
});

test("matchRecurringTemplate skips a template already posted for the current period", () => {
  const t = template({
    plaidMatch: { institutionPattern: "Bank of America", amountTolerance: 1 },
    postings: [{ periodKey: "2026-09", txGuid: "v1", postedAt: "2026-09-01" }],
  });
  assert.equal(matchRecurringTemplate("Bank of America", 15.99, "2026-09-15", [t]), null);
});
