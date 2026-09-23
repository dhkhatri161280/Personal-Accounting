import assert from "node:assert/strict";
import test from "node:test";
import { getApplicableRate, prevMonthKey } from "../lib/gr-consolidation.ts";
import { getApplicableDailyRate } from "../lib/fx-daily.ts";

// Both untested since creation (flagged in a whole-app review as twin fallback-chain
// implementations of the same underlying concept -- a fallback-order bug in either would
// silently misvalue every FX-converted figure on GR Books without looking obviously wrong).

test("prevMonthKey: normal month decrements within the same year", () => {
  assert.equal(prevMonthKey("2026-06-15"), "2026-05");
});

test("prevMonthKey: January wraps to December of the PREVIOUS year, not month 0", () => {
  assert.equal(prevMonthKey("2026-01-15"), "2025-12");
});

test("getApplicableRate: exact previous-month key hit", () => {
  const rates = { "2026-05": 83.1, "2026-06": 83.5 };
  // A June transaction looks up May's rate (previous-month convention).
  assert.equal(getApplicableRate(rates, "2026-06-15"), 83.1);
});

test("getApplicableRate: falls back to the nearest EARLIER month when the exact previous month is missing", () => {
  const rates = { "2026-03": 82.0, "2026-05": 83.1 };
  // Looking for 2026-06 (July tx), missing -- nearest earlier is 2026-05, not 2026-03.
  assert.equal(getApplicableRate(rates, "2026-07-01"), 83.1);
});

test("getApplicableRate: falls back to the most recent rate of ANY kind when nothing is earlier (a brand-new book with only future/later rates on file)", () => {
  const rates = { "2026-08": 84.2, "2026-09": 84.5 };
  // Looking for 2026-01 (Feb tx) -- nothing earlier exists at all, so it should NOT silently
  // return undefined/NaN; it should fall back to the latest rate on file rather than crash
  // downstream FX math.
  assert.equal(getApplicableRate(rates, "2026-02-01"), 84.5);
});

test("getApplicableRate: hardcoded 84 default when fxRates is completely empty", () => {
  assert.equal(getApplicableRate({}, "2026-06-15"), 84);
});

test("getApplicableDailyRate: exact date hit", () => {
  const rates = { "2026-06-10": 83.2, "2026-06-12": 83.4 };
  assert.equal(getApplicableDailyRate(rates, "2026-06-10"), 83.2);
});

test("getApplicableDailyRate: weekend/holiday gap falls back to the nearest EARLIER trading day, not the nearest later one", () => {
  const rates = { "2026-06-05": 83.0, "2026-06-08": 83.9 }; // Fri, then Mon
  // Saturday 2026-06-06 has no FX rate (markets closed) -- should use Friday's, not skip ahead to Monday's.
  assert.equal(getApplicableDailyRate(rates, "2026-06-06"), 83.0);
});

test("getApplicableDailyRate: falls back to the nearest LATER date only when nothing earlier exists (start of the FX history)", () => {
  const rates = { "2026-06-10": 83.2, "2026-06-12": 83.4 };
  // Requesting a date before the earliest rate on file at all.
  assert.equal(getApplicableDailyRate(rates, "2026-06-01"), 83.2);
});

test("getApplicableDailyRate: hardcoded 84 default when rates is completely empty", () => {
  assert.equal(getApplicableDailyRate({}, "2026-06-15"), 84);
});
