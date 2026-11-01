#!/usr/bin/env node
// Reconciliation: writes real claim-payment credits from statement-claims.json (see that file --
// gitignored, never committed, since it holds real account data) into
// amexCoverageBenefits[].statementClaims (see that field's own comment in lib/vault-types.ts for
// why this exists -- the ledger's own voucher-narration search misses/mis-scopes some of these).
//
// There's no automated way to produce statement-claims.json -- Amex has no API for its downloadable
// account-activity export, so it's hand-reconciled from that export and edited directly. Re-run
// this script any time that file is updated with new entries.
//
// Usage: node apply-statement-claims.mjs (same env vars as import-to-vault.mjs)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { load, encrypt } = require("../tally-sync/sync-core.js");

const claimsPath = join(__dirname, "statement-claims.json");

async function main() {
  if (!existsSync(claimsPath)) {
    console.log("Nothing to apply -- statement-claims.json not found.");
    return;
  }
  const STATEMENT_CLAIMS = JSON.parse(readFileSync(claimsPath, "utf8"));

  const sitePw = process.env.PL_SITE_PASSWORD || "", vaultPw = process.env.PL_VAULT_PASSWORD || "";
  const accessToken = process.env.PL_ACCESS_CODE || "";
  if (!sitePw || !vaultPw) throw new Error("Passwords were not supplied -- run via import-to-vault.ps1's pattern.");
  if (!accessToken) throw new Error("PL_ACCESS_CODE not set -- required for /api/vault writes.");
  const auth = "Basic " + Buffer.from("manual-amex-import:" + sitePw).toString("base64");

  const state = await load(auth, vaultPw, "us");
  const existing = state.vault.amexCoverageBenefits || [];
  let changed = 0;
  const updated = existing.map((b) => {
    const claims = STATEMENT_CLAIMS[b.benefitKey];
    if (!claims) return b;
    if (JSON.stringify(b.statementClaims || []) === JSON.stringify(claims)) return b;
    changed++;
    return { ...b, statementClaims: claims };
  });
  if (!changed) {
    console.log("Nothing to update -- vault already has these statement claims on file.");
    return;
  }

  const backup = join(__dirname, `encrypted-us-vault-before-statement-claims-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backup, state.raw);

  state.vault.amexCoverageBenefits = updated;
  const body = JSON.stringify(encrypt(state.vault, vaultPw));
  const put = await fetch(state.url, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json", "If-Match": state.etag, "x-dk-access-token": accessToken },
    body,
  });
  if (!put.ok) throw new Error("Cloud update rejected HTTP " + put.status + " " + (await put.text()));

  console.log(`SUCCESS: statement claims applied to ${changed} benefit(s).`);
  console.log("Encrypted backup: " + backup);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
});
