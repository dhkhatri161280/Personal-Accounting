import type { Account, Ledger, Tx } from "./vault-types";

// A pure relocation from components/vault/PlaidImport.tsx (was a private helper there) -- moved
// here so it can be shared with the Bank Reconciliation report without duplicating the
// Dr/Cr-to-balance sign convention. Behavior is unchanged.
export function vaultBookBalance(accountId: number, plaidType: string, ledger: Ledger): number {
  let sum = 0;
  for (const v of ledger.transactions) {
    if (v.deleted || v.cancelled) continue;
    for (const e of v.entries) {
      if (e.accountId === accountId) sum += e.amount;
    }
  }
  // Vault convention: Dr=negative, Cr=positive
  // Asset (depository): balance = -sum  (Dr entries increase the asset)
  // Liability (credit): balance = +sum  (Cr entries increase what you owe)
  return plaidType === "credit" ? sum : -sum;
}

// Minimal shape of what /api/plaid/transactions returns -- just the fields this report needs,
// not the full PlaidAccount/PlaidTxRaw interfaces private to PlaidImport.tsx.
export type PlaidAccountSummary = {
  account_id: string;
  type: string;
  name: string;
  institution_name: string;
  balances: { current: number | null; available?: number | null };
};
export type PlaidTxSummary = {
  transaction_id: string;
  date: string;
  name: string;
  amount: number; // Plaid: positive = money OUT, negative = money IN
  account_id: string;
  pending?: boolean;
};

// Maps one Plaid account to a vault GL account by exact (case-insensitive) name match against
// either the Plaid account's own name or its institution name -- deliberately no fuzzy/alias
// guessing here (unlike buildDraft()'s heuristics elsewhere), since a wrong pairing in a
// reconciliation report is worse than simply omitting an account this can't confidently match.
export function matchAccountToVault(plaidAccount: PlaidAccountSummary, vaultAccounts: Account[]): Account | undefined {
  const candidates = [plaidAccount.name, plaidAccount.institution_name].map((s) => s.toLowerCase().trim());
  return vaultAccounts.find((a) => candidates.includes(a.name.toLowerCase().trim()));
}

export type ReconAccountStatus = {
  account: Account;
  // One vault account can have several physical Plaid accounts behind it (e.g. a bank exposes
  // checking + savings under one institution, and neither name matches the vault ledger's name
  // closely enough to tell them apart) -- all of them, not just one.
  plaidAccounts: PlaidAccountSummary[];
  plaidBalance: number; // summed across plaidAccounts
  vaultBalance: number;
  diff: number;
  unmatchedPlaid: PlaidTxSummary[];
  unmatchedVault: Tx[];
};

export const DIFF_TOL = 0.005;
const DATE_TOL_DAYS = 1;

function daysApart(a: string, b: string): number {
  return Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000;
}

// Net amount a vault Tx moves through one specific account (sum of that account's own entries,
// since a split voucher can touch the same account more than once) -- compared against Plaid's
// single-line transaction amount (sign-flipped: Plaid positive = money out = a vault debit).
function vaultTxAccountAmount(t: Tx, accountId: number): number {
  return t.entries.filter((e) => e.accountId === accountId).reduce((s, e) => s + e.amount, 0);
}

// Per matched account: live Plaid balance vs. the vault's own computed balance, plus a simple
// two-way date+amount comparison (not Plaid Import's multi-pattern alreadyImported() matcher) --
// what's in Plaid but not yet posted to the vault, and what's posted to the vault but Plaid
// hasn't reported (deliberately un-adjusted for pending/uncleared items -- see lib/plaid-recon.ts's
// module doc in the Bank Reconciliation report for why that tradeoff was made).
//
// Grouped by matched vault account, not one row per Plaid account -- an institution that exposes
// several physical accounts (checking + savings) under names that don't individually match any
// vault ledger all fall back to the SAME institution-name match, and without grouping that
// produced several rows all comparing the identical vault balance against different Plaid
// balances, which reads as "4 accounts need attention" when it's really one ambiguous mapping.
export function reconciliationStatusForAccounts(
  data: Ledger,
  plaidAccounts: PlaidAccountSummary[],
  plaidTransactions: PlaidTxSummary[],
  todayStr: string
): ReconAccountStatus[] {
  // Bounds the "in vault, no Plaid match" comparison to roughly the same window Plaid itself
  // returns -- without this, every old historical voucher outside Plaid's fetch window would
  // spuriously show up as "unmatched" since Plaid never reports transactions that old.
  const windowStart = new Date(todayStr + "T00:00:00Z");
  windowStart.setUTCDate(windowStart.getUTCDate() - 90);
  const windowStartStr = windowStart.toISOString().slice(0, 10);

  const groups = new Map<number, { account: Account; plaidAccounts: PlaidAccountSummary[] }>();
  for (const pa of plaidAccounts) {
    const account = matchAccountToVault(pa, data.accounts);
    if (!account) continue;
    const g = groups.get(account.id) ?? { account, plaidAccounts: [] };
    g.plaidAccounts.push(pa);
    groups.set(account.id, g);
  }

  const results: ReconAccountStatus[] = [];
  for (const { account, plaidAccounts: paGroup } of groups.values()) {
    // Same convention vaultBookBalance already returns: depository = positive asset value
    // (prefer `available`, which excludes pending holds, matching PlaidImport.tsx's Balances
    // tab), credit = positive amount owed. No sign flip needed on either side.
    const balanceOf = (pa: PlaidAccountSummary) =>
      pa.type === "depository" ? (pa.balances.available ?? pa.balances.current ?? 0) : (pa.balances.current ?? 0);
    const plaidBalance = paGroup.reduce((s, pa) => s + balanceOf(pa), 0);
    const vaultBalance = vaultBookBalance(account.id, paGroup[0].type, data);
    const diff = plaidBalance - vaultBalance;

    const groupAcctIds = new Set(paGroup.map((pa) => pa.account_id));
    const acctPlaidTxs = plaidTransactions.filter((t) => groupAcctIds.has(t.account_id));
    const recentVaultTxs = data.transactions.filter(
      (t) => !t.deleted && !t.cancelled && t.date >= windowStartStr && t.entries.some((e) => e.accountId === account.id)
    );

    const unmatchedPlaid = acctPlaidTxs.filter((pt) => {
      // Plaid: positive = money out = a vault debit (negative entry); flip sign to compare.
      const expected = -pt.amount;
      return !recentVaultTxs.some(
        (vt) => daysApart(vt.date, pt.date) <= DATE_TOL_DAYS && Math.abs(vaultTxAccountAmount(vt, account.id) - expected) < 0.5
      );
    });
    const unmatchedVault = recentVaultTxs.filter((vt) => {
      const amt = vaultTxAccountAmount(vt, account.id);
      return !acctPlaidTxs.some((pt) => daysApart(vt.date, pt.date) <= DATE_TOL_DAYS && Math.abs(-pt.amount - amt) < 0.5);
    });

    results.push({ account, plaidAccounts: paGroup, plaidBalance, vaultBalance, diff, unmatchedPlaid, unmatchedVault });
  }
  return results.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}
