import type { Tx, Account, IndiaPayslipMonth } from "./vault-types";

// Same broad, regex-based match already used for the US book's salary-voucher detection
// (lib/payroll-match.ts's isSalaryVoucher) rather than one hardcoded exact ledger name -- covers
// a flat "Salary Income" account shared across employers, or per-employer salary ledgers, either
// way without needing an exact name.
const SALARY_LEDGER_PATTERN = /salary/i;

// TCS pays on the last working day of the SAME month the salary is for. Every other employer
// pays in the first few days of the FOLLOWING month for the prior month's salary -- so the real
// ledger posting for, say, April 2011 salary shows up dated early May 2011, not April. Matching
// April payroll against April's ledger activity for those employers would show a false mismatch
// every single month.
const TCS_PATTERN = /\btcs\b/i;
// "First few days" of the following month -- wide enough to cover normal payday drift, narrow
// enough not to bleed into the NEXT month's own salary posting a few weeks later.
const NEXT_MONTH_WINDOW_END_DAY = 10;

export interface PayrollLedgerRow {
  ym: string; // "YYYY-MM" -- the payroll month, not the ledger posting month
  label: string; // "Apr 2011 — RCOM"
  employer: string;
  ledgerWindowLabel: string; // e.g. "1–10 May 2011" or "Apr 2011 (full month)" -- shown in the
  // export so the offset applied is visible, not a silent assumption.
  basic: number;
  hra: number;
  otherAllowances: number;
  pf: number;
  professionalTax: number;
  otherDeductions: number;
  incomeTax: number;
  payrollGross: number;
  payrollNet: number;
  ledgerAmount: number; // net "salary income" credit recorded in the real ledger for that window
  variance: number; // ledgerAmount - payrollGross
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthRange(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, "0")}` };
}

function addMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The date range the real ledger posting for a given payroll month/employer is expected to
 * fall in, plus a human-readable label for the export. */
function ledgerWindowFor(ym: string, employer: string): { start: string; end: string; label: string } {
  const [y, m] = ym.split("-").map(Number);
  if (TCS_PATTERN.test(employer)) {
    const { start, end } = monthRange(ym);
    return { start, end, label: `${MONTH_NAMES[m - 1]} ${y} (full month)` };
  }
  const nextYm = addMonth(ym);
  const [ny, nm] = nextYm.split("-").map(Number);
  return {
    start: `${nextYm}-01`,
    end: `${nextYm}-${String(NEXT_MONTH_WINDOW_END_DAY).padStart(2, "0")}`,
    label: `1–${NEXT_MONTH_WINDOW_END_DAY} ${MONTH_NAMES[nm - 1]} ${ny}`,
  };
}

/** Net "salary income" recorded in the real Tally-derived ledgers for an arbitrary date range --
 * sums every account whose name matches /salary/i, crediting income postings and netting off any
 * debit reversal. */
export function salaryLedgerTotalForRange(transactions: Tx[], accounts: Account[], start: string, end: string): number {
  const matchingIds = new Set(accounts.filter((a) => SALARY_LEDGER_PATTERN.test(a.name)).map((a) => a.id));
  if (matchingIds.size === 0) return 0;
  let credit = 0;
  let debit = 0;
  for (const t of transactions) {
    if (t.deleted || t.cancelled) continue;
    if (t.date < start || t.date > end) continue;
    for (const e of t.entries) {
      if (!matchingIds.has(e.accountId)) continue;
      if (e.amount < 0) debit += -e.amount;
      else credit += e.amount;
    }
  }
  return credit - debit;
}

/** One row per real payroll entry in the FY (same granularity as the Payroll tab's own table --
 * a month can have more than one row if there was a mid-year job change), each matched against
 * the real ledger's activity in THAT employer's expected payment window -- same month for TCS,
 * first few days of the following month for everyone else. */
export function buildPayrollLedgerReconciliation(
  fy: string,
  fyMonths: IndiaPayslipMonth[],
  transactions: Tx[],
  accounts: Account[]
): PayrollLedgerRow[] {
  return fyMonths
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((m) => {
      const ym = m.date.slice(0, 7);
      const [, mm] = ym.split("-");
      const employer = employerFromPayslipLabel(m.label);
      const window = ledgerWindowFor(ym, employer);
      const ledgerAmount = salaryLedgerTotalForRange(transactions, accounts, window.start, window.end);
      return {
        ym,
        label: m.label || `${MONTH_NAMES[Number(mm) - 1]} ${ym.slice(0, 4)}`,
        employer,
        ledgerWindowLabel: window.label,
        basic: m.basic,
        hra: m.hra,
        otherAllowances: m.conveyance + m.otherAllowances,
        pf: m.pf,
        professionalTax: m.professionalTax,
        otherDeductions: m.otherDeductions,
        incomeTax: m.incomeTax,
        payrollGross: m.grossEarnings,
        payrollNet: m.netPay,
        ledgerAmount,
        variance: ledgerAmount - m.grossEarnings,
      };
    });
}

// Same best-effort label parsing as IndiaTaxReport.tsx's employerFromLabel -- duplicated here
// (rather than imported) since that one lives in a "use client" component file.
function employerFromPayslipLabel(label: string): string {
  const m = label.match(/—\s*([^(]+?)\s*(?:\(.*\))?\s*$/);
  return m ? m[1].trim() : "";
}
