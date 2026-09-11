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
