// Shared by check-prices.mjs (which appends to this log) and analyze-price-gaps.mjs (which only
// reads it) -- one place for the storage format and the summary math, so the two never drift.
//
// Real, observed warehouse-vs-online price gaps, logged whenever Costco's own search response
// carries BOTH a real warehousePrice and a real deliveryPrice for the same matched item -- never
// an estimate, never a guess. The whole point: replace the apparel-only $2 adjustment (itself
// based on a single real data point) with an actual, reviewable number once there's enough real
// data for a category -- and even then, only ever applied by hand after a human looks at it, not
// automatically.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const GAP_LOG_PATH = join(__dirname, ".captures", "price-gap-observations.json");

export function loadGapObservations() {
  if (!existsSync(GAP_LOG_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(GAP_LOG_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Appends (not replaces) -- a re-run against the same items adds more observations of the same
// real gap over time rather than losing history, since Costco's own prices move cycle to cycle.
export function appendGapObservations(newOnes) {
  if (!newOnes.length) return loadGapObservations();
  const all = [...loadGapObservations(), ...newOnes];
  writeFileSync(GAP_LOG_PATH, JSON.stringify(all, null, 2));
  return all;
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Buckets by topCategory (Costco's own most-general category label for that item). A negative
// gap means warehouse was CHEAPER than online (the direction the apparel $2 estimate assumes);
// a positive gap means online was cheaper -- both are real and worth seeing, not just the
// negative ones, since assuming the direction without data would be the same guessing this exists
// to avoid.
export function summarizeByCategory(observations) {
  const byCategory = new Map();
  for (const o of observations) {
    const key = o.topCategory || "(no category)";
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(o.gap);
  }
  return [...byCategory.entries()]
    .map(([category, gaps]) => ({
      category,
      count: gaps.length,
      averageGap: Number((gaps.reduce((s, g) => s + g, 0) / gaps.length).toFixed(2)),
      medianGap: Number(median(gaps).toFixed(2)),
      minGap: Math.min(...gaps),
      maxGap: Math.max(...gaps),
    }))
    .sort((a, b) => b.count - a.count);
}

export function printGapSummary(observations) {
  if (!observations.length) {
    console.log("\nNo real warehouse-vs-online gap observations logged yet.");
    return;
  }
  console.log(`\n${observations.length} real warehouse-vs-online observation(s) logged so far (${GAP_LOG_PATH}):`);
  for (const row of summarizeByCategory(observations)) {
    const enough = row.count >= 10 ? "" : `  -- too few to generalize from yet (want 10+)`;
    console.log(
      `  ${row.category.padEnd(40)} n=${String(row.count).padEnd(3)} avg=$${row.averageGap.toFixed(2).padStart(6)}  median=$${row.medianGap.toFixed(2).padStart(6)}  range=[$${row.minGap.toFixed(2)}, $${row.maxGap.toFixed(2)}]${enough}`
    );
  }
  console.log(`  (gap = deliveryPrice - warehousePrice -- positive means online was MORE expensive, i.e. warehouse cheaper)`);
}
