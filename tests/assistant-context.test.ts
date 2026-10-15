import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantContext } from "../lib/assistant-context.ts";
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
