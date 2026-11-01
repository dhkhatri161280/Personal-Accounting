import assert from "node:assert/strict";
import test from "node:test";
import { mergeAmexBenefits, parseAmexBenefitsUpload, summarizeAmexBenefits } from "../lib/amex-benefits.ts";
import type { AmexBenefit } from "../lib/vault-types.ts";

function benefit(overrides: Partial<AmexBenefit> = {}): AmexBenefit {
  return {
    benefitId: "200-afc-tracker",
    benefitName: "$200 Airline Fee Credit",
    periodStartDate: "2026-01-01",
    periodEndDate: "2026-12-31",
    trackerDuration: "CalenderYear",
    status: "IN_PROGRESS",
    targetAmount: 200,
    spentAmount: 100,
    remainingAmount: 100,
    currency: "USD",
    lastCheckedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

test("parseAmexBenefitsUpload: accepts a well-formed array", () => {
  const parsed = parseAmexBenefitsUpload([benefit()]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].benefitId, "200-afc-tracker");
  assert.equal(parsed[0].spentAmount, 100);
});

test("parseAmexBenefitsUpload: rejects a non-array", () => {
  assert.throws(() => parseAmexBenefitsUpload({}));
});

test("parseAmexBenefitsUpload: rejects a benefit missing benefitId", () => {
  const bad = { ...benefit(), benefitId: undefined };
  assert.throws(() => parseAmexBenefitsUpload([bad]));
});

test("parseAmexBenefitsUpload: defaults missing optional fields rather than throwing", () => {
  const parsed = parseAmexBenefitsUpload([{ benefitId: "x", benefitName: "Y" }]);
  assert.equal(parsed[0].targetAmount, 0);
  assert.equal(parsed[0].currency, "USD");
});

test("mergeAmexBenefits: dedupes by benefitId, incoming (newer) wins", () => {
  const existing = [benefit({ spentAmount: 50, remainingAmount: 150 })];
  const incoming = [benefit({ spentAmount: 100, remainingAmount: 100 })];
  const merged = mergeAmexBenefits(existing, incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].spentAmount, 100);
});

test("mergeAmexBenefits: keeps distinct benefitIds as separate rows", () => {
  const existing = [benefit({ benefitId: "a", benefitName: "A" })];
  const incoming = [benefit({ benefitId: "b", benefitName: "B" })];
  const merged = mergeAmexBenefits(existing, incoming);
  assert.equal(merged.length, 2);
});

test("summarizeAmexBenefits: totals target/used/remaining and counts achieved vs. in-progress", () => {
  const benefits = [
    benefit({ benefitId: "a", targetAmount: 200, spentAmount: 200, remainingAmount: 0, status: "ACHIEVED" }),
    benefit({ benefitId: "b", targetAmount: 120, spentAmount: 0, remainingAmount: 120, status: "IN_PROGRESS" }),
  ];
  const summary = summarizeAmexBenefits(benefits);
  assert.equal(summary.totalTarget, 320);
  assert.equal(summary.totalUsed, 200);
  assert.equal(summary.totalRemaining, 120);
  assert.equal(summary.achievedCount, 1);
  assert.equal(summary.inProgressCount, 1);
});

test("summarizeAmexBenefits: empty list sums to zero, not NaN or a crash", () => {
  const summary = summarizeAmexBenefits([]);
  assert.deepEqual(summary, { totalTarget: 0, totalUsed: 0, totalRemaining: 0, achievedCount: 0, inProgressCount: 0 });
});
