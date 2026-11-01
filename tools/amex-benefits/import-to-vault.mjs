#!/usr/bin/env node
// Writes benefits.json (produced by parse.mjs) straight into the encrypted US-book vault,
// replacing a manual Masters -> Amex Benefits file-picker upload.
//
// Reuses the SAME proven crypto/load/PUT primitives as tools/tally-sync (../tally-sync/sync-core.js)
// rather than reimplementing vault encryption from scratch -- same reasoning as
// ../costco-receipts/import-to-vault.mjs. Only US book: Amex Platinum benefits are a US-only
// feature (same as Costco receipts).
//
// The merge/parse functions below are a deliberately faithful, field-by-field port of
// lib/amex-benefits.ts's parseAmexBenefitsUpload/mergeAmexBenefits -- a standalone Node script
// can't import that TypeScript module directly. Same two-copies-of-one-truth risk already
// documented in ../costco-receipts/import-to-vault.mjs: any future change to those TS functions
// must be mirrored here by hand.
//
// Usage: node import-to-vault.mjs
// Requires PL_SITE_PASSWORD, PL_VAULT_PASSWORD (the "us-vault" one), PL_ACCESS_CODE in the
// environment -- see import-to-vault.ps1, which reads these from the same DPAPI secret files
// tools/tally-sync's own scheduled sync already uses on this machine.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { load, encrypt } = require("../tally-sync/sync-core.js");

// ── Faithful ports of lib/amex-benefits.ts (see header comment) ────────────────────────────────

function parseBenefits(raw) {
  if (!Array.isArray(raw)) throw new Error("Expected a JSON array of benefits (from benefits.json).");
  return raw.map((b, i) => {
    if (typeof b !== "object" || b === null) throw new Error(`Benefit ${i}: not an object.`);
    if (typeof b.benefitId !== "string" || !b.benefitId) throw new Error(`Benefit ${i}: missing "benefitId".`);
    if (typeof b.benefitName !== "string" || !b.benefitName) throw new Error(`Benefit ${i} (${b.benefitId}): missing "benefitName".`);
    return {
      benefitId: b.benefitId,
      benefitName: b.benefitName,
      periodStartDate: typeof b.periodStartDate === "string" ? b.periodStartDate : "",
      periodEndDate: typeof b.periodEndDate === "string" ? b.periodEndDate : "",
      trackerDuration: typeof b.trackerDuration === "string" ? b.trackerDuration : "",
      status: typeof b.status === "string" ? b.status : "",
      targetAmount: typeof b.targetAmount === "number" ? b.targetAmount : 0,
      spentAmount: typeof b.spentAmount === "number" ? b.spentAmount : 0,
      remainingAmount: typeof b.remainingAmount === "number" ? b.remainingAmount : 0,
      currency: typeof b.currency === "string" ? b.currency : "USD",
      lastCheckedAt: typeof b.lastCheckedAt === "string" ? b.lastCheckedAt : new Date().toISOString(),
    };
  });
}

function mergeBenefits(existing, incoming) {
  const byId = new Map(existing.map((b) => [b.benefitId, b]));
  for (const b of incoming) byId.set(b.benefitId, b);
  return [...byId.values()].sort((a, b) => (a.benefitName < b.benefitName ? -1 : 1));
}

function parseCoverageBenefits(raw) {
  if (!Array.isArray(raw)) throw new Error("Expected a JSON array of coverage benefits (from coverage-benefits.json).");
  return raw.map((b, i) => {
    if (typeof b !== "object" || b === null) throw new Error(`Coverage benefit ${i}: not an object.`);
    if (typeof b.benefitKey !== "string" || !b.benefitKey) throw new Error(`Coverage benefit ${i}: missing "benefitKey".`);
    if (typeof b.title !== "string" || !b.title) throw new Error(`Coverage benefit ${i} (${b.benefitKey}): missing "title".`);
    return {
      benefitKey: b.benefitKey,
      title: b.title,
      summary: typeof b.summary === "string" ? b.summary : "",
      lastCheckedAt: typeof b.lastCheckedAt === "string" ? b.lastCheckedAt : new Date().toISOString(),
    };
  });
}

function mergeCoverageBenefits(existing, incoming) {
  const byKey = new Map(existing.map((b) => [b.benefitKey, b]));
  for (const b of incoming) byKey.set(b.benefitKey, b);
  return [...byKey.values()].sort((a, b) => (a.title < b.title ? -1 : 1));
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const sitePw = process.env.PL_SITE_PASSWORD || "", vaultPw = process.env.PL_VAULT_PASSWORD || "";
  const accessToken = process.env.PL_ACCESS_CODE || "";
  if (!sitePw || !vaultPw) throw new Error("Passwords were not supplied -- run via import-to-vault.ps1.");
  if (!accessToken) throw new Error("PL_ACCESS_CODE not set -- required for /api/vault writes.");
  const auth = "Basic " + Buffer.from("manual-amex-import:" + sitePw).toString("base64");

  const benefitsPath = join(__dirname, "benefits.json");
  const coveragePath = join(__dirname, "coverage-benefits.json");
  const hasBenefits = existsSync(benefitsPath);
  const hasCoverage = existsSync(coveragePath);
  if (!hasBenefits && !hasCoverage) {
    console.log("Nothing to import -- no benefits.json or coverage-benefits.json found. Run parse.mjs first.");
    return;
  }

  const incomingBenefits = hasBenefits ? parseBenefits(JSON.parse(readFileSync(benefitsPath, "utf8"))) : [];
  const incomingCoverage = hasCoverage ? parseCoverageBenefits(JSON.parse(readFileSync(coveragePath, "utf8"))) : [];

  const state = await load(auth, vaultPw, "us");
  const existingBenefits = state.vault.amexBenefits || [];
  const existingCoverage = state.vault.amexCoverageBenefits || [];
  const mergedBenefits = mergeBenefits(existingBenefits, incomingBenefits);
  const mergedCoverage = mergeCoverageBenefits(existingCoverage, incomingCoverage);
  const added = mergedBenefits.length - existingBenefits.length;
  const coverageAdded = mergedCoverage.length - existingCoverage.length;
  // Full content comparison, not just length -- re-running parse.mjs for benefits already on file
  // refreshes their spent/remaining/status (or summary text) under the SAME key, so length alone
  // wouldn't catch it (same reasoning as costco-receipts' own import).
  const unchanged = JSON.stringify(mergedBenefits) === JSON.stringify(existingBenefits)
    && JSON.stringify(mergedCoverage) === JSON.stringify(existingCoverage);
  if (unchanged) {
    console.log("Nothing new -- vault already matches these files exactly.");
    return;
  }

  const backup = join(__dirname, `encrypted-us-vault-before-amex-import-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backup, state.raw);

  state.vault.amexBenefits = mergedBenefits;
  state.vault.amexCoverageBenefits = mergedCoverage;
  const body = JSON.stringify(encrypt(state.vault, vaultPw));
  const put = await fetch(state.url, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json", "If-Match": state.etag, "x-dk-access-token": accessToken },
    body,
  });
  if (!put.ok) throw new Error("Cloud update rejected HTTP " + put.status + " " + (await put.text()));

  console.log(`SUCCESS: ${added} new benefit(s) (${mergedBenefits.length} total), ${coverageAdded} new coverage benefit(s) (${mergedCoverage.length} total) written directly to the vault.`);
  console.log("Encrypted backup: " + backup);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
});
