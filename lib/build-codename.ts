// Turns a build's raw version-id hex (e.g. "b92588e2", from Cloudflare's version_metadata) into
// a memorable "adjective-noun" codename -- same idea as Docker container names or Ubuntu release
// names. Deterministic: the same id always produces the same codename, so it's still a real,
// reproducible fingerprint for a specific deploy, just easier to read/say/remember than a raw hex
// string. The raw id stays available separately (BuildStamp.tsx's tooltip) for anyone who
// actually needs to match it back to a Cloudflare version.
const ADJECTIVES = [
  "swift", "cosmic", "amber", "quiet", "bold", "rustic", "lucky", "clever", "mighty", "gentle",
  "vivid", "brisk", "cozy", "electric", "frosty", "golden", "hidden", "jolly", "keen", "lively",
  "misty", "noble", "plucky", "quirky", "radiant", "sly", "tidy", "upbeat", "witty", "zesty",
];
const NOUNS = [
  "falcon", "otter", "comet", "maple", "badger", "harbor", "lantern", "ember", "canyon", "sparrow",
  "glacier", "meadow", "raven", "willow", "boulder", "cricket", "dune", "ferret", "geyser", "heron",
  "iris", "juniper", "kestrel", "lynx", "marlin", "nectar", "opal", "pebble", "quartz", "reef",
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
  const hash = fnv1aHash(id);
  const adjective = ADJECTIVES[hash % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(hash / ADJECTIVES.length) % NOUNS.length];
  return `${adjective}-${noun}`;
}
