import assert from "node:assert/strict";
import test from "node:test";
import { mergeAmexBenefits, parseAmexBenefitsUpload, summarizeAmexBenefits, mergeAmexCoverageBenefits, parseAmexCoverageBenefitsUpload } from "../lib/amex-benefits.ts";
import type { AmexBenefit, AmexCoverageBenefit } from "../lib/vault-types.ts";

function coverageBenefit(overrides: Partial<AmexCoverageBenefit> = {}): AmexCoverageBenefit {
  return {
    benefitKey: "return-protection",
    title: "Return Protection",
    summary: "Up to $300 per item, up to $1,000 per calendar year.",
    lastCheckedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

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
    yearToDateAmount: 100,
    annualTargetAmount: 200,
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

test("summarizeAmexBenefits: totals use the real ANNUAL figures (yearToDateAmount/annualTargetAmount), not the current sub-period's own targetAmount/spentAmount", () => {
  const benefits = [
    benefit({ benefitId: "a", annualTargetAmount: 200, yearToDateAmount: 200, status: "ACHIEVED" }),
    // A quarterly benefit: current-cycle target/spent are intentionally much smaller than the real
    // annual figures -- confirmed live (Resy: $100/quarter target, spentAmount 0, but $296.12
    // already earned this year of a real $400 annual value). summarizeAmexBenefits must use the
    // annual fields, not these, or it reproduces the exact bug this was built to fix.
    benefit({ benefitId: "b", targetAmount: 100, spentAmount: 0, annualTargetAmount: 400, yearToDateAmount: 296.12, status: "IN_PROGRESS" }),
  ];
  const summary = summarizeAmexBenefits(benefits);
  assert.equal(summary.totalTarget, 600);
  assert.equal(summary.totalUsed, 496.12);
  assert.equal(summary.totalRemaining, 103.88);
  assert.equal(summary.achievedCount, 1);
  assert.equal(summary.inProgressCount, 1);
});

test("summarizeAmexBenefits: empty list sums to zero, not NaN or a crash", () => {
  const summary = summarizeAmexBenefits([]);
  assert.deepEqual(summary, { totalTarget: 0, totalUsed: 0, totalRemaining: 0, achievedCount: 0, inProgressCount: 0 });
});

test("parseAmexCoverageBenefitsUpload: accepts a well-formed array", () => {
  const parsed = parseAmexCoverageBenefitsUpload([coverageBenefit()]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].benefitKey, "return-protection");
  assert.ok(parsed[0].summary.includes("$1,000"));
});

test("parseAmexCoverageBenefitsUpload: rejects a non-array", () => {
  assert.throws(() => parseAmexCoverageBenefitsUpload({}));
});

test("parseAmexCoverageBenefitsUpload: rejects an entry missing benefitKey", () => {
  const bad = { ...coverageBenefit(), benefitKey: undefined };
  assert.throws(() => parseAmexCoverageBenefitsUpload([bad]));
});

test("parseAmexCoverageBenefitsUpload: defaults a missing summary to an empty string, not a throw", () => {
  const parsed = parseAmexCoverageBenefitsUpload([{ benefitKey: "x", title: "Y" }]);
  assert.equal(parsed[0].summary, "");
});

test("mergeAmexCoverageBenefits: dedupes by benefitKey, incoming (newer) wins", () => {
  const existing = [coverageBenefit({ summary: "Old terms" })];
  const incoming = [coverageBenefit({ summary: "New terms" })];
  const merged = mergeAmexCoverageBenefits(existing, incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].summary, "New terms");
});

test("mergeAmexCoverageBenefits: keeps distinct benefitKeys as separate rows", () => {
  const existing = [coverageBenefit({ benefitKey: "return-protection", title: "Return Protection" })];
  const incoming = [coverageBenefit({ benefitKey: "purchase-protection", title: "Purchase Protection" })];
  const merged = mergeAmexCoverageBenefits(existing, incoming);
  assert.equal(merged.length, 2);
});
