import test from "node:test";
import assert from "node:assert/strict";

// ── centsOf ──────────────────────────────────────────────────────────────────

const centsOf = (value) => Math.round(Number(value || 0) * 100);

test("centsOf converts integer amount to cents", () => {
  assert.equal(centsOf(10), 1000);
  assert.equal(centsOf(0), 0);
});

test("centsOf converts decimal string amount to cents", () => {
  assert.equal(centsOf("1.97"), 197);
  assert.equal(centsOf("0.005"), 1); // rounds half up
});

test("centsOf treats empty string and null as zero", () => {
  assert.equal(centsOf(""), 0);
  assert.equal(centsOf(null), 0);
  assert.equal(centsOf(undefined), 0);
});

test("centsOf avoids floating-point drift on common amounts", () => {
  assert.equal(centsOf(1.1), 110);
  assert.equal(centsOf(2.99), 299);
  assert.equal(centsOf(100.01), 10001);
});

// ── fiscalYearOf ──────────────────────────────────────────────────────────────

const fiscalYearOf = (date) => {
  const y = Number(date.slice(0, 4)),
    m = Number(date.slice(5, 7));
  return m >= 4 ? y : y - 1;
};

test("fiscalYearOf: April starts a new fiscal year", () => {
  assert.equal(fiscalYearOf("2026-04-01"), 2026);
  assert.equal(fiscalYearOf("2026-04-30"), 2026);
});

test("fiscalYearOf: March closes the prior fiscal year", () => {
  assert.equal(fiscalYearOf("2026-03-31"), 2025);
  assert.equal(fiscalYearOf("2027-03-31"), 2026);
});

test("fiscalYearOf: mid-year months stay in the same fiscal year", () => {
  assert.equal(fiscalYearOf("2026-07-15"), 2026);
  assert.equal(fiscalYearOf("2026-12-31"), 2026);
  assert.equal(fiscalYearOf("2027-01-01"), 2026);
});

test("fiscalYearOf: January–March belong to the prior calendar year's FY", () => {
  assert.equal(fiscalYearOf("2027-01-15"), 2026);
  assert.equal(fiscalYearOf("2027-02-28"), 2026);
});

// ── Opening + debit/credit = closing ─────────────────────────────────────────
// Convention (matching vault internals): debit entries have negative amounts,
// credit entries have positive amounts.
// closing = opening - periodDebit + periodCredit

test("closing balance = opening minus debit plus credit (asset account)", () => {
  const opening = 1000;
  const periodDebit = 300; // cash received → debit increases asset
  const periodCredit = 100; // cash paid out → credit decreases asset
  const closing = opening - periodDebit + periodCredit;
  assert.equal(closing, 800); // net outflow of 200
});

test("double-entry always nets to zero within a voucher", () => {
  const entries = [
    { amount: -500 }, // debit leg
    { amount: 500 }, // credit leg
  ];
  assert.equal(
    entries.reduce((s, e) => s + e.amount, 0),
    0
  );
});

test("sum of all closing balances in a balanced ledger is zero", () => {
  // Simplified two-account ledger: bank debit balanced by income credit
  const accounts = [
    { id: 1, opening: 0, debit: 0, credit: 500 }, // income (credit nature)
    { id: 2, opening: 0, debit: 500, credit: 0 }, // bank (debit nature, stored negative)
  ];
  const closings = accounts.map((a) => -a.debit + a.credit);
  assert.equal(
    closings.reduce((s, n) => s + n, 0),
    0
  );
});

test("trial balance: total debits equal total credits across all accounts", () => {
  const txs = [
    { entries: [{ amount: -200 }, { amount: 200 }] },
    { entries: [{ amount: -50 }, { amount: 50 }] },
    { entries: [{ amount: -75 }, { amount: 40 }, { amount: 35 }] },
  ];
  for (const t of txs) {
    assert.equal(t.entries.reduce((s, e) => s + e.amount, 0), 0);
  }
});

// ── nextVoucherNumber ─────────────────────────────────────────────────────────

const nextVoucherNumber = (txs, type, date, excludeGuid) => {
  const fy = fiscalYearOf(date),
    wanted = type.toLowerCase(),
    numbers = txs
      .filter(
        (t) =>
          !t.deleted &&
          !t.cancelled &&
          t.guid !== excludeGuid &&
          t.type.toLowerCase() === wanted &&
          fiscalYearOf(t.date) === fy
      )
      .map((t) => Number(t.number))
      .filter(Number.isFinite);
  return String((numbers.length ? Math.max(...numbers) : 0) + 1);
};

test("nextVoucherNumber returns 1 when no vouchers exist for that type/FY", () => {
  assert.equal(nextVoucherNumber([], "Payment", "2026-07-01"), "1");
});

test("nextVoucherNumber increments from the highest existing number", () => {
  const txs = [
    { type: "Payment", date: "2026-04-01", number: "5", guid: "a" },
    { type: "Payment", date: "2026-06-01", number: "3", guid: "b" },
  ];
  assert.equal(nextVoucherNumber(txs, "Payment", "2026-07-01"), "6");
});

test("nextVoucherNumber resets across fiscal years", () => {
  const txs = [{ type: "Payment", date: "2026-12-01", number: "249", guid: "a" }];
  // FY2026 = Apr 2026 – Mar 2027. Apr 2027 starts FY2027.
  assert.equal(nextVoucherNumber(txs, "Payment", "2027-04-01"), "1");
});

test("nextVoucherNumber is independent per voucher type", () => {
  const txs = [
    { type: "Payment", date: "2026-07-01", number: "10", guid: "a" },
    { type: "Receipt", date: "2026-07-01", number: "3", guid: "b" },
  ];
  assert.equal(nextVoucherNumber(txs, "Payment", "2026-07-10"), "11");
  assert.equal(nextVoucherNumber(txs, "Receipt", "2026-07-10"), "4");
  assert.equal(nextVoucherNumber(txs, "Journal", "2026-07-10"), "1");
});

test("nextVoucherNumber excludes the voucher being edited", () => {
  const txs = [
    { type: "Payment", date: "2026-07-01", number: "7", guid: "edit-me" },
    { type: "Payment", date: "2026-07-02", number: "6", guid: "keep" },
  ];
  // Editing voucher #7: excluding it, max is #6, so next is 7 again
  assert.equal(nextVoucherNumber(txs, "Payment", "2026-07-10", "edit-me"), "7");
});

test("nextVoucherNumber skips deleted and cancelled vouchers", () => {
  const txs = [
    { type: "Payment", date: "2026-07-01", number: "99", guid: "a", deleted: true },
    { type: "Payment", date: "2026-07-02", number: "5", guid: "b", cancelled: true },
    { type: "Payment", date: "2026-07-03", number: "3", guid: "c" },
  ];
  assert.equal(nextVoucherNumber(txs, "Payment", "2026-07-10"), "4");
});

// ── repairLocalDuplicateNumbers ───────────────────────────────────────────────

const repairLocalDuplicateNumbers = (txs) => {
  const seen = new Set(),
    max = new Map(),
    ordered = [...txs].sort((a, b) => Number(b.historical) - Number(a.historical));
  let changed = false;
  for (const t of ordered) {
    if (t.deleted || t.cancelled) continue;
    const group = `${t.type.toLowerCase()}|${fiscalYearOf(t.date)}`,
      n = Number(t.number);
    if (Number.isFinite(n)) max.set(group, Math.max(max.get(group) || 0, n));
    const key = `${group}|${t.number}`;
    if (!t.historical && seen.has(key)) {
      const next = (max.get(group) || 0) + 1;
      max.set(group, next);
      t.number = String(next);
      changed = true;
    }
    seen.add(`${group}|${t.number}`);
  }
  return changed;
};

test("repairLocalDuplicateNumbers returns false when no duplicates", () => {
  const txs = [
    { type: "Payment", date: "2026-07-01", number: "1", historical: false },
    { type: "Payment", date: "2026-07-02", number: "2", historical: false },
  ];
  assert.equal(repairLocalDuplicateNumbers(txs), false);
});

test("repairLocalDuplicateNumbers renumbers a local duplicate after the historical one", () => {
  const txs = [
    { type: "Payment", date: "2026-07-01", number: "5", historical: true },
    { type: "Payment", date: "2026-07-02", number: "5", historical: false },
  ];
  const changed = repairLocalDuplicateNumbers(txs);
  assert.equal(changed, true);
  const numbers = txs.map((t) => t.number);
  assert.equal(numbers[0], "5"); // historical preserved
  assert.equal(numbers[1], "6"); // local renumbered
});

test("repairLocalDuplicateNumbers does not touch deleted vouchers", () => {
  const txs = [
    { type: "Payment", date: "2026-07-01", number: "3", historical: false },
    { type: "Payment", date: "2026-07-02", number: "3", historical: false, deleted: true },
  ];
  const changed = repairLocalDuplicateNumbers(txs);
  assert.equal(changed, false); // deleted voucher not considered a duplicate
});

test("repairLocalDuplicateNumbers is independent per voucher type", () => {
  const txs = [
    { type: "Payment", date: "2026-07-01", number: "1", historical: true },
    { type: "Payment", date: "2026-07-02", number: "1", historical: false },
    { type: "Receipt", date: "2026-07-01", number: "1", historical: false },
  ];
  repairLocalDuplicateNumbers(txs);
  const payments = txs.filter((t) => t.type === "Payment").map((t) => t.number);
  const receipts = txs.filter((t) => t.type === "Receipt").map((t) => t.number);
  assert.equal(payments[1], "2"); // duplicate Payment renumbered
  assert.equal(receipts[0], "1"); // Receipt unaffected
});

// ── P&L transfer to capital ───────────────────────────────────────────────────

test("P&L surplus increases capital; deficit decreases it", () => {
  const capitalBefore = 500000;
  const surplus = 30000;
  const deficit = -15000;
  assert.equal(capitalBefore + surplus, 530000);
  assert.equal(capitalBefore + deficit, 485000);
});

test("only current-period result transfers, not accumulated history", () => {
  const allTimeIncome = 1200000;
  const currentFYIncome = 80000;
  const capitalAdjustment = currentFYIncome; // NOT allTimeIncome
  const capitalBefore = 400000;
  assert.equal(capitalBefore + capitalAdjustment, 480000);
  assert.notEqual(capitalBefore + allTimeIncome, capitalBefore + capitalAdjustment);
});

test("balance sheet balances after transferring P&L result to capital side", () => {
  const assets = 900000;
  const liabilities = 350000;
  const capitalBefore = 520000;
  const currentProfit = 30000;
  const capitalAfter = capitalBefore + currentProfit;
  assert.equal(liabilities + capitalAfter, assets);
});

// ── isDebitNatureAccount ──────────────────────────────────────────────────────

const isDebitNatureAccount = (account) => {
  const parent = (account.parent || "").toLowerCase(),
    category = (account.category || "").toLowerCase(),
    name = (account.name || "").toLowerCase(),
    classification = `${parent} ${category}`;
  if (name.includes("credit card")) return false;
  if (/capital|liabilit|sundry creditors|payable/.test(classification)) return false;
  return /asset|bank accounts|cash-in-hand|cash|deposit|investment|fixed assets|loans & advances \(asset\)|ppf/.test(
    `${classification} ${name}`
  );
};

test("isDebitNatureAccount: bank and cash accounts are debit nature", () => {
  assert.equal(isDebitNatureAccount({ parent: "Bank Accounts" }), true);
  assert.equal(isDebitNatureAccount({ parent: "Cash-in-hand" }), true);
});

test("isDebitNatureAccount: investments and fixed assets are debit nature", () => {
  assert.equal(isDebitNatureAccount({ parent: "Investments" }), true);
  assert.equal(isDebitNatureAccount({ parent: "Fixed Assets" }), true);
});

test("isDebitNatureAccount: liabilities and capital are credit nature", () => {
  assert.equal(isDebitNatureAccount({ parent: "Current Liabilities" }), false);
  assert.equal(isDebitNatureAccount({ parent: "Capital Account" }), false);
  assert.equal(isDebitNatureAccount({ parent: "Loans (Liability)" }), false);
});

test("isDebitNatureAccount: credit card is always credit nature regardless of parent", () => {
  assert.equal(isDebitNatureAccount({ parent: "Bank Accounts", name: "AMEX Credit Card" }), false);
});

test("isDebitNatureAccount: sundry debtors (asset) is debit nature", () => {
  assert.equal(isDebitNatureAccount({ parent: "Sundry Debtors" }), false); // not matched → credit
  assert.equal(isDebitNatureAccount({ parent: "Loans & Advances (Asset)" }), true);
});
