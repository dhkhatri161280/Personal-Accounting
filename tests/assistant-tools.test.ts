import assert from "node:assert/strict";
import test from "node:test";
import { resolvePeriod, executeTool, TOOL_DEFS, coerceToolArgs } from "../lib/assistant-tools.ts";
import type { Account, Tx, Ledger, RsuGrant, Trade, Budget, FixedAsset, Loan, PrepaidExpense, PayrollData, PayrollYear, IndiaPayslipMonth, IndiaItrYear } from "../lib/vault-types.ts";

function account(id: number, name: string, parent: string, openingBalance = 0): Account {
  return { id, name, parent, category: "Asset", currency: "USD", openingBalance, active: true };
}

// accountName defaults to "" but can be set per-entry (e.g. to "Salary Income - Employer") --
// buildShadowPeriod (lib/payroll-match.ts, used by get_salary_summary) matches deduction buckets
// by each ENTRY's own accountName text, not by looking up the account record, so a salary test
// must carry the real name through on the entry itself.
function tx(id: number, date: string, type: string, narration: string, entries: { accountId: number; amount: number; accountName?: string }[]): Tx {
  return { id, guid: `v${id}`, date, number: String(id), type, narration, historical: false, entries: entries.map((e) => ({ accountId: e.accountId, amount: e.amount, accountName: e.accountName || "" })) };
}

// ---- resolvePeriod: the exact date math that replaced the old fiscal-year/calendar-year
// confusion -- the model no longer computes date ranges itself, so this must be right in code.

test("resolvePeriod: current_fiscal_year runs Apr-Mar, not Jan-Dec", () => {
  // "Today" Oct 2026 -> FY2026 (Apr 2026 - Mar 2027), matching this app's own books (fiscalYearOf).
  const r = resolvePeriod("current_fiscal_year", "2026-10-15");
  assert.equal(r.from, "2026-04-01");
  assert.equal(r.to, "2027-03-31");
  assert.ok(r.label.includes("FY2026"));
});

test("resolvePeriod: a date in Jan-Mar belongs to the PREVIOUS fiscal year", () => {
  // Jan 2027 is still FY2026 (Apr 2026 - Mar 2027) under this app's Apr-start fiscal year.
  const r = resolvePeriod("current_fiscal_year", "2027-01-15");
  assert.equal(r.from, "2026-04-01");
  assert.equal(r.to, "2027-03-31");
});

test("resolvePeriod: current_calendar_year is Jan-Dec and differs from current_fiscal_year", () => {
  const fy = resolvePeriod("current_fiscal_year", "2026-10-15");
  const cy = resolvePeriod("current_calendar_year", "2026-10-15");
  assert.equal(cy.from, "2026-01-01");
  assert.equal(cy.to, "2026-12-31");
  assert.notEqual(fy.from, cy.from, "fiscal year and calendar year must never resolve to the same range");
});

test("resolvePeriod: last_fiscal_year and last_calendar_year are each one period earlier", () => {
  const lastFy = resolvePeriod("last_fiscal_year", "2026-10-15");
  assert.equal(lastFy.from, "2025-04-01");
  assert.equal(lastFy.to, "2026-03-31");
  const lastCy = resolvePeriod("last_calendar_year", "2026-10-15");
  assert.equal(lastCy.from, "2025-01-01");
  assert.equal(lastCy.to, "2025-12-31");
});

test("resolvePeriod: current_month resolves to the real last day of that month", () => {
  const r = resolvePeriod("current_month", "2026-02-10");
  assert.equal(r.from, "2026-02-01");
  assert.equal(r.to, "2026-02-28");
});

// ---- search_vouchers ---------------------------------------------------------------------

test("search_vouchers: a Payment is spend (positive), a Receipt against an expense account is a refund (negative, labeled)", () => {
  const accounts = [account(1, "Shopping", "Indirect Expenses"), account(999, "Citi Credit Card", "Bank Accounts")];
  const purchase = tx(1, "2026-04-05", "Payment", "Shopping @ Costco", [{ accountId: 1, amount: -129.77 }, { accountId: 999, amount: 129.77 }]);
  const refund = tx(2, "2026-04-06", "Receipt", "Shopping @ Costco", [{ accountId: 1, amount: 22.04 }, { accountId: 999, amount: -22.04 }]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [purchase, refund] };
  const result = executeTool("search_vouchers", { terms: ["costco"], period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("(129.77 USD)"), "a normal Payment purchase stays a plain positive amount");
  assert.ok(result.includes("(-22.04 USD -- REFUND/return)"), "a Receipt refund must show negative and explicitly labeled");
  assert.ok(result.includes("PRECOMPUTED TOTAL") && result.includes("107.73 USD"), "total must be 129.77 - 22.04 = 107.73");
});

test("search_vouchers: a salary Receipt with both Income and Expense entries is never mislabeled a refund", () => {
  const accounts = [account(1, "Salary Income - Employer", "Direct Incomes"), account(2, "Tax Deduction", "Indirect Expenses"), account(999, "Bank", "Bank Accounts")];
  const paystub = tx(1, "2026-04-15", "Receipt", "Salary Income - Semi Monthly", [
    { accountId: 1, amount: 10_000 },
    { accountId: 2, amount: -200 },
    { accountId: 999, amount: -9_800 },
  ]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [paystub] };
  const result = executeTool("search_vouchers", { terms: ["salary"], period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(!result.includes("REFUND/return"), "a salary voucher with an Income entry must never be labeled a refund");
});

test("search_vouchers: the precomputed total covers EVERY real match, not just the ones listed", () => {
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses"), account(999, "Citi Credit Card", "Bank Accounts")];
  const transactions: Tx[] = Array.from({ length: 6 }, (_, i) =>
    tx(i + 1, `2026-0${4 + i}-15`, "Payment", "Shopping @ Costco Gasoline", [{ accountId: 1, amount: -10 }, { accountId: 999, amount: 10 }])
  );
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions };
  const result = executeTool("search_vouchers", { terms: ["costco"], period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("6 matching voucher(s)"));
  assert.ok(result.includes("60.00 USD"), "total must cover all 6 vouchers (6 x 10.00)");
});

test("search_vouchers: a match outside the fiscal year is excluded", () => {
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses"), account(999, "Citi Credit Card", "Bank Accounts")];
  const inFy = tx(1, "2026-04-15", "Payment", "Gasoline @ Costco", [{ accountId: 1, amount: -50 }, { accountId: 999, amount: 50 }]);
  const pastFy = tx(2, "2016-10-27", "Payment", "Gas from Costco", [{ accountId: 1, amount: -18 }, { accountId: 999, amount: 18 }]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [inFy, pastFy] };
  const result = executeTool("search_vouchers", { terms: ["costco"], period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("Gasoline @ Costco"));
  assert.ok(!result.includes("Gas from Costco"), "a match from a past fiscal year must be excluded");
});

test("search_vouchers: says plainly when nothing matches", () => {
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses")];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [] };
  const result = executeTool("search_vouchers", { terms: ["costco"], period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("0 matching vouchers found"));
});

// ---- get_account_ledger ------------------------------------------------------------------

test("get_account_ledger: returns every voucher in the named account regardless of narration", () => {
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses"), account(999, "Citi Credit Card", "Bank Accounts")];
  const costco = tx(1, "2026-04-15", "Payment", "Gasoline @ Costco", [{ accountId: 1, amount: -50 }, { accountId: 999, amount: 50 }]);
  const chargepoint = tx(2, "2026-05-01", "Payment", "CHARGEPOINT INC", [{ accountId: 1, amount: -3 }, { accountId: 999, amount: 3 }]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [costco, chargepoint] };
  const result = executeTool("get_account_ledger", { accountName: "Vehicle Maintenance", period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("Gasoline @ Costco"));
  assert.ok(result.includes("CHARGEPOINT INC"), "every voucher in the account must be included, regardless of narration");
  assert.ok(result.includes("53.00 USD"), "total must be 50 + 3 = 53");
});

test("get_account_ledger: says plainly when the account name doesn't exist", () => {
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses")];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [] };
  const result = executeTool("get_account_ledger", { accountName: "Nonexistent Account", period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("no account found"));
});

test("get_account_ledger: two DISTINCT accounts sharing a substring are never silently blended into one total", () => {
  // Confirmed live: asked "how much is the ESPP this FY", a plain substring match found TWO real
  // accounts both containing "espp" (an ESPP Deduction account and a separate ESPP-related
  // account) and summed vouchers from BOTH into one total that matched neither account's own real
  // ledger report ($41559.46 vs the real $3802.22). Must refuse to blend and name both instead.
  const accounts = [
    account(1, "ESPP Deduction", "Investments"),
    account(2, "ESPP Shares Held", "Investments"),
    account(999, "Bank", "Bank Accounts"),
  ];
  const deduction = tx(1, "2026-04-15", "Payment", "ESPP payroll deduction", [{ accountId: 1, amount: -1525 }, { accountId: 999, amount: 1525 }]);
  const shares = tx(2, "2026-05-01", "Receipt", "ESPP shares purchased", [{ accountId: 2, amount: 40000 }, { accountId: 999, amount: -40000 }]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [deduction, shares] };
  const result = executeTool("get_account_ledger", { accountName: "ESPP", period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("DIFFERENT accounts"), "must refuse to guess/blend when multiple distinct accounts match");
  assert.ok(result.includes("ESPP Deduction") && result.includes("ESPP Shares Held"), "must name both real candidate accounts");
  assert.ok(!result.includes("41525.00"), "must never produce a blended total across the two distinct accounts");
});

test("get_account_ledger: an EXACT name match wins outright over a broader partial match", () => {
  const accounts = [account(1, "ESPP Deduction", "Investments"), account(2, "ESPP Deduction Extra", "Investments"), account(999, "Bank", "Bank Accounts")];
  const real = tx(1, "2026-04-15", "Payment", "ESPP payroll deduction", [{ accountId: 1, amount: -1525 }, { accountId: 999, amount: 1525 }]);
  const other = tx(2, "2026-05-01", "Payment", "Other", [{ accountId: 2, amount: -999 }, { accountId: 999, amount: 999 }]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [real, other] };
  const result = executeTool("get_account_ledger", { accountName: "ESPP Deduction", period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("1525.00 USD"), "an exact name match must use ONLY that account, not blend in the similarly-named one");
  assert.ok(!result.includes("DIFFERENT accounts"));
});

test("get_account_ledger: an Investment-nature account's net total matches the real Ledger report's own math, not an always-positive magnitude", () => {
  // Confirmed live: the real Ledger report for "ESPP Deduction" (Investments) this FY showed
  // exactly 4 vouchers -- three deductions of +1525.00 (10-Oct, 09-Sep, 15-Apr) and one reversal
  // of -772.78 (01-Jun) -- for a real "Displayed total" of 3802.22. The old classifyVoucher-based
  // logic only special-cased Expense-nature accounts; for an Investment-nature account like this
  // one, every voucher fell through to an always-positive magnitude, which would have shown the
  // reversal as +772.78 instead of -772.78 (total 5347.78, still wrong, though not the exact wrong
  // number seen live -- the point is ANY non-Expense account's sign was never handled at all).
  // Real ledgerSignedAmount convention (components/TransactionTable.tsx): displayed = -(this
  // account's own raw entry sum) -- so a deduction (Dr, raw negative) displays positive, and a
  // reversal (Cr, raw positive) displays negative.
  const accounts = [account(1, "ESPP Deduction", "Investments"), account(999, "Bank Of America", "Bank Accounts")];
  const transactions: Tx[] = [
    tx(1, "2026-04-15", "Payment", "ESPP payroll deduction", [{ accountId: 1, amount: -1525 }, { accountId: 999, amount: 1525 }]),
    tx(2, "2026-06-01", "Receipt", "ESPP deduction reversal", [{ accountId: 1, amount: 772.78 }, { accountId: 999, amount: -772.78 }]),
    tx(3, "2026-09-09", "Payment", "ESPP payroll deduction", [{ accountId: 1, amount: -1525 }, { accountId: 999, amount: 1525 }]),
    tx(4, "2026-10-10", "Payment", "ESPP payroll deduction", [{ accountId: 1, amount: -1525 }, { accountId: 999, amount: 1525 }]),
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions };
  const result = executeTool("get_account_ledger", { accountName: "ESPP Deduction", period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("4 voucher(s)"));
  assert.ok(result.includes("3802.22 USD"), "must match the real Ledger report's own 'Displayed total' exactly");
  assert.ok(result.includes("(-772.78 USD)"), "the reversal must display negative, same sign the real Ledger report shows it with");
});

// ---- search_accounts ---------------------------------------------------------------------

test("search_accounts: combines several named accounts into one authoritative total, with a per-account breakdown", () => {
  // The user's own original ask: "Gas"/"Gasoline" spend could be recorded under Vehicle
  // Maintenance, Travelling, OR House Hold -- one real purchase in each, this must find all three
  // and sum them, while still showing which account each dollar came from.
  const accounts = [
    account(1, "Vehicle Maintenance", "Indirect Expenses"),
    account(2, "Travelling Expenses", "Indirect Expenses"),
    account(3, "House Hold Exps", "Indirect Expenses"),
    account(999, "Citi Credit Card", "Bank Accounts"),
  ];
  const vehicle = tx(1, "2026-04-05", "Payment", "Gas station fill-up", [{ accountId: 1, amount: -40 }, { accountId: 999, amount: 40 }]);
  const travel = tx(2, "2026-05-10", "Payment", "Rental car gasoline", [{ accountId: 2, amount: -25 }, { accountId: 999, amount: 25 }]);
  const house = tx(3, "2026-06-01", "Payment", "Generator gasoline", [{ accountId: 3, amount: -15 }, { accountId: 999, amount: 15 }]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [vehicle, travel, house] };
  const result = executeTool(
    "search_accounts",
    { accountNames: ["Vehicle Maintenance", "Travelling Expenses", "House Hold Exps"], period: "current_fiscal_year" },
    data, "us", "2026-10-15"
  );
  assert.ok(result.includes("3 voucher(s) across 3 account(s)"));
  assert.ok(result.includes("PRECOMPUTED TOTAL") && result.includes("80.00 USD"), "total must be 40 + 25 + 15 = 80");
  assert.ok(result.includes("Vehicle Maintenance: 40.00") && result.includes("Travelling Expenses: 25.00") && result.includes("House Hold Exps: 15.00"), "per-account breakdown must show each account's own contribution");
});

test("search_accounts: an optional narration term filters WITHIN the requested accounts, excluding unrelated vouchers in the same accounts", () => {
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses"), account(999, "Bank", "Bank Accounts")];
  const gas = tx(1, "2026-04-05", "Payment", "Gasoline fill-up", [{ accountId: 1, amount: -40 }, { accountId: 999, amount: 40 }]);
  const oilChange = tx(2, "2026-04-06", "Payment", "Oil change service", [{ accountId: 1, amount: -60 }, { accountId: 999, amount: 60 }]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [gas, oilChange] };
  const result = executeTool("search_accounts", { accountNames: ["Vehicle Maintenance"], terms: ["gas"], period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("Gasoline fill-up"));
  assert.ok(!result.includes("Oil change service"), "a narration term must exclude a voucher in the same account that doesn't match it");
  assert.ok(result.includes("40.00 USD"));
});

test("search_accounts: resolves what it can and reports what it can't, without blending an ambiguous name's accounts together", () => {
  const accounts = [
    account(1, "Vehicle Maintenance", "Indirect Expenses"),
    account(2, "ESPP Deduction", "Investments"),
    account(3, "ESPP Shares Held", "Investments"),
    account(999, "Bank", "Bank Accounts"),
  ];
  const real = tx(1, "2026-04-05", "Payment", "Gas", [{ accountId: 1, amount: -40 }, { accountId: 999, amount: 40 }]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [real] };
  const result = executeTool("search_accounts", { accountNames: ["Vehicle Maintenance", "ESPP", "No Such Account"], period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("1 account(s)"), "only the one unambiguously-resolved account should be used");
  assert.ok(result.includes("40.00 USD"));
  assert.ok(result.includes("ambiguous") && result.includes("ESPP Deduction") && result.includes("ESPP Shares Held"), "the ambiguous name must be reported, naming both real candidates, not guessed or blended");
  assert.ok(result.includes("No Such Account"), "an unresolvable name must be reported too");
});

test("search_accounts: a clear error when no account name resolves at all", () => {
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses")];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [] };
  const result = executeTool("search_accounts", { accountNames: ["Nonexistent"], period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("could not resolve"));
});

// ---- get_salary_summary -------------------------------------------------------------------

test("get_salary_summary: take-home reads the real bank deposit, not a derived subtraction", () => {
  // Gross 10000, tax 200, plus a $100 "Other Deduction" the derived-subtraction formula doesn't
  // recognize -- the real bank deposit (9700) must win over the naive derived figure (9800).
  const accounts = [
    account(1, "Salary Income - Employer", "Direct Incomes"),
    account(2, "Tax Deduction", "Indirect Expenses"),
    account(3, "Other Deduction", "Indirect Expenses"),
    account(999, "Bank Of America", "Bank Accounts"),
  ];
  const paystub = tx(1, "2026-04-15", "Receipt", "Salary Income - Semi Monthly", [
    { accountId: 1, amount: 10_000, accountName: "Salary Income - Employer" },
    { accountId: 2, amount: -200, accountName: "Tax Deduction" },
    { accountId: 3, amount: -100, accountName: "Other Deduction" },
    { accountId: 999, amount: -9_700, accountName: "Bank Of America" },
  ]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [paystub] };
  const result = executeTool("get_salary_summary", { period: "current_fiscal_year" }, data, "us", "2026-10-15");
  assert.ok(result.includes("gross pay 10000.00"));
  assert.ok(result.includes("tax deducted 200.00"));
  assert.ok(result.includes("net take-home (actual bank deposits) 9700.00"), "must be the real bank deposit (9700), not the derived figure (9800)");
});

test("get_salary_summary: fiscal-year and calendar-year periods give different totals when they should", () => {
  const accounts = [account(1, "Salary Income - Employer", "Direct Incomes"), account(2, "Tax Deduction", "Indirect Expenses"), account(999, "Bank", "Bank Accounts")];
  const janVoucher = tx(1, "2026-01-15", "Receipt", "Salary Income - Semi Monthly", [
    { accountId: 1, amount: 5_000, accountName: "Salary Income - Employer" },
    { accountId: 2, amount: -1_000, accountName: "Tax Deduction" },
    { accountId: 999, amount: -4_000, accountName: "Bank" },
  ]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [janVoucher] };
  // "Today" Oct 2026 -> FY2026 is Apr 2026-Mar 2027, so a January 2026 voucher is in the PRIOR FY,
  // but IS in the current calendar year (CY2026, Jan-Dec).
  const fyResult = executeTool("get_salary_summary", { period: "current_fiscal_year" }, data, "us", "2026-10-15");
  const cyResult = executeTool("get_salary_summary", { period: "current_calendar_year" }, data, "us", "2026-10-15");
  assert.ok(fyResult.includes("0 paystub vouchers found"), "a January voucher is outside the current (Apr-start) fiscal year");
  assert.ok(cyResult.includes("gross pay 5000.00"), "the same voucher IS inside the current calendar year");
});

// ---- get_account_balances -----------------------------------------------------------------

test("get_account_balances: shows non-zero balances and labels them as cumulative, not period/YTD", () => {
  const accounts = [account(1, "SBI Savings", "Bank Accounts", -500_000), account(2, "Zero Balance Acct", "Bank Accounts", 0)];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [] };
  const result = executeTool("get_account_balances", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("SBI Savings"));
  assert.ok(!result.includes("Zero Balance Acct"), "a zero balance must be omitted");
  assert.ok(result.includes("CUMULATIVE"), "must explicitly disclose these are cumulative, not a period total");
});

test("get_account_balances: nameFilter narrows to matching accounts only", () => {
  const accounts = [account(1, "SBI Savings", "Bank Accounts", -500_000), account(2, "NVDA Equity", "Investments", -1_000)];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [] };
  const result = executeTool("get_account_balances", { nameFilter: "nvda" }, data, "us", "2026-10-15");
  assert.ok(result.includes("NVDA Equity"));
  assert.ok(!result.includes("SBI Savings"));
});

test("get_account_balances: matches the real dashboard's sign exactly, not its double-negated opposite", () => {
  // Confirmed live: asked "closing balance of 401K as of today", this tool answered -$97,452.78
  // against the real dashboard's own +$97,452.78 for the same account -- a double-negation bug.
  // ledgerBalanceAsOf (lib/vault-accounting.ts) already returns the final, correctly-signed
  // display value on its own; wrapping it in displayLedgerBalance() (as this tool used to) applied
  // a SECOND negation, flipping every single balance's sign back to wrong. Every other call site
  // in the app (VaultApp.tsx's own dashboard included) uses ledgerBalanceAsOf directly, never
  // wrapped -- this fixture mirrors VaultApp's own closing-balance math (opening + all entries,
  // then negated for display) for a single contribution so the two can be compared directly.
  const accounts = [account(1, "401K Investments", "Investments")];
  const contribution = tx(1, "2026-04-15", "Payment", "401k contribution", [{ accountId: 1, amount: -97_452.78 }, { accountId: 999, amount: 97_452.78 }]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [...accounts, account(999, "Bank", "Bank Accounts")], transactions: [contribution] };
  const result = executeTool("get_account_balances", { nameFilter: "401k" }, data, "us", "2026-10-15");
  assert.ok(result.includes("97452.78 USD"), "a real positive contribution must display positive, matching the real dashboard");
  assert.ok(!result.includes("-97452.78"), "must not show the double-negated (wrong-sign) figure");
});

// ---- get_fbar_status -----------------------------------------------------------------------

test("get_fbar_status: only available for the India book", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const usResult = executeTool("get_fbar_status", { year: 2026 }, data, "us", "2026-10-15");
  assert.ok(usResult.includes("only applies to India Books"));
  const indiaResult = executeTool("get_fbar_status", { year: 2026 }, data, "india", "2026-10-15");
  assert.ok(indiaResult.includes("FBAR"));
});

// ---- tool schema sanity -------------------------------------------------------------------

test("TOOL_DEFS: every tool has a name, description, and object-type parameters schema", () => {
  assert.ok(TOOL_DEFS.length >= 5);
  for (const t of TOOL_DEFS) {
    assert.ok(t.name.length > 0);
    assert.ok(t.description.length > 0);
    assert.equal((t.parameters as { type?: string }).type, "object");
  }
});

// ---- hardening pass: defensive behavior for malformed/unexpected model output ------------

test("executeTool: an unrecognized tool name lists the valid tool names instead of a bare error", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const result = executeTool("delete_everything", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("Unknown tool"));
  for (const t of TOOL_DEFS) assert.ok(result.includes(t.name), `must list ${t.name} as a valid tool`);
});

test("executeTool: an invalid period value falls back to current_fiscal_year AND says so explicitly", () => {
  // Confirmed live this needed visible surfacing, not just a silent fallback -- a model that sends
  // a garbled period value (e.g. a typo, or a date string instead of a period name) should show up
  // in the conversation transcript as a correction, not silently become a different period than
  // what was actually asked for.
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses"), account(999, "Bank", "Bank Accounts")];
  const inFy = tx(1, "2026-04-15", "Payment", "Gasoline @ Costco", [{ accountId: 1, amount: -50 }, { accountId: 999, amount: 50 }]);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [inFy] };
  const result = executeTool("search_vouchers", { terms: ["costco"], period: "next_tuesday" }, data, "us", "2026-10-15");
  assert.ok(result.includes("50.00 USD"), "must still fall back to current_fiscal_year and find the real match");
  assert.ok(result.includes('unrecognized period "next_tuesday"'), "must explicitly flag the invalid value, not silently substitute");
});

test("executeTool: an OMITTED period (normal case) does NOT get flagged as invalid", () => {
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses")];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [] };
  const result = executeTool("search_vouchers", { terms: ["costco"] }, data, "us", "2026-10-15");
  assert.ok(!result.includes("unrecognized period"), "omitting the period is normal and expected, not an error to flag");
});

test("coerceToolArgs: passes a real object straight through", () => {
  assert.deepEqual(coerceToolArgs({ terms: ["costco"], period: "current_fiscal_year" }), { terms: ["costco"], period: "current_fiscal_year" });
});

test("coerceToolArgs: parses a JSON-string-encoded arguments payload (a different provider's function-calling convention)", () => {
  assert.deepEqual(coerceToolArgs('{"accountName":"Vehicle Maintenance","period":"current_fiscal_year"}'), { accountName: "Vehicle Maintenance", period: "current_fiscal_year" });
});

test("coerceToolArgs: falls back to an empty object for garbage input instead of throwing", () => {
  assert.deepEqual(coerceToolArgs("not valid json"), {});
  assert.deepEqual(coerceToolArgs(null), {});
  assert.deepEqual(coerceToolArgs(undefined), {});
  assert.deepEqual(coerceToolArgs(42), {});
  assert.deepEqual(coerceToolArgs(["costco"]), {}, "an array is not a valid arguments object, even though typeof is 'object'");
});

// ---- get_equity_position --------------------------------------------------------------------

function heldRsuGrant(sharesHeld: number, vestDate = "2026-05-01"): RsuGrant {
  return {
    id: "g1", ticker: "NVDA", grantDate: "2024-01-01", totalShares: sharesHeld, grantPrice: 100,
    vests: [{ id: "v1", vestDate, shares: sharesHeld, vestPrice: 100, sharesHeld, pending: false }],
  };
}

test("get_equity_position: matches the dashboard's own math for market value, shares, and today's gain/loss", () => {
  // Confirmed against components/VaultApp.tsx's own "Equity (NVDA)" dashboard card formula
  // directly (not re-derived) -- see getEquityPosition's own comment in lib/assistant-tools.ts.
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [], equity: { grants: [heldRsuGrant(100)], esppPurchases: [] } };
  const result = executeTool("get_equity_position", {}, data, "us", "2026-10-15", 200, 190);
  assert.ok(result.includes("RSU market value: 20000.00 USD"), "100 held shares x $200 live price");
  assert.ok(result.includes("Total shares (held + scheduled): 100.0000"));
  assert.ok(result.includes("Today's gain/loss on HELD") && result.includes("1000.00 USD"), "100 shares x ($200 - $190 prev close) = 1000");
});

test("get_equity_position: says plainly when no live price is available, instead of showing $0", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [], equity: { grants: [heldRsuGrant(100)], esppPurchases: [] } };
  const result = executeTool("get_equity_position", {}, data, "us", "2026-10-15", null, null);
  assert.ok(result.includes("live stock price is currently unavailable"));
});

test("get_equity_position: says plainly when there's no equity data at all", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const result = executeTool("get_equity_position", {}, data, "us", "2026-10-15", 200, 190);
  assert.ok(result.includes("no RSU/ESPP equity data on file"));
});

// ---- get_net_worth ---------------------------------------------------------------------------

test("get_net_worth: computes ledger-only net worth, and bolts on live RSU/ESPP value when a price is available", () => {
  const accounts = [account(1, "Bank", "Bank Accounts", -10_000), account(2, "Capital", "Capital Account")];
  const voucher = tx(1, "2026-05-01", "Payment", "Transfer", [{ accountId: 1, amount: -500 }, { accountId: 2, amount: 500 }]);
  const dataNoEquity: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [voucher] };
  const resultNoPrice = executeTool("get_net_worth", {}, dataNoEquity, "us", "2026-10-15");
  assert.ok(resultNoPrice.includes("Net worth: 10500.00 USD"), "ledger-only: opening -10000 + voucher -500 => raw -10500 => displayed asset +10500");
  assert.ok(resultNoPrice.includes("ledger-only book value"));

  const dataWithEquity: Ledger = { ...dataNoEquity, equity: { grants: [heldRsuGrant(100)], esppPurchases: [] } };
  const resultWithPrice = executeTool("get_net_worth", {}, dataWithEquity, "us", "2026-10-15", 200);
  assert.ok(resultWithPrice.includes("Net worth: 30500.00 USD"), "10500 ledger + 100 held shares x $200 live = 30500");
  assert.ok(resultWithPrice.includes("live RSU/ESPP held value of 20000.00"));
});

test("get_net_worth: says plainly when there's no transaction history to compute from", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const result = executeTool("get_net_worth", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("no transaction history"));
});

// ---- get_trading_gains ------------------------------------------------------------------------

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "t1", company: "MicroStrategy", symbol: "MSTR", broker: "CST",
    buyDate: "2025-01-27", saleDate: "2025-07-15", units: 50, costPerSh: 365.44, marketOrSalePrice: 388.0, yesterday: 388.0,
    ...overrides,
  };
}

test("get_trading_gains: computes a real realized gain for the requested year, labeled as realized-sales-only", () => {
  // Same trade fixture/expected gain as tests/tax-classify-trading.test.ts's own direct test of
  // classifyTradingSales, confirming this tool reuses that exact, already-proven logic.
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [], trades: [trade()] };
  const result = executeTool("get_trading_gains", { year: "2025" }, data, "us", "2026-10-15");
  assert.ok(result.includes("1 realized sale(s)"));
  assert.ok(result.includes("net short-term 1128.00"), "50 x (388.00 - 365.44) = 1128.00, within the <365-day short-term window");
  assert.ok(result.includes("REALIZED gains/losses from actual sales ONLY"), "must disclose this is not the live value of shares still held");
});

test("get_trading_gains: excludes the employer's own ticker to avoid double-counting with RSU/ESPP sales", () => {
  const data: Ledger = {
    version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [],
    trades: [trade({ symbol: "NVDA" })],
    equity: { grants: [{ id: "g1", ticker: "NVDA", grantDate: "2024-01-01", totalShares: 1, grantPrice: 1, vests: [] }], esppPurchases: [] },
  };
  const result = executeTool("get_trading_gains", { year: "2025" }, data, "us", "2026-10-15");
  assert.ok(result.includes("0 realized sale(s)"), "NVDA trades must be excluded since NVDA is the employer ticker (would double-count with Equity RSU/ESPP sales)");
});

test("get_trading_gains: says plainly when there are no realized sales for the requested year", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [], trades: [] };
  const result = executeTool("get_trading_gains", { year: "2025" }, data, "us", "2026-10-15");
  assert.ok(result.includes("0 realized sale(s)"));
});

// ---- get_financial_ratios / get_multi_year_trend (share computeMultiYearTrend/computeNetWorthTrend) ----

function netWorthFixture(): Ledger {
  const accounts = [account(1, "Bank", "Bank Accounts", -10_000), account(2, "Capital", "Capital Account")];
  const voucher = tx(1, "2026-05-01", "Payment", "Transfer", [{ accountId: 1, amount: -500 }, { accountId: 2, amount: 500 }]);
  return { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [voucher] };
}

test("get_financial_ratios: reports the latest fiscal year's liquid assets and debt correctly", () => {
  const result = executeTool("get_financial_ratios", {}, netWorthFixture(), "us", "2026-10-15");
  assert.ok(result.includes("Liquid assets (Bank + Cash): 10500.00 USD"), "opening -10000 + voucher -500 => raw -10500 => displayed +10500");
  assert.ok(result.includes("Total debt (all liabilities): 0.00 USD"));
});

test("get_financial_ratios: says plainly when there's no history", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const result = executeTool("get_financial_ratios", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("no fiscal-year history"));
});

test("get_multi_year_trend: lists at least one fiscal year with a real net worth figure", () => {
  const result = executeTool("get_multi_year_trend", {}, netWorthFixture(), "us", "2026-10-15");
  assert.ok(result.includes("net worth 10500.00 USD"));
});

// ---- get_cash_flow_forecast ------------------------------------------------------------------

test("get_cash_flow_forecast: projects the requested number of months starting from today's cash balance", () => {
  const accounts = [account(1, "Bank", "Bank Accounts", -5_000)];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [] };
  const result = executeTool("get_cash_flow_forecast", { months: 3 }, data, "us", "2026-10-15");
  assert.ok(result.includes("next 3 month(s)"));
  assert.ok(result.includes("5000.00 USD"), "with nothing recurring configured, projected cash should stay at today's starting balance (5000)");
});

// ---- get_budget_vs_actual ----------------------------------------------------------------------

test("get_budget_vs_actual: compares a saved budget against real actuals for the fiscal year", () => {
  const accounts = [account(1, "Groceries", "Indirect Expenses"), account(999, "Bank", "Bank Accounts")];
  const voucher = tx(1, "2026-04-15", "Payment", "Groceries", [{ accountId: 1, amount: -200 }, { accountId: 999, amount: 200 }]);
  const budget: Budget = { fy: "2026", lines: [{ id: "b1", accountId: 1, monthly: Array(12).fill(100) }], updatedAt: "2026-01-01" };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [voucher], budgets: [budget] };
  const result = executeTool("get_budget_vs_actual", { fy: "2026" }, data, "us", "2026-10-15");
  assert.ok(result.includes("total expense budget 1200.00"), "12 months x 100 budgeted = 1200");
  assert.ok(result.includes("actual 200.00"), "one $200 grocery voucher this FY");
});

test("get_budget_vs_actual: says plainly when there's no budget saved for the fiscal year", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const result = executeTool("get_budget_vs_actual", { fy: "2026" }, data, "us", "2026-10-15");
  assert.ok(result.includes("no budget saved"));
});

// ---- get_401k_summary --------------------------------------------------------------------------

test("get_401k_summary: reports lifetime and by-year self/employer contributions", () => {
  const payroll: PayrollData = {
    years: [{ year: "2026", sheetName: "Yearly 2026", periodLabels: [], rows: [
      { label: "401K", annual: 0, cumulative: 15_000, values: [] },
      { label: "401K Emplr", annual: 0, cumulative: 5_000, values: [] },
    ] }],
    importedAt: "2026-01-01", sourceFileName: "test.xlsx",
  };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [], payroll };
  const result = executeTool("get_401k_summary", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("lifetime self contributions 15000.00"));
  assert.ok(result.includes("lifetime employer match 5000.00"));
  assert.ok(result.includes("- 2026: self 15000.00, employer match 5000.00"));
});

test("get_401k_summary: says plainly when there's no payroll data", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const result = executeTool("get_401k_summary", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("no payroll/401k data"));
});

// ---- get_fixed_assets --------------------------------------------------------------------------

test("get_fixed_assets: lists non-disposed assets with a depreciated book value below cost", () => {
  const asset: FixedAsset = { id: "a1", name: "Laptop", accountId: 1, purchaseDate: "2025-01-01", cost: 3_000, salvageValue: 0, usefulLifeMonths: 36 };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [], fixedAssets: [asset] };
  const result = executeTool("get_fixed_assets", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("Laptop"));
  assert.ok(result.includes("cost 3000.00"));
  assert.ok(result.includes("PRECOMPUTED TOTAL book value"));
});

test("get_fixed_assets: excludes disposed assets", () => {
  const asset: FixedAsset = { id: "a1", name: "Old Laptop", accountId: 1, purchaseDate: "2020-01-01", cost: 1_000, salvageValue: 0, usefulLifeMonths: 36, disposed: { date: "2023-01-01", proceeds: 100 } };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [], fixedAssets: [asset] };
  const result = executeTool("get_fixed_assets", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("no (non-disposed) fixed assets"));
});

// ---- get_loans ----------------------------------------------------------------------------------

test("get_loans: reports the current balance owed on an open loan", () => {
  const accounts = [account(1, "Car Loan", "Loans (Liability)", 15_000)];
  const loan: Loan = { id: "l1", name: "Car Loan", accountId: 1, interestExpenseAccountId: 2, originalPrincipal: 20_000, annualRate: 0.05, termMonths: 60, startDate: "2025-01-01", standardPayment: 377.42 };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [], loans: [loan] };
  const result = executeTool("get_loans", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("balance owed 15000.00 USD"));
  assert.ok(result.includes("rate 5.00%"));
  assert.ok(result.includes("PRECOMPUTED TOTAL owed"));
});

test("get_loans: excludes closed loans", () => {
  const accounts = [account(1, "Paid Off Loan", "Loans (Liability)", 0)];
  const loan: Loan = { id: "l1", name: "Paid Off Loan", accountId: 1, interestExpenseAccountId: 2, originalPrincipal: 5_000, annualRate: 0.05, termMonths: 36, startDate: "2023-01-01", standardPayment: 150, closed: { date: "2026-01-01" } };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [], loans: [loan] };
  const result = executeTool("get_loans", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("no open loans"));
});

// ---- get_prepaid_expenses ----------------------------------------------------------------------

test("get_prepaid_expenses: reports remaining unamortized balance below the original total", () => {
  const item: PrepaidExpense = { id: "p1", name: "Annual Insurance", accountId: 1, expenseAccountId: 2, startDate: "2026-01-01", totalAmount: 1_200, termMonths: 12 };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [], prepaidExpenses: [item] };
  const result = executeTool("get_prepaid_expenses", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("Annual Insurance"));
  assert.ok(result.includes("original total 1200.00"));
  assert.ok(result.includes("PRECOMPUTED TOTAL remaining"));
});

test("get_prepaid_expenses: excludes written-off items", () => {
  const item: PrepaidExpense = { id: "p1", name: "Cancelled Policy", accountId: 1, expenseAccountId: 2, startDate: "2025-01-01", totalAmount: 500, termMonths: 12, writtenOff: { date: "2025-06-01" } };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [], prepaidExpenses: [item] };
  const result = executeTool("get_prepaid_expenses", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("no (non-written-off) prepaid expenses"));
});

// ---- get_us_tax_estimate -----------------------------------------------------------------------

test("get_us_tax_estimate: wires a minimal payroll year through to a real, non-crashing estimate", () => {
  // This does not re-verify the underlying tax MATH (estimateUsFederalTax/computeItemizedDeduction
  // are already verified against a real filed return elsewhere in this test suite) -- it proves
  // the orchestration (lib/us-tax-estimate.ts's verbatim copy of TaxReport.tsx's own
  // computeYearTaxEstimate) wires together correctly end-to-end without crashing and produces the
  // expected output shape.
  const payrollYear: PayrollYear = {
    year: "2025",
    sheetName: "Yearly 2025",
    periodLabels: ["Jan 01 Jan 15"],
    rows: [
      { label: "Gross Salary", annual: 100_000, cumulative: 100_000, values: [100_000] },
      { label: "Federal", annual: 15_000, cumulative: 15_000, values: [15_000] },
      { label: "SSN", annual: 6_200, cumulative: 6_200, values: [6_200] },
      { label: "Medicare", annual: 1_450, cumulative: 1_450, values: [1_450] },
      { label: "State W/H", annual: 5_000, cumulative: 5_000, values: [5_000] },
    ],
  };
  const payroll: PayrollData = { years: [payrollYear], importedAt: "2026-01-01", sourceFileName: "test.xlsx" };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [], payroll };
  const result = executeTool("get_us_tax_estimate", { year: "2025" }, data, "us", "2026-10-15");
  assert.ok(result.includes("get_us_tax_estimate(2025"));
  assert.ok(result.includes("PRECOMPUTED TOTAL"));
  assert.ok(result.includes("ESTIMATE for planning purposes, not a filed return"));
});

test("get_us_tax_estimate: the PRECOMPUTED TOTAL is the NET amount owed/refunded, not the gross tax liability", () => {
  // Confirmed live: asked "what will I owe in taxes", the model answered with the GROSS federal +
  // state tax liability added together -- for the real case that exposed this, CA alone was
  // actually a $17,681.20 REFUND (withheld exceeded the CA tax), the opposite of "owed". The old
  // output's "Combined estimated federal + state tax" line was genuinely ambiguous for an "owe"
  // question; this locks in that the authoritative line now explicitly nets balance-due against
  // refund per side, and is clearly labeled as NOT the gross figure.
  const payrollYear: PayrollYear = {
    year: "2025", sheetName: "Yearly 2025", periodLabels: ["Jan 01 Jan 15"],
    rows: [
      { label: "Gross Salary", annual: 100_000, cumulative: 100_000, values: [100_000] },
      { label: "Federal", annual: 15_000, cumulative: 15_000, values: [15_000] },
      { label: "SSN", annual: 6_200, cumulative: 6_200, values: [6_200] },
      { label: "Medicare", annual: 1_450, cumulative: 1_450, values: [1_450] },
      { label: "State W/H", annual: 5_000, cumulative: 5_000, values: [5_000] },
    ],
  };
  const payroll: PayrollData = { years: [payrollYear], importedAt: "2026-01-01", sourceFileName: "test.xlsx" };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [], payroll };
  const result = executeTool("get_us_tax_estimate", { year: "2025" }, data, "us", "2026-10-15");
  assert.ok(result.includes('NOT the gross tax figures above, which ignore withholding'), "must explicitly warn the gross figures are not the answer to an \"owe\" question");
  assert.ok(/you (OWE \(balance due\)|get a REFUND of) [\d.]+ USD\.$/m.test(result), "the authoritative combined line must state a clear net owe/refund verdict");
});

test("get_us_tax_estimate: says plainly when there's no payroll data", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const result = executeTool("get_us_tax_estimate", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("no payroll data"));
});

test("get_us_tax_estimate: is India-book-gated the same way get_fbar_status is US-book-gated", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const result = executeTool("get_us_tax_estimate", {}, data, "india", "2026-10-15");
  assert.ok(result.includes("only available in US Books"));
  assert.ok(result.includes("NEVER substitute get_india_tax_estimate"), "must not let the model substitute the other country's tax figures");
});

// ---- get_india_tax_estimate --------------------------------------------------------------------

function indiaPayslipMonth(date: string, grossEarnings: number): IndiaPayslipMonth {
  return { label: date, date, basic: 0, hra: 0, conveyance: 0, otherAllowances: 0, grossEarnings, pf: 0, professionalTax: 0, incomeTax: 0, otherDeductions: 0, totalDeductions: 0, netPay: grossEarnings, sourceFile: "test.pdf" };
}

test("get_india_tax_estimate: uses the REAL filed figure when an ITR is on record for that year", () => {
  const itr: IndiaItrYear = {
    id: "y1", assessmentYear: "2026-27", grossTotalIncome: 1_000_000, deductionsChapterVIA: 150_000, totalIncome: 850_000,
    taxPayable: 72_500, advanceTax: 0, tds: 80_000, tcs: 0, selfAssessmentTax: 0, refundOrDemand: 7_500,
  };
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts: [], transactions: [], indiaTax: { itrYears: [itr] } };
  const result = executeTool("get_india_tax_estimate", { fy: "2025-26" }, data, "india", "2026-10-15");
  assert.ok(result.includes("FILED ITR on record"));
  assert.ok(result.includes("Gross tax payable 72500.00 INR (real filed figure)"));
  assert.ok(result.includes("you get a REFUND of 7500.00 INR"), "taxesPaidTotal (80000) - taxPayable (72500) = 7500 refund");
  assert.ok(result.includes('NOT the gross tax payable above, which ignores taxes already paid'), "must explicitly warn the gross figure is not the answer to an \"owe\"/\"refund\" question");
});

test("get_india_tax_estimate: falls back to its own slab-based estimate when no ITR is filed but the year is modeled", () => {
  const months = [indiaPayslipMonth("2025-06-01", 100_000), indiaPayslipMonth("2025-07-01", 100_000)];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts: [], transactions: [], indiaTax: { payslips: { months, importedAt: "2026-01-01" }, itrYears: [] } };
  const result = executeTool("get_india_tax_estimate", { fy: "2025-26" }, data, "india", "2026-10-15");
  assert.ok(result.includes("NO ITR filed yet for this year"));
  assert.ok(result.includes("(ESTIMATE -- ordinary slab rates only"));
  assert.ok(result.includes("ESTIMATE for planning purposes, not a filed return"));
});

test("get_india_tax_estimate: says plainly it can't determine tax for a year with no ITR and unmodeled slabs", () => {
  const months = [indiaPayslipMonth("1988-06-01", 50_000)];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts: [], transactions: [], indiaTax: { payslips: { months, importedAt: "2026-01-01" }, itrYears: [] } };
  const result = executeTool("get_india_tax_estimate", { fy: "1988-89" }, data, "india", "2026-10-15");
  assert.ok(result.includes("cannot determine"), "must not mislabel the fallback 0 as either a real figure or a valid estimate");
});

test("get_india_tax_estimate: says plainly when there's no India tax data at all", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const result = executeTool("get_india_tax_estimate", {}, data, "india", "2026-10-15");
  assert.ok(result.includes("no India tax data"));
});

test("get_india_tax_estimate: is US-book-gated the same way get_fbar_status is India-book-gated", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const result = executeTool("get_india_tax_estimate", {}, data, "us", "2026-10-15");
  assert.ok(result.includes("only available in India Books"));
  assert.ok(result.includes("NEVER substitute get_us_tax_estimate"), "must not let the model substitute the other country's tax figures");
});
