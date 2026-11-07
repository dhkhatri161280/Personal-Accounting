#!/usr/bin/env node
// One-off (re-runnable) backfill: parses a real Amex "Download activity" CSV export and matches
// it against lib/amex-credit-match.ts's confirmed benefit-credit names, producing
// statement-credits.json in the exact shape apply-statement-claims.mjs already expects
// ({ benefitId: [{date, amount}] }). This is the non-automated side of the Plaid-based credit sync
// (see AmexBenefitsReport.tsx's "Sync credits from card transactions" button for the ongoing,
// no-download-needed path) -- useful for backfilling a full benefit year in one shot, or for
// confirming the real posted name of a benefit (Digital Entertainment, Lodging) the first time it
// shows up here, so it can be added to AMEX_BENEFIT_CREDIT_NAMES.
//
// The CSV itself is never committed (same reasoning as statement-credits.json/statement-
// claims.json -- real account data) -- run this, inspect the printed summary, then run
// apply-statement-claims.ps1 (same DPAPI-secret pattern as import-to-vault.ps1) to push it.
//
// Usage: node --import tsx backfill-credits-from-statement.mjs <path-to-activity.csv>

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { matchAmexBenefitCredits } from "../../lib/amex-credit-match.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: node --import tsx backfill-credits-from-statement.mjs <path-to-activity.csv>");
  process.exit(1);
}

// Minimal RFC4180 parser -- handles quoted fields with embedded commas/newlines and doubled ""
// quotes, which Amex's own export uses throughout its "Extended Details"/"Address" columns. Only
// the first three columns (Date, Description, Amount) are ever read by the caller below, but a
// field-unaware split on "," or "\n" would misalign every row after the first quoted field with
// an embedded comma/newline, so the whole row structure has to be parsed properly, not skipped.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = []; field = "";
      } else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const text = readFileSync(csvPath, "utf8");
const rows = parseCsv(text);
const header = rows[0];
const dateIdx = header.indexOf("Date");
const descIdx = header.indexOf("Description");
const amtIdx = header.indexOf("Amount");
if (dateIdx < 0 || descIdx < 0 || amtIdx < 0) throw new Error("Unexpected CSV header -- expected Date/Description/Amount columns.");

const transactions = rows.slice(1).filter((r) => r[dateIdx]).map((r) => {
  const [mm, dd, yyyy] = r[dateIdx].split("/");
  return { date: `${yyyy}-${mm}-${dd}`, name: r[descIdx], amount: Number(r[amtIdx]) };
});

const matched = matchAmexBenefitCredits(transactions, {});

const benefitIds = Object.keys(matched);
if (!benefitIds.length) {
  console.log("No matching benefit credits found in this statement.");
  process.exit(0);
}

console.log(`Matched ${benefitIds.length} benefit(s) from ${transactions.length} statement row(s):\n`);
for (const id of benefitIds) {
  const sum = matched[id].reduce((s, c) => s + c.amount, 0);
  console.log(`  ${id}: ${matched[id].length} credit(s), total $${sum.toFixed(2)}`);
}

const outPath = join(__dirname, "statement-credits.json");
writeFileSync(outPath, JSON.stringify(matched, null, 2));
console.log(`\nWrote ${outPath} -- run apply-statement-claims.ps1 to push this to the vault.`);
