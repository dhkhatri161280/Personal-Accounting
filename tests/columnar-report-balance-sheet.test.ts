import assert from "node:assert/strict";
import test from "node:test";
import { buildBalanceSheetColumns, periodBoundariesForRange } from "../lib/columnar-report.ts";
import type { Ledger } from "../lib/vault-types.ts";

function ledger(): Ledger {
  return {
    currency: "USD",
    accounts: [
      { id: 1, name: "Bank", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: -1000, active: true },
      { id: 2, name: "Furniture", parent: "Fixed Assets", category: "Asset", currency: "USD", openingBalance: 0, active: true },
      { id: 3, name: "Capital", parent: "Capital Account", category: "Capital", currency: "USD", openingBalance: 1000, active: true },
    ],
    transactions: [
      // Before the displayed range (Apr 2026): a $500 furniture purchase, paid from Bank.
      {
        id: 1,
        guid: "t1",
        date: "2026-03-15",
        number: "1",
        type: "Payment",
        narration: "Furniture purchase",
        entries: [
          { accountId: 2, accountName: "Furniture", amount: -500 },
          { accountId: 1, accountName: "Bank", amount: 500 },
        ],
      },
      // Within Apr 2026: another $200 furniture purchase.
      {
        id: 2,
        guid: "t2",
        date: "2026-04-10",
        number: "2",
        type: "Payment",
        narration: "More furniture",
        entries: [
          { accountId: 2, accountName: "Furniture", amount: -200 },
          { accountId: 1, accountName: "Bank", amount: 200 },
        ],
      },
    ],
    groups: [],
  } as unknown as Ledger;
}

test("buildBalanceSheetColumns: openingBeforeRange reflects the account's balance before the first displayed period", () => {
  const data = ledger();
  const periods = periodBoundariesForRange("2026-04-01", "2026-04-30", "monthly");
  const { assetRows } = buildBalanceSheetColumns(data, periods);
  const furniture = assetRows.find((r) => r.name === "Furniture")!;
  // The $500 pre-range purchase already sits in Furniture's opening balance going into April.
  assert.equal(furniture.openingBeforeRange, 500);
  // April's own closing includes both the pre-range 500 and the in-range 200.
  assert.equal(furniture.values[periods[0].key], 700);
});

test("buildBalanceSheetColumns: an incremental delta (closing - openingBeforeRange) isolates only the in-period movement", () => {
  const data = ledger();
  const periods = periodBoundariesForRange("2026-04-01", "2026-04-30", "monthly");
  const { assetRows } = buildBalanceSheetColumns(data, periods);
  const furniture = assetRows.find((r) => r.name === "Furniture")!;
  const delta = furniture.values[periods[0].key] - (furniture.openingBeforeRange || 0);
  assert.equal(delta, 200); // only April's own purchase, not the March one
});

function closedFyLedger(): Ledger {
  const salaryTxs = ["04", "05", "06", "07", "08", "09", "10", "11", "12"].map((m, i) => ({
    id: i + 1, guid: `s${i}`, date: `2025-${m}-10`, number: String(i + 1), type: "Receipt", narration: "Salary",
    entries: [
      { accountId: 1, accountName: "Bank", amount: -1000 },
      { accountId: 2, accountName: "Salary Income", amount: 1000 },
    ],
  })).concat(
    ["01", "02", "03"].map((m, i) => ({
      id: i + 10, guid: `s${i + 10}`, date: `2026-${m}-10`, number: String(i + 10), type: "Receipt", narration: "Salary",
      entries: [
        { accountId: 1, accountName: "Bank", amount: -1000 },
        { accountId: 2, accountName: "Salary Income", amount: 1000 },
      ],
    }))
  );
  const closingVoucher = {
    id: 100, guid: "close-fy2025", date: "2026-03-31", number: "1", type: "Journal", narration: "-",
    entries: [
      { accountId: 4, accountName: "Profit & Loss A/c", amount: -12000 },
      { accountId: 3, accountName: "Dignesh Khatri", amount: 12000 },
    ],
  };
  return {
    currency: "USD",
    accounts: [
      { id: 1, name: "Bank", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0, active: true },
      { id: 2, name: "Salary Income", parent: "Indirect Incomes", category: "Income", currency: "USD", openingBalance: 0, active: true },
      { id: 3, name: "Dignesh Khatri", parent: "Capital Account", category: "Capital", currency: "USD", openingBalance: 0, active: true },
      { id: 4, name: "Profit & Loss A/c", parent: "Capital Account", category: "Capital", currency: "USD", openingBalance: 0, active: true },
    ],
    transactions: [...salaryTxs, closingVoucher],
    groups: [],
  } as unknown as Ledger;
}

test("buildBalanceSheetColumns: does not double-count a fiscal year's surplus once its real closing voucher exists", () => {
  const data = closedFyLedger();
  const periods = periodBoundariesForRange("2025-04-01", "2026-03-31", "monthly");
  const { assetRows, liabilityRows } = buildBalanceSheetColumns(data, periods);
  const march = periods[periods.length - 1].key;
  const plRow = liabilityRows.find((r) => r.name === "Profit & Loss A/c")!;
  // The real closing voucher already transferred the full $12,000 surplus into Capital for real
  // in March -- the synthetic P&L A/c row must NOT also carry it, or Liabilities would be $12,000
  // too high that month (confirmed live: this exact bug, FY2025's real $132,389.75 voucher plus
  // this row's own accumulation).
  assert.equal(plRow.values[march], 0);
  const assetTotal = assetRows.reduce((s, r) => s + (r.values[march] || 0), 0);
  const liabilityTotal = liabilityRows.reduce((s, r) => s + (r.values[march] || 0), 0);
  assert.equal(assetTotal, liabilityTotal); // Balance Check must be exactly $0 in the closing month
});

test("buildBalanceSheetColumns: still accrues the synthetic surplus normally for months BEFORE the FY closes", () => {
  const data = closedFyLedger();
  const periods = periodBoundariesForRange("2025-04-01", "2026-03-31", "monthly");
  const { liabilityRows } = buildBalanceSheetColumns(data, periods);
  const june = periods[2].key; // June 2025 -- 3 months of salary posted, nowhere near closed
  const plRow = liabilityRows.find((r) => r.name === "Profit & Loss A/c")!;
  assert.equal(plRow.values[june], 3000); // Apr+May+Jun, live-accumulated, matches Capital not yet moved
});
