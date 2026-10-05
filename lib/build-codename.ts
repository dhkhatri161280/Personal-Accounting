// Turns a build's raw version-id hex (e.g. "b92588e2", from Cloudflare's version_metadata) into
// a memorable Gujarati "adjective-noun" codename -- same idea as Docker container names, but
// relatable to the user instead of generic English words. Deterministic: the same id always
// produces the same codename, so it's still a real, reproducible fingerprint for a specific
// deploy. The raw id stays available separately (BuildStamp.tsx's tooltip) for anyone who
// actually needs to match it back to a Cloudflare version.
//
// A hand-curated list, not a free cross-product of every adjective against every noun -- the
// earlier version (any of ~30 adjectives x any of ~30 nouns) produced grammatically-correct but
// semantically random pairings like "tikha pendha" ("spicy pendha" -- pendha is a plain milk
// sweet, never spicy, so the combo just reads as a mistake, not a joke). Every entry below was
// picked because the pairing itself is funny or satisfying: either genuinely true to the real
// food ("kadak khakhra" -- khakhra really is hard/crisp; "khatmithi dabeli" -- dabeli really is
// sweet-tangy), or deliberate hyperbole applied to something it's known for ("garmagaram samosa",
// "dhamakedar undhiyu"). No gender-agreement machinery needed anymore since every string here is
// already written correctly by hand.
export const CODENAMES: string[] = [
  "fluffy-dhokla", "jordar-dhokla",
  "crispy-fafda", "faadu-fafda",
  "spongy-khaman", "zabardast-khaman",
  "mast-thepla", "mazedar-thepla",
  "tikhu-undhiyu", "dhamakedar-undhiyu",
  "mithi-jalebi", "crispy-jalebi",
  "crunchy-gathiya", "kadak-gathiya",
  "namkeen-chevdo", "chatpata-chevdo",
  "swadisht-handvo", "jordar-handvo",
  "kadak-khakhra", "crispy-khakhra",
  "mithi-lapsi", "ghee-lapsi",
  "mithu-shrikhand", "malai-shrikhand",
  "tikha-bhajiya", "garmagaram-bhajiya",
  "namkeen-sev", "kadak-sev",
  "taazi-chaas", "thanda-chaas",
  "garmagaram-rotlo", "jordar-rotlo",
  "khatmithi-dabeli", "mazedar-dabeli",
  "taazu-farsaan", "namkeen-farsaan",
  "kadak-papdi", "crispy-papdi",
  "khushbudar-sutarfeni", "mithi-sutarfeni",
  "mast-muthiya", "swadisht-muthiya",
  "garmagaram-samosa", "crispy-samosa",
  "garmagaram-khichdi", "swadisht-khichdi",
  "khatti-kadhi", "garmagaram-kadhi",
  "garmagaram-bhakhri", "dabang-bhakhri",
  "mitha-pendha", "malai-pendha",
  "mithi-ghari", "khaas-ghari",
  "malai-basundi", "mithi-basundi",
  "chatpata-chakri", "kadak-chakri",
  "chatpata-locho", "garmagaram-locho",
];

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
  return CODENAMES[fnv1aHash(id) % CODENAMES.length];
}
