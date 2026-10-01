import assert from "node:assert/strict";
import test from "node:test";
import { consolidateLedger } from "../lib/gr-consolidation.ts";
import type { Account, Tx, Ledger } from "../lib/vault-types.ts";

function account(id: number, name: string, parent: string): Account {
  return { id, name, parent, category: "Income", currency: "INR", openingBalance: 0 };
}

function tx(id: number, date: string, entries: Tx["entries"]): Tx {
  return { id, guid: `v${id}`, date, number: String(id), type: "Receipt", narration: "test", historical: false, entries };
}

function ledger(accounts: Account[], transactions: Tx[]): Ledger {
  return { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions };
}

test("consolidateLedger: resolves a transaction entry's account name via accountId, not its possibly-stale stored name", () => {
  const accounts = [
    account(1, "Salary Income - TCS", "Direct Incomes"),
    account(2, "Bank Of India", "Bank Accounts"),
  ];
  const transactions = [
    // The voucher's own stored accountName lacks the hyphen the real ledger has -- a real,
    // observed case (confirmed via a live diagnostic on the user's actual India book) where a
    // voucher's snapshot name drifted from the current ledger name, silently orphaning that
    // account's entire real activity from every GR report.
    tx(1, "2026-04-05", [
      { accountId: 2, accountName: "Bank Of India", amount: -50000 },
      { accountId: 1, accountName: "Salary Income TCS", amount: 50000 },
    ]),
  ];
  const indiaData = ledger(accounts, transactions);
  const usData = ledger([], []);
  const gr = consolidateLedger(usData, indiaData, {});

  const salaryEntry = gr.transactions[0].entries.find((e) => e.accountName === "Salary Income - TCS");
  assert.ok(salaryEntry, "transaction entry should carry the account's real current name (with hyphen), not the stale stored one");
  assert.equal(salaryEntry!.amountInr, 50000);

  // Confirm the account itself is findable with a non-zero closing balance -- this is exactly
  // the real-world symptom: before this fix, gr.accounts had a "Salary Income - TCS" account
  // with closingInr === 0 (built from Account.openingBalance alone, no transaction activity ever
  // matched it), even though real money moved through it.
  const salaryAccount = gr.accounts.find((a) => a.name === "Salary Income - TCS");
  assert.ok(salaryAccount);
  assert.equal(salaryAccount!.creditInr, 50000);
});
