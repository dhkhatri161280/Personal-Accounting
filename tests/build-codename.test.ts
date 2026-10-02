import assert from "node:assert/strict";
import test from "node:test";
import { buildCodename, CODENAMES } from "../lib/build-codename.ts";

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

test("every curated codename is reachable and well-formed", () => {
  // Every entry in the curated list matches the adjective-noun shape, and a wide spread of ids
  // reaches a large fraction of the list -- catches a typo (stray space/underscore/uppercase) and
  // a hash-distribution regression at once, without demanding every single one hit in 500 tries.
  for (const name of CODENAMES) assert.match(name, /^[a-z]+-[a-z]+$/, `malformed codename: "${name}"`);
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(buildCodename(`build-${i}`));
  assert.ok(seen.size > CODENAMES.length * 0.8, `expected most of the ${CODENAMES.length} codenames reachable, only saw ${seen.size}`);
});

test("no duplicate entries in the curated list", () => {
  assert.equal(new Set(CODENAMES).size, CODENAMES.length);
});
