import assert from "node:assert/strict";
import test from "node:test";
import { vaultBookBalance, matchAccountToVault, reconciliationStatusForAccounts, type PlaidAccountSummary, type PlaidTxSummary } from "../lib/plaid-recon.ts";
import type { Ledger } from "../lib/vault-types.ts";

function baseLedger(overrides: Partial<Ledger> = {}): Ledger {
  return {
    currency: "USD",
    accounts: [
      { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 },
      { id: 2, name: "Groceries", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 },
    ],
    transactions: [],
    ...overrides,
  } as Ledger;
}

test("vaultBookBalance: depository balance flips sign (Dr increases asset), credit balance doesn't", () => {
  const ledger = baseLedger({
    transactions: [
      {
        id: 1, guid: "v1", date: "2026-08-01", number: "1", type: "Payment", narration: "deposit", historical: false,
        entries: [{ accountId: 1, accountName: "Bank Of America", amount: -100 }, { accountId: 2, accountName: "Groceries", amount: 100 }],
      },
    ],
  });
  assert.equal(vaultBookBalance(1, "depository", ledger), 100);
  assert.equal(vaultBookBalance(1, "credit", ledger), -100);
});

test("matchAccountToVault matches by exact Plaid account name or institution name, case-insensitively", () => {
  const vaultAccounts = baseLedger().accounts;
  const byName: PlaidAccountSummary = { account_id: "a1", type: "depository", name: "bank of america", institution_name: "Some Other Name", balances: { current: 100 } };
  const byInstitution: PlaidAccountSummary = { account_id: "a2", type: "depository", name: "Checking ...1234", institution_name: "Bank Of America", balances: { current: 100 } };
  const noMatch: PlaidAccountSummary = { account_id: "a3", type: "depository", name: "Random", institution_name: "Random Bank", balances: { current: 100 } };
  assert.equal(matchAccountToVault(byName, vaultAccounts)?.id, 1);
  assert.equal(matchAccountToVault(byInstitution, vaultAccounts)?.id, 1);
  assert.equal(matchAccountToVault(noMatch, vaultAccounts), undefined);
});

test("reconciliationStatusForAccounts: matched balances produce zero diff and no unmatched items", () => {
  const ledger = baseLedger({
    transactions: [
      {
        id: 1, guid: "v1", date: "2026-08-05", number: "1", type: "Payment", narration: "grocery run", historical: false,
        entries: [{ accountId: 2, accountName: "Groceries", amount: -50 }, { accountId: 1, accountName: "Bank Of America", amount: 50 }],
      },
    ],
  });
  const plaidAccounts: PlaidAccountSummary[] = [
    { account_id: "a1", type: "depository", name: "Checking", institution_name: "Bank Of America", balances: { current: -50, available: -50 } },
  ];
  const plaidTransactions: PlaidTxSummary[] = [
    // A $50 deposit to the bank: vault records it as a Cr(+50) on Bank Of America; Plaid
    // represents money IN as a negative amount.
    { transaction_id: "t1", date: "2026-08-05", name: "Grocery Store", amount: -50, account_id: "a1" },
  ];
  const [status] = reconciliationStatusForAccounts(ledger, plaidAccounts, plaidTransactions, "2026-09-06");
  assert.ok(status);
  assert.equal(status.diff, 0);
  assert.equal(status.unmatchedPlaid.length, 0);
  assert.equal(status.unmatchedVault.length, 0);
});

test("reconciliationStatusForAccounts: flags an unmatched Plaid transaction and a nonzero diff", () => {
  const ledger = baseLedger();
  const plaidAccounts: PlaidAccountSummary[] = [
    { account_id: "a1", type: "depository", name: "Checking", institution_name: "Bank Of America", balances: { current: -50, available: -50 } },
  ];
  const plaidTransactions: PlaidTxSummary[] = [
    { transaction_id: "t1", date: "2026-08-05", name: "Grocery Store", amount: 50, account_id: "a1" },
  ];
  const [status] = reconciliationStatusForAccounts(ledger, plaidAccounts, plaidTransactions, "2026-09-06");
  assert.equal(status.diff, -50);
  assert.equal(status.unmatchedPlaid.length, 1);
});

test("reconciliationStatusForAccounts: an unrelated Plaid account with no vault match is simply omitted", () => {
  const ledger = baseLedger();
  const plaidAccounts: PlaidAccountSummary[] = [
    { account_id: "a1", type: "depository", name: "Random", institution_name: "Some Credit Union", balances: { current: 100 } },
  ];
  const results = reconciliationStatusForAccounts(ledger, plaidAccounts, [], "2026-09-06");
  assert.equal(results.length, 0);
});
