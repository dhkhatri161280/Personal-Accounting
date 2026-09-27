import assert from "node:assert/strict";
import test from "node:test";
import { buildCodename } from "../lib/build-codename.ts";

test("is deterministic -- the same id always produces the same codename", () => {
  assert.equal(buildCodename("b92588e2"), buildCodename("b92588e2"));
});

test("different ids produce different codenames (not a constant fallback)", () => {
  assert.notEqual(buildCodename("b92588e2"), buildCodename("a5da91a1"));
});

test("always renders as adjective-noun", () => {
  const codename = buildCodename("14222e8f");
  assert.match(codename, /^[a-z]+-[a-z]+$/);
});

test("an empty id doesn't throw or produce a blank string", () => {
  assert.equal(buildCodename(""), "unknown-build");
});

test("distributes across a real spread of pairs, not just a handful", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(buildCodename(`build-${i}`));
  // 30 adjectives x 30 nouns = 900 possible pairs; 200 random-ish ids should land on well over
  // half of them distinct if the hash is spreading properly, not collapsing to a few buckets.
  assert.ok(seen.size > 150, `expected broad spread, only saw ${seen.size} distinct codenames`);
});
