import { test } from "node:test";
import assert from "node:assert/strict";
import { postDepreciation, postDepreciationConsolidated } from "../lib/fixed-assets-ledger.ts";
import { postAmortization } from "../lib/prepaid-expense-ledger.ts";
import { registerOpeningBalance, findOrCreateAccount } from "../lib/opening-balance-equity.ts";
import type { Account, FixedAsset, Ledger, PrepaidExpense } from "../lib/vault-types.ts";

// First-ever coverage for this file. The PURE math these wrap (monthlyDepreciation,
// pendingAmortizationMonths, etc.) is already tested, but the actual GL-posting wrapper --
// the part that turns that math into real, balanced Journal vouchers -- was not. A bug here
// (unbalanced entries, an off-by-one month, double-posting on a second run) would post a
// plausible-looking but wrong voucher straight into the real ledger, not just a wrong report
// number -- higher blast radius than the pure-math functions already covered.

function baseLedger(overrides: Partial<Ledger> = {}): Ledger {
  return {
    currency: "USD",
    accounts: [
      { id: 1, name: "Furniture", parent: "Fixed Assets", category: "Asset", currency: "USD", openingBalance: 0 },
      { id: 2, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 },
      { id: 3, name: "Rent Prepaid", parent: "Current Assets", category: "Asset", currency: "USD", openingBalance: 0 },
      { id: 4, name: "Rent Expense", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 },
    ],
    transactions: [],
    ...overrides,
  } as Ledger;
}

function fixedAsset(overrides: Partial<FixedAsset> = {}): FixedAsset {
  return {
    id: "fa1", name: "Furniture", accountId: 1, purchaseDate: "2026-01-15",
    cost: 1200, salvageValue: 0, usefulLifeMonths: 12,
    ...overrides,
  };
}

function prepaidExpense(overrides: Partial<PrepaidExpense> = {}): PrepaidExpense {
  return {
    id: "pe1", name: "Annual Rent", accountId: 3, expenseAccountId: 4,
    startDate: "2026-01-15", totalAmount: 1200, termMonths: 12,
    ...overrides,
  };
}

test("postDepreciation: posts one balanced Journal per elapsed month, advances lastDepreciatedThrough", () => {
  const data = baseLedger({ fixedAssets: [fixedAsset()] });
  const { data: after, postedCount } = postDepreciation(data, "2026-04-01");
  // Jan+Feb+Mar fully elapsed (purchased mid-Jan) -- 3 months at $100/mo.
  assert.equal(postedCount, 3);
  const journals = after.transactions.filter((t) => t.type === "Journal");
  assert.equal(journals.length, 3);
  for (const j of journals) {
    assert.equal(j.entries.reduce((s, e) => s + e.amount, 0), 0, `voucher ${j.narration} must balance`);
    assert.equal(j.entries.length, 2);
    const depExp = j.entries.find((e) => e.accountName === "Depreciation Expense");
    const accumDep = j.entries.find((e) => e.accountName === "Accumulated Depreciation");
    assert.ok(depExp && accumDep);
    assert.equal(depExp!.amount, -100);
    assert.equal(accumDep!.amount, 100);
  }
  assert.equal(after.fixedAssets![0].lastDepreciatedThrough, "2026-03");
});

test("postDepreciation: a second run through the same throughDate posts nothing more (idempotent)", () => {
  const data = baseLedger({ fixedAssets: [fixedAsset()] });
  const { data: once } = postDepreciation(data, "2026-04-01");
  const { data: twice, postedCount } = postDepreciation(once, "2026-04-01");
  assert.equal(postedCount, 0);
  assert.equal(twice.transactions.length, once.transactions.length);
});

test("postDepreciation: skips a disposed asset entirely, even with pending months", () => {
  const data = baseLedger({ fixedAssets: [fixedAsset({ disposed: { date: "2026-01-20", proceeds: 0 } })] });
  const { postedCount } = postDepreciation(data, "2026-06-01");
  assert.equal(postedCount, 0);
});

test("postDepreciationConsolidated: collapses a multi-month backlog into ONE balanced true-up voucher per asset", () => {
  const data = baseLedger({ fixedAssets: [fixedAsset()] });
  const { data: after, postedCount } = postDepreciationConsolidated(data, "2026-04-01", "2026-04-15");
  assert.equal(postedCount, 1);
  const journals = after.transactions.filter((t) => t.type === "Journal");
  assert.equal(journals.length, 1);
  assert.equal(journals[0].date, "2026-04-15"); // posted on the caller-supplied catch-up date
  assert.equal(journals[0].entries.reduce((s, e) => s + e.amount, 0), 0);
  assert.equal(journals[0].entries.find((e) => e.accountName === "Depreciation Expense")!.amount, -300); // 3 months x $100
  assert.equal(after.fixedAssets![0].lastDepreciatedThrough, "2026-03");
});

test("postAmortization: posts one balanced Journal per elapsed month against the item's OWN expense account (not a shared pool)", () => {
  const data = baseLedger({ prepaidExpenses: [prepaidExpense()] });
  const { data: after, postedCount } = postAmortization(data, "2026-04-01");
  assert.equal(postedCount, 3); // Jan+Feb+Mar at $100/mo
  const journals = after.transactions.filter((t) => t.type === "Journal");
  assert.equal(journals.length, 3);
  for (const j of journals) {
    assert.equal(j.entries.reduce((s, e) => s + e.amount, 0), 0);
    const exp = j.entries.find((e) => e.accountName === "Rent Expense");
    const prepaid = j.entries.find((e) => e.accountName === "Rent Prepaid");
    assert.equal(exp!.amount, -100);
    assert.equal(prepaid!.amount, 100);
  }
  assert.equal(after.prepaidExpenses![0].lastAmortizedThrough, "2026-03");
});

test("postAmortization: a written-off item is skipped even with pending months", () => {
  const data = baseLedger({ prepaidExpenses: [prepaidExpense({ writtenOff: { date: "2026-01-20" } })] });
  const { postedCount } = postAmortization(data, "2026-06-01");
  assert.equal(postedCount, 0);
});

test("postAmortization: an item missing its target expense or prepaid account is skipped, not crashed", () => {
  const data = baseLedger({ prepaidExpenses: [prepaidExpense({ expenseAccountId: 999 })] });
  const { postedCount } = postAmortization(data, "2026-04-01");
  assert.equal(postedCount, 0);
});

test("registerOpeningBalance: posts a balanced Journal against Opening Balance Equity, debit direction (asset-like)", () => {
  const data = baseLedger();
  const { account } = findOrCreateAccount(data.accounts, "New Fixed Asset", "Fixed Assets", "USD");
  const after = registerOpeningBalance(data, account, 500, "2026-01-01", "Opening: New Fixed Asset");
  const journal = after.transactions.find((t) => t.type === "Journal");
  assert.ok(journal);
  assert.equal(journal!.entries.reduce((s, e) => s + e.amount, 0), 0);
  const assetEntry = journal!.entries.find((e) => e.accountId === account.id);
  const equityEntry = journal!.entries.find((e) => e.accountName === "Opening Balance Equity");
  assert.equal(assetEntry!.amount, -500); // Dr the asset
  assert.equal(equityEntry!.amount, 500); // Cr equity
});

test("registerOpeningBalance: credit direction (a liability, e.g. a loan) flips the sign", () => {
  const data = baseLedger();
  const { account } = findOrCreateAccount(data.accounts, "New Loan", "Loans (Liability)", "USD");
  const after = registerOpeningBalance(data, account, 500, "2026-01-01", "Opening: New Loan", "credit");
  const journal = after.transactions.find((t) => t.type === "Journal");
  const loanEntry = journal!.entries.find((e) => e.accountId === account.id);
  assert.equal(loanEntry!.amount, 500); // Cr the liability
});

test("registerOpeningBalance: a zero amount is a no-op, no empty/unbalanced voucher posted", () => {
  const data = baseLedger();
  const { account } = findOrCreateAccount(data.accounts, "New Asset", "Fixed Assets", "USD");
  const after = registerOpeningBalance(data, account, 0, "2026-01-01", "Opening: New Asset");
  assert.equal(after.transactions.length, 0);
});
