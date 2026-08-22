import type { PayrollData, PayrollYear, PayrollRow, Tx, ManualPayrollPeriod } from "@/lib/vault-types";

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

// Only handles the "Mon DD Mon DD" period-label format used by the NVIDIA-era sheets
// (2024+). Older/prior-employer sheets use inconsistent labels ("Dec 2021", etc.) —
// those simply fail to parse here and are skipped, which is fine since Plaid's
// payroll auto-detection is NVIDIA-specific anyway.
export function parsePeriodRange(label: string, year: string): { start: string; end: string } | null {
  const m = label.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2})$/);
  if (!m) return null;
  const mo1 = MONTHS[m[1]];
  const mo2 = MONTHS[m[3]];
  if (!mo1 || !mo2) return null;
  let endYear = year;
  if (mo1 === "12" && mo2 === "01") endYear = String(Number(year) + 1);
  return {
    start: `${year}-${mo1}-${m[2].padStart(2, "0")}`,
    end: `${endYear}-${mo2}-${m[4].padStart(2, "0")}`,
  };
}

export type PayrollPeriodRef = { yearIdx: number; periodIndex: number };

// Bank deposits (payday) typically post a few days after the pay period ends.
const PAYDAY_LAG_DAYS = 5;

export function matchPayrollPeriod(payroll: PayrollData | undefined, txDate: string): PayrollPeriodRef | null {
  if (!payroll) return null;
  for (let yi = 0; yi < payroll.years.length; yi++) {
    const y = payroll.years[yi];
    for (let pi = 0; pi < y.periodLabels.length; pi++) {
      const range = parsePeriodRange(y.periodLabels[pi], y.year);
      if (!range) continue;
      const endPlus = new Date(range.end + "T00:00:00Z");
      endPlus.setUTCDate(endPlus.getUTCDate() + PAYDAY_LAG_DAYS);
      const endPlusStr = endPlus.toISOString().slice(0, 10);
      if (txDate >= range.start && txDate <= endPlusStr) return { yearIdx: yi, periodIndex: pi };
    }
  }
  return null;
}

export function rowValue(year: PayrollYear, label: string, periodIndex: number, occurrence = 0): number {
  const r = year.rows.filter((x) => x.label === label)[occurrence];
  return r?.values[periodIndex] ?? 0;
}

// Live-detect an existing Receipt voucher (manually entered, Tally-synced, or Plaid-imported —
// doesn't matter how it got there) that already accounts for a given pay period, so the Tax tab
// can link straight to it instead of tracking a separate "confirmed" flag.
const VOUCHER_WINDOW_DAYS_AFTER = 10;

export function findPayrollVoucher(transactions: Tx[], year: string, periodLabel: string): Tx | undefined {
  const range = parsePeriodRange(periodLabel, year);
  if (!range) return undefined;
  const endPlus = new Date(range.end + "T00:00:00Z");
  endPlus.setUTCDate(endPlus.getUTCDate() + VOUCHER_WINDOW_DAYS_AFTER);
  const endPlusStr = endPlus.toISOString().slice(0, 10);
  return transactions.find((t) => isSalaryVoucher(t) && t.date >= range.start && t.date <= endPlusStr);
}

export function isSalaryVoucher(t: Tx): boolean {
  if (t.cancelled || t.deleted) return false;
  const narrationMatch = /salary/i.test(t.narration || "");
  const entryMatch = t.entries.some((e) => /salary income/i.test(e.accountName || ""));
  return narrationMatch || entryMatch;
}

// Semi-monthly period label matching the "Mon DD Mon DD" format the Excel import uses,
// so a voucher posted for a period the imported workbook doesn't cover yet (e.g. the
// user's books run ahead of their last Excel export) still renders consistently.
export function inferPeriodLabel(dateIso: string): string {
  const d = new Date(dateIso + "T00:00:00Z");
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  if (day <= 15) return `${month} 01 ${month} 15`;
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return `${month} 16 ${month} ${lastDay}`;
}

export type ShadowPeriod = {
  label: string;
  tx: Tx;
  base: number;
  telephone: number;
  medical: number;
  k401: number;
  tax: number; // lump total — vouchers only carry one blended "Tax Deduction" line, not the
  // Federal/SSN/Medicare/State W-H/State SDI breakdown the Excel import provides.
  net: number;
};

function entrySum(t: Tx, pattern: RegExp): number {
  return t.entries.filter((e) => pattern.test(e.accountName || "")).reduce((s, e) => s + Math.abs(e.amount), 0);
}

export function buildShadowPeriod(t: Tx): ShadowPeriod {
  const base = entrySum(t, /salary income/i);
  const telephone = entrySum(t, /telephone/i);
  const medical = entrySum(t, /health insurance|medical/i);
  const k401 = entrySum(t, /401\s*k/i);
  const tax = entrySum(t, /tax deduction|^tax$/i);
  // The bank-side deposit is whatever's left once the known buckets balance out —
  // avoids having to guess the bank account's name (varies by institution).
  const net = Math.max(0, base + telephone - medical - k401 - tax);
  return { label: inferPeriodLabel(t.date), tx: t, base, telephone, medical, k401, tax, net };
}

// Salary vouchers posted in the vault (manual entry, Tally sync, or Plaid import) for a
// date not covered by any period already in the imported Excel, AND not already turned into
// a persisted manual period — i.e. genuinely new since the last Excel import or manual entry.
export function findUncoveredSalaryVouchers(transactions: Tx[], yr: PayrollYear): Tx[] {
  const manualGuids = new Set((yr.manualPeriods ?? []).map((m) => m.txGuid));
  return transactions.filter((t) => {
    if (manualGuids.has(t.guid)) return false;
    if (!t.date.startsWith(yr.year)) return false;
    if (!isSalaryVoucher(t)) return false;
    const covered = yr.periodLabels.some((label) => {
      if (!label) return false;
      const range = parsePeriodRange(label, yr.year);
      if (!range) return false;
      const endPlus = new Date(range.end + "T00:00:00Z");
      endPlus.setUTCDate(endPlus.getUTCDate() + VOUCHER_WINDOW_DAYS_AFTER);
      return t.date >= range.start && t.date <= endPlus.toISOString().slice(0, 10);
    });
    return !covered;
  });
}

function rowFor(rows: PayrollRow[], label: string): PayrollRow | undefined {
  return rows.find((r) => r.label === label);
}

// A first-pass estimate for a voucher-derived period: finds the existing period (Excel or
// already-saved manual) whose Base+Telephone amount is closest to this voucher's, then applies
// THAT period's Federal:SSN:Medicare:State W-H:State SDI ratio-of-total-tax to this voucher's
// own (known) lump tax total. Marked `estimated: true` — meant to be corrected once the user
// has their real paystub, not treated as authoritative.
export function estimateManualPeriod(yr: PayrollYear, t: Tx): ManualPayrollPeriod {
  const shadow = buildShadowPeriod(t);
  const base = rowFor(yr.rows, "Base");
  const telephone = rowFor(yr.rows, "Telephone");
  const federal = rowFor(yr.rows, "Federal");
  const ssn = rowFor(yr.rows, "SSN");
  const medicare = rowFor(yr.rows, "Medicare");
  const stateWH = rowFor(yr.rows, "State W/H");
  const stateSDI = rowFor(yr.rows, "State SDI");
  const totalTax = rowFor(yr.rows, "Total Tax");
  const targetGross = shadow.base + shadow.telephone;

  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < yr.periodLabels.length; i++) {
    const g = (base?.values[i] ?? 0) + (telephone?.values[i] ?? 0);
    const refTax = totalTax?.values[i] ?? 0;
    if (!g || !refTax) continue;
    const diff = Math.abs(g - targetGross);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }

  let federalEst = 0, ssnEst = 0, medicareEst = 0, stateWHEst = 0, stateSDIEst = 0;
  if (bestIdx >= 0) {
    const refTax = totalTax?.values[bestIdx] ?? 0;
    if (refTax > 0) {
      const scale = (r?: PayrollRow) => ((r?.values[bestIdx] ?? 0) / refTax) * shadow.tax;
      federalEst = scale(federal);
      ssnEst = scale(ssn);
      medicareEst = scale(medicare);
      stateWHEst = scale(stateWH);
      stateSDIEst = scale(stateSDI);
    }
  }

  return {
    id: crypto.randomUUID(),
    label: shadow.label,
    txGuid: t.guid,
    base: shadow.base,
    telephone: shadow.telephone,
    medical: shadow.medical,
    k401: shadow.k401,
    federal: federalEst,
    ssn: ssnEst,
    medicare: medicareEst,
    stateWH: stateWHEst,
    stateSDI: stateSDIEst,
    totalTax: shadow.tax,
    net: shadow.net,
    estimated: true,
  };
}
