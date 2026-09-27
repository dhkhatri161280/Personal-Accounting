#!/usr/bin/env node
// Regenerates lib/changelog-data.json from the full git commit history -- every commit, not a
// manually-curated subset. Runs as part of `npm run build`, so every deploy bakes in the exact
// commit history as of that build. Replaces a hand-maintained CHANGELOG array that silently went
// stale (confirmed live: it sat unchanged for 5 days while 10+ real user-facing changes shipped,
// with nothing to catch the drift) -- generating it straight from git means it can't drift again.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const outPath = join(repoRoot, "lib", "changelog-data.json");

const SEP = "\u0001"; // a real git commit subject is vanishingly unlikely to contain this
const raw = execSync(`git log --no-merges --pretty=format:%ad${SEP}%s --date=format:%Y-%m-%d`, {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});

const entries = raw
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [date, ...rest] = line.split(SEP);
    return { date, summary: rest.join(SEP) };
  });

writeFileSync(outPath, JSON.stringify(entries, null, 2) + "\n");
console.log(`Generated ${entries.length} changelog entries -> ${outPath}`);
