import assert from "node:assert/strict";
import test from "node:test";
import { formatPacificTimestamp, parseNarrationDate } from "../lib/format-date.ts";

test("formats an ISO timestamp in Pacific time with a middle dot before the clock time", () => {
  // 2026-09-26T22:42:00Z is 2026-09-26 3:42 PM PDT (UTC-7, daylight saving in effect).
  assert.equal(formatPacificTimestamp("2026-09-26T22:42:00.000Z"), "Sep 26, 2026 · 3:42 PM PDT");
});

test("switches to PST (not PDT) for a winter date outside daylight saving", () => {
  // 2026-01-15T20:05:00Z is 2026-01-15 12:05 PM PST (UTC-8, standard time).
  assert.equal(formatPacificTimestamp("2026-01-15T20:05:00.000Z"), "Jan 15, 2026 · 12:05 PM PST");
});

test("only replaces the comma before the time, not the one between day and year", () => {
  const result = formatPacificTimestamp("2026-09-26T22:42:00.000Z");
  assert.ok(result?.includes("Sep 26, 2026"), `expected "Sep 26, 2026" intact, got "${result}"`);
  assert.ok(!result?.includes("26 · 2026"), `comma-before-year got mangled: "${result}"`);
});

test("parseNarrationDate extracts a Schwab-style embedded date as ISO", () => {
  assert.equal(parseNarrationDate("NVDA Qualified Dividend (02-04-2025)"), "2025-04-02");
});

test("parseNarrationDate still finds the date when something is appended after it", () => {
  assert.equal(parseNarrationDate("CURRENCY_USD NVIDIA CORP (01-10-2026) Dividend/Interest"), "2026-10-01");
});

test("parseNarrationDate returns undefined when no parenthesized date is present", () => {
  assert.equal(parseNarrationDate("Dividend/interest income"), undefined);
  assert.equal(parseNarrationDate(""), undefined);
});

test("returns null for a missing timestamp -- caller hides the line instead of showing blank", () => {
  assert.equal(formatPacificTimestamp(undefined), null);
  assert.equal(formatPacificTimestamp(null), null);
  assert.equal(formatPacificTimestamp(""), null);
});

test("returns null for a genuinely invalid timestamp instead of throwing", () => {
  assert.equal(formatPacificTimestamp("not-a-date"), null);
});
