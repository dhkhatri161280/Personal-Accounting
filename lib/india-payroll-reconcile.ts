import type { Tx, Account, IndiaPayslipMonth } from "./vault-types";

// Same broad, regex-based match already used for the US book's salary-voucher detection
// (lib/payroll-match.ts's isSalaryVoucher) rather than one hardcoded exact ledger name -- a
// year with more than one employer often has separate salary ledgers per employer (e.g. "Salary
// Income - TCS"), so matching by name pattern picks up all of them without the user needing to
// tell us each one.
const SALARY_LEDGER_PATTERN = /salary/i;

export interface PayrollLedgerMonthRow {
  ym: string; // "YYYY-MM"
  label: string; // "Apr 2016"
  employers: string; // comma-joined, best-effort from payroll row labels
  basic: number;
  hra: number;
  otherAllowances: number;
  pf: number;
  professionalTax: number;
  otherDeductions: number;
  incomeTax: number;
  payrollGross: number;
  payrollNet: number;
  ledgerAmount: number; // net "salary income" credit recorded in the real ledger that month
  variance: number; // ledgerAmount - payrollGross
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthRange(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, "0")}` };
}

/** Net "salary income" recorded in the real Tally-derived ledgers for one calendar month --
 * sums every account whose name matches /salary/i (covers per-employer salary ledgers without
 * needing an exact name), crediting income postings and netting off any debit reversal. */
export function salaryLedgerMonthlyTotal(transactions: Tx[], accounts: Account[], ym: string): number {
  const matchingIds = new Set(accounts.filter((a) => SALARY_LEDGER_PATTERN.test(a.name)).map((a) => a.id));
  if (matchingIds.size === 0) return 0;
  const { start, end } = monthRange(ym);
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

/** One row per calendar month in the FY (Apr-Mar) -- the union of months that have payroll
 * data AND months where the real ledger recorded salary activity, so a month missing from the
 * Payroll tab still shows up (with payroll figures at 0) instead of being silently skipped. */
export function buildPayrollLedgerReconciliation(
  fy: string,
  fyMonths: IndiaPayslipMonth[],
  transactions: Tx[],
  accounts: Account[]
): PayrollLedgerMonthRow[] {
  const startYear = Number(fy.slice(0, 4));
  const yms: string[] = [];
  for (let i = 0; i < 12; i++) {
    const monthNum = ((i + 3) % 12) + 1; // Apr(4)..Mar(3)
    const year = monthNum >= 4 ? startYear : startYear + 1;
    yms.push(`${year}-${String(monthNum).padStart(2, "0")}`);
  }

  return yms.map((ym) => {
    const monthRows = fyMonths.filter((m) => m.date.slice(0, 7) === ym);
    const [, mm] = ym.split("-");
    const label = `${MONTH_NAMES[Number(mm) - 1]} ${ym.slice(0, 4)}`;
    const employers = Array.from(new Set(monthRows.map((m) => employerFromPayslipLabel(m.label)).filter(Boolean))).join(", ");
    const sum = (f: (m: IndiaPayslipMonth) => number) => monthRows.reduce((s, m) => s + f(m), 0);
    const payrollGross = sum((m) => m.grossEarnings);
    const payrollNet = sum((m) => m.netPay);
    const ledgerAmount = salaryLedgerMonthlyTotal(transactions, accounts, ym);
    return {
      ym,
      label,
      employers,
      basic: sum((m) => m.basic),
      hra: sum((m) => m.hra),
      otherAllowances: sum((m) => m.conveyance + m.otherAllowances),
      pf: sum((m) => m.pf),
      professionalTax: sum((m) => m.professionalTax),
      otherDeductions: sum((m) => m.otherDeductions),
      incomeTax: sum((m) => m.incomeTax),
      payrollGross,
      payrollNet,
      ledgerAmount,
      variance: ledgerAmount - payrollGross,
    };
  });
}

// Same best-effort label parsing as IndiaTaxReport.tsx's employerFromLabel -- duplicated here
// (rather than imported) since that one lives in a "use client" component file.
function employerFromPayslipLabel(label: string): string {
  const m = label.match(/—\s*([^(]+?)\s*(?:\(.*\))?\s*$/);
  return m ? m[1].trim() : "";
}
