import assert from "node:assert/strict";
import test from "node:test";
import { computePaperPositions, mergeAlpacaPaperTrades, parseAlpacaPaperTradesUpload } from "../lib/alpaca-paper.ts";
import type { AlpacaPaperTrade } from "../lib/vault-types.ts";

function trade(overrides: Partial<AlpacaPaperTrade> = {}): AlpacaPaperTrade {
  return {
    timestamp: "2026-11-02T16:42:13",
    ticker: "ORCL",
    action: "BUY",
    qty: 1,
    price: 119.22,
    orderId: "order-1",
    status: "OrderStatus.ACCEPTED",
    ...overrides,
  };
}

test("computePaperPositions: two BUYs blend into one running average-cost position", () => {
  const { open, closed } = computePaperPositions([
    trade({ orderId: "a", timestamp: "2026-11-02T16:42:00", qty: 1, price: 100 }),
    trade({ orderId: "b", timestamp: "2026-11-02T16:45:00", qty: 4, price: 120 }),
  ]);
  assert.equal(closed.length, 0);
  assert.equal(open.length, 1);
  // (1*100 + 4*120) / 5 = 116
  assert.equal(open[0].qty, 5);
  assert.equal(open[0].avgCost, 116);
  assert.equal(open[0].totalCost, 580);
});

test("computePaperPositions: a SELL realizes gain against the average cost at that moment", () => {
  const { open, closed } = computePaperPositions([
    trade({ orderId: "a", timestamp: "2026-11-01T00:00:00", qty: 10, price: 100 }),
    trade({ orderId: "b", timestamp: "2026-11-02T00:00:00", action: "SELL", qty: 4, price: 130 }),
  ]);
  assert.equal(open.length, 1);
  assert.equal(open[0].qty, 6);
  assert.equal(open[0].avgCost, 100);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].qty, 4);
  assert.equal(closed[0].realizedGL, 4 * (130 - 100));
  assert.ok(Math.abs(closed[0].realizedPct - 30) < 1e-9);
});

test("computePaperPositions: a fully-sold ticker has no open position left", () => {
  const { open, closed } = computePaperPositions([
    trade({ orderId: "a", timestamp: "2026-11-01T00:00:00", qty: 5, price: 50 }),
    trade({ orderId: "b", timestamp: "2026-11-02T00:00:00", action: "SELL", qty: 5, price: 40 }),
  ]);
  assert.equal(open.length, 0);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].realizedGL, 5 * (40 - 50));
});

test("computePaperPositions: a SELL larger than what's held caps at the held qty instead of going negative", () => {
  const { open, closed } = computePaperPositions([
    trade({ orderId: "a", timestamp: "2026-11-01T00:00:00", qty: 3, price: 50 }),
    trade({ orderId: "b", timestamp: "2026-11-02T00:00:00", action: "SELL", qty: 10, price: 60 }),
  ]);
  assert.equal(open.length, 0);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].qty, 3);
});

test("computePaperPositions: CANCELED/REJECTED orders are excluded from the position math", () => {
  const { open } = computePaperPositions([
    trade({ orderId: "a", qty: 5, price: 100, status: "OrderStatus.ACCEPTED" }),
    trade({ orderId: "b", qty: 50, price: 999, status: "OrderStatus.CANCELED" }),
    trade({ orderId: "c", qty: 50, price: 999, status: "OrderStatus.REJECTED" }),
  ]);
  assert.equal(open.length, 1);
  assert.equal(open[0].qty, 5);
  assert.equal(open[0].avgCost, 100);
});

test("computePaperPositions: processes trades chronologically regardless of input order", () => {
  const { open } = computePaperPositions([
    trade({ orderId: "later", timestamp: "2026-11-02T00:00:00", qty: 4, price: 120 }),
    trade({ orderId: "earlier", timestamp: "2026-11-01T00:00:00", qty: 1, price: 100 }),
  ]);
  assert.equal(open[0].qty, 5);
  assert.equal(open[0].avgCost, 116); // same blended result as the first test, input order reversed
});

test("computePaperPositions: separate tickers never mix cost basis", () => {
  const { open } = computePaperPositions([
    trade({ orderId: "a", ticker: "ORCL", qty: 2, price: 100 }),
    trade({ orderId: "b", ticker: "AAPL", qty: 3, price: 200 }),
  ]);
  const byTicker = Object.fromEntries(open.map((p) => [p.ticker, p]));
  assert.equal(byTicker.ORCL.avgCost, 100);
  assert.equal(byTicker.AAPL.avgCost, 200);
});

test("mergeAlpacaPaperTrades: dedupes by orderId, incoming wins on collision", () => {
  const merged = mergeAlpacaPaperTrades(
    [trade({ orderId: "a", status: "OrderStatus.ACCEPTED" })],
    [trade({ orderId: "a", status: "OrderStatus.FILLED" })]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "OrderStatus.FILLED");
});

test("parseAlpacaPaperTradesUpload: rejects a non-array payload", () => {
  assert.throws(() => parseAlpacaPaperTradesUpload({ not: "an array" }));
});

test("parseAlpacaPaperTradesUpload: requires orderId and ticker", () => {
  assert.throws(() => parseAlpacaPaperTradesUpload([{ ticker: "ORCL" }]));
  assert.throws(() => parseAlpacaPaperTradesUpload([{ orderId: "a" }]));
});
