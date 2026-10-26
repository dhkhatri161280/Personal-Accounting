#!/usr/bin/env node
// Automated live price check against Costco's own site, driven straight through the already-
// authenticated debug Chrome (attach.mjs's same connectOverCDP pattern) -- no manual clicking.
// For every item still inside the price-adjustment window (.captures/watchlist.json), this
// navigates Costco's own site search for that exact item number, captures whatever JSON API
// response(s) load, and makes a best-effort attempt to pull a current price out of them.
//
// TWO real price sources, confirmed against real runs (2026-10-25/26):
//   1. gdx-api.costco.com/.../search's own `inventoryResponse` array -- carries a REAL distinct
//      warehousePrice (the actual in-store/pickup price at the account's "My Warehouse") AND a
//      separate deliveryPrice (online/ship-to-home, which can legitimately differ). This is the
//      one that answers "what would I actually pay walking into the store" -- always preferred.
//   2. gdx-api.costco.com/.../display-price-lite -- only fires when a search lands on exactly one
//      product; its onlinePrice/deliveredPrice fields are confirmed ONLINE pricing, not a true
//      warehouse price. Used only as a fallback when source 1 has nothing.
// CRITICAL caveat, confirmed live: warehousePrice is keyed to whichever physical warehouse the
// Costco ACCOUNT's own "My Warehouse" setting points to (the search response's own
// `myWarehouse.locationId`, e.g. "1062-wh") -- not the item's real purchase warehouse, and not
// configurable per-request from this script. If that account setting doesn't match where the
// user actually shops (confirmed live: it was pointed at a Manhattan warehouse while real
// purchases were at Fremont/Newark, CA), warehousePrice reflects the WRONG store's inventory and
// pricing. Fix this once in the Costco account/app ("My Warehouse" / nearby club setting) before
// trusting a comparison -- this script has no way to detect or correct that mismatch itself.
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

// Pulls the real current price out of a captured display-price-lite response (fires only when a
// search lands on exactly one product). This endpoint's fields are onlinePrice/deliveredPrice --
// confirmed to be online/delivery pricing, not a distinct in-warehouse price (see
// extractFromSearchResponse below for the endpoint that DOES carry real warehouse pricing) --
// always tagged priceSource "online" here.
function extractFromDisplayPriceLite(body) {
  const out = [];
  for (const p of body?.priceData ?? []) {
    for (const dp of p.displayPrice ?? []) {
      const price = dp.onlinePrice ?? dp.deliveredPrice;
      if (typeof price === "number" && price > 0) out.push({ price, priceSource: "online", warehouseLocationId: null });
    }
  }
  return out;
}
function findDisplayPriceResponse(captured) {
  return captured.find((c) => c.url.includes("display-price-lite"));
}
function findSearchResponse(captured) {
  return captured.find((c) => c.url.includes("/catalog/search/api/v1/search"));
}
function searchReturnedNoResults(captured) {
  return findSearchResponse(captured)?.body?.searchResult?.totalSize === 0;
}

// The real source of TRUE warehouse pricing -- confirmed live against a real item (search
// response's own `inventoryResponse` array, matched to a `searchResult.results` entry by
// `productId === result.id`). Each inventoryResponse entry carries BOTH a `warehousePrice` (the
// actual in-store/pickup price at the account's own "My Warehouse" -- null when that warehouse
// doesn't stock the item) and a `deliveryPrice` (ship-to-home/online price, which can legitimately
// differ from the in-store price) -- this always prefers warehousePrice when present, only
// falling back to deliveryPrice (tagged priceSource "online") when Costco itself has no
// warehouse-specific price to give. `myWarehouse.locationId` in the same response (e.g. "1062-wh")
// identifies WHICH physical warehouse that warehousePrice is actually for -- callers should
// confirm this is the user's real shopping warehouse before trusting a comparison, since an
// account whose "My Warehouse" setting points somewhere else will only ever return pricing for
// that other store.
//
// Matching rule, confirmed live against two failure modes:
//   - totalSize > 1 (genuinely ambiguous, e.g. a sneaker's Men's/Women's colorways): REQUIRE an
//     exact tag match on `product.attributes.marketing_keywords.text` -- loosening this to
//     "closest" or "lowest of all results" produced real false positives (a grapes search
//     matching an unrelated $14.97 product, a CRV/bottle-deposit line matching a random $4.97
//     item). No exact tag match here means genuinely no match -- never guess at a substitute.
//   - totalSize === 1 (confirmed live: Kirkland A2 milk, item 1462714): the lone result is
//     trusted even WITHOUT an exact tag match, since marketing_keywords is sometimes simply
//     absent from Costco's own data for a product -- but with only one possible candidate, there
//     is no ambiguity to guard against in the first place, so demanding the tag here only
//     discarded real, unambiguous warehouse-price data for no safety benefit.
function extractFromSearchResponse(searchBody, itemNumber) {
  const results = searchBody?.searchResult?.results ?? [];
  const inventoryById = new Map((searchBody?.inventoryResponse ?? []).map((inv) => [inv.productId, inv]));
  const matching =
    searchBody?.searchResult?.totalSize === 1 && results.length === 1
      ? results
      : results.filter((r) => r.product?.attributes?.marketing_keywords?.text?.includes(itemNumber));
  const out = [];
  for (const r of matching) {
    const inv = inventoryById.get(r.id);
    if (!inv) continue;
    const whPrice = Number(inv.warehousePrice?.minPrice);
    const dlPrice = Number(inv.deliveryPrice?.minPrice);
    if (Number.isFinite(whPrice) && whPrice > 0) {
      out.push({ price: whPrice, priceSource: "warehouse", warehouseLocationId: searchBody?.myWarehouse?.locationId ?? null });
    } else if (Number.isFinite(dlPrice) && dlPrice > 0) {
      out.push({ price: dlPrice, priceSource: "online", warehouseLocationId: null });
    }
  }
  return out;
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

    const searchResponse = findSearchResponse(captured);
    const priceResponse = findDisplayPriceResponse(captured);
    // Combine both sources -- the search response's inventoryResponse (true warehouse pricing,
    // when the item is stocked at "My Warehouse") takes priority over display-price-lite (always
    // online/delivery pricing), never the other way around.
    const searchPrices = searchResponse ? extractFromSearchResponse(searchResponse.body, item.itemNumber) : [];
    const displayPrices = priceResponse ? extractFromDisplayPriceLite(priceResponse.body) : [];
    const warehousePrices = searchPrices.filter((p) => p.priceSource === "warehouse");
    const onlinePrices = [...searchPrices.filter((p) => p.priceSource === "online"), ...displayPrices];
    const pool = warehousePrices.length ? warehousePrices : onlinePrices;
    const best = pool.length ? pool.reduce((a, b) => (b.price < a.price ? b : a)) : null;
    const notSoldOnline = !searchPrices.length && !displayPrices.length && searchReturnedNoResults(captured);
    const currentPrice = best?.price ?? null;
    const priceDropped = currentPrice != null && currentPrice < item.pricePaid - 0.005;
    results.push({
      itemNumber: item.itemNumber,
      description: item.description,
      pricePaid: item.pricePaid,
      currentPrice,
      priceSource: best?.priceSource ?? null,
      currentPriceWarehouse: best?.warehouseLocationId ?? null,
      notSoldOnline,
      priceDropped,
      checkedAt: new Date().toISOString(),
    });
    const status = notSoldOnline
      ? "not sold on costco.com"
      : currentPrice != null
        ? `$${currentPrice.toFixed(2)} (${best.priceSource})${priceDropped ? "  ** DROPPED **" : ""}`
        : "no match found";
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
