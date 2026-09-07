import { test } from "node:test";
import assert from "node:assert/strict";
import { standardMonthlyPayment, computePaymentSplit } from "../lib/loans.ts";

test("standardMonthlyPayment: matches the real mortgage's own known payment as a sanity anchor", () => {
  // $900,000 / 2.875% / 360 months -- confirmed live against a real Closing Disclosure
  // (lib/mortgage-amortization.ts's MORTGAGE_STANDARD_PAYMENT = 3734.03).
  const payment = standardMonthlyPayment(900_000, 0.02875, 360);
  assert.ok(Math.abs(payment - 3734.03) < 0.5, `expected ~3734.03, got ${payment}`);
});

test("standardMonthlyPayment: a simple known case (0% APR car-style loan, $12,000/24mo)", () => {
  assert.equal(standardMonthlyPayment(12_000, 0, 24), 500);
});

test("standardMonthlyPayment: zero term returns 0, no divide-by-zero", () => {
  assert.equal(standardMonthlyPayment(10_000, 0.05, 0), 0);
});

test("standardMonthlyPayment: a standard car loan (5.5%, $20,000, 60mo) lands near a known reference value", () => {
  const payment = standardMonthlyPayment(20_000, 0.055, 60);
  // Reference: standard amortization tables put this at ~$381.99
  assert.ok(Math.abs(payment - 381.99) < 0.1, `expected ~381.99, got ${payment}`);
});

test("computePaymentSplit: interest is balance x monthly rate, principal is the remainder", () => {
  const { principal, interest } = computePaymentSplit(20_000, 0.06, 400);
  assert.equal(interest, 100); // 20000 * 0.06/12 = 100
  assert.equal(principal, 300); // 400 - 100
});

test("computePaymentSplit: zero-rate loan has no interest, full payment is principal", () => {
  const { principal, interest } = computePaymentSplit(10_000, 0, 500);
  assert.equal(interest, 0);
  assert.equal(principal, 500);
});

test("computePaymentSplit: rounds to cents", () => {
  const { principal, interest } = computePaymentSplit(10_000.33, 0.0725, 250.5);
  assert.equal(interest, Math.round(10_000.33 * (0.0725 / 12) * 100) / 100);
  assert.equal(principal, Math.round((250.5 - interest) * 100) / 100);
});
