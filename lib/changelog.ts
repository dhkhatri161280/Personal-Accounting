// Full commit history, regenerated at build time by scripts/generate-changelog.mjs straight from
// `git log` (every real commit, most recent first) -- surfaced by clicking the header's
// BuildStamp, so "what changed" is answerable in-app instead of only via git log. Previously a
// short, manually-maintained list; confirmed live that it silently went stale (sat unchanged for
// 5 days while 10+ real user-facing changes shipped, with nothing to catch the drift). Deriving
// it from git directly means it can never drift again -- every deploy bakes in the exact history
// as of that build.
import changelogData from "./changelog-data.json";

export const CHANGELOG: { date: string; summary: string }[] = changelogData;
