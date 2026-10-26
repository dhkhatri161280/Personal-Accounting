import assert from "node:assert/strict";
import test from "node:test";
import {
  isQualifyingReceipt,
  isQualifyingReceiptItem,
  mergeCostcoReceipts,
  parseCostcoReceiptsUpload,
  computeCostcoRewardFromReceipts,
  costcoPriceMatchWatchlist,
  mergeCostcoPriceChecks,
  parseCostcoPriceChecksUpload,
} from "../lib/costco-receipts.ts";
import type { CostcoReceipt, CostcoPriceCheck } from "../lib/vault-types.ts";

function receipt(key: string, date: string, receiptType: string, items: { itemNumber: string; description: string; amount: number; qty: number }[]): CostcoReceipt {
  return { key, cardholder: "dignesh", date, warehouse: "FREMONT", receiptType, total: items.reduce((s, i) => s + i.amount, 0), items };
}

test("isQualifyingReceipt: excludes Gas Station, includes In-Warehouse and online", () => {
  assert.equal(isQualifyingReceipt({ receiptType: "Gas Station" } as CostcoReceipt), false);
  assert.equal(isQualifyingReceipt({ receiptType: "In-Warehouse" } as CostcoReceipt), true);
  assert.equal(isQualifyingReceipt({ receiptType: "Online" } as CostcoReceipt), true);
});

test("isQualifyingReceiptItem: excludes only Costco's own Shop Card, not a third-party gift card", () => {
  assert.equal(isQualifyingReceiptItem("COSTCO SHOP CARD $100"), false);
  assert.equal(isQualifyingReceiptItem("UBER GIFT CARD"), true);
  assert.equal(isQualifyingReceiptItem("ORG BLUES 510 G"), true);
});

test("mergeCostcoReceipts: dedupes by key, incoming wins on collision", () => {
  const existing = [receipt("k1", "2026-10-01", "In-Warehouse", [])];
  const incoming = [receipt("k1", "2026-10-01", "In-Warehouse", [{ itemNumber: "1", description: "NEW ITEM", amount: 5, qty: 1 }])];
  const merged = mergeCostcoReceipts(existing, incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].items.length, 1);
});

test("mergeCostcoReceipts: keeps distinct keys, sorted newest first", () => {
  const merged = mergeCostcoReceipts([receipt("a", "2026-09-01", "In-Warehouse", [])], [receipt("b", "2026-10-01", "In-Warehouse", [])]);
  assert.deepEqual(merged.map((r) => r.key), ["b", "a"]);
});

test("parseCostcoReceiptsUpload: accepts a well-formed array", () => {
  const parsed = parseCostcoReceiptsUpload([
    { key: "k1", cardholder: "dignesh", date: "2026-10-01", warehouse: "FREMONT", receiptType: "In-Warehouse", total: 10, items: [{ itemNumber: "1", description: "X", amount: 10, qty: 1 }] },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].items[0].amount, 10);
});

test("parseCostcoReceiptsUpload: rejects non-array input", () => {
  assert.throws(() => parseCostcoReceiptsUpload({ not: "an array" }));
});

test("parseCostcoReceiptsUpload: rejects a receipt missing a date", () => {
  assert.throws(() => parseCostcoReceiptsUpload([{ key: "k1", items: [] }]));
});

test("computeCostcoRewardFromReceipts: sums qualifying items, excludes Gas Station receipts and Shop Card items", () => {
  const receipts: CostcoReceipt[] = [
    receipt("k1", "2026-06-01", "In-Warehouse", [
      { itemNumber: "1", description: "ORG BLUES", amount: 300, qty: 1 },
      { itemNumber: "2", description: "COSTCO SHOP CARD", amount: 100, qty: 1 }, // excluded
    ]),
    receipt("k2", "2026-06-05", "Gas Station", [{ itemNumber: "3", description: "GAS", amount: 50, qty: 1 }]), // whole receipt excluded
    receipt("k3", "2026-06-10", "In-Warehouse", [{ itemNumber: "4", description: "UBER GIFT CARD", amount: 80, qty: 1 }]), // included -- not a Shop Card
  ];
  const result = computeCostcoRewardFromReceipts(receipts, "2026-05-31", "2027-05-31");
  assert.equal(result.qualifyingSpend, 380); // 300 + 80
  assert.ok(Math.abs(result.estimatedReward - 7.6) < 0.001); // 2% of 380
  assert.equal(result.receiptCount, 2);
  assert.equal(result.capped, false);
});

test("computeCostcoRewardFromReceipts: caps at $1,250", () => {
  const receipts: CostcoReceipt[] = [receipt("k1", "2026-06-01", "In-Warehouse", [{ itemNumber: "1", description: "X", amount: 100_000, qty: 1 }])];
  const result = computeCostcoRewardFromReceipts(receipts, "2026-05-31", "2027-05-31");
  assert.equal(result.estimatedReward, 1250);
  assert.equal(result.capped, true);
});

test("computeCostcoRewardFromReceipts: respects the window boundaries", () => {
  const receipts: CostcoReceipt[] = [
    receipt("k1", "2026-05-30", "In-Warehouse", [{ itemNumber: "1", description: "X", amount: 100, qty: 1 }]), // before window
    receipt("k2", "2026-05-31", "In-Warehouse", [{ itemNumber: "2", description: "X", amount: 200, qty: 1 }]), // first day, included
    receipt("k3", "2027-05-31", "In-Warehouse", [{ itemNumber: "3", description: "X", amount: 400, qty: 1 }]), // exclusive end, excluded
  ];
  const result = computeCostcoRewardFromReceipts(receipts, "2026-05-31", "2027-05-31");
  assert.equal(result.qualifyingSpend, 200);
});

test("costcoPriceMatchWatchlist: flags items still within the 30-day window, drops items past it", () => {
  const receipts: CostcoReceipt[] = [
    receipt("k1", "2026-10-01", "In-Warehouse", [{ itemNumber: "1", description: "RECENT ITEM", amount: 10, qty: 1 }]),
    receipt("k2", "2026-01-01", "In-Warehouse", [{ itemNumber: "2", description: "OLD ITEM", amount: 20, qty: 1 }]),
  ];
  const watchlist = costcoPriceMatchWatchlist(receipts, "2026-10-15");
  assert.equal(watchlist.length, 1);
  assert.equal(watchlist[0].description, "RECENT ITEM");
  assert.equal(watchlist[0].daysLeft, 16); // Oct 1 + 30 days = Oct 31, minus Oct 15 = 16
});

test("costcoPriceMatchWatchlist: excludes Gas Station receipts and Shop Card items", () => {
  const receipts: CostcoReceipt[] = [
    receipt("k1", "2026-10-01", "Gas Station", [{ itemNumber: "1", description: "GAS", amount: 50, qty: 1 }]),
    receipt("k2", "2026-10-01", "In-Warehouse", [{ itemNumber: "2", description: "COSTCO SHOP CARD", amount: 100, qty: 1 }]),
  ];
  assert.equal(costcoPriceMatchWatchlist(receipts, "2026-10-05").length, 0);
});

test("costcoPriceMatchWatchlist: a later return/credit for the same item number clears it off the watchlist entirely", () => {
  const receipts: CostcoReceipt[] = [
    receipt("k1", "2026-10-01", "In-Warehouse", [{ itemNumber: "2007436", description: "ADIDAS SNKR", amount: 37.99, qty: 1 }]),
    // The return shows up on a LATER, separate receipt -- still clears the original purchase.
    receipt("k2", "2026-10-05", "In-Warehouse", [{ itemNumber: "2007436", description: "/2007436", amount: -37.99, qty: -1 }]),
    receipt("k3", "2026-10-01", "In-Warehouse", [{ itemNumber: "999", description: "UNRELATED ITEM", amount: 10, qty: 1 }]),
  ];
  const watchlist = costcoPriceMatchWatchlist(receipts, "2026-10-10");
  assert.equal(watchlist.some((w) => w.itemNumber === "2007436"), false);
  assert.equal(watchlist.some((w) => w.itemNumber === "999"), true);
});

test("costcoPriceMatchWatchlist: a return line itself never appears as a watchlist entry", () => {
  const receipts: CostcoReceipt[] = [receipt("k1", "2026-10-01", "In-Warehouse", [{ itemNumber: "1", description: "X", amount: -5, qty: -1 }])];
  assert.equal(costcoPriceMatchWatchlist(receipts, "2026-10-05").length, 0);
});

function priceCheck(itemNumber: string, overrides: Partial<CostcoPriceCheck> = {}): CostcoPriceCheck {
  return { itemNumber, description: "X", pricePaid: 10, currentPrice: null, notSoldOnline: false, priceDropped: false, checkedAt: "2026-10-26T00:00:00Z", ...overrides };
}

test("parseCostcoPriceChecksUpload: accepts a well-formed array", () => {
  const parsed = parseCostcoPriceChecksUpload([{ itemNumber: "1", description: "X", pricePaid: 10, currentPrice: 8, notSoldOnline: false, priceDropped: true, checkedAt: "2026-10-26T00:00:00Z" }]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].priceDropped, true);
});

test("parseCostcoPriceChecksUpload: rejects non-array input", () => {
  assert.throws(() => parseCostcoPriceChecksUpload({ not: "an array" }));
});

test("parseCostcoPriceChecksUpload: rejects a check missing itemNumber", () => {
  assert.throws(() => parseCostcoPriceChecksUpload([{ description: "X" }]));
});

test("mergeCostcoPriceChecks: dedupes by itemNumber, incoming wins", () => {
  const existing = [priceCheck("1", { currentPrice: 10 })];
  const incoming = [priceCheck("1", { currentPrice: 8, priceDropped: true })];
  const merged = mergeCostcoPriceChecks(existing, incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].currentPrice, 8);
});

test("mergeCostcoPriceChecks: keeps distinct item numbers", () => {
  const merged = mergeCostcoPriceChecks([priceCheck("1")], [priceCheck("2")]);
  assert.equal(merged.length, 2);
});
