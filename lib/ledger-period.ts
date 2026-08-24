import type { Tx, Account } from "./vault-types";

export interface LedgerPeriodTotals {
  debit: number;
  credit: number;
}

/** Net Debit/Credit for one named ledger account across a date range (inclusive) -- same logic
 * as the Ledgers report's own period calculation (an entry with a negative signed amount is a
 * debit, sign flipped to positive; everything else a credit). Skips deleted/cancelled vouchers.
 * Returns null if no account with that exact name exists, so callers can tell "zero activity"
 * apart from "no such ledger" (e.g. a company that never had that account). */
export function ledgerPeriodTotals(
  transactions: Tx[],
  accounts: Account[],
  ledgerName: string,
  startDate: string,
  endDate: string
): LedgerPeriodTotals | null {
  const account = accounts.find((a) => a.name.trim().toLowerCase() === ledgerName.trim().toLowerCase());
  if (!account) return null;
  let debit = 0;
  let credit = 0;
  for (const t of transactions) {
    if (t.deleted || t.cancelled) continue;
    if (t.date < startDate || t.date > endDate) continue;
    for (const e of t.entries) {
      if (e.accountId !== account.id) continue;
      if (e.amount < 0) debit += -e.amount;
      else credit += e.amount;
    }
  }
  return { debit, credit };
}
