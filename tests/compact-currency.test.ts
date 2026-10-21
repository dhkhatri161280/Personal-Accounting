import assert from "node:assert/strict";
import test from "node:test";
import { compactCurrency } from "../lib/compact-currency.ts";

test("compactCurrency: INR uses Crore above 1,00,00,000", () => {
  assert.equal(compactCurrency(45828481.42, "INR"), "₹4.58C");
  assert.equal(compactCurrency(122555355.81, "INR"), "₹12.26C");
});

test("compactCurrency: INR uses Lakh between 1,00,000 and 1,00,00,000", () => {
  assert.equal(compactCurrency(1319876.96, "INR"), "₹13.20L");
  assert.equal(compactCurrency(196707, "INR"), "₹1.97L");
});

test("compactCurrency: INR uses K between 1,000 and 1,00,000", () => {
  assert.equal(compactCurrency(6754.31, "INR"), "₹6.75K");
});

test("compactCurrency: INR below 1,000 shows a rounded whole number", () => {
  assert.equal(compactCurrency(804, "INR"), "₹804");
});

test("compactCurrency: negative amounts keep the minus sign before the symbol", () => {
  assert.equal(compactCurrency(-250000, "INR"), "-₹2.50L");
});

test("compactCurrency: USD uses the Western K/M/B system, not Lakh/Crore", () => {
  assert.equal(compactCurrency(4500000, "USD"), "$4.50M");
  assert.equal(compactCurrency(2500, "USD"), "$2.50K");
  assert.equal(compactCurrency(1200000000, "USD"), "$1.20B");
});
