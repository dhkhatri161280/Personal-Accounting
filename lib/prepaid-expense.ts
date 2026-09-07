import type { PrepaidExpense } from "./vault-types";

// Pure straight-line amortization math -- deliberately free of any runtime import from another
// lib/*.ts file (only a type-only import above), mirroring lib/fixed-assets.ts's own structure.
// node --test cannot resolve extensionless relative imports between two lib/*.ts files when the
// import carries actual runtime values, so the tiny date-math helpers below are duplicated from
// fixed-assets.ts rather than imported, keeping this file directly unit-testable in isolation.
// Ledger-mutating logic (posting Tx's, creating accounts) lives in lib/prepaid-expense-ledger.ts.

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function ym(dateStr: string): string {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

function monthsBetween(fromYm: string, toYm: string): number {
  const [fy, fm] = fromYm.split("-").map(Number);
  const [ty, tm] = toYm.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function addMonths(yearMonth: string, n: number): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

// Straight-line monthly amortization. termMonths <= 0 returns 0 rather than dividing by zero.
export function monthlyAmortization(p: PrepaidExpense): number {
  if (p.termMonths <= 0) return 0;
  return round2(p.totalAmount / p.termMonths);
}

// Amortized-to-date as of asOfDate: whole months elapsed since the start month, capped at
// termMonths and at the write-off month if written off, capped again at totalAmount.
export function amortizedToDate(p: PrepaidExpense, asOfDate: string): number {
  const monthly = monthlyAmortization(p);
  if (monthly <= 0) return 0;
  const capDate = p.writtenOff?.date && p.writtenOff.date < asOfDate ? p.writtenOff.date : asOfDate;
  let months = monthsBetween(ym(p.startDate), ym(capDate));
  months = Math.max(0, Math.min(months, p.termMonths));
  return Math.min(round2(monthly * months), p.totalAmount);
}

export function remainingBalance(p: PrepaidExpense, asOfDate: string): number {
  return round2(p.totalAmount - amortizedToDate(p, asOfDate));
}

// Months not yet posted (lastAmortizedThrough exclusive) up through throughDate's month, capped
// at termMonths total and at a write-off month if written off. Strictly-before semantics (only
// fully-elapsed months count) so this always matches amortizedToDate's own month count.
export function pendingAmortizationMonths(p: PrepaidExpense, throughDate: string): { yearMonth: string; amount: number }[] {
  const monthly = monthlyAmortization(p);
  if (monthly <= 0) return [];
  const startYm = ym(p.startDate);
  const capYm = p.writtenOff?.date ? ym(p.writtenOff.date) : ym(throughDate);
  const throughYm = ym(throughDate) < capYm ? ym(throughDate) : capYm;
  const cursorStart = p.lastAmortizedThrough ? addMonths(p.lastAmortizedThrough, 1) : startYm;
  if (cursorStart >= throughYm) return [];

  const alreadyPosted = p.lastAmortizedThrough
    ? Math.min(round2(monthly * monthsBetween(startYm, addMonths(p.lastAmortizedThrough, 1))), p.totalAmount)
    : 0;
  let remaining = round2(p.totalAmount - alreadyPosted);

  const out: { yearMonth: string; amount: number }[] = [];
  let cursor = cursorStart;
  let monthIndex = monthsBetween(startYm, cursorStart);
  while (cursor < throughYm && monthIndex < p.termMonths && remaining > 0) {
    const amount = Math.min(monthly, remaining);
    out.push({ yearMonth: cursor, amount });
    remaining = round2(remaining - amount);
    cursor = addMonths(cursor, 1);
    monthIndex++;
  }
  return out;
}
