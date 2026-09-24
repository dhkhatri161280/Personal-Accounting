import assert from "node:assert/strict";
import test from "node:test";
import { classifyTradingSales, summarizeCapitalGains } from "../lib/tax-classify.ts";
import type { Trade } from "../lib/vault-types.ts";

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "t1",
    company: "MicroStrategy",
    symbol: "MSTR",
    broker: "CST",
    buyDate: "2025-01-27",
    saleDate: "2025-07-15",
    units: 50,
    costPerSh: 365.44,
    marketOrSalePrice: 388.00,
    yesterday: 388.00,
    ...overrides,
  };
}

test("classifyTradingSales ignores open positions (no saleDate)", () => {
  const events = classifyTradingSales([trade({ saleDate: undefined })], "2025", 365);
  assert.equal(events.length, 0);
});

test("classifyTradingSales ignores sales outside the requested year", () => {
  const events = classifyTradingSales([trade({ saleDate: "2024-07-15" })], "2025", 365);
  assert.equal(events.length, 0);
});

test("classifyTradingSales computes gain/loss and short vs long term correctly", () => {
  const [shortTerm] = classifyTradingSales([trade()], "2025", 365);
  assert.ok(shortTerm);
  assert.equal(shortTerm.term, "short"); // 2025-01-27 -> 2025-07-15 is ~169 days
  assert.ok(Math.abs(shortTerm.gain - 50 * (388.00 - 365.44)) < 0.01);

  const [longTerm] = classifyTradingSales(
    [trade({ buyDate: "2020-10-28", saleDate: "2025-01-13", costPerSh: 113.18, marketOrSalePrice: 223.96, units: 9.10 })],
    "2025",
    365
  );
  assert.equal(longTerm!.term, "long");
});

test("classifyTradingSales excludes the employer's own ticker to avoid double-counting with Equity RSU/ESPP sales", () => {
  const events = classifyTradingSales([trade({ symbol: "NVDA" })], "2025", 365, new Set(["NVDA"]));
  assert.equal(events.length, 0);
});

test("Trading gains combine with RSU/ESPP gains through the same Schedule D-style netting", () => {
  const tradingEvents = classifyTradingSales(
    [
      trade({ id: "t1", symbol: "PLTR", units: 50, costPerSh: 96.00, marketOrSalePrice: 182.30, buyDate: "2025-02-20", saleDate: "2025-12-09" }),
      trade({ id: "t2", symbol: "TSLA", units: 50, costPerSh: 391.00, marketOrSalePrice: 301.21, buyDate: "2024-12-10", saleDate: "2025-08-01" }),
    ],
    "2025",
    365
  );
  const summary = summarizeCapitalGains(tradingEvents);
  // PLTR gain 50*(182.30-96.00)=4315, TSLA loss 50*(301.21-391)=-4489.5 -> net -174.5
  assert.ok(Math.abs(summary.netShortTerm + summary.netLongTerm - (4315 - 4489.5)) < 0.01);
});
