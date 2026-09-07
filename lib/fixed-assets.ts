import type { FixedAsset } from "./vault-types";

// Pure straight-line depreciation math -- deliberately free of any runtime import from another
// lib/*.ts file (only a type-only import above). node --test cannot resolve extensionless
// relative imports between two lib/*.ts files when the import carries actual runtime values (a
// pre-existing gap in this repo's test infra, hit before with lib/budget.ts and
// lib/multi-year-trend.ts) -- keeping this file import-free keeps it directly unit-testable.
// Ledger-mutating logic (posting Tx's, creating accounts) lives in lib/fixed-assets-ledger.ts,
// which imports these functions as values and is verified live instead.

export const FIXED_ASSETS_GROUP_NAME = "Fixed Assets";
export const EXPENSE_GROUP_NAME = "Indirect Expenses";
export const DEPRECIATION_EXPENSE_ACCOUNT_NAME = "Depreciation Expense";
export const ACCUMULATED_DEPRECIATION_ACCOUNT_NAME = "Accumulated Depreciation";

// Straight-line monthly depreciation. usefulLifeMonths <= 0 is treated as "not depreciable"
// (e.g. land) -- returns 0 rather than dividing by zero/going negative.
export function monthlyDepreciation(asset: FixedAsset): number {
  if (asset.usefulLifeMonths <= 0) return 0;
  const depreciableBase = Math.max(0, asset.cost - asset.salvageValue);
  return round2(depreciableBase / asset.usefulLifeMonths);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function ym(dateStr: string): string {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

// Number of whole months between two "YYYY-MM" (or full date) strings.
export function monthsBetween(fromYm: string, toYm: string): number {
  const [fy, fm] = fromYm.split("-").map(Number);
  const [ty, tm] = toYm.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export function addMonths(yearMonth: string, n: number): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

// Accumulated depreciation as of asOfDate: whole months elapsed since the purchase month,
// capped at usefulLifeMonths and at the disposal month if disposed, capped again at the
// depreciable base so it never overshoots (rounding-safe).
export function accumulatedDepreciation(asset: FixedAsset, asOfDate: string): number {
  const monthly = monthlyDepreciation(asset);
  if (monthly <= 0) return 0;
  const capDate = asset.disposed?.date && asset.disposed.date < asOfDate ? asset.disposed.date : asOfDate;
  let months = monthsBetween(ym(asset.purchaseDate), ym(capDate));
  months = Math.max(0, Math.min(months, asset.usefulLifeMonths));
  const depreciableBase = Math.max(0, asset.cost - asset.salvageValue);
  return Math.min(round2(monthly * months), depreciableBase);
}

export function bookValue(asset: FixedAsset, asOfDate: string): number {
  return round2(asset.cost - accumulatedDepreciation(asset, asOfDate));
}

// Months not yet posted (lastDepreciatedThrough exclusive) up through throughDate's month,
// capped at usefulLifeMonths total and at a disposal month if disposed. Each entry is one
// month's depreciation Tx to post. Strictly-before semantics (only fully-elapsed months count)
// so this always matches accumulatedDepreciation's own month count for the same asOfDate.
export function pendingDepreciationMonths(asset: FixedAsset, throughDate: string): { yearMonth: string; amount: number }[] {
  const monthly = monthlyDepreciation(asset);
  if (monthly <= 0) return [];
  const purchaseYm = ym(asset.purchaseDate);
  const capYm = asset.disposed?.date ? ym(asset.disposed.date) : ym(throughDate);
  const throughYm = ym(throughDate) < capYm ? ym(throughDate) : capYm;
  const startYm = asset.lastDepreciatedThrough ? addMonths(asset.lastDepreciatedThrough, 1) : purchaseYm;
  if (startYm >= throughYm) return [];

  const depreciableBase = Math.max(0, asset.cost - asset.salvageValue);
  const alreadyPosted = asset.lastDepreciatedThrough
    ? Math.min(round2(monthly * monthsBetween(purchaseYm, addMonths(asset.lastDepreciatedThrough, 1))), depreciableBase)
    : 0;
  let remaining = round2(depreciableBase - alreadyPosted);

  const out: { yearMonth: string; amount: number }[] = [];
  let cursor = startYm;
  let monthIndex = monthsBetween(purchaseYm, startYm);
  while (cursor < throughYm && monthIndex < asset.usefulLifeMonths && remaining > 0) {
    const amount = Math.min(monthly, remaining);
    out.push({ yearMonth: cursor, amount });
    remaining = round2(remaining - amount);
    cursor = addMonths(cursor, 1);
    monthIndex++;
  }
  return out;
}
