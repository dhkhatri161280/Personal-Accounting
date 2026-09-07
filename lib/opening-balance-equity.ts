import type { Account, Ledger, Tx } from "./vault-types";
import { nextTransactionIds, nextVoucherNumber } from "./vault-accounting";
import { appendAuditEntry } from "./audit";

const OPENING_BALANCE_EQUITY_ACCOUNT_NAME = "Opening Balance Equity";
const CAPITAL_GROUP_NAME = "Capital Account";

// Shared by lib/fixed-assets-ledger.ts and lib/prepaid-expense-ledger.ts (safe to import
// cross-file here -- unlike the pure-math lib/fixed-assets.ts / lib/prepaid-expense.ts, these
// ledger-mutating files aren't run through node --test directly, so the runtime-import
// resolution gap that forces self-containment there doesn't apply).
export function findOrCreateAccount(
  accounts: Account[],
  name: string,
  groupName: string,
  currency: string,
  openingBalance = 0,
  category = "Asset"
): { account: Account; accounts: Account[]; created: boolean } {
  const existing = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (existing) return { account: existing, accounts, created: false };
  const account: Account = {
    id: Math.max(0, ...accounts.map((a) => a.id)) + 1,
    name,
    parent: groupName,
    category,
    currency,
    openingBalance,
    active: true,
  };
  return { account, accounts: [...accounts, account], created: true };
}

// Registers the starting balance of a newly-created account via a real, auditable Journal Tx
// against a shared "Opening Balance Equity" account instead of silently setting
// Account.openingBalance with no double-entry counterpart. Account.openingBalance alone breaks
// the Balance Sheet's own check (assets = liabilities + capital) by exactly that amount, since
// nothing else in the books moves to offset it -- confirmed live: adding one $1,200 fixed
// asset/prepaid expense this way shifted the Balance Sheet check by exactly $1,200. This is the
// standard "register something I already own (or owe)" pattern real ERPs use for onboarding
// pre-existing balances into a books-in-progress system.
// direction "debit" (default, for an asset-like account): Dr the account / Cr equity.
// direction "credit" (for a liability like a loan): Cr the account / Dr equity.
export function registerOpeningBalance(
  data: Ledger,
  account: Account,
  amount: number,
  date: string,
  narration: string,
  direction: "debit" | "credit" = "debit"
): Ledger {
  if (amount === 0) return data;
  const { account: equityAcct, accounts } = findOrCreateAccount(data.accounts, OPENING_BALANCE_EQUITY_ACCOUNT_NAME, CAPITAL_GROUP_NAME, data.currency);
  let next: Ledger = { ...data, accounts };
  const accountAmount = direction === "debit" ? -amount : amount;
  const tx: Tx = {
    id: nextTransactionIds(next.transactions, 1)[0],
    guid: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    date,
    number: nextVoucherNumber(next, "Journal", date),
    type: "Journal",
    narration,
    historical: false,
    cancelled: false,
    syncStatus: "pending",
    entries: [
      { accountId: account.id, accountName: account.name, amount: accountAmount },
      { accountId: equityAcct.id, accountName: equityAcct.name, amount: -accountAmount },
    ],
  };
  next = { ...next, transactions: [...next.transactions, tx] };
  next = appendAuditEntry(next, { entity: "voucher", entityId: tx.guid, action: "created", summary: narration });
  return next;
}
