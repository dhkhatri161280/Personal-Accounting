import { test } from "node:test";
import assert from "node:assert/strict";
import { postDepreciationSpread, postDepreciationConsolidated } from "../lib/fixed-assets-ledger.ts";
import { round2 } from "../lib/fixed-assets.ts";
import type { FixedAsset, Ledger } from "../lib/vault-types.ts";

function asset(overrides: Partial<FixedAsset> = {}): FixedAsset {
  return {
    id: "a1",
    name: "Car",
    accountId: 1,
    purchaseDate: "2020-01-01",
    cost: 60000,
    salvageValue: 0,
    usefulLifeMonths: 96,
    ...overrides,
  };
}

function ledger(overrides: Partial<Ledger> = {}): Ledger {
  return {
    currency: "USD",
    accounts: [{ id: 1, name: "Car", parent: "Fixed Assets", category: "Asset", currency: "USD", openingBalance: 0 }],
    transactions: [],
    fixedAssets: [asset()],
    ...overrides,
  } as Ledger;
}

test("postDepreciationSpread: splits one asset's full catch-up total evenly across N monthly vouchers", () => {
  // Nearly 5 years of untouched depreciation, well beyond a single lump sum a real ERP close
  // would want to post in one period -- this is the scenario the feature exists for.
  const data = ledger();
  const { data: next, postedCount } = postDepreciationSpread(data, "2025-01-01", 6, "2026-09");
  assert.equal(postedCount, 6);
  const deprecVouchers = next.transactions.filter((t) => t.narration.includes("Depreciation catch-up"));
  assert.equal(deprecVouchers.length, 6);

  // Dated at 6 consecutive month-ends starting Sep 2026.
  const dates = deprecVouchers.map((t) => t.date).sort();
  assert.deepEqual(dates, ["2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);

  // Amounts sum to the exact same total a single consolidated run would have posted in one shot --
  // spreading changes HOW MANY vouchers/periods absorb it, not the total amount owed.
  const { data: consolidatedResult } = postDepreciationConsolidated(data, "2025-01-01", "2026-09-30");
  const consolidatedTotal = consolidatedResult.transactions
    .filter((t) => t.narration.includes("Depreciation catch-up"))
    .reduce((s, t) => s + t.entries.filter((e) => e.amount > 0).reduce((es, e) => es + e.amount, 0), 0);
  const spreadTotal = round2(deprecVouchers.reduce((s, t) => s + t.entries.filter((e) => e.amount > 0).reduce((es, e) => es + e.amount, 0), 0));
  assert.equal(spreadTotal, consolidatedTotal);

  // No single installment should be dramatically larger than the others (the whole point) --
  // each is within a cent of total/6, including the last one absorbing rounding residue.
  const perInstallment = round2(consolidatedTotal / 6);
  for (const t of deprecVouchers) {
    const amt = t.entries.filter((e) => e.amount > 0).reduce((es, e) => es + e.amount, 0);
    assert.ok(Math.abs(amt - perInstallment) < 0.05, `installment ${amt} too far from even split ${perInstallment}`);
  }
});

test("postDepreciationSpread: lastDepreciatedThrough advances to the full backlog's last month in one shot, same as consolidated", () => {
  const data = ledger();
  const { data: next } = postDepreciationSpread(data, "2025-01-01", 12, "2026-09");
  const updated = next.fixedAssets!.find((a) => a.id === "a1")!;
  assert.equal(updated.lastDepreciatedThrough, "2024-12");
});

test("postDepreciationSpread: an asset already up to date posts nothing", () => {
  const data = ledger({ fixedAssets: [asset({ lastDepreciatedThrough: "2026-08" })] });
  const { postedCount } = postDepreciationSpread(data, "2026-09-01", 6, "2026-09");
  assert.equal(postedCount, 0);
});
