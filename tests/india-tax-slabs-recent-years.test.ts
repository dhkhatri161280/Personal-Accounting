import assert from "node:assert/strict";
import test from "node:test";
import { estimateIndiaTax, hasIndiaTaxSlabsFor, cessRateFor } from "../lib/india-tax-slabs.ts";

test("AY2018-19 through AY2023-24 (old regime) are now covered, not just through AY2017-18", () => {
  for (const ay of ["2018-19", "2019-20", "2020-21", "2021-22", "2022-23", "2023-24"]) {
    assert.ok(hasIndiaTaxSlabsFor(ay), `expected ${ay} to be covered`);
  }
});

test("AY2024-25 through AY2026-27 (new regime) are covered; AY2027-28 is deliberately NOT (unknown Budget 2026)", () => {
  for (const ay of ["2024-25", "2025-26", "2026-27"]) {
    assert.ok(hasIndiaTaxSlabsFor(ay), `expected ${ay} to be covered`);
  }
  assert.equal(hasIndiaTaxSlabsFor("2027-28"), false);
});

test("old regime AY2020-21 onward: taxable income at the 5L rebate ceiling owes zero tax", () => {
  for (const ay of ["2020-21", "2021-22", "2022-23", "2023-24"]) {
    assert.equal(estimateIndiaTax(ay, 500000), 0, `${ay} should be fully rebated at 5L`);
  }
});

test("old regime AY2020-21 onward: just above the 5L rebate ceiling, tax applies (no rebate, 5% bracket plus cess)", () => {
  // 2.5L exempt, next 2.5L at 5% = 12,500 tax on 5L; one rupee over removes the 87A rebate
  // entirely (it's a cliff, not a phase-out) so tax on 500001 is ~12,500 + cess.
  const tax = estimateIndiaTax("2023-24", 500001);
  assert.ok(tax! > 12000 && tax! < 14000, `expected ~12,500 + 4% cess, got ${tax}`);
});

test("new regime AY2024-25: fully rebated up to 7L, taxed above it", () => {
  assert.equal(estimateIndiaTax("2024-25", 700000), 0);
  assert.ok(estimateIndiaTax("2024-25", 700001)! > 0);
});

test("new regime AY2026-27: fully rebated up to 12L -- the 'no tax up to 12L' headline figure", () => {
  assert.equal(estimateIndiaTax("2026-27", 1200000), 0);
  assert.ok(estimateIndiaTax("2026-27", 1200001)! > 0);
});

test("cess is 4% for every AY2019-20+ entry (3% only for the last pre-2019 year, AY2018-19)", () => {
  assert.equal(cessRateFor("2018-19"), 0.03);
  for (const ay of ["2019-20", "2020-21", "2021-22", "2022-23", "2023-24", "2024-25", "2025-26", "2026-27"]) {
    assert.equal(cessRateFor(ay), 0.04, `${ay} should be 4% cess`);
  }
});

test("estimateIndiaTax returns null for the deliberately-unmodeled current AY2027-28", () => {
  assert.equal(estimateIndiaTax("2027-28", 1000000), null);
});
