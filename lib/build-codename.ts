// Turns a build's raw version-id hex (e.g. "b92588e2", from Cloudflare's version_metadata) into
// a memorable Gujarati "adjective-noun" codename -- same idea as Docker container names, but
// relatable to the user instead of generic English words. Deterministic: the same id always
// produces the same codename, so it's still a real, reproducible fingerprint for a specific
// deploy. The raw id stays available separately (BuildStamp.tsx's tooltip) for anyone who
// actually needs to match it back to a Cloudflare version.
//
// Gujarati adjectives agree in gender/number with the noun they modify (confirmed live: "mithu-
// jalebi" is wrong, "mithi-jalebi" is correct -- jalebi is feminine). Most of the adjective pool
// below is Hindi/Gujarati slang loanwords (jordar, zabardast, mast, kadak, ...) that stay
// invariant regardless of gender in real speech; only the handful of native Gujarati words
// (sweet/spicy/fresh/sweet-sour) actually inflect, so those are stored as all four forms and
// resolved against each noun's tagged gender at generation time.
type Gender = "m-sg" | "m-pl" | "f" | "n-sg";
type GenderedWord = Record<Gender, string>;

export const NOUNS: { word: string; gender: Gender }[] = [
  { word: "dhokla", gender: "m-pl" },
  { word: "fafda", gender: "m-pl" },
  { word: "khaman", gender: "n-sg" },
  { word: "thepla", gender: "m-pl" },
  { word: "undhiyu", gender: "n-sg" },
  { word: "jalebi", gender: "f" },
  { word: "gathiya", gender: "m-pl" },
  { word: "chevdo", gender: "m-sg" },
  { word: "handvo", gender: "m-sg" },
  { word: "khakhra", gender: "m-pl" },
  { word: "lapsi", gender: "f" },
  { word: "shrikhand", gender: "n-sg" },
  { word: "bhajiya", gender: "m-pl" },
  { word: "sev", gender: "f" },
  { word: "chaas", gender: "f" },
  { word: "rotlo", gender: "m-sg" },
  { word: "dabeli", gender: "f" },
  { word: "farsaan", gender: "n-sg" },
  { word: "papdi", gender: "f" },
  { word: "sutarfeni", gender: "f" },
  { word: "muthiya", gender: "m-pl" },
  { word: "samosa", gender: "m-pl" },
  { word: "khichdi", gender: "f" },
  { word: "kadhi", gender: "f" },
  { word: "bhakhri", gender: "f" },
  { word: "pendha", gender: "m-pl" },
  { word: "ghari", gender: "f" },
  { word: "basundi", gender: "f" },
  { word: "chakri", gender: "f" },
  { word: "locho", gender: "m-sg" },
];

// Invariant slang/loanword adjectives -- same form regardless of the noun's gender.
const INVARIANT_ADJECTIVES: string[] = [
  "jordar", "zabardast", "dhamakedar", "mast", "faadu", "lajawab", "kamaal", "gajab",
  "dhinchak", "bindaas", "rasilu", "swadisht", "mazedar", "dhasu", "lahejatdar",
  "khushbudar", "namkeen", "dhurandhar", "dabang", "adbhut", "bhaari", "jhakaas",
  "chatakedar", "chatpata", "garmagaram", "kadak",
];

// Native Gujarati adjectives that inflect for the noun's gender/number: sweet, spicy, fresh,
// sweet-sour (in that order).
export const GENDERED_ADJECTIVES: GenderedWord[] = [
  { "m-sg": "mitho", "m-pl": "mitha", f: "mithi", "n-sg": "mithu" },
  { "m-sg": "tikho", "m-pl": "tikha", f: "tikhi", "n-sg": "tikhu" },
  { "m-sg": "taazo", "m-pl": "taaza", f: "taazi", "n-sg": "taazu" },
  { "m-sg": "khatmitho", "m-pl": "khatmitha", f: "khatmithi", "n-sg": "khatmithu" },
];

const ADJECTIVE_SLOT_COUNT = INVARIANT_ADJECTIVES.length + GENDERED_ADJECTIVES.length;

function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function buildCodename(id: string): string {
  if (!id) return "unknown-build";
  const hash = fnv1aHash(id);
  const noun = NOUNS[Math.floor(hash / ADJECTIVE_SLOT_COUNT) % NOUNS.length];
  const adjSlot = hash % ADJECTIVE_SLOT_COUNT;
  const adjective =
    adjSlot < INVARIANT_ADJECTIVES.length
      ? INVARIANT_ADJECTIVES[adjSlot]
      : GENDERED_ADJECTIVES[adjSlot - INVARIANT_ADJECTIVES.length][noun.gender];
  return `${adjective}-${noun.word}`;
}
