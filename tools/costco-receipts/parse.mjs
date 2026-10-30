#!/usr/bin/env node
// Phase 2: turns the raw .captures/<label>/*/*.json files (from attach.mjs or capture.mjs) into
// a clean itemized purchase list, and flags which items are still within Costco's price-
// adjustment window. Built against REAL captured data from both accounts -- see 0001.json etc.
// under .captures/dignesh and .captures/hiral for the shape this was written against.
//
// Costco's receipts/graphql endpoint returns two different shapes for the same `receipts` array
// depending on which UI action triggered it:
//   - The ORDER LIST view: itemArray entries have only `itemNumber`, nothing else -- no
//     description or price, just a count. Still useful for date/warehouse/total, but not items.
//   - The RECEIPT DETAIL view (after clicking "View Receipt"): itemArray entries are fully
//     populated (itemDescription01/02, amount, itemUnitPriceAmount, etc.) -- this is what we need.
// Detected per-item by whether `itemDescription01` is present, not by which file it came from --
// a single capture run saves both kinds, often in the same file when a list and a detail both
// loaded close together.
//
// Price-adjustment window: Costco's own terms give 30 days on most items (longer -- e.g. 90 days
// -- on certain categories, electronics among them, per the Executive 2% Reward Program FAQ you
// shared -- but there is no reliable way to tell a TV apart from a toaster from this data alone,
// so this always uses the conservative 30-day figure and flags every window as "AT LEAST this
// long" rather than claiming precision it doesn't have).
//
// Usage:
//   node parse.mjs
// Output:
//   .captures/watchlist.json       -- every real purchase, every detail receipt found
//   Also prints a "still within window" summary to the console.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURES_DIR = join(__dirname, ".captures");
const PRICE_ADJUSTMENT_WINDOW_DAYS = 30;

function* walkJsonFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkJsonFiles(full);
    else if (name.endsWith(".json") && name !== "watchlist.json") yield full;
  }
}

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86400000);
}

// Costco's own itemArray entries carry price two ways: `amount` (correctly signed -- negative on
// a genuine return, confirmed live: "MWCHINOPANT" return captured as unit:-1, amount:-19.99) and
// `itemUnitPriceAmount` (always the positive per-unit reference price, same magnitude whether the
// line is a purchase OR a return -- confirmed live, same MWCHINOPANT return: itemUnitPriceAmount:
// 19.99). The per-unit price is genuinely the right figure to compare against a single unit's
// current price for price-matching (a multi-unit purchase's own `amount` is the EXTENDED total,
// e.g. "2 @ 14.39" -> amount: 28.78, itemUnitPriceAmount: 14.39) -- but naively preferring it with
// `itemUnitPriceAmount || amount` silently threw away the sign on every return, since a positive
// itemUnitPriceAmount always wins that `||` regardless of amount's own sign. That's exactly why a
// real return (MWCHINOPANT, BUFFALO HOOD) was showing up with a POSITIVE price, which also meant
// returnedItemNumbers() in lib/costco-receipts.ts (checks `item.amount < 0`) never recognized it
// as a return at all. Sign now always comes from amount/unit (which agree); magnitude still
// prefers the per-unit price when Costco provides one.
function signedUnitPrice(item) {
  const sign = (item.amount < 0 || item.unit < 0) ? -1 : 1;
  const magnitude = item.itemUnitPriceAmount || Math.abs(item.amount);
  return sign * magnitude;
}

// Stable identity for a receipt, so the same one captured in multiple files/runs collapses to
// one entry -- warehouse+register+transaction number+date is Costco's own natural key for a
// specific till transaction (transactionBarcode also encodes this, but isn't always present).
function receiptKey(r) {
  return `${r.warehouseNumber}-${r.registerNumber}-${r.transactionNumber}-${(r.transactionDate || r.transactionDateTime || "").slice(0, 10)}`;
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const receipts = new Map(); // receiptKey -> { ...receipt, cardholder }

  let labelDirs;
  try {
    labelDirs = readdirSync(CAPTURES_DIR).filter((n) => statSync(join(CAPTURES_DIR, n)).isDirectory());
  } catch {
    console.error(`No .captures folder found at ${CAPTURES_DIR} -- run attach.mjs or capture.mjs first.`);
    process.exit(1);
  }

  for (const label of labelDirs) {
    for (const file of walkJsonFiles(join(CAPTURES_DIR, label))) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const list = parsed?.body?.data?.receiptsWithCounts?.receipts;
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        const key = receiptKey(r);
        const existing = receipts.get(key);
        // Prefer whichever version actually has real item detail -- a later-captured list view
        // of the same receipt must not overwrite an earlier, richer detail view.
        const thisHasDetail = r.itemArray?.some((i) => i.itemDescription01 != null);
        const existingHasDetail = existing?.itemArray?.some((i) => i.itemDescription01 != null);
        if (!existing || (thisHasDetail && !existingHasDetail)) {
          receipts.set(key, { ...r, cardholder: label });
        }
      }
    }
  }

  const detailReceipts = [...receipts.values()].filter((r) => r.itemArray?.some((i) => i.itemDescription01 != null));

  const watchlist = [];
  for (const r of detailReceipts) {
    const date = (r.transactionDate || r.transactionDateTime || "").slice(0, 10);
    if (!date) continue;
    const deadline = new Date(date);
    deadline.setDate(deadline.getDate() + PRICE_ADJUSTMENT_WINDOW_DAYS);
    const deadlineIso = deadline.toISOString().slice(0, 10);
    const withinWindow = today <= deadlineIso;
    for (const item of r.itemArray) {
      if (item.itemDescription01 == null) continue;
      // unit === 0 (confirmed live: an "ADIDAS SNKR" line inside a later instant-savings
      // adjustment "receipt" for an item actually bought weeks earlier, amount: 0, unit: 0,
      // itemUnitPriceAmount still populated at the original $37.99) means zero units moved in
      // THIS specific line -- it's an informational echo of the original purchase, not a new
      // transaction, and must never be counted as a purchase to watch or reward.
      if (item.unit === 0) continue;
      const price = signedUnitPrice(item);
      if (price < 0) continue; // a return/adjustment line, not a purchase to watch
      watchlist.push({
        cardholder: r.cardholder,
        date,
        warehouse: r.warehouseName,
        receiptType: r.receiptType,
        itemNumber: item.itemNumber,
        description: [item.itemDescription01, item.itemDescription02].filter(Boolean).join(" "),
        pricePaid: price,
        qty: item.unit,
        priceAdjustmentDeadlineAtLeast: deadlineIso,
        stillWithinWindow: withinWindow,
        daysLeft: withinWindow ? daysBetween(today, deadlineIso) : null,
      });
    }
  }

  watchlist.sort((a, b) => (a.date < b.date ? 1 : -1));
  writeFileSync(join(CAPTURES_DIR, "watchlist.json"), JSON.stringify(watchlist, null, 2));

  // The upload-ready file for Masters -> Costco Receipts -- grouped by receipt (not flattened to
  // individual items like watchlist.json above), matching lib/vault-types.ts's CostcoReceipt
  // shape exactly so the app's import step is a direct parse with no further transformation.
  // Includes ALL receipt types (Gas Station included) -- lib/costco-receipts.ts does its own
  // gas/Shop-Card exclusion at calculation time, the same way the narration-based estimate
  // already does, rather than this file silently dropping data a future calculation might want.
  const receiptsOut = detailReceipts
    .map((r) => ({
      key: receiptKey(r),
      cardholder: r.cardholder,
      date: (r.transactionDate || r.transactionDateTime || "").slice(0, 10),
      warehouse: r.warehouseName,
      receiptType: r.receiptType,
      total: r.total,
      // Return/credit lines (negative amount) are kept, not dropped -- an app-side watchlist
      // filter cross-references them to clear a price-match entry for an item that was later
      // returned (see returnedItemNumbers in lib/costco-receipts.ts). A prior version filtered
      // these out entirely, which also meant item-level returns never reduced the receipt-based
      // reward calculation either -- this is a real correctness fix, not just a watchlist nicety.
      // unit === 0 lines are dropped here too (see signedUnitPrice's comment) -- they're not a
      // real purchase or a real return, just an echo of a purchase from some earlier receipt.
      items: r.itemArray
        .filter((i) => i.itemDescription01 != null && i.unit !== 0)
        .map((i) => ({
          itemNumber: i.itemNumber,
          description: [i.itemDescription01, i.itemDescription02].filter(Boolean).join(" "),
          amount: signedUnitPrice(i),
          qty: i.unit,
        })),
    }))
    .filter((r) => r.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  writeFileSync(join(CAPTURES_DIR, "receipts.json"), JSON.stringify(receiptsOut, null, 2));

  const withinWindow = watchlist.filter((w) => w.stillWithinWindow);
  console.log(`\nParsed ${detailReceipts.length} itemized receipt(s) across ${labelDirs.join(", ")}.`);
  console.log(`${watchlist.length} line items total, ${withinWindow.length} still within the price-adjustment window (>= ${PRICE_ADJUSTMENT_WINDOW_DAYS} days).\n`);
  if (withinWindow.length) {
    console.log("Still worth checking for a price match:");
    for (const w of withinWindow) {
      console.log(`  [${w.cardholder}] ${w.date} -- ${w.description} ($${w.pricePaid}) -- ${w.daysLeft} day(s) left (at least)`);
    }
  }
  console.log(`\nFull item list:      ${join(CAPTURES_DIR, "watchlist.json")}`);
  console.log(`Upload into the app:  ${join(CAPTURES_DIR, "receipts.json")}  (Masters -> Costco Receipts)`);
}

main();
