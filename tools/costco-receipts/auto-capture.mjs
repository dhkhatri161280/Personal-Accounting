#!/usr/bin/env node
// Automated receipt-LIST discovery -- zero clicking, safe to run unattended/on a schedule.
// Calls Costco's own GraphQL "list" query directly (receiptsWithCounts with
// startDate/endDate/documentType/documentSubType), the same one the Order & Purchase History
// page itself fires on load. Returns every receipt's identifying fields (date, warehouse, total,
// barcode) across the requested range -- NOT itemized detail (item names/prices).
//
// Itemized DETAIL per receipt (what "View Receipt" shows) is NOT auto-fetched here, on purpose.
// Costco protects that endpoint with Kasada, an anti-bot system that issues a fresh
// cryptographic token per request -- replaying a captured token for a different request gets
// flatly rejected (confirmed live: 116/116 detail calls returned 400 when attempted this way).
// That's Costco's security working as intended; this script doesn't try to defeat it. Full
// itemized detail still needs a real, human-driven "View Receipt" click per receipt -- see
// attach.mjs/README.md. What THIS script is for: telling you exactly which RECENT receipts
// (inside the 30-day price-match window) still need that click, so you're not guessing or
// clicking through the whole history every time, and so a scheduled run can flag new activity
// with no manual steps and no risk of looking like bulk/bot access.
//
// Usage (debug Chrome must already be open, on any costco.com page -- same one attach.mjs uses):
//   node auto-capture.mjs --label=dignesh [--months=24] [--recentDays=35]

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURES_DIR = join(__dirname, ".captures");
const GRAPHQL_URL = "https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const label = arg("label", "");
const months = Number(arg("months", "24"));
const recentDays = Number(arg("recentDays", "35")); // a few days past the 30-day window as buffer
if (!label || !/^[a-z0-9_-]+$/i.test(label)) {
  console.error("Usage: node auto-capture.mjs --label=<name> [--months=24] [--recentDays=35]   (letters/numbers/-/_ only)");
  process.exit(1);
}

// Costco's own date format, confirmed from a real captured request: "M/DD/YYYY" -- month NOT
// zero-padded, day IS (e.g. "8/01/2026", "10/31/2026").
function costcoDate(d) {
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

// Headers a browser's own fetch() sets itself (and errors on if a caller tries to override), or
// that only make sense for the request they were captured from -- stripped out, keeping only the
// custom/application headers (auth tokens, client/correlation ids) actually worth replaying for
// a request to the SAME endpoint with the SAME general shape (the list query only -- this does
// NOT attempt the per-receipt detail call the Kasada token wouldn't survive anyway).
const SKIP_HEADERS = new Set(["host", "content-length", "connection", "cookie", "origin", "referer", "accept-encoding", ":authority", ":method", ":path", ":scheme"]);

// Captures the auth header(s) Costco's OWN page attaches to its own list-query request, entirely
// inside the browser via Playwright's request listener -- held only in this script's own local
// variable for the rest of this run, never printed, never written to disk. It's the same
// credential the browser already legitimately holds for this already-authenticated session; this
// just lets that same session reuse it for a request this script issues instead of a page load.
async function primeAuthHeaders(page) {
  let captured = null;
  const onRequest = (req) => {
    if (captured || !req.url().includes(GRAPHQL_URL)) return;
    const h = req.headers();
    captured = Object.fromEntries(Object.entries(h).filter(([k]) => !SKIP_HEADERS.has(k.toLowerCase())));
  };
  page.on("request", onRequest);
  await page.goto("https://www.costco.com/myaccount/orderhistory/view-orders", { waitUntil: "networkidle" }).catch(() => {});
  for (let i = 0; i < 20 && !captured; i++) await page.waitForTimeout(250);
  page.off("request", onRequest);
  return captured;
}

async function graphql(page, authHeaders, query, variables) {
  return page.evaluate(
    async ({ url, authHeaders, query, variables }) => {
      const headers = { "Content-Type": "application/json", ...(authHeaders || {}) };
      const res = await fetch(url, { method: "POST", headers, credentials: "include", body: JSON.stringify({ query, variables }) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { url: GRAPHQL_URL, authHeaders, query, variables }
  );
}

const LIST_QUERY = `query receiptsWithCounts($startDate: String!, $endDate: String!,$documentType:String!,$documentSubType:String!) {
    receiptsWithCounts(startDate: $startDate, endDate: $endDate,documentType:$documentType,documentSubType:$documentSubType) {
    inWarehouse
    gasStation
    carWash
    gasAndCarWash
    receipts{
    warehouseName receiptType  documentType transactionDateTime transactionBarcode warehouseName transactionType total
    totalItemCount
  }
}
  }`;

function* walkJsonFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkJsonFiles(full);
    else if (name.endsWith(".json")) yield full;
  }
}

// Receipts we already have full ITEM detail for, by transactionBarcode -- Costco's own canonical
// identity for a receipt. Scanned straight from the raw capture files under .captures/<label>/
// (not receipts.json, which keys by a different composite field -- warehouse/register/transaction
// number/date -- built by parse.mjs, and never carries transactionBarcode through at all) so this
// works even before parse.mjs/import has run on a given capture.
function knownBarcodes() {
  const dir = join(CAPTURES_DIR, label);
  if (!existsSync(dir)) return new Set();
  const barcodes = new Set();
  for (const file of walkJsonFiles(dir)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const r of parsed?.body?.data?.receiptsWithCounts?.receipts ?? []) {
      if (r.transactionBarcode && r.itemArray?.some((i) => i.itemDescription01 != null)) barcodes.add(r.transactionBarcode);
    }
  }
  return barcodes;
}

async function main() {
  let browser;
  try {
    browser = await chromium.connectOverCDP("http://localhost:9222");
  } catch {
    console.error("\nCouldn't connect to Chrome on port 9222 -- make sure the debug Chrome window is open:");
    console.error('  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\Users\\dikhatri\\ChromeDebugProfile"');
    process.exit(1);
  }
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().includes("costco.com")) ?? (await context.newPage());

  console.log("Priming auth (loading Order History once to capture how it authenticates itself)...");
  const authHeaders = await primeAuthHeaders(page);
  // Diagnostic only -- WHICH header NAMES were captured (never values -- a name like
  // "x-api-key" isn't itself sensitive), so a failure here is visible without ever printing
  // credential material.
  console.log("Captured header names:", authHeaders ? Object.keys(authHeaders).join(", ") : "(none captured)");
  if (!authHeaders) {
    console.error("Couldn't capture auth headers -- make sure you're logged into costco.com in this Chrome session.");
    await browser.close();
    process.exit(1);
  }

  const today = new Date();
  const start = new Date(today);
  start.setMonth(start.getMonth() - months);
  const variables = { startDate: costcoDate(start), endDate: costcoDate(today), documentType: "all", documentSubType: "all" };
  console.log(`Fetching order list from ${variables.startDate} to ${variables.endDate}...`);

  const listResult = await graphql(page, authHeaders, LIST_QUERY, variables);
  const receipts = listResult.body?.data?.receiptsWithCounts?.receipts ?? [];
  await browser.close();

  if (!receipts.length) {
    console.log("No receipts found in that date range. (Status:", listResult.status, ")");
    if (listResult.body?.errors) console.log(JSON.stringify(listResult.body.errors, null, 2));
    return;
  }

  const captureDir = join(CAPTURES_DIR, label, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(join(captureDir, "0000-list.json"), JSON.stringify({ url: GRAPHQL_URL, body: listResult.body }, null, 2));
  console.log(`Found ${receipts.length} receipt(s). Saved to: ${captureDir}`);

  // The actual payoff: tell the user exactly which RECENT (price-match-window) receipts still
  // need a manual "View Receipt" click for item detail -- not the whole history, just what's
  // actually still actionable.
  const known = knownBarcodes();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - recentDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const needsDetail = receipts.filter((r) => {
    const date = (r.transactionDateTime || "").slice(0, 10);
    return date >= cutoffStr && !/gas/i.test(r.receiptType || "") && !known.has(r.transactionBarcode);
  });

  if (needsDetail.length === 0) {
    console.log(`\nNothing new -- every In-Warehouse/Online receipt from the last ${recentDays} days already has item detail on file.`);
  } else {
    console.log(`\n${needsDetail.length} recent receipt(s) still need a "View Receipt" click for item detail:`);
    for (const r of needsDetail.sort((a, b) => (a.transactionDateTime < b.transactionDateTime ? 1 : -1))) {
      console.log(`  ${r.transactionDateTime?.slice(0, 10)}  ${r.warehouseName.padEnd(12)}  ${r.receiptType.padEnd(14)}  $${r.total}`);
    }
    console.log(`\nOpen Order & Purchase History and click into just these -- then run: node parse.mjs`);
  }
}

main();
