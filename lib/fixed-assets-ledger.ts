import type { Account, FixedAsset, Ledger, Tx } from "./vault-types";
import { nextTransactionIds, nextVoucherNumber } from "./vault-accounting";
import { appendAuditEntry } from "./audit";
import {
  ACCUMULATED_DEPRECIATION_ACCOUNT_NAME,
  DEPRECIATION_EXPENSE_ACCOUNT_NAME,
  EXPENSE_GROUP_NAME,
  FIXED_ASSETS_GROUP_NAME,
  accumulatedDepreciation,
  pendingDepreciationMonths,
  round2,
} from "./fixed-assets";

function findOrCreateAccount(
  accounts: Account[],
  name: string,
  groupName: string,
  currency: string,
  openingBalance = 0
): { account: Account; accounts: Account[] } {
  const existing = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (existing) return { account: existing, accounts };
  const account: Account = {
    id: Math.max(0, ...accounts.map((a) => a.id)) + 1,
    name,
    parent: groupName,
    category: "Asset",
    currency,
    openingBalance,
    active: true,
  };
  return { account, accounts: [...accounts, account] };
}

// Finds an existing ledger account by name under the "Fixed Assets" group, or creates one -- used
// when adding a new asset to the register so its cost shows in the trial balance/balance sheet
// like any other asset, without forcing the user through Masters first. Ledger balance convention
// (lib/vault-accounting.ts's ledgerBalanceAsOf): displayed balance = -(openingBalance + sum of
// entries), so a brand-new account needs openingBalance = -cost to show a +cost asset balance --
// this represents the asset as already-owned/paid-for at the point it's registered (the common
// case: backfilling something bought before this feature existed), not a fresh purchase voucher.
// Never overrides an EXISTING account's real opening balance.
export function getOrCreateAssetAccount(data: Ledger, name: string, cost: number): { data: Ledger; account: Account } {
  const { account, accounts } = findOrCreateAccount(data.accounts, name, FIXED_ASSETS_GROUP_NAME, data.currency, -cost);
  return { data: { ...data, accounts }, account };
}

// Ensures the two shared GL accounts this feature depends on exist, creating them under the
// standard seeded "Fixed Assets"/"Indirect Expenses" groups if missing. Idempotent -- safe to
// call every time a new asset is added or depreciation is run.
export function ensureFixedAssetAccounts(data: Ledger): { data: Ledger; depreciationExpenseAcct: Account; accumulatedDeprecAcct: Account } {
  let accounts = data.accounts;
  const dep = findOrCreateAccount(accounts, DEPRECIATION_EXPENSE_ACCOUNT_NAME, EXPENSE_GROUP_NAME, data.currency);
  accounts = dep.accounts;
  const accum = findOrCreateAccount(accounts, ACCUMULATED_DEPRECIATION_ACCOUNT_NAME, FIXED_ASSETS_GROUP_NAME, data.currency);
  accounts = accum.accounts;
  return { data: { ...data, accounts }, depreciationExpenseAcct: dep.account, accumulatedDeprecAcct: accum.account };
}

// Posts every pending depreciation month for every active (non-disposed) asset, through
// throughDate, as one Journal Tx per asset-month (Dr Depreciation Expense / Cr Accumulated
// Depreciation). Mirrors TradingReport.tsx's addAllIncomeVouchers: a running `workingTxs` copy
// keeps nextTransactionIds/nextVoucherNumber correct across multiple new vouchers in one save.
export function postDepreciation(data: Ledger, throughDate: string): { data: Ledger; postedCount: number } {
  const { data: withAccounts, depreciationExpenseAcct, accumulatedDeprecAcct } = ensureFixedAssetAccounts(data);
  const assets = withAccounts.fixedAssets ?? [];
  let workingTxs = [...withAccounts.transactions];
  let workingLedger = { ...withAccounts, transactions: workingTxs };
  const updatedAssets: FixedAsset[] = [];
  let postedCount = 0;

  for (const asset of assets) {
    if (asset.disposed) {
      updatedAssets.push(asset);
      continue;
    }
    const pending = pendingDepreciationMonths(asset, throughDate);
    if (!pending.length) {
      updatedAssets.push(asset);
      continue;
    }
    let lastThrough = asset.lastDepreciatedThrough;
    for (const { yearMonth, amount } of pending) {
      if (amount <= 0) continue;
      const postDate = `${yearMonth}-28`; // last-week-of-month posting date, avoids month-length edge cases
      const tx: Tx = {
        id: nextTransactionIds(workingTxs, 1)[0],
        guid: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        date: postDate,
        number: nextVoucherNumber(workingLedger, "Journal", postDate),
        type: "Journal",
        narration: `Depreciation - ${asset.name} - ${yearMonth}`,
        historical: false,
        cancelled: false,
        syncStatus: "pending",
        entries: [
          { accountId: depreciationExpenseAcct.id, accountName: depreciationExpenseAcct.name, amount: -amount },
          { accountId: accumulatedDeprecAcct.id, accountName: accumulatedDeprecAcct.name, amount },
        ],
      };
      workingTxs = [...workingTxs, tx];
      workingLedger = { ...workingLedger, transactions: workingTxs };
      workingLedger = appendAuditEntry(workingLedger, {
        entity: "voucher",
        entityId: tx.guid,
        action: "created",
        summary: `Depreciation posted for ${asset.name}: ${yearMonth}`,
      });
      workingTxs = workingLedger.transactions;
      lastThrough = yearMonth;
      postedCount++;
    }
    updatedAssets.push({ ...asset, lastDepreciatedThrough: lastThrough });
  }

  return { data: { ...workingLedger, transactions: workingTxs, fixedAssets: updatedAssets }, postedCount };
}

// Disposes an asset: posts a Journal Tx that zeroes the asset's own cost account and its
// accumulated depreciation, records any cash proceeds, and plugs the difference to a Gain/Loss
// on Disposal line (auto-created if missing, same pattern as the depreciation accounts).
export function disposeAsset(
  data: Ledger,
  assetId: string,
  disposalDate: string,
  proceeds: number,
  cashAccountId: number
): { data: Ledger } | { error: string } {
  const asset = (data.fixedAssets ?? []).find((a) => a.id === assetId);
  if (!asset) return { error: "Asset not found" };
  if (asset.disposed) return { error: "Asset already disposed" };
  const assetAccount = data.accounts.find((a) => a.id === asset.accountId);
  const cashAccount = data.accounts.find((a) => a.id === cashAccountId);
  if (!assetAccount || !cashAccount) return { error: "Account not found" };

  const { data: withAccounts, accumulatedDeprecAcct } = ensureFixedAssetAccounts(data);
  const accumDep = accumulatedDepreciation(asset, disposalDate);
  const netBookValue = round2(asset.cost - accumDep);
  const gainOrLoss = round2(proceeds - netBookValue);
  const gainLoss = findOrCreateAccount(withAccounts.accounts, "Gain/Loss on Disposal", EXPENSE_GROUP_NAME, withAccounts.currency);

  // Vault convention: Dr=negative, Cr=positive; an Asset-nature account's balance = -sum(entries)
  // (Dr increases it). To remove the asset's cost from the books we Cr it (positive); to remove
  // its accumulated depreciation credit balance we Dr it (negative); receiving cash is a Dr
  // (negative) on the cash asset account, same as any other deposit.
  const entries = [
    { accountId: assetAccount.id, accountName: assetAccount.name, amount: asset.cost }, // Cr asset cost off the books
    { accountId: accumulatedDeprecAcct.id, accountName: accumulatedDeprecAcct.name, amount: -accumDep }, // Dr out accumulated dep
    { accountId: cashAccount.id, accountName: cashAccount.name, amount: -proceeds }, // Dr cash received
  ].filter((e) => e.amount !== 0);
  // Plug: gain (proceeds > NBV) is a credit (positive, income-like); a loss is a debit (negative).
  if (gainOrLoss !== 0) entries.push({ accountId: gainLoss.account.id, accountName: gainLoss.account.name, amount: gainOrLoss });

  const balance = round2(entries.reduce((s, e) => s + e.amount, 0));
  if (balance !== 0) return { error: `Disposal entry does not balance (off by ${balance})` };

  const tx: Tx = {
    id: nextTransactionIds(withAccounts.transactions, 1)[0],
    guid: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    date: disposalDate,
    number: nextVoucherNumber(withAccounts, "Journal", disposalDate),
    type: "Journal",
    narration: `Disposal - ${asset.name}`,
    historical: false,
    cancelled: false,
    syncStatus: "pending",
    entries,
  };

  const updatedAssets = (withAccounts.fixedAssets ?? []).map((a) =>
    a.id === assetId ? { ...a, disposed: { date: disposalDate, proceeds, txGuid: tx.guid } } : a
  );

  let next: Ledger = {
    ...withAccounts,
    accounts: gainLoss.accounts,
    transactions: [...withAccounts.transactions, tx],
    fixedAssets: updatedAssets,
  };
  next = appendAuditEntry(next, {
    entity: "voucher",
    entityId: tx.guid,
    action: "created",
    summary: `Disposed ${asset.name} on ${disposalDate} (proceeds ${proceeds}, ${gainOrLoss >= 0 ? "gain" : "loss"} ${Math.abs(gainOrLoss)})`,
  });
  return { data: next };
}
