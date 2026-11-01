#!/usr/bin/env node
// Automated, zero-click refresh -- safe to run unattended/on a schedule. Navigates the debug
// Chrome's existing, already-logged-in session directly to your real Amex Benefits pages (plain
// page loads, the SAME thing ../costco-receipts/auto-capture.mjs already does against Costco's
// own order-history page) and captures whatever JSON responses load, same filter as attach.mjs.
//
// Deliberately does NOT automate logging in -- no username/password typed, none stored anywhere.
// This only works because the debug Chrome profile stays signed into americanexpress.com between
// runs, same as it already does for Costco. When Amex eventually signs that session out (normal
// session expiry, a security check), this will simply capture 0 real trackers that run -- logged
// clearly, not silently -- and needs a human to open the debug Chrome and log in again before the
// next scheduled run picks back up. That's an intentional limit, not a bug: automating the actual
// login flow would mean storing Amex credentials somewhere AND looks exactly like the kind of bot
// behavior card-issuer fraud detection exists to catch, for very little benefit over just logging
// in by hand once in a while.
//
// Usage (debug Chrome must already be running -- run-scheduled.ps1 launches it if not):
//   node auto-capture.mjs

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURES_DIR = join(__dirname, ".captures");

// Both real pages the user confirmed showing their actual benefit trackers -- visited every run
// since it's unclear ahead of time which one (or both) fires the tracker API call, and visiting
// both costs only two extra page loads.
const BENEFITS_URLS = [
  "https://global.americanexpress.com/card-benefits/view-all",
  "https://global.americanexpress.com/card-benefits/activity",
];

const captureDir = join(CAPTURES_DIR, new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(captureDir, { recursive: true });

let seq = 0;
function wireUp(page) {
  page.on("response", async (res) => {
    try {
      if (!/(^|\.)americanexpress\.com$/i.test(new URL(res.url()).hostname)) return;
      const contentType = res.headers()["content-type"] || "";
      if (!contentType.includes("application/json")) return;
      const body = await res.json().catch(() => null);
      if (!body) return;
      seq += 1;
      writeFileSync(join(captureDir, `${String(seq).padStart(4, "0")}.json`), JSON.stringify({ url: res.url(), status: res.status(), body }, null, 2));
    } catch {
      // Not every response matters (fonts, analytics, ads) -- a skip here is expected.
    }
  });
}

async function main() {
  let browser;
  try {
    browser = await chromium.connectOverCDP("http://localhost:9222");
  } catch {
    console.error("Couldn't connect to Chrome on port 9222 -- is the debug Chrome running?");
    process.exit(1);
  }
  const context = browser.contexts()[0];
  if (!context) {
    console.error("Chrome is running, but no browser window/tab was found to attach to.");
    process.exit(1);
  }

  for (const page of context.pages()) wireUp(page);
  context.on("page", wireUp);

  // Reuses whichever tab is already open rather than opening a new one every run, same reasoning
  // as Costco's own auto-capture.mjs.
  const page = context.pages()[0] ?? (await context.newPage());
  for (const url of BENEFITS_URLS) {
    // "networkidle" is NOT used here -- confirmed live this page keeps a persistent background
    // beacon/chat-widget poll running (contact_management/chats, loyalty/observability/beacon in
    // real captures), which networkidle waits forever for and reliably times out on. "load" plus
    // a fixed settle window is what actually works: the tracker/catalog API calls fire within a
    // couple seconds of the page becoming interactive, well before "networkidle" would ever fire.
    await page.goto(url, { waitUntil: "load", timeout: 20000 }).catch((e) => {
      console.error(`Navigation to ${url} failed or timed out: ${e.message}`);
    });
    await page.waitForTimeout(4000);
  }

  await browser.close(); // only detaches the CDP connection -- does NOT close the real Chrome window.
  console.log(`Captured ${seq} JSON response(s) to:\n  ${captureDir}`);
  if (seq === 0) {
    console.log("0 responses captured -- the debug Chrome's Amex session may have signed out. Log in again manually, then re-run.");
  }
}

main();
