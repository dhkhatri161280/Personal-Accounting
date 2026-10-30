#!/usr/bin/env node
// Writes .captures/receipts.json and .captures/price-checks.json (produced by parse.mjs and
// check-prices.mjs) straight into the encrypted US-book vault, replacing the manual Masters ->
// Costco Receipts file-picker upload.
//
// Reuses the SAME proven crypto/load/PUT primitives as tools/tally-sync (../tally-sync/sync-core.js)
// rather than reimplementing vault encryption from scratch -- getting that wrong risks corrupting
// the whole vault, not just the Costco data. Only US book: Costco receipts are a US-only feature
// (see lib/costco-receipts.ts).
//
// The merge/parse functions below (parseReceipts/mergeReceipts/parsePriceChecks/mergePriceChecks)
// are a deliberately faithful, field-by-field port of lib/costco-receipts.ts's
// parseCostcoReceiptsUpload/mergeCostcoReceipts/parseCostcoPriceChecksUpload/mergeCostcoPriceChecks
// -- a standalone Node script can't import that TypeScript module directly. This is the SAME class
// of two-copies-of-one-truth risk already seen today in tools/tally-sync's App<->Tally directions
// quietly diverging -- any future change to those TS functions must be mirrored here by hand, or
// this script's merge behavior will silently drift from what Masters -> Costco Receipts does in
// the browser.
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
// Reuse, never reimplement -- same reasoning as the header comment above.
const { load, encrypt } = require("../tally-sync/sync-core.js");

const CAPTURES_DIR = join(__dirname, ".captures");

// ── Faithful ports of lib/costco-receipts.ts (see header comment) ──────────────────────────

function parseReceipts(raw) {
  if (!Array.isArray(raw)) throw new Error('Expected a JSON array of receipts (from receipts.json).');
  return raw.map((r, i) => {
    if (typeof r !== "object" || r === null) throw new Error(`Receipt ${i}: not an object.`);
    if (typeof r.key !== "string" || !r.key) throw new Error(`Receipt ${i}: missing "key".`);
    if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error(`Receipt ${i} (${r.key}): bad or missing "date".`);
    if (!Array.isArray(r.items)) throw new Error(`Receipt ${i} (${r.key}): missing "items" array.`);
    return {
      key: r.key,
      cardholder: typeof r.cardholder === "string" ? r.cardholder : "",
      date: r.date,
      warehouse: typeof r.warehouse === "string" ? r.warehouse : "",
      receiptType: typeof r.receiptType === "string" ? r.receiptType : "",
      total: typeof r.total === "number" ? r.total : 0,
      items: r.items.map((item, j) => {
        if (typeof item !== "object" || item === null) throw new Error(`Receipt ${i} (${r.key}), item ${j}: not an object.`);
        return {
          itemNumber: typeof item.itemNumber === "string" ? item.itemNumber : "",
          description: typeof item.description === "string" ? item.description : "",
          amount: typeof item.amount === "number" ? item.amount : 0,
          qty: typeof item.qty === "number" ? item.qty : 1,
        };
      }),
    };
  });
}

function mergeReceipts(existing, incoming) {
  const byKey = new Map(existing.map((r) => [r.key, r]));
  for (const r of incoming) byKey.set(r.key, r);
  return [...byKey.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

function parsePriceChecks(raw) {
  if (!Array.isArray(raw)) throw new Error('Expected a JSON array of price checks (from price-checks.json).');
  return raw.map((r, i) => {
    if (typeof r !== "object" || r === null) throw new Error(`Price check ${i}: not an object.`);
    if (typeof r.itemNumber !== "string" || !r.itemNumber) throw new Error(`Price check ${i}: missing "itemNumber".`);
    return {
      itemNumber: r.itemNumber,
      description: typeof r.description === "string" ? r.description : "",
      pricePaid: typeof r.pricePaid === "number" ? r.pricePaid : 0,
      currentPrice: typeof r.currentPrice === "number" ? r.currentPrice : null,
      priceSource: r.priceSource === "warehouse" || r.priceSource === "estimated-warehouse" || r.priceSource === "online" ? r.priceSource : null,
      currentPriceWarehouse: typeof r.currentPriceWarehouse === "string" ? r.currentPriceWarehouse : null,
      notSoldOnline: r.notSoldOnline === true,
      priceDropped: r.priceDropped === true,
      checkedAt: typeof r.checkedAt === "string" ? r.checkedAt : new Date().toISOString(),
    };
  });
}

function mergePriceChecks(existing, incoming) {
  const byItem = new Map(existing.map((c) => [c.itemNumber, c]));
  for (const c of incoming) byItem.set(c.itemNumber, c);
  return [...byItem.values()].sort((a, b) => (a.checkedAt < b.checkedAt ? 1 : -1));
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const sitePw = process.env.PL_SITE_PASSWORD || "", vaultPw = process.env.PL_VAULT_PASSWORD || "";
  const accessToken = process.env.PL_ACCESS_CODE || "";
  if (!sitePw || !vaultPw) throw new Error("Passwords were not supplied -- run via import-to-vault.ps1.");
  if (!accessToken) throw new Error("PL_ACCESS_CODE not set -- required for /api/vault writes.");
  const auth = "Basic " + Buffer.from("manual-costco-import:" + sitePw).toString("base64");

  const receiptsPath = join(CAPTURES_DIR, "receipts.json");
  const priceChecksPath = join(CAPTURES_DIR, "price-checks.json");
  const hasReceipts = existsSync(receiptsPath);
  const hasPriceChecks = existsSync(priceChecksPath);
  if (!hasReceipts && !hasPriceChecks) {
    console.log("Nothing to import -- no .captures/receipts.json or price-checks.json found. Run parse.mjs first.");
    return;
  }

  const incomingReceipts = hasReceipts ? parseReceipts(JSON.parse(readFileSync(receiptsPath, "utf8"))) : [];
  const incomingPriceChecks = hasPriceChecks ? parsePriceChecks(JSON.parse(readFileSync(priceChecksPath, "utf8"))) : [];

  const state = await load(auth, vaultPw, "us");
  const existingReceipts = state.vault.costcoReceipts || [];
  const existingPriceChecks = state.vault.costcoPriceChecks || [];
  const mergedReceipts = mergeReceipts(existingReceipts, incomingReceipts);
  const mergedPriceChecks = mergePriceChecks(existingPriceChecks, incomingPriceChecks);
  const receiptsAdded = mergedReceipts.length - existingReceipts.length;
  const priceChecksAdded = mergedPriceChecks.length - existingPriceChecks.length;
  // A length-only comparison would miss a real change: re-running check-prices.mjs for item
  // numbers already on file refreshes their price/checkedAt under the SAME itemNumber key, so
  // mergedPriceChecks.length doesn't grow even though the actual prices did change and are worth
  // writing. Full content comparison instead -- both arrays are already in the merge functions'
  // own canonical sort order, so this is a stable, correct equality check either way.
  const unchanged = JSON.stringify(mergedReceipts) === JSON.stringify(existingReceipts)
    && JSON.stringify(mergedPriceChecks) === JSON.stringify(existingPriceChecks);
  if (unchanged) {
    console.log("Nothing new -- vault already matches these files exactly.");
    return;
  }

  const backup = join(__dirname, `encrypted-us-vault-before-costco-import-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backup, state.raw);

  state.vault.costcoReceipts = mergedReceipts;
  state.vault.costcoPriceChecks = mergedPriceChecks;
  const body = JSON.stringify(encrypt(state.vault, vaultPw));
  const put = await fetch(state.url, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json", "If-Match": state.etag, "x-dk-access-token": accessToken },
    body,
  });
  if (!put.ok) throw new Error("Cloud update rejected HTTP " + put.status + " " + (await put.text()));

  console.log(`SUCCESS: ${receiptsAdded} new receipt(s), ${priceChecksAdded} new price check(s) (${mergedPriceChecks.length} total) written directly to the vault.`);
  console.log("Encrypted backup: " + backup);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
});
