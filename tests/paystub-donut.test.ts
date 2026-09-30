import assert from "node:assert/strict";
import test from "node:test";
import { paystubDonutSegments } from "../lib/paystub-donut.ts";

test("paystubDonutSegments: falls back to the gross-minus-itemized remainder when no net is passed", () => {
  const segments = paystubDonutSegments({ gross: 1000, federal: 200, ssn: 50, medicare: 20, state: 80, k401: 100, medical: 30, espp: 20 });
  const netTakeHome = segments.find((s) => s.label === "Net Take-Home")!;
  assert.equal(netTakeHome.value, 1000 - 200 - 50 - 20 - 80 - 100 - 30 - 20);
  assert.ok(!segments.some((s) => s.label.startsWith("Other")));
});

test("paystubDonutSegments: real NVIDIA Sep 30 2026 paystub -- RSU Excess Tax credit surfaces as an Other slice instead of vanishing from Net Take-Home", () => {
  // Straight from the actual PDF: Net Pay $6,206.20, but the itemized categories below (Base +
  // Telephone - 401k - Medical(incl. Dental/Vision/Legal) - ESPP - Federal - SSN - Medicare -
  // State W/H - State SDI) only remainder to $5,602.36 -- the PDF's own "RSU Excess Tax" line of
  // -$603.84 (a refund of previously over-withheld RSU tax) has no bucket in this app at all.
  const segments = paystubDonutSegments({
    gross: 10166.67 + 30, // Base + Telephone
    federal: 1276.76,
    ssn: 0,
    medicare: 236.32,
    state: 549.4, // State W/H + State SDI
    k401: 813.33,
    medical: 193.5, // Dental + Medical + Vision + Legal Plan, as this app buckets them
    espp: 1525,
    net: 6206.2, // the PDF's own printed Net Pay, independently parsed
  });
  const netTakeHome = segments.find((s) => s.label === "Net Take-Home")!;
  assert.ok(Math.abs(netTakeHome.value - 6206.2) < 0.01, `expected the true Net Pay, got ${netTakeHome.value}`);
  const other = segments.find((s) => s.label.startsWith("Other"));
  assert.ok(other, "expected an Other slice surfacing the unitemized RSU Excess Tax credit");
  assert.ok(Math.abs(other!.value - 603.84) < 0.01, `expected the Other slice to be 603.84, got ${other!.value}`);
  assert.equal(other!.label, "Other (not itemized)");
});

test("paystubDonutSegments: an unlisted EXTRA deduction (net lower than the remainder) surfaces as 'Other deduction', not silently inflating Net Take-Home", () => {
  const segments = paystubDonutSegments({
    gross: 1000, federal: 200, ssn: 50, medicare: 20, state: 80, k401: 100, medical: 30, espp: 20,
    net: 400, // remainder would be 500 -- 100 less actually landed, an unitemized extra deduction
  });
  const netTakeHome = segments.find((s) => s.label === "Net Take-Home")!;
  assert.equal(netTakeHome.value, 400);
  const other = segments.find((s) => s.label.startsWith("Other"));
  assert.ok(other);
  assert.equal(other!.label, "Other deduction");
  assert.equal(other!.value, 100);
});
