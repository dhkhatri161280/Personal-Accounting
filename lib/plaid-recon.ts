import type { Account, BankReconException, Ledger, Tx } from "./vault-types";

// Namespaced exception keys -- shared with the "Mark as reconciled" UI so both sides agree on
// what a given entry's key looks like.
export const vaultExceptionKey = (txGuid: string) => `v:${txGuid}`;
export const plaidExceptionKey = (accountId: string, transactionId: string) => `p:${accountId}:${transactionId}`;

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
  subtype: string;
  name: string;
  institution_name?: string;
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

// A pure relocation from components/vault/PlaidImport.tsx -- generic ledger-name lookup used
// throughout that file's own matching heuristics. Two passes: try an EXACT match for every
// candidate name first (in priority order), only falling back to substring matching if none hit.
export function findAcct(accounts: Account[], ...names: string[]): Account | undefined {
  for (const name of names) {
    const exact = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (exact) return exact;
  }
  for (const name of names) {
    const lc = name.toLowerCase();
    const partial = accounts.find((a) => a.name.toLowerCase().includes(lc));
    if (partial) return partial;
  }
}

// A pure relocation from components/vault/PlaidImport.tsx -- two physical BofA cards map to two
// separate GL accounts; Plaid's own account nickname is the one stable signal that tells them
// apart (institution name/type alone can't, since both are "BofA credit").
const BOFA_CARD_GL_BY_NAME: Record<string, string> = {
  "customized cash rewards visa signature": "Credit Card - BofA - Hiral",
  "unlimited cash rewards visa signature": "Credit Card - BofA",
};
export function bofaCardGlAccountName(plaidAcctName: string): string | undefined {
  return BOFA_CARD_GL_BY_NAME[(plaidAcctName || "").toLowerCase().trim()];
}

// A pure relocation from components/vault/PlaidImport.tsx's `matchVaultAccount` -- the SAME
// hand-tuned per-institution matcher the (proven, working) Balances tab already uses, reused here
// instead of a weaker from-scratch matcher. An earlier version of this file matched by raw
// institution name alone, which collapsed several distinct physical accounts at one bank (e.g.
// BofA checking + savings + two credit cards) onto a single vault ledger and produced misleading
// "need attention" rows comparing against the wrong balance entirely -- this is the real fix for
// that, not a heuristic patch on top of the broken matcher.
export function matchVaultAccount(plaidAcct: PlaidAccountSummary, vaultAccounts: Account[]): Account | undefined {
  const inst = (plaidAcct.institution_name || "").toLowerCase();
  const isCreditAcct = plaidAcct.type === "credit";
  const isSavings = plaidAcct.subtype === "savings";
  if (/bank.of.america|bofa/i.test(inst)) {
    if (isCreditAcct) {
      const specific = bofaCardGlAccountName(plaidAcct.name);
      return findAcct(vaultAccounts, ...(specific ? [specific] : []), "Credit Card - BofA", "BofA Credit Card");
    }
    if (isSavings) return findAcct(vaultAccounts, "Saving Account", "Savings Account", "BofA Savings", "Savings");
    return findAcct(vaultAccounts, "Bank Of America", "Bank of America");
  }
  if (/american express|amex/i.test(inst)) return findAcct(vaultAccounts, "AMEX Credit Card", "American Express", "Amex");
  if (/chase/i.test(inst))
    return isCreditAcct ? findAcct(vaultAccounts, "Chase Credit Card") : findAcct(vaultAccounts, "Chase Bank", "Chase");
  if (/citi(?!zen)/i.test(inst)) return findAcct(vaultAccounts, "Citi Credit Card", "Citibank", "Citi");
  if (/wells.fargo/i.test(inst)) return findAcct(vaultAccounts, "Wells Fargo");
  if (/fidelity/i.test(inst) && plaidAcct.subtype === "hsa") return findAcct(vaultAccounts, "HSA Fidelity Account");
  return undefined;
}

export type ReconAccountStatus = {
  account: Account;
  // One vault account can have several physical Plaid accounts behind it (e.g. two BofA credit
  // cards that both map to the same shared card GL account) -- all of them, not just one.
  plaidAccounts: PlaidAccountSummary[];
  plaidBalance: number; // summed across plaidAccounts
  vaultBalance: number;
  diff: number;
  unmatchedPlaid: PlaidTxSummary[];
  unmatchedVault: Tx[];
  // True when Plaid returned zero transactions at all for this account within the fetch window
  // (common for HSA/investment-type accounts, which often only expose a balance) -- "unmatched
  // vault entries" is meaningless noise in that case (there's nothing to have matched against),
  // so the UI shows an explanatory note instead of an alarming count.
  noPlaidTransactionFeed: boolean;
};

export const DIFF_TOL = 0.005;
// A vault voucher and the Plaid transaction it corresponds to don't always land on the exact
// same date -- pending-to-posted transitions and weekend/holiday posting delays commonly shift
// it by a day or two either side (confirmed live: a DoorDash charge landed 2 days apart).
const DATE_TOL_DAYS = 3;

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
// hasn't reported (deliberately un-adjusted for pending/uncleared items -- the Balances tab
// remains the precise source of truth for that; this report trades some precision for a much
// simpler, standalone "what's outstanding" view).
export function reconciliationStatusForAccounts(
  data: Ledger,
  plaidAccounts: PlaidAccountSummary[],
  plaidTransactions: PlaidTxSummary[],
  todayStr: string,
  exceptions?: BankReconException[]
): ReconAccountStatus[] {
  const exceptionKeys = new Set((exceptions ?? []).map((e) => e.key));
  // Bounds the "in vault, no Plaid match" comparison to roughly the same window Plaid itself
  // returns -- without this, every old historical voucher outside Plaid's fetch window would
  // spuriously show up as "unmatched" since Plaid never reports transactions that old.
  const windowStart = new Date(todayStr + "T00:00:00Z");
  windowStart.setUTCDate(windowStart.getUTCDate() - 90);
  const windowStartStr = windowStart.toISOString().slice(0, 10);

  const groups = new Map<number, { account: Account; plaidAccounts: PlaidAccountSummary[] }>();
  for (const pa of plaidAccounts) {
    const account = matchVaultAccount(pa, data.accounts);
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

    // Plaid's own transaction.amount sign, on a given account, already matches this app's Dr/Cr
    // entry sign for THAT SAME account directly -- no flip. Proof from vaultBookBalance (already
    // proven correct, since the balance-vs-Plaid diff above genuinely reconciles): a depository
    // balance is `-sum(entries)`, i.e. Dr (negative) entries INCREASE it -- exactly matching
    // Plaid's own "negative = money in" convention for a depository account. A credit-card
    // balance is `+sum(entries)`, i.e. Cr (positive) entries increase what's owed -- exactly
    // matching Plaid's "positive = money out (a charge)" convention there too. An earlier version
    // of this file flipped the sign here, which produced a real bug: a genuinely-matching pair
    // (e.g. one $0.91 interest-earned transaction) showed up as two separate "unmatched" entries,
    // one in each column, mirror-imaged in sign.
    const unmatchedPlaid = acctPlaidTxs
      .filter((pt) => {
        const expected = pt.amount;
        return !recentVaultTxs.some(
          (vt) => daysApart(vt.date, pt.date) <= DATE_TOL_DAYS && Math.abs(vaultTxAccountAmount(vt, account.id) - expected) < 0.5
        );
      })
      // "Mark as reconciled" exceptions -- a Plaid-side entry the user has said will never get a
      // vault voucher (e.g. a bank fee they don't book) stops being flagged, permanently.
      .filter((pt) => !exceptionKeys.has(plaidExceptionKey(pt.account_id, pt.transaction_id)));
    const noPlaidTransactionFeed = acctPlaidTxs.length === 0;
    const unmatchedVault = noPlaidTransactionFeed
      ? []
      : recentVaultTxs
          .filter((vt) => {
            const amt = vaultTxAccountAmount(vt, account.id);
            return !acctPlaidTxs.some((pt) => daysApart(vt.date, pt.date) <= DATE_TOL_DAYS && Math.abs(pt.amount - amt) < 0.5);
          })
          // Same "mark as reconciled" override, for a vault voucher that will never have a Plaid
          // match (e.g. a cash transaction with no corresponding bank line).
          .filter((vt) => !exceptionKeys.has(vaultExceptionKey(vt.guid)));

    results.push({ account, plaidAccounts: paGroup, plaidBalance, vaultBalance, diff, unmatchedPlaid, unmatchedVault, noPlaidTransactionFeed });
  }
  return results.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}
