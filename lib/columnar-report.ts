import type { Ledger } from "./vault-types";

export type PeriodBoundary = { key: string; label: string; start: string; end: string };

// Same hardcoded-April fiscal year convention as VaultApp.tsx's `calc` (${year}-04-01 through
// ${year + 1}-03-31) -- not data.fiscalYearStartMonth, which `calc` itself doesn't consume either.
const pad2 = (n: number) => String(n).padStart(2, "0");
const lastDayOfMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Offset i=0..11 from April -- calendar (year, month) for the i-th month of fiscal year `fy`.
function fyMonth(fy: number, i: number): { y: number; m: number } {
  const m = ((3 + i) % 12) + 1; // i=0 -> April(4)
  const y = fy + (3 + i >= 12 ? 1 : 0);
  return { y, m };
}

export function periodBoundaries(fy: number, granularity: "monthly" | "quarterly"): PeriodBoundary[] {
  const months: PeriodBoundary[] = Array.from({ length: 12 }, (_, i) => {
    const { y, m } = fyMonth(fy, i);
    const start = `${y}-${pad2(m)}-01`;
    const end = `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}`;
    return { key: `${y}-${pad2(m)}`, label: `${MONTH_NAMES[m - 1]} ${y}`, start, end };
  });
  if (granularity === "monthly") return months;
  return [0, 1, 2, 3].map((q) => {
    const group = months.slice(q * 3, q * 3 + 3);
    return {
      key: `${fy}-Q${q + 1}`,
      label: `Q${q + 1} (${group[0].label.split(" ")[0]}–${group[2].label.split(" ")[0]})`,
      start: group[0].start,
      end: group[2].end,
    };
  });
}

// Tally-style trimming: drop columns for periods that haven't started yet as of the latest
// posted voucher anywhere in the ledger (not just within the selected FY -- a future FY with no
// postings yet would otherwise trim to nothing). Keeps at least the first period so the report
// never renders with zero columns.
export function trimToLatestActivity(periods: PeriodBoundary[], data: Ledger): PeriodBoundary[] {
  let latest = "";
  for (const t of data.transactions) {
    if (t.deleted) continue;
    if (t.date > latest) latest = t.date;
  }
  if (!latest) return periods.slice(0, 1);
  const trimmed = periods.filter((p) => p.start <= latest);
  return trimmed.length ? trimmed : periods.slice(0, 1);
}

export type ColumnarCell = { opening: number; debit: number; credit: number; closing: number };

// One pass over data.transactions, bucketing every entry into the period whose [start, end] it
// falls in, carrying each account's opening balance forward from the previous period's closing --
// mirrors VaultApp.tsx's `calc`, just parameterized across N periods instead of one range.
export function calcColumnar(data: Ledger, periods: PeriodBoundary[]): Map<number, Map<string, ColumnarCell>> {
  const result = new Map<number, Map<string, ColumnarCell>>();
  if (!periods.length) return result;
  const opening = new Map(data.accounts.map((a) => [a.id, a.openingBalance]));
  const rangeStart = periods[0].start;
  const debitByPeriod = new Map<string, Map<number, number>>();
  const creditByPeriod = new Map<string, Map<number, number>>();
  for (const p of periods) {
    debitByPeriod.set(p.key, new Map());
    creditByPeriod.set(p.key, new Map());
  }

  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    if (t.date < rangeStart) {
      for (const e of t.entries) opening.set(e.accountId, (opening.get(e.accountId) || 0) + e.amount);
      continue;
    }
    const period = periods.find((p) => t.date >= p.start && t.date <= p.end);
    if (!period) continue;
    const debit = debitByPeriod.get(period.key)!, credit = creditByPeriod.get(period.key)!;
    for (const e of t.entries) {
      if (e.amount < 0) debit.set(e.accountId, (debit.get(e.accountId) || 0) - e.amount);
      else credit.set(e.accountId, (credit.get(e.accountId) || 0) + e.amount);
    }
  }

  for (const a of data.accounts) {
    const perPeriod = new Map<string, ColumnarCell>();
    let running = opening.get(a.id) || 0;
    for (const p of periods) {
      const debit = debitByPeriod.get(p.key)!.get(a.id) || 0;
      const credit = creditByPeriod.get(p.key)!.get(a.id) || 0;
      const closing = running - debit + credit;
      perPeriod.set(p.key, { opening: running, debit, credit, closing });
      running = closing;
    }
    result.set(a.id, perPeriod);
  }
  return result;
}

export type ColumnarRow = {
  id: number;
  name: string;
  parent: string;
  category: string;
  values: Record<string, number>;
  total: number;
};

// Same nature-classification rules as components/VaultApp.tsx's `natureFor`/`isProfitLoss`
// (duplicated there too, once per report section) -- kept here rather than shared since it's a
// small pure function and this module has no dependency on VaultApp's local state.
function isProfitLoss(name: string) {
  return /profit\s*&\s*loss|income\s*&\s*expenditure/i.test(name);
}
function natureFor(a: { parent: string }, groups: Ledger["groups"]) {
  const group = (a.parent || "").toLowerCase();
  const configured = (groups || []).find((g) => g.name.toLowerCase() === group);
  if (group.includes("(asset)")) return "Asset";
  if (configured) return configured.nature;
  if (/^(direct incomes|indirect incomes|sales accounts)$/.test(group)) return "Income";
  if (/^(direct expenses|indirect expenses|purchase accounts)$/.test(group)) return "Expense";
  if (/^(capital account|reserves & surplus)$/.test(group)) return "Capital";
  if (/^(current liabilities|loans \(liability\)|bank od a\/c|secured loans|unsecured loans|duties & taxes|provisions|sundry creditors)$/.test(group)) return "Liability";
  if (group === "bank accounts") return "Bank";
  if (group === "cash-in-hand") return "Cash";
  if (group === "investments") return "Investment";
  return "Asset";
}

const TOL = 0.005;

// Builds the Income and Expense row sets for the columnar report -- one row per ledger account
// that has activity in at least one period, with per-period values already signed for display
// (Income: credit − debit; Expense: debit − credit, both positive-when-normal like the existing
// single-period periodIncomeRows/periodExpenseRows in VaultApp.tsx).
export function buildIncomeExpenseColumns(
  data: Ledger,
  periods: PeriodBoundary[]
): { incomeRows: ColumnarRow[]; expenseRows: ColumnarRow[] } {
  const cellMap = calcColumnar(data, periods);
  const build = (kind: "Income" | "Expense") => {
    const rows: ColumnarRow[] = [];
    for (const a of data.accounts) {
      if (isProfitLoss(a.name) || natureFor(a, data.groups) !== kind) continue;
      const cells = cellMap.get(a.id);
      if (!cells) continue;
      const values: Record<string, number> = {};
      let total = 0;
      for (const p of periods) {
        const c = cells.get(p.key);
        const v = c ? (kind === "Income" ? c.credit - c.debit : c.debit - c.credit) : 0;
        values[p.key] = v;
        total += v;
      }
      if (Math.abs(total) > TOL || Object.values(values).some((v) => Math.abs(v) > TOL))
        rows.push({ id: a.id, name: a.name, parent: a.parent, category: a.category, values, total });
    }
    return rows;
  };
  return { incomeRows: build("Income"), expenseRows: build("Expense") };
}

const PL_ROW_ID = -1; // synthetic row id for the "Profit & Loss A/c" line -- no real Account has a negative id

// Tally's canonical Balance Sheet head grouping and order -- same mapping as BS_SECTION/L_ORDER/
// R_ORDER in components/reports/BalanceSheetReport.tsx, duplicated here so the columnar view
// groups ledgers the same way (Fixed Assets / Investments / Current Assets, and Capital Account /
// Loans (Liability) / Current Liabilities / Profit & Loss A/c) instead of raw ledger-group names.
const BS_SECTION: Record<string, string> = {
  "capital account": "Capital Account",
  "reserves & surplus": "Capital Account",
  "secured loans": "Loans (Liability)",
  "unsecured loans": "Loans (Liability)",
  "bank od a/c": "Loans (Liability)",
  "loans (liability)": "Loans (Liability)",
  "sundry creditors": "Current Liabilities",
  "duties & taxes": "Current Liabilities",
  provisions: "Current Liabilities",
  "current liabilities": "Current Liabilities",
  "suspense a/c": "Suspense A/c",
  "fixed assets": "Fixed Assets",
  investments: "Investments",
  "current assets": "Current Assets",
  "cash-in-hand": "Current Assets",
  "bank accounts": "Current Assets",
  "loans & advances (asset)": "Current Assets",
  "deposits (asset)": "Current Assets",
  "sundry debtors": "Current Assets",
  "miscellaneous expenditure (asset)": "Miscellaneous Expenditure",
};
export const BS_LIABILITY_ORDER = ["Capital Account", "Loans (Liability)", "Current Liabilities", "Suspense A/c", "Profit & Loss A/c"];
export const BS_ASSET_ORDER = ["Fixed Assets", "Investments", "Current Assets", "Miscellaneous Expenditure"];
function bsSectionFor(a: { parent: string }, defaultSection: string): string {
  const g = (a.parent || "").toLowerCase().trim();
  return BS_SECTION[g] || (g.includes("(asset)") ? "Current Assets" : defaultSection);
}

// Builds the Asset and Liability & Capital row sets for the columnar Balance Sheet -- unlike
// Income/Expense (period flows), each cell here is a CUMULATIVE closing balance as of that
// period's end (real balance-sheet accounts carry forward across periods by nature), so `total`
// is set to the LAST period's value (the ending balance), not a sum across columns. A synthetic
// "Profit & Loss A/c" row is added to the Liability & Capital side, carrying the FY-scoped
// cumulative surplus/deficit through each period-end -- without it the two sides wouldn't tie out
// mid-year, the same reason the single-period BalanceSheetReport adds capitalTransfer.
export function buildBalanceSheetColumns(
  data: Ledger,
  periods: PeriodBoundary[]
): { assetRows: ColumnarRow[]; liabilityRows: ColumnarRow[] } {
  const cellMap = calcColumnar(data, periods);
  const assetRows: ColumnarRow[] = [];
  const liabilityRows: ColumnarRow[] = [];

  let cumSurplus = 0;
  const surplusValues: Record<string, number> = {};
  for (const p of periods) {
    let periodSurplus = 0;
    for (const a of data.accounts) {
      if (isProfitLoss(a.name)) continue;
      const nat = natureFor(a, data.groups);
      if (nat !== "Income" && nat !== "Expense") continue;
      const c = cellMap.get(a.id)?.get(p.key);
      if (!c) continue;
      periodSurplus += nat === "Income" ? c.credit - c.debit : -(c.debit - c.credit);
    }
    cumSurplus += periodSurplus;
    surplusValues[p.key] = cumSurplus;
  }

  for (const a of data.accounts) {
    if (isProfitLoss(a.name)) continue;
    const nat = natureFor(a, data.groups);
    const isAssetNat = nat === "Asset" || nat === "Bank" || nat === "Cash" || nat === "Investment";
    const isLiabNat = nat === "Liability" || nat === "Capital";
    if (!isAssetNat && !isLiabNat) continue;
    const cells = cellMap.get(a.id);
    if (!cells) continue;
    const values: Record<string, number> = {};
    for (const p of periods) {
      const raw = cells.get(p.key)?.closing || 0;
      values[p.key] = isAssetNat ? -raw : raw;
    }
    const lastValue = values[periods[periods.length - 1].key] || 0;
    if (Math.abs(lastValue) > TOL || Object.values(values).some((v) => Math.abs(v) > TOL))
      (isAssetNat ? assetRows : liabilityRows).push({
        id: a.id,
        name: a.name,
        parent: bsSectionFor(a, isAssetNat ? "Current Assets" : "Current Liabilities"),
        category: a.category,
        values,
        total: lastValue,
      });
  }

  if (Object.values(surplusValues).some((v) => Math.abs(v) > TOL))
    liabilityRows.push({
      id: PL_ROW_ID,
      name: "Profit & Loss A/c",
      parent: "Profit & Loss A/c",
      category: "",
      values: surplusValues,
      total: surplusValues[periods[periods.length - 1].key] || 0,
    });

  return { assetRows, liabilityRows };
}

// Builds Cash Inflow and Cash Outflow row sets for the columnar Cash Flow report -- for every
// cash-affecting voucher (any entry touching a Bank Accounts/Cash-in-hand ledger), the OTHER
// (non-cash) side of that voucher is attributed to its ledger as an inflow (credit, money coming
// from that ledger) or outflow (debit, money going to that ledger), bucketed by the period the
// voucher falls in. Mirrors the cashFlowItems/cashFlowGroups logic in VaultApp.tsx, just
// parameterized across N periods instead of one selected range.
export function buildCashFlowColumns(
  data: Ledger,
  periods: PeriodBoundary[]
): { inflowRows: ColumnarRow[]; outflowRows: ColumnarRow[]; closingByPeriod: Record<string, number> } {
  const isCashBank = (a: { parent: string }) => /^(bank accounts|cash-in-hand)$/i.test((a.parent || "").toLowerCase());
  const cashAccounts = data.accounts.filter(isCashBank);
  const cashIds = new Set(cashAccounts.map((a) => a.id));
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const inflowValues = new Map<number, Record<string, number>>();
  const outflowValues = new Map<number, Record<string, number>>();

  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    const period = periods.find((p) => t.date >= p.start && t.date <= p.end);
    if (!period) continue;
    const cashEntries = t.entries.filter((e) => cashIds.has(e.accountId));
    const cashMovement = -cashEntries.reduce((s, e) => s + e.amount, 0);
    if (!cashEntries.length || Math.abs(cashMovement) <= TOL) continue;
    for (const e of t.entries) {
      if (cashIds.has(e.accountId) || Math.abs(e.amount) <= TOL) continue;
      const map = e.amount > 0 ? inflowValues : outflowValues;
      const rec = map.get(e.accountId) || (map.set(e.accountId, {}).get(e.accountId) as Record<string, number>);
      rec[period.key] = (rec[period.key] || 0) + Math.abs(e.amount);
    }
  }

  const buildRows = (map: Map<number, Record<string, number>>): ColumnarRow[] => {
    const rows: ColumnarRow[] = [];
    for (const [id, raw] of map) {
      const a = accountById.get(id);
      if (!a) continue;
      const values: Record<string, number> = {};
      let total = 0;
      for (const p of periods) {
        const v = raw[p.key] || 0;
        values[p.key] = v;
        total += v;
      }
      if (total > TOL) rows.push({ id, name: a.name, parent: a.parent, category: a.category, values, total });
    }
    return rows;
  };

  // Closing cash & bank balance as of each period-end -- cumulative like Balance Sheet's asset
  // closings (same -closing sign flip used by VaultApp.tsx's cashBank), not a flow, so callers
  // should show the LAST period's value as the "Total", not a sum across periods.
  const cellMap = calcColumnar(data, periods);
  const closingByPeriod: Record<string, number> = {};
  for (const p of periods) {
    closingByPeriod[p.key] = cashAccounts.reduce((s, a) => s - (cellMap.get(a.id)?.get(p.key)?.closing || 0), 0);
  }

  return { inflowRows: buildRows(inflowValues), outflowRows: buildRows(outflowValues), closingByPeriod };
}
