#!/usr/bin/env node
// Reconciliation: writes real credits/claims, hand-reconciled against Amex's own downloadable
// account-activity export, into the vault -- for the handful of cases where Amex's own live data
// (either a coverage benefit's voucher-narration claim search, or a tracker's own
// yearToDateAmount) has been confirmed to miss or understate what actually posted. See
// AmexCoverageBenefit.statementClaims and AmexBenefit.statementCredits's own comments in
// lib/vault-types.ts for why each exists.
//
// Reads two gitignored, never-committed local files (since they hold real account data):
//   statement-claims.json  -> { benefitKey: [{date, amount}] }   applied to amexCoverageBenefits
//   statement-credits.json -> { benefitId: [{date, amount}] }    applied to amexBenefits
// Either file may be absent if there's nothing to reconcile for that side.
//
// There's no automated way to produce these -- Amex has no API for its downloadable account-
// activity export, so each is hand-reconciled from that export and edited directly. Re-run this
// script any time either file is updated with new entries.
//
// Usage: node apply-statement-claims.mjs (same env vars as import-to-vault.mjs)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { load, encrypt } = require("../tally-sync/sync-core.js");

function readJson(name) {
  const path = join(__dirname, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

async function main() {
  const STATEMENT_CLAIMS = readJson("statement-claims.json");
  const STATEMENT_CREDITS = readJson("statement-credits.json");
  if (!Object.keys(STATEMENT_CLAIMS).length && !Object.keys(STATEMENT_CREDITS).length) {
    console.log("Nothing to apply -- neither statement-claims.json nor statement-credits.json has entries.");
    return;
  }

  const sitePw = process.env.PL_SITE_PASSWORD || "", vaultPw = process.env.PL_VAULT_PASSWORD || "";
  const accessToken = process.env.PL_ACCESS_CODE || "";
  if (!sitePw || !vaultPw) throw new Error("Passwords were not supplied -- run via import-to-vault.ps1's pattern.");
  if (!accessToken) throw new Error("PL_ACCESS_CODE not set -- required for /api/vault writes.");
  const auth = "Basic " + Buffer.from("manual-amex-import:" + sitePw).toString("base64");

  const state = await load(auth, vaultPw, "us");
  let changed = 0;

  const existingCoverage = state.vault.amexCoverageBenefits || [];
  const updatedCoverage = existingCoverage.map((b) => {
    const claims = STATEMENT_CLAIMS[b.benefitKey];
    if (!claims || JSON.stringify(b.statementClaims || []) === JSON.stringify(claims)) return b;
    changed++;
    return { ...b, statementClaims: claims };
  });

  const existingBenefits = state.vault.amexBenefits || [];
  const updatedBenefits = existingBenefits.map((b) => {
    const credits = STATEMENT_CREDITS[b.benefitId];
    if (!credits || JSON.stringify(b.statementCredits || []) === JSON.stringify(credits)) return b;
    changed++;
    return { ...b, statementCredits: credits };
  });

  if (!changed) {
    console.log("Nothing to update -- vault already has these statement figures on file.");
    return;
  }

  const backup = join(__dirname, `encrypted-us-vault-before-statement-claims-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backup, state.raw);

  state.vault.amexCoverageBenefits = updatedCoverage;
  state.vault.amexBenefits = updatedBenefits;
  const body = JSON.stringify(encrypt(state.vault, vaultPw));
  const put = await fetch(state.url, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json", "If-Match": state.etag, "x-dk-access-token": accessToken },
    body,
  });
  if (!put.ok) throw new Error("Cloud update rejected HTTP " + put.status + " " + (await put.text()));

  console.log(`SUCCESS: statement figures applied to ${changed} benefit(s).`);
  console.log("Encrypted backup: " + backup);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
});
