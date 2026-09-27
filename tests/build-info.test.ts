import assert from "node:assert/strict";
import test from "node:test";
import { parseVersionTimestamp } from "../lib/build-info.ts";

test("parses a numeric epoch-ms value", () => {
  assert.equal(parseVersionTimestamp(1758960000000), new Date(1758960000000).toISOString());
});

test("parses a numeric epoch-ms value given as a string", () => {
  assert.equal(parseVersionTimestamp("1758960000000"), new Date(1758960000000).toISOString());
});

test("parses an ISO 8601 string -- the real production shape that crashed the old Number()-first code", () => {
  assert.equal(parseVersionTimestamp("2026-09-27T08:00:00.000Z"), "2026-09-27T08:00:00.000Z");
});

test("returns null (not a throw) for undefined or null", () => {
  assert.equal(parseVersionTimestamp(undefined), null);
  assert.equal(parseVersionTimestamp(null), null);
});

test("returns null (not a throw) for a genuinely unparseable value", () => {
  assert.equal(parseVersionTimestamp("not-a-date"), null);
});
