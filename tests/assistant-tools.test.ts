import assert from "node:assert/strict";
import test from "node:test";
import { resolvePeriod, executeTool, TOOL_DEFS, coerceToolArgs } from "../lib/assistant-tools.ts";
import type { Account, Tx, Ledger } from "../lib/vault-types.ts";

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
  assert.ok(usResult.includes("only available for the India book"));
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
