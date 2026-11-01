import assert from "node:assert/strict";
import test from "node:test";
import { mergeAmexBenefits, parseAmexBenefitsUpload, summarizeAmexBenefits, mergeAmexCoverageBenefits, parseAmexCoverageBenefitsUpload, selfReportedUberCashUsed, effectiveYearToDate } from "../lib/amex-benefits.ts";
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
  const summary = summarizeAmexBenefits(benefits, "2026");
  assert.equal(summary.totalTarget, 600);
  assert.equal(summary.totalUsed, 496.12);
  assert.equal(summary.totalRemaining, 103.88);
  assert.equal(summary.achievedCount, 1);
  assert.equal(summary.inProgressCount, 1);
});

test("summarizeAmexBenefits: empty list sums to zero, not NaN or a crash", () => {
  const summary = summarizeAmexBenefits([], "2026");
  assert.deepEqual(summary, { totalTarget: 0, totalUsed: 0, totalRemaining: 0, achievedCount: 0, inProgressCount: 0 });
});

test("effectiveYearToDate: Amex's own live tracker figure, when it's already the larger one", () => {
  const b = benefit({ yearToDateAmount: 100, statementCredits: [{ date: "2026-03-10", amount: 50 }] });
  assert.equal(effectiveYearToDate(b, "2026"), 100);
});

test("effectiveYearToDate: a hand-reconciled statement figure, when it's larger than Amex's own live tracker", () => {
  // Confirmed live: a tracker can report $0 used despite a real credit confirmed on Amex's own
  // downloadable statement (CLEAR+) -- never summed with yearToDateAmount, since Amex's own
  // tracker may later catch up to the same real figure on its own.
  const b = benefit({ yearToDateAmount: 0, statementCredits: [{ date: "2026-03-10", amount: 209 }] });
  assert.equal(effectiveYearToDate(b, "2026"), 209);
});

test("effectiveYearToDate: ignores a statement credit from a prior calendar year", () => {
  const b = benefit({ yearToDateAmount: 0, statementCredits: [{ date: "2025-03-10", amount: 209 }] });
  assert.equal(effectiveYearToDate(b, "2026"), 0);
});

test("summarizeAmexBenefits: achievedCount counts a statement-confirmed figure that alone clears the annual target", () => {
  const benefits = [benefit({ status: "IN_PROGRESS", annualTargetAmount: 219, yearToDateAmount: 0, statementCredits: [{ date: "2026-03-10", amount: 219 }] })];
  const summary = summarizeAmexBenefits(benefits, "2026");
  assert.equal(summary.totalUsed, 219);
  assert.equal(summary.achievedCount, 1);
  assert.equal(summary.inProgressCount, 0);
});

test("mergeAmexBenefits: preserves statementCredits from the existing record across a re-import", () => {
  const existing = [benefit({ statementCredits: [{ date: "2026-03-10", amount: 209 }] })];
  const incoming = [benefit({ spentAmount: 150 })];
  const merged = mergeAmexBenefits(existing, incoming);
  assert.equal(merged[0].spentAmount, 150);
  assert.deepEqual(merged[0].statementCredits, [{ date: "2026-03-10", amount: 209 }]);
});

test("parseAmexBenefitsUpload: parses statementCredits, dropping malformed entries", () => {
  const parsed = parseAmexBenefitsUpload([benefit({ statementCredits: [{ date: "2026-03-10", amount: 209 }, { date: "", amount: 0 }] })]);
  assert.deepEqual(parsed[0].statementCredits, [{ date: "2026-03-10", amount: 209 }]);
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

test("mergeAmexCoverageBenefits: preserves selfReportedFullyUsed from the existing record across a re-import", () => {
  // parse.mjs never sets this field at all -- a straight overwrite on every daily scheduled
  // import would otherwise silently wipe the user's own stated claim.
  const existing = [coverageBenefit({ benefitKey: "uber-rides-with-platinum", selfReportedFullyUsed: true })];
  const incoming = [coverageBenefit({ benefitKey: "uber-rides-with-platinum", summary: "Refreshed terms" })];
  const merged = mergeAmexCoverageBenefits(existing, incoming);
  assert.equal(merged[0].summary, "Refreshed terms");
  assert.equal(merged[0].selfReportedFullyUsed, true);
});

test("mergeAmexCoverageBenefits: an explicit incoming value still overrides (e.g. a manual re-upload toggling it off)", () => {
  const existing = [coverageBenefit({ benefitKey: "uber-rides-with-platinum", selfReportedFullyUsed: true })];
  const incoming = [coverageBenefit({ benefitKey: "uber-rides-with-platinum", selfReportedFullyUsed: false })];
  const merged = mergeAmexCoverageBenefits(existing, incoming);
  assert.equal(merged[0].selfReportedFullyUsed, false);
});

test("mergeAmexCoverageBenefits: preserves statementClaims from the existing record across a re-import", () => {
  // Same reasoning as selfReportedFullyUsed above -- parse.mjs's daily tracker/catalog re-import
  // has no way to know about hand-reconciled Amex statement claims, so a straight overwrite would
  // silently wipe them.
  const existing = [coverageBenefit({ statementClaims: [{ date: "2026-02-18", amount: 300 }] })];
  const incoming = [coverageBenefit({ summary: "Refreshed terms" })];
  const merged = mergeAmexCoverageBenefits(existing, incoming);
  assert.equal(merged[0].summary, "Refreshed terms");
  assert.deepEqual(merged[0].statementClaims, [{ date: "2026-02-18", amount: 300 }]);
});

test("parseAmexCoverageBenefitsUpload: parses statementClaims, dropping malformed entries", () => {
  const parsed = parseAmexCoverageBenefitsUpload([
    coverageBenefit({ statementClaims: [{ date: "2026-02-18", amount: 300 }, { date: "", amount: 0 }] }),
  ]);
  assert.deepEqual(parsed[0].statementClaims, [{ date: "2026-02-18", amount: 300, voucherGuid: undefined }]);
});

test("parseAmexCoverageBenefitsUpload: parses a statement claim's voucherGuid -- for a real claim whose own voucher narration doesn't match the regex search", () => {
  const parsed = parseAmexCoverageBenefitsUpload([
    coverageBenefit({ statementClaims: [{ date: "2026-02-18", amount: 300, voucherGuid: "example-voucher-guid-0001" }] }),
  ]);
  assert.equal(parsed[0].statementClaims?.[0].voucherGuid, "example-voucher-guid-0001");
});

test("selfReportedUberCashUsed: $15/month, with a $20 December bonus once December has arrived", () => {
  assert.equal(selfReportedUberCashUsed("2026-01-15"), 15);
  assert.equal(selfReportedUberCashUsed("2026-03-15"), 45);
  assert.equal(selfReportedUberCashUsed("2026-11-30"), 165);
  assert.equal(selfReportedUberCashUsed("2026-12-01"), 200);
});
