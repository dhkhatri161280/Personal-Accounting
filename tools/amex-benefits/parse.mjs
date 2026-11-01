#!/usr/bin/env node
// Phase 2: turns the raw .captures/<timestamp>/*.json files (from attach.mjs) into a clean
// benefits.json, ready to import into the vault (Masters -> Amex Benefits, or import-to-vault.mjs
// directly). Built against REAL captured data from a live Amex Platinum account -- Amex's
// ReadBestLoyaltyBenefitsTrackers.v1 endpoint (confirmed live: 12 real trackers, each with its own
// current cycle dates, target/spent/remaining amounts, and status) is the source of truth; this
// file is a thin, faithful mapping of that shape, not a guess at what Amex's API might return.
//
// Scoped to category "usage" trackers only (real statement credits -- $200 Airline Fee,
// Digital Entertainment, Uber One, etc.) with a MONETARY targetUnit. Amex's same response also
// carries "spend" trackers (progress toward a spend-based perk tier, e.g. Centurion Lounge/Delta
// Sky Club access) and "access" trackers (a visit/pass count, not a dollar credit) -- neither is
// "what I utilize" in the dollars-back sense this tracker is for, so both are left out of
// benefits.json entirely (not silently miscounted as statement credits).
//
// Usage:
//   node parse.mjs
// Output:
//   benefits.json -- ready to import (Masters -> Amex Benefits, or import-to-vault.mjs)

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURES_DIR = join(__dirname, ".captures");
const TRACKERS_URL_RE = /ReadBestLoyaltyBenefitsTrackers/i;

function* walkJsonFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkJsonFiles(full);
    else if (name.endsWith(".json")) yield full;
  }
}

function main() {
  let files;
  try {
    files = [...walkJsonFiles(CAPTURES_DIR)].sort(); // chronological -- timestamp folder names sort lexically
  } catch {
    console.error(`No .captures folder found at ${CAPTURES_DIR} -- run attach.mjs first.`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const byId = new Map(); // benefitId -> clean benefit -- later captures overwrite earlier ones

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!TRACKERS_URL_RE.test(parsed?.url || "")) continue;
    // body is an array of accounts, each with its own `trackers` array -- confirmed live: index 0
    // was the only entry for a single-card account; walking all of them covers multiple cards too.
    const accounts = Array.isArray(parsed.body) ? parsed.body : [];
    for (const acct of accounts) {
      for (const t of acct.trackers || []) {
        if (t.category !== "usage" || t.tracker?.targetUnit !== "MONETARY") continue;
        if (!t.benefitId || !t.benefitName) continue;
        byId.set(t.benefitId, {
          benefitId: t.benefitId,
          benefitName: t.benefitName,
          periodStartDate: (t.periodStartDate || "").slice(0, 10),
          periodEndDate: (t.periodEndDate || "").slice(0, 10),
          trackerDuration: t.trackerDuration || "",
          status: t.status || "",
          targetAmount: Number(t.tracker.targetAmount) || 0,
          spentAmount: Number(t.tracker.spentAmount) || 0,
          remainingAmount: Number(t.tracker.remainingAmount) || 0,
          currency: t.tracker.targetCurrency || "USD",
          lastCheckedAt: now,
        });
      }
    }
  }

  const benefits = [...byId.values()].sort((a, b) => (a.benefitName < b.benefitName ? -1 : 1));
  if (!benefits.length) {
    console.log("No usage trackers found in any capture -- run attach.mjs again while on the Benefits page.");
    return;
  }

  writeFileSync(join(__dirname, "benefits.json"), JSON.stringify(benefits, null, 2));

  console.log(`Parsed ${benefits.length} real benefit tracker(s):\n`);
  let totalTarget = 0, totalSpent = 0;
  for (const b of benefits) {
    totalTarget += b.targetAmount;
    totalSpent += b.spentAmount;
    console.log(
      `  ${b.benefitName.padEnd(42)} ${b.status.padEnd(12)} $${b.spentAmount.toFixed(2)} / $${b.targetAmount.toFixed(2)}  (resets ${b.periodEndDate})`
    );
  }
  console.log(`\nTotal across all trackers' current cycles: $${totalSpent.toFixed(2)} used of $${totalTarget.toFixed(2)} available.`);
  console.log(`\nSaved: ${join(__dirname, "benefits.json")}`);
}

main();
