import assert from "node:assert/strict";
import test from "node:test";
import { auditNarrationCategorization } from "../lib/categorization-audit.ts";
import type { Account, Tx, Ledger } from "../lib/vault-types.ts";

function account(id: number, name: string, parent: string): Account {
  return { id, name, parent, category: "Expense", currency: "USD", openingBalance: 0 };
}

function tx(
  guid: string,
  date: string,
  narration: string,
  debitAccountId: number,
  creditAccountId: number,
  amount: number,
  opts: { plaidTxId?: string; type?: string } = {}
): Tx {
  return {
    id: 0,
    guid,
    date,
    number: guid,
    type: opts.type ?? "Payment",
    narration,
    historical: false,
    plaidTxId: opts.plaidTxId,
    entries: [
      { accountId: debitAccountId, accountName: "", amount: -amount },
      { accountId: creditAccountId, accountName: "", amount },
    ],
  };
}

function ledger(accounts: Account[], transactions: Tx[]): Ledger {
  return { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions };
}

test("auditNarrationCategorization: flags a 'thin' categorization -- the real DECCAN MORSEL / Vehicle Maintenance bug reproduced", () => {
  const accounts = [
    account(1, "Vehicle Maintenance", "Indirect Expenses"),
    account(2, "Citi Credit Card", "Bank Accounts"),
  ];
  const transactions = [
    // A genuine, correctly-categorized prior Vehicle Maintenance voucher that happens to mention
    // "Fremont" (e.g. Tesla's Fremont service center).
    tx("v1", "2026-07-15", "Charging @ Tesla Fremont", 1, 2, 10.85),
    // The bug: a restaurant charge that coincidentally shares the "fremont" token, auto-posted
    // (plaidTxId set) to the same Vehicle Maintenance ledger with no other corroborating evidence
    // at all.
    tx("v2", "2026-08-20", "DECCAN MORSEL FREMONT", 1, 2, 8.25, { plaidTxId: "plaid-v2" }),
  ];
  const flags = auditNarrationCategorization(ledger(accounts, transactions));

  assert.equal(flags.length, 1);
  assert.equal(flags[0].guid, "v2");
  assert.equal(flags[0].kind, "thin");
  assert.equal(flags[0].ownVotes, 1);
  assert.equal(flags[0].suggestedDebitId, undefined); // "thin" has no computable alternative
});

test("auditNarrationCategorization: flags a 'conflicting' categorization with a concrete suggested ledger", () => {
  const accounts = [
    account(1, "Vehicle Maintenance", "Indirect Expenses"),
    account(2, "Groceries", "Indirect Expenses"),
    account(3, "Citi Credit Card", "Bank Accounts"),
  ];
  const transactions = [
    // Three genuine, correctly-categorized "Shopping @ X" grocery-type vouchers.
    tx("v1", "2026-05-01", "Shopping @ Safeway", 2, 3, 40),
    tx("v2", "2026-06-01", "Shopping @ Trader Joes", 2, 3, 55),
    tx("v3", "2026-07-01", "Shopping @ Costco", 2, 3, 120),
    // The bug: a food-delivery charge auto-posted to Vehicle Maintenance instead, sharing only
    // the generic "Shopping" word with the three Groceries vouchers above.
    tx("v4", "2026-08-13", "Shopping @ DoorDash", 1, 3, 9.99, { plaidTxId: "plaid-v4" }),
  ];
  const flags = auditNarrationCategorization(ledger(accounts, transactions));

  assert.equal(flags.length, 1);
  assert.equal(flags[0].guid, "v4");
  assert.equal(flags[0].kind, "conflicting");
  assert.equal(flags[0].ownVotes, 0); // nothing else supports the Vehicle Maintenance ledger
  assert.equal(flags[0].suggestedDebitId, 2); // Groceries
  assert.equal(flags[0].suggestedVotes, 3);
});

test("auditNarrationCategorization: does NOT flag a correct ledger just because a different card paid for it -- the real false-positive this audit flagged", () => {
  // Real false positive: dozens of already-correct House Hold Exps vouchers got flagged as
  // "wrong" purely because they were paid on a less-common card than the majority -- a real
  // difference in payment method, not a miscategorization. The audit must compare the debit
  // (expense) ledger only, never the credit (payment) side.
  const accounts = [
    account(1, "House Hold Exps - Oct 26", "Indirect Expenses"),
    account(2, "Citi Credit Card", "Bank Accounts"),
    account(3, "BofA Checking", "Bank Accounts"),
  ];
  const transactions = [
    // Majority paid via Citi.
    tx("v1", "2026-10-01", "Walmart", 1, 2, 40),
    tx("v2", "2026-10-02", "Walmart", 1, 2, 35),
    tx("v3", "2026-10-03", "Walmart", 1, 2, 28),
    // This one, same correct ledger, just paid via a different (less common) account.
    tx("v4", "2026-10-13", "Walmart", 1, 3, 19.99, { plaidTxId: "plaid-v4" }),
  ];
  const flags = auditNarrationCategorization(ledger(accounts, transactions));
  assert.deepEqual(flags, []);
});

test("auditNarrationCategorization: a genuinely multi-purpose merchant (gas vs. groceries) is resolved by the MORE SPECIFIC shared word, not raw vote count", () => {
  // Real false positive: "Gasoline @ Costco" (correctly Vehicle Maintenance) got suggested for
  // House Hold Exps purely because "costco" shows up on far more grocery-run vouchers than gas
  // ones. The specific word "gasoline" -- which has only ever meant Vehicle Maintenance in this
  // ledger -- should outweigh the ambiguous "costco" token shared with both categories.
  const accounts = [
    account(1, "Vehicle Maintenance", "Indirect Expenses"),
    account(2, "House Hold Exps - Oct 26", "Indirect Expenses"),
    account(3, "Citi Credit Card", "Bank Accounts"),
  ];
  const transactions = [
    // A handful of genuine gas purchases -- always "gasoline" + "costco", always Vehicle Maintenance.
    tx("v1", "2026-06-01", "Gasoline @ Costco", 1, 3, 45),
    tx("v2", "2026-07-01", "Gasoline @ Costco", 1, 3, 48),
    // Far more grocery runs -- just "costco", never "gasoline", always House Hold Exps.
    tx("v3", "2026-05-01", "Shopping @ Costco", 2, 3, 120),
    tx("v4", "2026-05-15", "Shopping @ Costco", 2, 3, 95),
    tx("v5", "2026-06-15", "Shopping @ Costco", 2, 3, 110),
    tx("v6", "2026-07-15", "Shopping @ Costco", 2, 3, 130),
    tx("v7", "2026-08-01", "Shopping @ Costco", 2, 3, 88),
    // The voucher under audit: another genuine gas purchase, correctly posted to Vehicle Maintenance.
    tx("v8", "2026-08-11", "Gasoline @ Costco", 1, 3, 52, { plaidTxId: "plaid-v8" }),
  ];
  const flags = auditNarrationCategorization(ledger(accounts, transactions));
  assert.deepEqual(flags, []);
});

test("auditNarrationCategorization: does NOT flag a well-supported categorization", () => {
  const accounts = [
    account(1, "Groceries", "Indirect Expenses"),
    account(2, "Citi Credit Card", "Bank Accounts"),
  ];
  const transactions = [
    tx("v1", "2026-05-01", "Shopping @ Costco", 1, 2, 120),
    tx("v2", "2026-06-01", "Shopping @ Costco", 1, 2, 95),
    tx("v3", "2026-07-01", "Shopping @ Costco", 1, 2, 110, { plaidTxId: "plaid-v3" }),
  ];
  const flags = auditNarrationCategorization(ledger(accounts, transactions));
  assert.deepEqual(flags, []);
});

test("auditNarrationCategorization: ignores manually-entered vouchers (no plaidTxId), even with a coincidental word match", () => {
  const accounts = [
    account(1, "Vehicle Maintenance", "Indirect Expenses"),
    account(2, "Citi Credit Card", "Bank Accounts"),
  ];
  const transactions = [
    tx("v1", "2026-07-15", "Charging @ Tesla Fremont", 1, 2, 10.85),
    // Same coincidental-word shape as the real bug, but typed in by hand -- not the auto-import's
    // mistake to flag.
    tx("v2", "2026-08-20", "DECCAN MORSEL FREMONT", 1, 2, 8.25),
  ];
  const flags = auditNarrationCategorization(ledger(accounts, transactions));
  assert.deepEqual(flags, []);
});

test("auditNarrationCategorization: a brand-new category with zero history is not flagged (no corroboration either way is not evidence of a mistake)", () => {
  const accounts = [
    account(1, "Pet Expenses", "Indirect Expenses"),
    account(2, "Citi Credit Card", "Bank Accounts"),
  ];
  const transactions = [tx("v1", "2026-08-01", "Chewy Pet Supplies", 1, 2, 42, { plaidTxId: "plaid-v1" })];
  const flags = auditNarrationCategorization(ledger(accounts, transactions));
  assert.deepEqual(flags, []);
});
