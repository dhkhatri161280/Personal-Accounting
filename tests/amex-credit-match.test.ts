import assert from "node:assert/strict";
import test from "node:test";
import { matchAmexBenefitCredits, type RawAmexTx } from "../lib/amex-credit-match.ts";

test("matchAmexBenefitCredits: matches a clean single credit", () => {
  const txs: RawAmexTx[] = [{ date: "2026-11-02", name: "Platinum Uber One Credit", amount: -76.8 }];
  const result = matchAmexBenefitCredits(txs);
  assert.deepEqual(result["uber-one-credit"], [{ date: "2026-11-02", amount: 76.8 }]);
});

test("matchAmexBenefitCredits: sums multiple months of a recurring credit (real Walmart+ case)", () => {
  const months = ["01-27", "02-27", "03-27", "04-27", "05-27", "06-27", "07-27", "08-27", "09-27", "10-28"];
  const txs: RawAmexTx[] = months.map((md) => ({ date: `2026-${md}`, name: "Platinum Walmart+ Credit", amount: -14.28 }));
  const result = matchAmexBenefitCredits(txs);
  assert.equal(result["walmart-platinum-tracker"].length, 10);
  const sum = result["walmart-platinum-tracker"].reduce((s, c) => s + c.amount, 0);
  assert.ok(Math.abs(sum - 142.8) < 0.001);
});

test("matchAmexBenefitCredits: nets out a same-amount reversal pair regardless of order (real Oura Ring case)", () => {
  // Real data: -200 (the actual credit), then an unrelated -125.48/+125.48 pair that must net to
  // zero and not affect the -200 entry at all.
  const txs: RawAmexTx[] = [
    { date: "2026-05-11", name: "Platinum Oura Ring Credit", amount: -125.48 },
    { date: "2026-05-09", name: "Platinum Oura Ring Credit", amount: 125.48 },
    { date: "2026-05-04", name: "Platinum Oura Ring Credit", amount: -200 },
  ];
  const result = matchAmexBenefitCredits(txs);
  assert.deepEqual(result["oura-ring-credit"], [{ date: "2026-05-04", amount: 200 }]);
});

test("matchAmexBenefitCredits: a credit fully reversed nets to zero -- no entry at all (real CLEAR+ case)", () => {
  const txs: RawAmexTx[] = [
    { date: "2026-03-11", name: "AMEX CLEAR PLUS CREDIT", amount: 209 },
    { date: "2026-03-10", name: "AMEX CLEAR PLUS CREDIT", amount: -209 },
  ];
  const result = matchAmexBenefitCredits(txs);
  assert.equal(result["clear-platinum-tracker"], undefined);
});

test("matchAmexBenefitCredits: ignores transactions that don't match a known benefit-credit name", () => {
  const txs: RawAmexTx[] = [
    { date: "2026-10-06", name: "WALMART.COM", amount: 22.66 },
    { date: "2026-11-02", name: "UBER ONE", amount: 76.8 },
    { date: "2026-08-12", name: "AMEX TRAVEL PAY WITH POINTS CREDIT", amount: -1439.19 },
  ];
  const result = matchAmexBenefitCredits(txs);
  assert.deepEqual(result, {});
});

test("matchAmexBenefitCredits: is a no-op re-run against a date window that overlaps already-recorded credits", () => {
  const existing = { "400-resy-credit": [{ date: "2026-09-30", amount: 37.18 }] };
  const txs: RawAmexTx[] = [{ date: "2026-09-30", name: "Platinum Resy Credit", amount: -37.18 }];
  const result = matchAmexBenefitCredits(txs, existing);
  assert.deepEqual(result, {});
});

test("matchAmexBenefitCredits: a re-run with one genuinely new credit only adds that one, keeping existing", () => {
  const existing = { "400-resy-credit": [{ date: "2026-09-30", amount: 37.18 }] };
  const txs: RawAmexTx[] = [
    { date: "2026-09-30", name: "Platinum Resy Credit", amount: -37.18 },
    { date: "2026-10-15", name: "Platinum Resy Credit", amount: -42.0 },
  ];
  const result = matchAmexBenefitCredits(txs, existing);
  assert.deepEqual(result["400-resy-credit"], [
    { date: "2026-09-30", amount: 37.18 },
    { date: "2026-10-15", amount: 42.0 },
  ]);
});

test("matchAmexBenefitCredits: match is case-insensitive and ignores surrounding whitespace", () => {
  const txs: RawAmexTx[] = [{ date: "2026-08-22", name: "  platinum lululemon credit  ", amount: -75 }];
  const result = matchAmexBenefitCredits(txs);
  assert.deepEqual(result["300-lululemon-credit"], [{ date: "2026-08-22", amount: 75 }]);
});
