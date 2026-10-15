import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantContext, extractSearchTerms, searchVouchersThisFiscalYear } from "../lib/assistant-context.ts";
import { fiscalYearOf } from "../lib/vault-accounting.ts";
import { todayLocalIso } from "../lib/format-date.ts";
import type { Account, Tx, Ledger } from "../lib/vault-types.ts";

function account(id: number, name: string, parent: string, openingBalance = 0): Account {
  return { id, name, parent, category: "Asset", currency: "INR", openingBalance, active: true };
}

function tx(id: number, date: string, accountId: number, amount: number, narration = "test", type?: string): Tx {
  return {
    id,
    guid: `v${id}`,
    date,
    number: String(id),
    type: type ?? (amount < 0 ? "Payment" : "Receipt"),
    narration,
    historical: false,
    entries: [
      { accountId, accountName: "", amount },
      { accountId: 999, accountName: "Other", amount: -amount },
    ],
  };
}

test("buildAssistantContext: includes non-zero balances and omits zero ones", () => {
  const accounts = [account(1, "SBI Savings", "Bank Accounts", -500_000), account(2, "Zero Balance Acct", "Bank Accounts", 0), account(999, "Other", "Indirect Incomes")];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions: [] };
  const context = buildAssistantContext(data, "india");
  assert.ok(context.includes("SBI Savings"));
  assert.ok(!context.includes("Zero Balance Acct"));
});

test("buildAssistantContext: sums this month's income/expense from current transactions", () => {
  const today = new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const accounts = [
    account(1, "Salary Income", "Direct Incomes"),
    account(2, "Groceries", "Indirect Expenses"),
    account(999, "Bank", "Bank Accounts"),
  ];
  const transactions = [
    tx(1, `${monthKey}-02`, 1, -100_000), // income
    tx(2, `${monthKey}-05`, 2, 5_000, "test", "Payment"), // expense (a genuine purchase is a Payment voucher)
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions };
  const context = buildAssistantContext(data, "us");
  assert.ok(context.includes(`This month (${monthKey})`));
  assert.ok(context.includes("income 100000.00"));
  assert.ok(context.includes("expense 5000.00"));
});

test("buildAssistantContext: includes FBAR status only for the India book", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const indiaContext = buildAssistantContext(data, "india");
  const usContext = buildAssistantContext(data, "us");
  assert.ok(indiaContext.includes("FBAR"));
  assert.ok(!usContext.includes("FBAR"));
});

test("buildAssistantContext: includes the WHOLE current month in chronological order, not just the most-recent few", () => {
  // Confirmed live: a real question ("Costco spending this month") got a wrong answer because an
  // earlier fix only sent the most-recent-15-overall vouchers, silently dropping an
  // earlier-in-month voucher once monthly volume exceeded that. This locks in the fix: every
  // voucher dated this month is present, oldest first (how a real ledger reads), and nothing
  // outside this month leaks in just because it's "recent" in absolute terms.
  const today = new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const accounts = [account(1, "Bank", "Bank Accounts"), account(999, "Other", "Indirect Incomes")];
  const transactions = [
    ...Array.from({ length: 20 }, (_, i) => tx(i + 1, `${monthKey}-01`, 1, -(i + 1), `Filler voucher ${i + 1}`)),
    tx(100, `${monthKey}-02`, 1, -999, "Early-in-month Costco voucher"),
    tx(101, "2020-01-01", 1, -1, "Long-ago voucher outside this month"),
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions };
  const context = buildAssistantContext(data, "us");
  assert.ok(context.includes("Early-in-month Costco voucher"), "an earlier-in-month voucher must not be dropped just because other vouchers are more recent");
  assert.ok(!context.includes("Long-ago voucher outside this month"));
  // Chronological (oldest first) within the month, not most-recent-first
  const firstFillerIdx = context.indexOf("Filler voucher 1 ");
  const earlyCostcoIdx = context.indexOf("Early-in-month Costco voucher");
  assert.ok(firstFillerIdx > -1 && earlyCostcoIdx > -1 && firstFillerIdx < earlyCostcoIdx);
});

test("buildAssistantContext: a refund against an expense account shows negative and labeled, not a plain positive amount", () => {
  // Confirmed live (user's own Day Book data): a Payment voucher is a genuine purchase, a Receipt
  // voucher against an expense account is a refund/return -- NOT the other way around. An earlier
  // attempt at this fix derived the sign from each entry's raw amount against its account's
  // nature and got it backwards (showed real purchases as negative "REFUND"s and the actual
  // refund as a plain positive amount). The voucher's own `type` field is the correct signal,
  // matching lib/costco-reward.ts's already-proven convention.
  const today = new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const accounts = [account(1, "Shopping", "Indirect Expenses"), account(999, "Citi Credit Card", "Bank Accounts")];
  const purchase: Tx = {
    id: 1, guid: "v1", date: `${monthKey}-05`, number: "587", type: "Payment", narration: "Shopping @ Costco", historical: false,
    entries: [{ accountId: 1, accountName: "", amount: -129.77 }, { accountId: 999, accountName: "", amount: 129.77 }],
  };
  const refund: Tx = {
    id: 2, guid: "v2", date: `${monthKey}-06`, number: "125", type: "Receipt", narration: "Shopping @ Costco", historical: false,
    entries: [{ accountId: 1, accountName: "", amount: 22.04 }, { accountId: 999, accountName: "", amount: -22.04 }],
  };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [purchase, refund] };
  const context = buildAssistantContext(data, "us");
  assert.ok(context.includes("(129.77 USD)"), "a normal Payment purchase stays a plain positive amount");
  assert.ok(context.includes("(-22.04 USD -- REFUND/return)"), "a Receipt refund must show negative and explicitly labeled");
});

test("buildAssistantContext: each voucher line names the real account(s) it posted to", () => {
  // Confirmed live: asked to "check the Vehicle Maintenance account", the assistant flatly
  // contradicted its own prior answer in the same reply -- it had no real data to check account
  // membership against, since the voucher line only ever showed narration text. Each line now
  // names the actual account(s) so an account-specific question has something real to match.
  const today = new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses"), account(999, "Citi Credit Card", "Bank Accounts")];
  const gas: Tx = {
    id: 1, guid: "v1", date: `${monthKey}-05`, number: "587", type: "Payment", narration: "Gasoline @ Costco", historical: false,
    entries: [{ accountId: 1, accountName: "", amount: -69 }, { accountId: 999, accountName: "", amount: 69 }],
  };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [gas] };
  const context = buildAssistantContext(data, "us");
  assert.ok(context.includes("[accounts: Vehicle Maintenance / Citi Credit Card]"), "the voucher line must name every account it actually posted to");
});

test("buildAssistantContext: a salary voucher is never labeled a refund, and shows a gross/tax/net breakdown instead of one summed amount", () => {
  // Confirmed live THREE times: (1) a semi-monthly paystub voucher (gross pay credited to an
  // Income account, plus tax/benefit deductions hitting Expense-nature accounts in the SAME
  // voucher) got mislabeled "REFUND/return" because the voucher touched an Expense account at all
  // -- fixed by letting an Income entry anywhere in the voucher rule out the refund
  // interpretation. (2) Even after that fix, "what's my take-home and tax deducted" still
  // couldn't be answered because the voucher was shown as one summed amount -- fixed by routing a
  // salary voucher through buildShadowPeriod (lib/payroll-match.ts), which parses gross/tax/
  // 401k/medical/telephone by account name. (3) The user then pointed out take-home must be
  // "whatever is deposited in Bank" -- buildShadowPeriod's `net` is DERIVED by subtracting only
  // the deduction buckets it recognizes, so it silently drifts from the real deposit the moment a
  // voucher has an unrecognized deduction line (here: "Other Deduction", $100, not base/
  // telephone/medical/401k/tax). Fixed by reading the voucher's own Bank-nature entry directly.
  const today = new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const accounts = [
    account(1, "Salary Income - Employer", "Direct Incomes"),
    account(2, "Tax Deduction", "Indirect Expenses"),
    account(3, "Other Deduction", "Indirect Expenses"),
    account(999, "Bank Of America", "Bank Accounts"),
  ];
  const paystub: Tx = {
    id: 1, guid: "v1", date: `${monthKey}-15`, number: "131", type: "Receipt", narration: "Salary Income - Semi Monthly", historical: false,
    entries: [
      { accountId: 1, accountName: "Salary Income - Employer", amount: 10_000 },
      { accountId: 2, accountName: "Tax Deduction", amount: -200 },
      { accountId: 3, accountName: "Other Deduction", amount: -100 },
      { accountId: 999, accountName: "Bank Of America", amount: -9_700 },
    ],
  };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [paystub] };
  const context = buildAssistantContext(data, "us");
  assert.ok(!context.includes("REFUND/return"), "a salary voucher must never be labeled a refund");
  assert.ok(context.includes("gross pay 10000.00"), "gross pay must be broken out");
  assert.ok(context.includes("tax deducted 200.00"), "tax deducted must be broken out, answering a 'how much tax' question directly");
  assert.ok(
    context.includes("net take-home (actual bank deposit) 9700.00"),
    "net take-home must be the REAL bank deposit (9700), not the derived gross-minus-known-buckets figure (9800, which silently ignores the unrecognized $100 'Other Deduction' line)"
  );
});

test("buildAssistantContext: includes a year-to-date salary summary across ALL this year's paystubs, not just this month's", () => {
  // Confirmed live: asked "how much YTD" right after a correct per-paystub answer, the assistant
  // had no year-to-date figure anywhere in its context and fabricated one from the "Current
  // account balances" section (cumulative since the account was opened, not year-to-date) instead
  // of saying it didn't have that data. This locks in the real fix: every salary voucher dated
  // this calendar year is summed into an explicit YTD line, regardless of which month it's in.
  const yearKey = new Date().toISOString().slice(0, 4);
  const accounts = [
    account(1, "Salary Income - Employer", "Direct Incomes"),
    account(2, "Tax Deduction", "Indirect Expenses"),
    account(999, "Bank Of America", "Bank Accounts"),
  ];
  function salaryVoucher(id: number, date: string, gross: number, tax: number): Tx {
    return {
      id, guid: `v${id}`, date, number: String(id), type: "Receipt", narration: "Salary Income - Semi Monthly", historical: false,
      entries: [
        { accountId: 1, accountName: "Salary Income - Employer", amount: gross },
        { accountId: 2, accountName: "Tax Deduction", amount: -tax },
        { accountId: 999, accountName: "Bank Of America", amount: -(gross - tax) },
      ],
    };
  }
  const transactions = [salaryVoucher(1, `${yearKey}-02-01`, 5_000, 1_000), salaryVoucher(2, `${yearKey}-08-01`, 6_000, 1_200)];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions };
  const context = buildAssistantContext(data, "us");
  assert.ok(context.includes(`Calendar-year-to-date (CY${yearKey}`), "must include an explicit calendar-year-to-date section");
  assert.ok(context.includes("across 2 paystub voucher(s)"), "must count both of this year's paystubs, not just the current month's");
  assert.ok(context.includes("gross pay 11000.00"), "YTD gross must sum both vouchers (5000 + 6000)");
  assert.ok(context.includes("tax deducted 2200.00"), "YTD tax must sum both vouchers (1000 + 1200)");
  assert.ok(context.includes("net take-home (actual bank deposits) 8800.00"), "YTD net take-home must sum both vouchers' actual bank deposits (4000 + 4800)");
});

test("buildAssistantContext: a fiscal-year-to-date salary summary is distinct from, and never confused with, the calendar-year one", () => {
  // Confirmed live: asked "what is the tax deducted from salary for this fiscal year", the
  // assistant had only the CALENDAR-year summary and said it was "also the fiscal year in this
  // case" -- wrong, since this app's own books run Apr-Mar (see fiscalYearOf), not Jan-Dec. A real
  // fiscal-year-scoped summary, with its own unambiguous label and date range, fixes that.
  const fy = fiscalYearOf(todayLocalIso());
  const accounts = [
    account(1, "Salary Income - Employer", "Direct Incomes"),
    account(2, "Tax Deduction", "Indirect Expenses"),
    account(999, "Bank Of America", "Bank Accounts"),
  ];
  function salaryVoucher(id: number, date: string, gross: number, tax: number): Tx {
    return {
      id, guid: `v${id}`, date, number: String(id), type: "Receipt", narration: "Salary Income - Semi Monthly", historical: false,
      entries: [
        { accountId: 1, accountName: "Salary Income - Employer", amount: gross },
        { accountId: 2, accountName: "Tax Deduction", amount: -tax },
        { accountId: 999, accountName: "Bank Of America", amount: -(gross - tax) },
      ],
    };
  }
  // Apr 15 of fiscal year `fy` always falls inside FY `fy` (Apr fy - Mar fy+1); Apr 15 one full
  // year earlier always falls BEFORE it -- both true regardless of which real date this test runs
  // on, so no date-mocking is needed.
  const inFy = salaryVoucher(1, `${fy}-04-15`, 5_000, 1_000);
  const beforeFy = salaryVoucher(2, `${fy - 1}-04-15`, 9_000, 1_800);
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [inFy, beforeFy] };
  const context = buildAssistantContext(data, "us");
  assert.ok(context.includes(`Fiscal-year-to-date (FY${fy}: ${fy}-04-01 to ${fy + 1}-03-31`), "must include an explicit fiscal-year-to-date section with its own FY number and date range");
  const fySection = context.slice(context.indexOf("Fiscal-year-to-date"));
  assert.ok(fySection.includes("across 1 paystub voucher(s)"), "must count only the voucher actually inside FY, not the one from a year before it");
  assert.ok(fySection.includes("gross pay 5000.00"), "fiscal-year total must be just the in-FY voucher (5000), not both (14000)");
  assert.ok(fySection.includes("tax deducted 1000.00"), "fiscal-year tax total must be just the in-FY voucher (1000), not both (2800)");
});

test("buildAssistantContext: voucher dates match the app's own DD-MM-YYYY display format, not raw ISO", () => {
  const today = new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const accounts = [account(1, "Bank", "Bank Accounts"), account(999, "Other", "Indirect Incomes")];
  const transactions = [tx(1, `${monthKey}-05`, 1, -100, "Test voucher")];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions };
  const context = buildAssistantContext(data, "us");
  assert.ok(context.includes(`- 05-${monthKey.slice(5)}-${monthKey.slice(0, 4)} Payment`), "should read DD-MM-YYYY, matching lib/format-date.ts's fmtDate used everywhere else in the app");
  assert.ok(!context.includes(`${monthKey}-05 Payment`), "must not leak the raw ISO date format");
});

test("buildAssistantContext: flags truncation explicitly instead of silently dropping vouchers past the safety cap", () => {
  const today = new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const accounts = [account(1, "Bank", "Bank Accounts"), account(999, "Other", "Indirect Incomes")];
  const transactions = Array.from({ length: 160 }, (_, i) => tx(i + 1, `${monthKey}-01`, 1, -1, `Voucher ${i + 1}`));
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions };
  const context = buildAssistantContext(data, "us");
  assert.ok(context.includes("160 total"));
  assert.ok(context.includes("NOT included below"));
});

test("extractSearchTerms: picks out question words that actually appear in the vault's own vocabulary, drops generic ones", () => {
  // Confirmed live: asked "this fiscal year" questions, the assistant could only say "I only have
  // this month's data" -- accurate, but useless. A real search term must be NOT a generic question
  // word AND genuinely part of THIS vault's vocabulary (an account name or a voucher narration).
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses")];
  const transactions = [
    { id: 1, guid: "v1", date: "2026-03-01", number: "1", type: "Payment", narration: "Gasoline @ Costco", historical: false, entries: [{ accountId: 1, accountName: "", amount: -69 }] } as Tx,
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions };
  const terms = extractSearchTerms("How much is my Costco Gasoline Spending till today for this fiscal year", data);
  assert.deepEqual(new Set(terms), new Set(["costco", "gasoline"]), "only real content words should survive, not generic question words");
});

test("extractSearchTerms: a stopword is dropped even when it coincidentally also appears as a real word in a narration", () => {
  // Confirmed live: a question's generic words ("for", "this", "year") survived the vocabulary
  // filter and massively over-matched (2219 vouchers for one query), because years of real
  // narrations very often also contain those exact common words (e.g. "... for groceries", "this
  // year's ..."). The stopword list must win regardless of what the vault's own vocabulary has.
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses")];
  const transactions = [
    { id: 1, guid: "v1", date: "2026-03-01", number: "1", type: "Payment", narration: "Paid for this year's Costco membership", historical: false, entries: [{ accountId: 1, accountName: "", amount: -69 }] } as Tx,
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions };
  const terms = extractSearchTerms("How much Costco spending for this fiscal year", data);
  assert.deepEqual(new Set(terms), new Set(["costco"]), "'for'/'this'/'fiscal'/'year' must never survive even though they're genuine words in this vault's own narration");
});

test("searchVouchersThisFiscalYear: finds a match EARLIER in the fiscal year (not just this month), excludes one from a past fiscal year, and totals it", () => {
  // Confirmed live TWICE: (1) with no search at all, the assistant could only see the current
  // calendar month. (2) with an unbounded full-history search, "this fiscal year" instead searched
  // the vault's ENTIRE history back to 2016 (2219 matches), not just the fiscal year asked about.
  // FY2026 runs Apr 2026 - Mar 2027 (see fiscalYearOf) -- "today" here is Oct 2026.
  const today = "2026-10-15";
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses"), account(999, "Citi Credit Card", "Bank Accounts")];
  const inFyGas: Tx = {
    id: 1, guid: "v1", date: "2026-04-15", number: "100", type: "Payment", narration: "Gasoline @ Costco", historical: false,
    entries: [{ accountId: 1, accountName: "", amount: -50 }, { accountId: 999, accountName: "", amount: 50 }],
  };
  const pastFyGas: Tx = {
    id: 2, guid: "v2", date: "2016-10-27", number: "24", type: "Payment", narration: "Gas from Costco", historical: false,
    entries: [{ accountId: 1, accountName: "", amount: -18 }, { accountId: 999, accountName: "", amount: 18 }],
  };
  const unrelated: Tx = {
    id: 3, guid: "v3", date: "2026-04-16", number: "101", type: "Payment", narration: "Groceries @ Safeway", historical: false,
    entries: [{ accountId: 1, accountName: "", amount: -20 }, { accountId: 999, accountName: "", amount: 20 }],
  };
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [inFyGas, pastFyGas, unrelated] };
  const result = searchVouchersThisFiscalYear(data, ["costco"], today);
  assert.ok(result.includes("Fiscal-year search"), "must be labeled as a fiscal-year search, not month-scoped or all-time");
  assert.ok(result.includes("FY2026"), "must state which fiscal year it searched");
  assert.ok(result.includes("Gasoline @ Costco"), "must find the match even though it's months before today, within the same FY");
  assert.ok(!result.includes("Gas from Costco"), "must NOT include a match from a past fiscal year");
  assert.ok(!result.includes("Safeway"), "must not include an unrelated voucher");
  assert.ok(result.includes("PRECOMPUTED TOTAL") && result.includes("50.00 USD"), "must compute a real, authoritative total scoped to just the current FY's match");
});

test("searchVouchersThisFiscalYear: the precomputed total covers EVERY real match, even ones not shown when the list is truncated", () => {
  // Confirmed live: given the correct voucher set, the free model still re-derived its OWN total
  // by reading a subset of the listed lines and silently dropped 3 of 6 real matches doing it
  // (understated $365.05 as $171.02). The fix is to never ask the model to do the arithmetic --
  // the total is computed here, once, over every real match, independent of how many are shown.
  const today = "2026-10-15";
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses"), account(999, "Citi Credit Card", "Bank Accounts")];
  const transactions: Tx[] = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1, guid: `v${i + 1}`, date: `2026-0${4 + i}-15`, number: String(i + 1), type: "Payment", narration: "Shopping @ Costco Gasoline", historical: false,
    entries: [{ accountId: 1, accountName: "", amount: -10 }, { accountId: 999, accountName: "", amount: 10 }],
  }));
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions };
  const result = searchVouchersThisFiscalYear(data, ["costco"], today);
  assert.ok(result.includes("PRECOMPUTED TOTAL") && result.includes("60.00 USD"), "total must cover all 6 vouchers (6 x 10.00), not just whichever ones a reader might stop at");
  assert.ok(result.includes("do NOT add up the voucher lines yourself") || result.includes("quote this exact number"), "must explicitly instruct against re-deriving the total");
});

test("searchVouchersThisFiscalYear: says plainly when nothing matches, instead of staying silent", () => {
  const accounts = [account(1, "Vehicle Maintenance", "Indirect Expenses")];
  const data: Ledger = { version: 1, company: "Test", currency: "USD", createdAt: "2026-01-01", accounts, transactions: [] };
  const result = searchVouchersThisFiscalYear(data, ["costco"], "2026-10-15");
  assert.ok(result.includes("0 matching vouchers found"));
});
