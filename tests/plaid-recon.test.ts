import assert from "node:assert/strict";
import test from "node:test";
import { vaultBookBalance, matchVaultAccount, reconciliationStatusForAccounts, vaultExceptionKey, plaidExceptionKey, type PlaidAccountSummary, type PlaidTxSummary } from "../lib/plaid-recon.ts";
import type { Ledger, BankReconException } from "../lib/vault-types.ts";

function baseLedger(overrides: Partial<Ledger> = {}): Ledger {
  return {
    currency: "USD",
    accounts: [
      { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 },
      { id: 2, name: "Groceries", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 },
      { id: 3, name: "Saving Account", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 },
      { id: 4, name: "Credit Card - BofA", parent: "Current Liabilities", category: "Liability", currency: "USD", openingBalance: 0 },
      { id: 5, name: "Credit Card - BofA - Hiral", parent: "Current Liabilities", category: "Liability", currency: "USD", openingBalance: 0 },
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

test("matchVaultAccount: BofA checking vs. savings resolve to their own distinct vault ledgers, not the same one", () => {
  const vaultAccounts = baseLedger().accounts;
  const checking: PlaidAccountSummary = { account_id: "a1", type: "depository", subtype: "checking", name: "Adv Plus Banking", institution_name: "Bank of America", balances: { current: 100 } };
  const savings: PlaidAccountSummary = { account_id: "a2", type: "depository", subtype: "savings", name: "Advantage Savings", institution_name: "Bank of America", balances: { current: 25000 } };
  assert.equal(matchVaultAccount(checking, vaultAccounts)?.id, 1);
  assert.equal(matchVaultAccount(savings, vaultAccounts)?.id, 3);
});

test("matchVaultAccount: two BofA credit cards with distinct nicknames resolve to their own separate GL accounts", () => {
  const vaultAccounts = baseLedger().accounts;
  const dkCard: PlaidAccountSummary = { account_id: "c1", type: "credit", subtype: "credit card", name: "Unlimited Cash Rewards Visa Signature", institution_name: "Bank of America", balances: { current: 7.1 } };
  const hiralCard: PlaidAccountSummary = { account_id: "c2", type: "credit", subtype: "credit card", name: "Customized Cash Rewards Visa Signature", institution_name: "Bank of America", balances: { current: 57.19 } };
  assert.equal(matchVaultAccount(dkCard, vaultAccounts)?.id, 4);
  assert.equal(matchVaultAccount(hiralCard, vaultAccounts)?.id, 5);
});

test("matchVaultAccount: an unrecognized institution is simply omitted, no fuzzy guessing", () => {
  const vaultAccounts = baseLedger().accounts;
  const unrelated: PlaidAccountSummary = { account_id: "a3", type: "depository", subtype: "checking", name: "Random", institution_name: "Some Credit Union", balances: { current: 100 } };
  assert.equal(matchVaultAccount(unrelated, vaultAccounts), undefined);
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
    { account_id: "a1", type: "depository", subtype: "checking", name: "Checking", institution_name: "Bank Of America", balances: { current: -50, available: -50 } },
  ];
  const plaidTransactions: PlaidTxSummary[] = [
    // A $50 grocery payment out of the bank: vault records it as a Cr(+50) on Bank Of America
    // (Cr decreases a depository asset); Plaid represents money OUT with a positive amount too --
    // same sign, no flip, on this specific account (see lib/plaid-recon.ts's comment for why).
    { transaction_id: "t1", date: "2026-08-05", name: "Grocery Store", amount: 50, account_id: "a1" },
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
    { account_id: "a1", type: "depository", subtype: "checking", name: "Checking", institution_name: "Bank Of America", balances: { current: -50, available: -50 } },
  ];
  const plaidTransactions: PlaidTxSummary[] = [
    { transaction_id: "t1", date: "2026-08-05", name: "Grocery Store", amount: 50, account_id: "a1" },
  ];
  const [status] = reconciliationStatusForAccounts(ledger, plaidAccounts, plaidTransactions, "2026-09-06");
  assert.equal(status.diff, -50);
  assert.equal(status.unmatchedPlaid.length, 1);
});

test("reconciliationStatusForAccounts: a real matching pair (interest earned) is NOT flagged as unmatched on either side -- regression for the mirror-imaged sign bug seen live", () => {
  const ledger = baseLedger({
    accounts: [
      { id: 3, name: "Saving Account", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 },
      { id: 6, name: "Interest Income", parent: "Indirect Incomes", category: "Income", currency: "USD", openingBalance: 0 },
    ],
    transactions: [
      {
        id: 1, guid: "v1", date: "2026-08-11", number: "1", type: "Receipt", narration: "Interest Received on BofA Savings Account", historical: false,
        // Interest earned increases the savings balance -- per vaultBookBalance, Dr (negative)
        // increases a depository asset, so this is correctly a -0.91 entry on the savings account.
        entries: [{ accountId: 3, accountName: "Saving Account", amount: -0.91 }, { accountId: 6, accountName: "Interest Income", amount: 0.91 }],
      },
    ],
  });
  const plaidAccounts: PlaidAccountSummary[] = [
    { account_id: "s1", type: "depository", subtype: "savings", name: "Advantage Savings", institution_name: "Bank of America", balances: { current: 25000.91, available: 25000.91 } },
  ];
  const plaidTransactions: PlaidTxSummary[] = [
    // Plaid: money IN = negative, same sign as the vault's own Dr(-0.91) entry on this account.
    { transaction_id: "t1", date: "2026-08-11", name: "Interest Earned", amount: -0.91, account_id: "s1" },
  ];
  const [status] = reconciliationStatusForAccounts(ledger, plaidAccounts, plaidTransactions, "2026-09-06");
  assert.equal(status.unmatchedPlaid.length, 0);
  assert.equal(status.unmatchedVault.length, 0);
});

test("reconciliationStatusForAccounts: a matching pair posted 2 days apart (a real delayed-posting case seen live) still matches", () => {
  const ledger = baseLedger({
    transactions: [
      {
        id: 1, guid: "v1", date: "2026-08-19", number: "1", type: "Payment", narration: "DD DOORDASHDASHPASS", historical: false,
        entries: [{ accountId: 4, accountName: "Credit Card - BofA", amount: -9.99 }, { accountId: 2, accountName: "Groceries", amount: 9.99 }],
      },
    ],
  });
  const plaidAccounts: PlaidAccountSummary[] = [
    { account_id: "c1", type: "credit", subtype: "credit card", name: "Unlimited Cash Rewards Visa Signature", institution_name: "Bank of America", balances: { current: -9.99 } },
  ];
  const plaidTransactions: PlaidTxSummary[] = [
    // Posted to the vault on the 19th, reported by Plaid on the 21st -- a 2-day gap, common for
    // pending-to-posted transitions.
    { transaction_id: "t1", date: "2026-08-21", name: "DD *DOORDASHDASHPASS", amount: -9.99, account_id: "c1" },
  ];
  const [status] = reconciliationStatusForAccounts(ledger, plaidAccounts, plaidTransactions, "2026-09-06");
  assert.equal(status.unmatchedPlaid.length, 0);
  assert.equal(status.unmatchedVault.length, 0);
});

test("reconciliationStatusForAccounts: an account Plaid reports no transactions for at all (e.g. an HSA) doesn't flag every vault voucher as unmatched", () => {
  const ledger = baseLedger({
    accounts: [{ id: 7, name: "HSA Fidelity Account", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 }],
    transactions: [
      {
        id: 1, guid: "v1", date: "2026-08-31", number: "1", type: "Payment", narration: "Kidney Stone Medicine", historical: false,
        entries: [{ accountId: 7, accountName: "HSA Fidelity Account", amount: 23.24 }, { accountId: 2, accountName: "Groceries", amount: -23.24 }],
      },
    ],
  });
  const plaidAccounts: PlaidAccountSummary[] = [
    { account_id: "h1", type: "depository", subtype: "hsa", name: "Health Savings Account", institution_name: "Fidelity", balances: { current: 235.41 } },
  ];
  // No plaidTransactions at all for this account -- Plaid only exposes a balance for it.
  const [status] = reconciliationStatusForAccounts(ledger, plaidAccounts, [], "2026-09-06");
  assert.equal(status.noPlaidTransactionFeed, true);
  assert.equal(status.unmatchedVault.length, 0);
});

test("reconciliationStatusForAccounts: an unrelated Plaid account with no vault match is simply omitted", () => {
  const ledger = baseLedger();
  const plaidAccounts: PlaidAccountSummary[] = [
    { account_id: "a1", type: "depository", subtype: "checking", name: "Random", institution_name: "Some Credit Union", balances: { current: 100 } },
  ];
  const results = reconciliationStatusForAccounts(ledger, plaidAccounts, [], "2026-09-06");
  assert.equal(results.length, 0);
});

test("reconciliationStatusForAccounts: two unrecognized BofA cards both fall back to the shared 'Credit Card - BofA' GL and combine into ONE row, not a separate row each", () => {
  const ledger = baseLedger();
  // Neither nickname is in the known BOFA_CARD_GL_BY_NAME map, so both fall back to the generic
  // "Credit Card - BofA" match -- this is the one case that's still SUPPOSED to combine into a
  // single row (unlike checking/savings/named-cards, which each resolve to their own ledger).
  const plaidAccounts: PlaidAccountSummary[] = [
    { account_id: "c1", type: "credit", subtype: "credit card", name: "Some New Card Product", institution_name: "Bank of America", balances: { current: 10 } },
    { account_id: "c2", type: "credit", subtype: "credit card", name: "Another New Card Product", institution_name: "Bank of America", balances: { current: 20 } },
  ];
  const results = reconciliationStatusForAccounts(ledger, plaidAccounts, [], "2026-09-06");
  assert.equal(results.length, 1);
  assert.equal(results[0].account.id, 4);
  assert.equal(results[0].plaidAccounts.length, 2);
  assert.equal(results[0].plaidBalance, 30);
});

test("reconciliationStatusForAccounts: a 'Mark as reconciled' exception permanently excludes that specific entry from either unmatched list", () => {
  const ledger = baseLedger({
    transactions: [
      {
        id: 1, guid: "cash-voucher", date: "2026-08-31", number: "1", type: "Payment", narration: "Cash purchase, no Plaid line", historical: false,
        entries: [{ accountId: 4, accountName: "Credit Card - BofA", amount: -1322.90 }, { accountId: 2, accountName: "Groceries", amount: 1322.90 }],
      },
    ],
  });
  const plaidAccounts: PlaidAccountSummary[] = [
    { account_id: "c1", type: "credit", subtype: "credit card", name: "Unlimited Cash Rewards Visa Signature", institution_name: "Bank of America", balances: { current: 0 } },
  ];
  const plaidTransactions: PlaidTxSummary[] = [
    // A one-off Plaid entry the user has decided not to book as a voucher (e.g. a bank fee).
    { transaction_id: "fee1", date: "2026-08-15", name: "Monthly Fee", amount: 5, account_id: "c1" },
  ];
  const exceptions: BankReconException[] = [
    { key: vaultExceptionKey("cash-voucher"), label: "Cash purchase", markedAt: "2026-09-01T00:00:00.000Z" },
    { key: plaidExceptionKey("c1", "fee1"), label: "Monthly Fee", markedAt: "2026-09-01T00:00:00.000Z" },
  ];

  const withoutExceptions = reconciliationStatusForAccounts(ledger, plaidAccounts, plaidTransactions, "2026-09-06");
  assert.equal(withoutExceptions[0].unmatchedVault.length, 1);
  assert.equal(withoutExceptions[0].unmatchedPlaid.length, 1);

  const withExceptions = reconciliationStatusForAccounts(ledger, plaidAccounts, plaidTransactions, "2026-09-06", exceptions);
  assert.equal(withExceptions[0].unmatchedVault.length, 0);
  assert.equal(withExceptions[0].unmatchedPlaid.length, 0);
});
