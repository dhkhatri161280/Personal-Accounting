import type { Account, FixedAsset, Ledger, Tx } from "./vault-types";
import { nextTransactionIds, nextVoucherNumber, ledgerBalanceAsOf } from "./vault-accounting";
import { appendAuditEntry } from "./audit";
import {
  ACCUMULATED_DEPRECIATION_ACCOUNT_NAME,
  DEPRECIATION_EXPENSE_ACCOUNT_NAME,
  EXPENSE_GROUP_NAME,
  FIXED_ASSETS_GROUP_NAME,
  accumulatedDepreciation,
  pendingDepreciationMonths,
  round2,
  assetClassFromTag,
  guessAssetClass,
} from "./fixed-assets";
import { findOrCreateAccount, registerOpeningBalance } from "./opening-balance-equity";

// Finds an existing ledger account by name under the "Fixed Assets" group, or creates one -- used
// when adding a new asset to the register so its cost shows in the trial balance/balance sheet
// like any other asset, without forcing the user through Masters first. A brand-new account's
// starting balance is posted via a real, auditable Journal Tx against "Opening Balance Equity"
// (registerOpeningBalance) rather than a silent Account.openingBalance value with no double-entry
// counterpart -- that trick was tried first and confirmed live to break the Balance Sheet check
// by exactly the account's starting amount. Never touches an existing account's real balance.
export function getOrCreateAssetAccount(data: Ledger, name: string, cost: number, purchaseDate: string): { data: Ledger; account: Account } {
  const { account, accounts, created } = findOrCreateAccount(data.accounts, name, FIXED_ASSETS_GROUP_NAME, data.currency);
  let next: Ledger = { ...data, accounts };
  if (created) next = registerOpeningBalance(next, account, cost, purchaseDate, `Registered fixed asset: ${name}`);
  return { data: next, account };
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

// Same pending-months math as postDepreciation, but posts ONE Journal Tx per asset -- dated
// postDate (an open period the user picked) rather than each month's own historical date --
// for the summed catch-up amount. For a backlog spanning years of already-closed/reported
// periods, postDepreciation's month-by-month vouchers would land on dates the app refuses to
// save into; this collapses the whole backlog into a single true-up entry per asset instead,
// the same way a real ERP handles a large catch-up run. lastDepreciatedThrough still advances to
// the last pending month, so later periodic runs (via postDepreciation) resume from here.
export function postDepreciationConsolidated(data: Ledger, throughDate: string, postDate: string): { data: Ledger; postedCount: number } {
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
    const total = round2(pending.reduce((s, m) => s + m.amount, 0));
    if (!pending.length || total <= 0) {
      updatedAssets.push(asset);
      continue;
    }
    const lastThrough = pending[pending.length - 1].yearMonth;
    const tx: Tx = {
      id: nextTransactionIds(workingTxs, 1)[0],
      guid: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      date: postDate,
      number: nextVoucherNumber(workingLedger, "Journal", postDate),
      type: "Journal",
      narration: `Depreciation catch-up - ${asset.name} - through ${lastThrough}`,
      historical: false,
      cancelled: false,
      syncStatus: "pending",
      entries: [
        { accountId: depreciationExpenseAcct.id, accountName: depreciationExpenseAcct.name, amount: -total },
        { accountId: accumulatedDeprecAcct.id, accountName: accumulatedDeprecAcct.name, amount: total },
      ],
    };
    workingTxs = [...workingTxs, tx];
    workingLedger = { ...workingLedger, transactions: workingTxs };
    workingLedger = appendAuditEntry(workingLedger, {
      entity: "voucher",
      entityId: tx.guid,
      action: "created",
      summary: `Depreciation catch-up posted for ${asset.name}: through ${lastThrough} (${total})`,
    });
    workingTxs = workingLedger.transactions;
    postedCount++;
    updatedAssets.push({ ...asset, lastDepreciatedThrough: lastThrough });
  }

  return { data: { ...workingLedger, transactions: workingTxs, fixedAssets: updatedAssets }, postedCount };
}

export type TaggedAssetGroup = {
  accountId: number;
  accountName: string;
  tag: string;
  cost: number;
  purchaseDate: string;
  existingAssetId?: string;
  costChanged: boolean;
};

// Scans every posted voucher entry carrying an Entry.assetTag (set at entry time in the New
// Voucher form when the debit ledger is a Fixed-Assets-nature account -- see VaultApp.tsx's
// voucher-line rendering) and groups them by (accountId, tag). Several tagged entries on the same
// GL ledger (e.g. two installments of one sofa, both posted to "Furniture Purchase") net into one
// group: cost = the net Dr amount, purchaseDate = the earliest entry's date. Cross-references
// data.fixedAssets (matched via sourceAccountId/sourceTag) so a caller can tell a genuinely new
// tag apart from one that already has an asset and just needs its cost/date refreshed.
export function discoverTaggedAssetGroups(data: Ledger): TaggedAssetGroup[] {
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const groups = new Map<string, { accountId: number; tag: string; cost: number; earliestDate: string }>();
  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    for (const e of t.entries) {
      if (!e.assetTag) continue;
      const acc = accountById.get(e.accountId);
      if (!acc || acc.parent !== FIXED_ASSETS_GROUP_NAME) continue;
      const key = `${e.accountId}::${e.assetTag}`;
      const cost = round2(-e.amount); // Dr (negative) increases the asset, mirrors ledgerBalanceAsOf's convention
      const existing = groups.get(key);
      if (existing) {
        existing.cost = round2(existing.cost + cost);
        if (t.date < existing.earliestDate) existing.earliestDate = t.date;
      } else {
        groups.set(key, { accountId: e.accountId, tag: e.assetTag, cost, earliestDate: t.date });
      }
    }
  }
  const linkedByKey = new Map<string, FixedAsset>(
    (data.fixedAssets ?? [])
      .filter((a) => a.sourceAccountId != null && a.sourceTag)
      .map((a) => [`${a.sourceAccountId}::${a.sourceTag}`, a])
  );
  return [...groups.entries()]
    .map(([key, g]) => {
      const linked = linkedByKey.get(key);
      return {
        accountId: g.accountId,
        accountName: accountById.get(g.accountId)?.name || "",
        tag: g.tag,
        cost: g.cost,
        purchaseDate: g.earliestDate,
        existingAssetId: linked?.id,
        costChanged: !!linked && round2(linked.cost) !== g.cost,
      };
    })
    .sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
}

// Recomputes the ledger's one untagged/legacy asset (if it has one) as: this account's real,
// full GL balance minus every OTHER (tagged) asset's cost on the same ledger. Exact by
// construction, so it can't drift regardless of how many tags exist, what order they were synced
// in, or whether a tag's own net is a credit (a return/refund) rather than a debit -- unlike
// incrementally subtracting each new tag's cost one at a time, which clamped at zero and silently
// discarded the remainder once enough tags had been carved out of the same legacy sibling.
function reconcileLegacyAssetCost(data: Ledger, accountId: number): Ledger {
  const fixedAssets = data.fixedAssets ?? [];
  const legacy = fixedAssets.find((a) => a.accountId === accountId && !a.sourceTag && !a.disposed);
  if (!legacy) return data;
  const realBalance = ledgerBalanceAsOf(data, accountId, "9999-12-31");
  const othersCost = fixedAssets
    .filter((a) => a.accountId === accountId && a.id !== legacy.id && !a.disposed)
    .reduce((s, a) => s + a.cost, 0);
  return {
    ...data,
    fixedAssets: fixedAssets.map((a) => (a.id === legacy.id ? { ...a, cost: round2(realBalance - othersCost) } : a)),
  };
}

// One legacy asset per already-tagged ledger, whose stored cost doesn't match what
// reconcileLegacyAssetCost would now compute -- surfaces the pre-existing bug's damage (assets
// synced before the fix used the old incremental-subtraction approach, which could clamp at zero
// and lose money) so it can be repaired with one click instead of silently staying wrong.
export function findLegacyCostMismatches(data: Ledger): { accountId: number; name: string; currentCost: number; correctCost: number }[] {
  const fixedAssets = data.fixedAssets ?? [];
  const accountIds = new Set(fixedAssets.filter((a) => a.sourceTag && !a.disposed).map((a) => a.accountId));
  const out: { accountId: number; name: string; currentCost: number; correctCost: number }[] = [];
  for (const accountId of accountIds) {
    const legacy = fixedAssets.find((a) => a.accountId === accountId && !a.sourceTag && !a.disposed);
    if (!legacy) continue;
    const realBalance = ledgerBalanceAsOf(data, accountId, "9999-12-31");
    const othersCost = fixedAssets
      .filter((a) => a.accountId === accountId && a.id !== legacy.id && !a.disposed)
      .reduce((s, a) => s + a.cost, 0);
    const correctCost = round2(realBalance - othersCost);
    if (Math.abs(correctCost - legacy.cost) > 0.005) out.push({ accountId, name: legacy.name, currentCost: legacy.cost, correctCost });
  }
  return out;
}

// Applies findLegacyCostMismatches's fix to every affected ledger in one save.
export function repairLegacyAssetCosts(data: Ledger): Ledger {
  let next = data;
  for (const { accountId } of findLegacyCostMismatches(data)) next = reconcileLegacyAssetCost(next, accountId);
  return next;
}

export function createTaggedAsset(
  data: Ledger,
  group: TaggedAssetGroup,
  usefulLifeMonths: number,
  salvageValue: number,
  name?: string
): Ledger {
  // The tag's own prefix (e.g. "FUR-002") already declares its class -- that's the whole point of
  // class-prefixed numbering -- so it's the authoritative source, ahead of guessing from the
  // ledger name. Falls back to the name guess only for a freehand tag that doesn't follow the
  // PREFIX-NNN convention (e.g. typed before this feature existed), and is left unset (not forced
  // to "Unclassified") when neither can tell, same as a manually-added asset today.
  const assetClass = assetClassFromTag(group.tag) || guessAssetClass(group.accountName);
  const asset: FixedAsset = {
    id: crypto.randomUUID(),
    // Defaults to the ledger's own name (same as every sibling asset), but the caller can supply
    // a more descriptive one (e.g. "Dining Table") since sourceTag, not the name, is what
    // actually identifies this asset -- the name is purely for the user's own readability.
    name: name?.trim() || group.accountName,
    accountId: group.accountId,
    ...(assetClass ? { assetClass } : {}),
    purchaseDate: group.purchaseDate,
    cost: group.cost,
    salvageValue,
    usefulLifeMonths,
    sourceAccountId: group.accountId,
    sourceTag: group.tag,
  };
  const withNewAsset: Ledger = { ...data, fixedAssets: [...(data.fixedAssets ?? []), asset] };
  return reconcileLegacyAssetCost(withNewAsset, group.accountId);
}

// Refreshes an already-synced asset's cost/purchaseDate from its tag group -- e.g. a 2nd
// installment posted later under the same tag. Useful life/salvage are left untouched (already
// set from the first sync).
export function updateTaggedAssetCost(data: Ledger, group: TaggedAssetGroup): Ledger {
  if (!group.existingAssetId) return data;
  const updated = (data.fixedAssets ?? []).map((a) =>
    a.id === group.existingAssetId ? { ...a, cost: group.cost, purchaseDate: group.purchaseDate } : a
  );
  return reconcileLegacyAssetCost({ ...data, fixedAssets: updated }, group.accountId);
}

// Called from every save path that can introduce or change an Entry.assetTag (a new voucher, an
// edited one, or a tag added/changed on an already-posted voucher) -- creates the Asset Master
// record for any newly-tagged group and refreshes cost/date for any tag that grew, with no
// separate manual "Sync" step. Useful life/salvage for a brand-new tag are inherited from a
// sibling asset already on the same ledger (or default to 60/0 if there's no sibling yet) --
// same defaults the old manual review used, just applied silently. Correctable afterward in
// Masters > Fixed Assets if the inherited default isn't right for that specific item.
// `desiredNames` (keyed by "accountId::tag") lets a caller that just typed a brand-new tag also
// supply the name for its Master record in the same action -- e.g. the voucher-line/voucher-
// detail tag pickers' optional Name field -- instead of it always defaulting to the ledger's own
// generic name and requiring a separate rename in Masters afterward.
export function autoSyncTaggedAssets(data: Ledger, desiredNames?: Record<string, string>): Ledger {
  const groups = discoverTaggedAssetGroups(data);
  let next = data;
  for (const g of groups) {
    if (g.existingAssetId) {
      if (g.costChanged) next = updateTaggedAssetCost(next, g);
      continue;
    }
    const sibling = (next.fixedAssets ?? [])
      .filter((a) => a.accountId === g.accountId)
      .sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate))[0];
    next = createTaggedAsset(
      next,
      g,
      sibling?.usefulLifeMonths ?? 60,
      sibling?.salvageValue ?? 0,
      desiredNames?.[`${g.accountId}::${g.tag}`]
    );
  }
  return next;
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
