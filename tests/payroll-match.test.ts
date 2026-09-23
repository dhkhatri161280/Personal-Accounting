import assert from "node:assert/strict";
import test from "node:test";
import { estimateManualPeriod } from "../lib/payroll-match.ts";
import type { PayrollYear, PayrollRow, Tx } from "../lib/vault-types.ts";

// Untested since creation. estimateManualPeriod picks an existing pay period as the tax-ratio
// donor for a brand-new voucher-derived period -- this locks in the cutoff added to stop it from
// scaling by a wildly mismatched period's ratio (e.g. a one-off bonus check) and producing a
// confidently-wrong-looking "estimated" number instead of an honest "not enough to go on".

function row(label: string, values: number[]): PayrollRow {
  return { label, annual: 0, cumulative: 0, values };
}

function payrollYear(rows: PayrollRow[]): PayrollYear {
  return { year: "2026", sheetName: "Yearly 2026", periodLabels: rows[0].values.map((_, i) => `P${i}`), rows };
}

function salaryVoucher(base: number, tax: number): Tx {
  return {
    id: 1, guid: "v1", date: "2026-06-15", number: "1", type: "Receipt", narration: "Salary Income - Semi Monthly", historical: false,
    entries: [
      { accountId: 1, accountName: "Salary Income - Employer", amount: base },
      { accountId: 2, accountName: "Tax Deduction", amount: -tax },
      { accountId: 3, accountName: "Bank Of America", amount: -(base - tax) },
    ],
  };
}

test("estimateManualPeriod scales by the closest-gross reference period's tax ratio when it's a reasonable match", () => {
  const yr = payrollYear([
    row("Base", [5000]),
    row("Telephone", [0]),
    row("Federal", [800]),
    row("SSN", [300]),
    row("Medicare", [70]),
    row("State W/H", [200]),
    row("State SDI", [30]),
    row("Total Tax", [1400]),
  ]);
  // New voucher's gross ($5100) is close to the reference period's ($5000) -- a legitimate match.
  const result = estimateManualPeriod(yr, salaryVoucher(5100, 1428));
  assert.equal(result.estimated, true);
  // Federal should scale proportionally: (800/1400) * 1428 ≈ 816
  assert.ok(Math.abs(result.federal - (800 / 1400) * 1428) < 0.01);
});

test("estimateManualPeriod: a wildly mismatched reference period (a one-off bonus check) is NOT used to scale a regular paycheck -- falls back to all-zero rather than a confidently-wrong ratio", () => {
  const yr = payrollYear([
    // The only period on file is a $200 one-off bonus with its own (very different) withholding mix.
    row("Base", [200]),
    row("Telephone", [0]),
    row("Federal", [80]),
    row("SSN", [15]),
    row("Medicare", [3]),
    row("State W/H", [20]),
    row("State SDI", [2]),
    row("Total Tax", [120]),
  ]);
  // New voucher is a normal $5000 paycheck -- gross diff (4800) far exceeds 50% of target (2500).
  const result = estimateManualPeriod(yr, salaryVoucher(5000, 1400));
  assert.equal(result.federal, 0);
  assert.equal(result.ssn, 0);
  assert.equal(result.medicare, 0);
  assert.equal(result.stateWH, 0);
  assert.equal(result.stateSDI, 0);
  // The voucher's own known figures (not derived from the bad reference) are still populated.
  assert.equal(result.totalTax, 1400);
});

test("estimateManualPeriod: no reference periods at all still returns a usable (all-zero-estimate) result, not a crash", () => {
  const yr = payrollYear([row("Base", [0]), row("Total Tax", [0])]);
  const result = estimateManualPeriod(yr, salaryVoucher(5000, 1400));
  assert.equal(result.federal, 0);
  assert.equal(result.estimated, true);
});
