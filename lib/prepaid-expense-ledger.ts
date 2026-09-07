import type { Account, Ledger, PrepaidExpense, Tx } from "./vault-types";
import { nextTransactionIds, nextVoucherNumber } from "./vault-accounting";
import { appendAuditEntry } from "./audit";
import { pendingAmortizationMonths, remainingBalance } from "./prepaid-expense";
import { findOrCreateAccount, registerOpeningBalance } from "./opening-balance-equity";

const CURRENT_ASSETS_GROUP_NAME = "Current Assets";
const EXPENSE_GROUP_NAME = "Indirect Expenses";

// Finds an existing ledger account by name under "Current Assets", or creates one -- used when
// registering a new prepaid expense so its unamortized balance shows in the trial balance/balance
// sheet immediately. A brand-new account's starting balance is posted via a real, auditable
// Journal Tx against "Opening Balance Equity" (registerOpeningBalance) rather than a silent
// Account.openingBalance value with no double-entry counterpart -- that trick was tried first and
// confirmed live to break the Balance Sheet check by exactly the account's starting amount. Never
// touches an existing account's real balance/history.
export function getOrCreatePrepaidAccount(data: Ledger, name: string, totalAmount: number, startDate: string): { data: Ledger; account: Account } {
  const { account, accounts, created } = findOrCreateAccount(data.accounts, name, CURRENT_ASSETS_GROUP_NAME, data.currency);
  let next: Ledger = { ...data, accounts };
  if (created) next = registerOpeningBalance(next, account, totalAmount, startDate, `Registered prepaid expense: ${name}`);
  return { data: next, account };
}

// Finds an existing expense-nature account by name, or creates one under "Indirect Expenses" --
// used for the target expense account picker when the user types a new category name instead of
// picking an existing one.
export function getOrCreateExpenseAccount(data: Ledger, name: string): { data: Ledger; account: Account } {
  const existing = data.accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (existing) return { data, account: existing };
  const account: Account = {
    id: Math.max(0, ...data.accounts.map((a) => a.id)) + 1,
    name,
    parent: EXPENSE_GROUP_NAME,
    category: "Expense",
    currency: data.currency,
    openingBalance: 0,
    active: true,
  };
  return { data: { ...data, accounts: [...data.accounts, account] }, account };
}

// Posts every pending amortization month for every active (not written-off) prepaid expense,
// through throughDate, as one Journal Tx per item-month (Dr the item's own target expense account
// / Cr its own prepaid asset account -- no shared pool account, unlike Fixed Assets' Depreciation
// Expense/Accumulated Depreciation, since each prepaid item hits its own expense category).
// Mirrors lib/fixed-assets-ledger.ts's postDepreciation exactly.
export function postAmortization(data: Ledger, throughDate: string): { data: Ledger; postedCount: number } {
  const items = data.prepaidExpenses ?? [];
  let workingTxs = [...data.transactions];
  let workingLedger: Ledger = { ...data, transactions: workingTxs };
  const updatedItems: PrepaidExpense[] = [];
  let postedCount = 0;

  for (const item of items) {
    if (item.writtenOff) {
      updatedItems.push(item);
      continue;
    }
    const pending = pendingAmortizationMonths(item, throughDate);
    if (!pending.length) {
      updatedItems.push(item);
      continue;
    }
    const expenseAcct = workingLedger.accounts.find((a) => a.id === item.expenseAccountId);
    const prepaidAcct = workingLedger.accounts.find((a) => a.id === item.accountId);
    if (!expenseAcct || !prepaidAcct) {
      updatedItems.push(item);
      continue;
    }
    let lastThrough = item.lastAmortizedThrough;
    for (const { yearMonth, amount } of pending) {
      if (amount <= 0) continue;
      const postDate = `${yearMonth}-28`;
      const tx: Tx = {
        id: nextTransactionIds(workingTxs, 1)[0],
        guid: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        date: postDate,
        number: nextVoucherNumber(workingLedger, "Journal", postDate),
        type: "Journal",
        narration: `Amortization - ${item.name} - ${yearMonth}`,
        historical: false,
        cancelled: false,
        syncStatus: "pending",
        entries: [
          { accountId: expenseAcct.id, accountName: expenseAcct.name, amount: -amount },
          { accountId: prepaidAcct.id, accountName: prepaidAcct.name, amount },
        ],
      };
      workingTxs = [...workingTxs, tx];
      workingLedger = { ...workingLedger, transactions: workingTxs };
      workingLedger = appendAuditEntry(workingLedger, {
        entity: "voucher",
        entityId: tx.guid,
        action: "created",
        summary: `Amortization posted for ${item.name}: ${yearMonth}`,
      });
      workingTxs = workingLedger.transactions;
      lastThrough = yearMonth;
      postedCount++;
    }
    updatedItems.push({ ...item, lastAmortizedThrough: lastThrough });
  }

  return { data: { ...workingLedger, transactions: workingTxs, prepaidExpenses: updatedItems }, postedCount };
}

// Writes off whatever's left of a prepaid expense immediately: one Tx recognizing the full
// remaining balance as expense (Dr the target expense account / Cr the prepaid asset account) --
// no cash/proceeds, no gain-or-loss plug, simpler than lib/fixed-assets-ledger.ts's disposeAsset
// since a prepaid write-off is just accelerated expense recognition.
export function writeOffPrepaid(data: Ledger, prepaidId: string, date: string): { data: Ledger } | { error: string } {
  const item = (data.prepaidExpenses ?? []).find((p) => p.id === prepaidId);
  if (!item) return { error: "Prepaid expense not found" };
  if (item.writtenOff) return { error: "Already written off" };
  const expenseAcct = data.accounts.find((a) => a.id === item.expenseAccountId);
  const prepaidAcct = data.accounts.find((a) => a.id === item.accountId);
  if (!expenseAcct || !prepaidAcct) return { error: "Account not found" };

  const remaining = remainingBalance(item, date);
  if (remaining <= 0) {
    const updatedItems = (data.prepaidExpenses ?? []).map((p) => (p.id === prepaidId ? { ...p, writtenOff: { date } } : p));
    return { data: { ...data, prepaidExpenses: updatedItems } };
  }

  const tx: Tx = {
    id: nextTransactionIds(data.transactions, 1)[0],
    guid: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    date,
    number: nextVoucherNumber(data, "Journal", date),
    type: "Journal",
    narration: `Write-off - ${item.name}`,
    historical: false,
    cancelled: false,
    syncStatus: "pending",
    entries: [
      { accountId: expenseAcct.id, accountName: expenseAcct.name, amount: -remaining },
      { accountId: prepaidAcct.id, accountName: prepaidAcct.name, amount: remaining },
    ],
  };

  const updatedItems = (data.prepaidExpenses ?? []).map((p) =>
    p.id === prepaidId ? { ...p, writtenOff: { date, txGuid: tx.guid } } : p
  );

  let next: Ledger = { ...data, transactions: [...data.transactions, tx], prepaidExpenses: updatedItems };
  next = appendAuditEntry(next, {
    entity: "voucher",
    entityId: tx.guid,
    action: "created",
    summary: `Wrote off remaining balance of ${item.name} on ${date} (${remaining})`,
  });
  return { data: next };
}
