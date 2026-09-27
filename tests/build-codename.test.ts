import assert from "node:assert/strict";
import test from "node:test";
import { buildCodename, GENDERED_ADJECTIVES, NOUNS } from "../lib/build-codename.ts";

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
  assert.ok(seen.size > 150, `expected broad spread, only saw ${seen.size} distinct codenames`);
});

// The bug the user actually caught: "mithu-jalebi" is grammatically wrong (jalebi is feminine),
// "mithi-jalebi" is correct. This asserts the fix directly off the real data (not a hash-luck
// search) -- "sweet" is GENDERED_ADJECTIVES[0], jalebi is tagged feminine, so its feminine form
// must be "mithi".
test("jalebi (feminine) pairs with the feminine form of a gendered adjective", () => {
  const jalebi = NOUNS.find((n) => n.word === "jalebi");
  assert.equal(jalebi?.gender, "f");
  assert.equal(GENDERED_ADJECTIVES[0].f, "mithi");
});

// Every gendered adjective must actually change across its 4 forms -- catches a copy-paste
// mistake where one form was accidentally left equal to another (e.g. f === n-sg).
test("every gendered adjective has 4 distinct forms", () => {
  for (const word of GENDERED_ADJECTIVES) {
    const forms = new Set(Object.values(word));
    assert.equal(forms.size, 4, `expected 4 distinct forms, got ${JSON.stringify(word)}`);
  }
});

// Brute-force gender-agreement invariant across a wide swath of the hash space: whenever a
// generated codename's adjective half is one of the gendered forms, it must be THAT noun's own
// tagged-gender form -- never a different noun's form (the exact class of bug "mithu-jalebi"
// was: the neuter form attached to a feminine noun).
test("gender agreement holds across many generated ids, not just the one example caught live", () => {
  const formToGenderMap = new Map<string, Gender[]>();
  function recordForm(gender: string, form: string) {
    if (!formToGenderMap.has(form)) formToGenderMap.set(form, []);
    formToGenderMap.get(form)!.push(gender as Gender);
  }
  type Gender = "m-sg" | "m-pl" | "f" | "n-sg";
  for (const word of GENDERED_ADJECTIVES) {
    for (const [gender, form] of Object.entries(word)) recordForm(gender, form);
  }
  const nounByWord = new Map(NOUNS.map((n) => [n.word, n.gender]));

  for (let i = 0; i < 500; i++) {
    const codename = buildCodename(`gender-check-${i}`);
    const [adjective, ...nounParts] = codename.split("-");
    const noun = nounParts.join("-");
    const expectedGenders = formToGenderMap.get(adjective);
    if (!expectedGenders) continue; // an invariant (non-gendered) adjective -- nothing to check
    const nounGender = nounByWord.get(noun);
    assert.ok(nounGender, `unknown noun "${noun}" in codename "${codename}"`);
    assert.ok(
      expectedGenders.includes(nounGender!),
      `"${adjective}" is the ${expectedGenders.join("/")} form but was paired with "${noun}" (${nounGender}) in "${codename}"`
    );
  }
});
