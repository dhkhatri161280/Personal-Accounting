#!/usr/bin/env node
// Automated live price check against Costco's own site, driven straight through the already-
// authenticated debug Chrome (attach.mjs's same connectOverCDP pattern) -- no manual clicking.
// For every item still inside the price-adjustment window (.captures/watchlist.json), this
// navigates Costco's own site search for that exact item number, captures whatever JSON API
// response(s) load, and makes a best-effort attempt to pull a current price out of them.
//
// Confirmed against a real run (2026-10-25): Costco's actual current-price API is
// gdx-api.costco.com/catalog/product/dispprice-api/v3/display-price-lite, firing only when the
// item-number search lands on exactly one product (an ambiguous or zero-result search never
// calls it -- confirmed live, item 26294/water softener salt returned a search response with
// totalSize:0, i.e. it simply isn't sold on costco.com at all, warehouse-only; no technique
// fixes that, there's nothing online to find a price for). Its shape:
//   { priceData: [{ id, displayPrice: [{ onlinePrice, deliveredPrice, warehouseNumber, ... }] }] }
// `warehouseNumber` here is costco.com's own web/catalog warehouse code, NOT the same numbering
// as a receipt's POS `warehouseNumber` (confirmed live: a Fremont, CA receipt shows warehouseNumber
// 778, but this API returned prices for "1062"/"847" instead) -- there is no known mapping between
// the two, so this picks whichever entries come back (usually the browser session's own pinned/
// nearby warehouses) rather than guaranteeing a match to the exact store the item was bought at.
// If "My Warehouse" in the debug Chrome session isn't actually set to the real shopping warehouse,
// these prices reflect wherever IS set, not necessarily the right region -- check that before
// trusting a comparison.
//
// Usage (debug Chrome must already be open -- same one attach.mjs/capture.mjs use):
//   node check-prices.mjs

import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURES_DIR = join(__dirname, ".captures");
const RAW_DIR = join(CAPTURES_DIR, "price-checks");
mkdirSync(RAW_DIR, { recursive: true });

// Pulls the real current price(s) out of a captured display-price-lite response (see the
// file-level comment for its confirmed shape). Returns every {warehouseNumber, price} pair found
// -- the caller picks the lowest, since without a confirmed mapping to the item's real purchase
// warehouse, the lowest of whatever came back is the closest thing to a usable "is there a price
// worth checking in person" signal.
function extractPrices(body) {
  const out = [];
  for (const p of body?.priceData ?? []) {
    for (const dp of p.displayPrice ?? []) {
      const price = dp.onlinePrice ?? dp.deliveredPrice;
      if (typeof price === "number" && price > 0) out.push({ warehouseNumber: dp.warehouseNumber, price });
    }
  }
  return out;
}
function findDisplayPriceResponse(captured) {
  return captured.find((c) => c.url.includes("display-price-lite"));
}
function searchReturnedNoResults(captured) {
  const search = captured.find((c) => c.url.includes("/catalog/search/api/v1/search"));
  return search?.body?.searchResult?.totalSize === 0;
}

async function main() {
  let watchlist;
  try {
    watchlist = JSON.parse(readFileSync(join(CAPTURES_DIR, "watchlist.json"), "utf8"));
  } catch {
    console.error("No .captures/watchlist.json found -- run parse.mjs first.");
    process.exit(1);
  }
  const within = watchlist.filter((w) => w.stillWithinWindow);
  // One check per distinct item number -- buying the same item twice shouldn't cost two lookups.
  const uniqueItems = [...new Map(within.map((w) => [w.itemNumber, w])).values()];
  if (!uniqueItems.length) {
    console.log("Nothing currently within the price-adjustment window -- nothing to check.");
    return;
  }
  console.log(`Checking ${uniqueItems.length} distinct item(s)...`);

  let browser;
  try {
    browser = await chromium.connectOverCDP("http://localhost:9222");
  } catch {
    console.error("\nCouldn't connect to Chrome on port 9222 -- make sure the debug Chrome window is open:");
    console.error('  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\Users\\dikhatri\\ChromeDebugProfile"');
    process.exit(1);
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());

  const results = [];
  for (const item of uniqueItems) {
    const captured = [];
    const onResponse = async (res) => {
      try {
        const contentType = res.headers()["content-type"] || "";
        if (!contentType.includes("application/json")) return;
        const body = await res.json().catch(() => null);
        if (body) captured.push({ url: res.url(), body });
      } catch {
        // Not every response matters -- skip.
      }
    };
    page.on("response", onResponse);
    await page
      .goto(`https://www.costco.com/CatalogSearch?keyword=${encodeURIComponent(item.itemNumber)}`, { waitUntil: "networkidle", timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    page.off("response", onResponse);

    writeFileSync(join(RAW_DIR, `${item.itemNumber}.json`), JSON.stringify(captured, null, 2));

    const priceResponse = findDisplayPriceResponse(captured);
    const prices = priceResponse ? extractPrices(priceResponse.body) : [];
    const lowest = prices.length ? prices.reduce((a, b) => (b.price < a.price ? b : a)) : null;
    const notSoldOnline = !priceResponse && searchReturnedNoResults(captured);
    const currentPrice = lowest?.price ?? null;
    const priceDropped = currentPrice != null && currentPrice < item.pricePaid - 0.005;
    results.push({
      itemNumber: item.itemNumber,
      description: item.description,
      pricePaid: item.pricePaid,
      currentPrice,
      currentPriceWarehouse: lowest?.warehouseNumber ?? null,
      notSoldOnline,
      priceDropped,
      checkedAt: new Date().toISOString(),
    });
    const status = notSoldOnline ? "not sold on costco.com" : currentPrice != null ? `$${currentPrice.toFixed(2)}${priceDropped ? "  ** DROPPED **" : ""}` : "no match found";
    console.log(`  ${item.itemNumber}  ${item.description.slice(0, 35).padEnd(35)}  paid $${item.pricePaid.toFixed(2)}  ->  ${status}`);
    // A short, slightly randomized pause between lookups -- not aggressive scraping, just
    // courteous pacing against someone's own real warehouse search while logged in.
    await page.waitForTimeout(800 + Math.random() * 700);
  }

  writeFileSync(join(CAPTURES_DIR, "price-checks.json"), JSON.stringify(results, null, 2));
  const drops = results.filter((r) => r.priceDropped);
  const notSoldOnline = results.filter((r) => r.notSoldOnline);
  const noMatch = results.filter((r) => !r.notSoldOnline && r.currentPrice == null);
  console.log(`\n${drops.length} of ${results.length} item(s) show a lower current price.`);
  if (notSoldOnline.length) console.log(`${notSoldOnline.length} item(s) aren't sold on costco.com at all (warehouse-only) -- can't be checked this way.`);
  if (noMatch.length) console.log(`${noMatch.length} item(s) had no clean single-product match -- check .captures/price-checks/<itemNumber>.json for the raw response.`);
  console.log(`\nSaved: ${join(CAPTURES_DIR, "price-checks.json")}`);

  await browser.close();
}

main();
