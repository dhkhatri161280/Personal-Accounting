#!/usr/bin/env node
// Costco purchase-history capture tool -- Phase 1 of the price-match watchlist feature.
//
// Logs into Costco.com under a persistent, per-person browser profile. You log in by hand once
// (including any 2FA/MFA Costco asks for); the profile folder keeps that session, so your
// Costco password is never typed into, read by, or stored by this script -- there is nothing in
// here that handles credentials at all. Every run after the first should already show you
// logged in, same as reopening a browser tab you never closed, unless Costco itself forces a
// re-login.
//
// While you browse Order & Purchase History / Digital Receipts, this records every JSON API
// response the page loads, plus a full-page HTML snapshot as a fallback -- order-history pages
// are almost always backed by an internal JSON API, so capturing those responses verbatim is far
// more reliable than guessing CSS selectors against a page layout Costco can change at any time.
//
// This script deliberately does NOT try to parse the captures into itemized purchases itself --
// nobody has seen the real shape of Costco's response JSON yet. Run this once, then hand the
// .captures folder to Claude (or whoever's building the parser) to look at real data and write
// the actual item/price/date extraction logic against it, instead of guessing blind.
//
// Usage:
//   npm install              (first time only)
//   npx playwright install chromium   (first time only -- downloads the browser binary)
//   npm run capture -- --profile=dignesh
//   npm run capture -- --profile=hiral
//
// Each profile is fully separate (its own browser profile folder, its own captures folder) --
// use a different --profile name per Costco account.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const profile = arg("profile", "");
if (!profile || !/^[a-z0-9_-]+$/i.test(profile)) {
  console.error("Usage: npm run capture -- --profile=<name>   (letters/numbers/-/_ only, e.g. --profile=dignesh)");
  process.exit(1);
}

const profileDir = join(__dirname, ".profiles", profile);
const captureDir = join(__dirname, ".captures", profile, new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(profileDir, { recursive: true });
mkdirSync(captureDir, { recursive: true });

let seq = 0;

async function main() {
  const context = await chromium.launchPersistentContext(profileDir, {
    // Headless browsers are far more likely to get flagged by Costco's own bot detection than a
    // real, visible browser window -- this is meant to look exactly like you browsing normally.
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  page.on("response", async (res) => {
    try {
      const contentType = res.headers()["content-type"] || "";
      if (!contentType.includes("application/json")) return;
      const body = await res.json().catch(() => null);
      if (!body) return;
      seq += 1;
      const file = join(captureDir, `${String(seq).padStart(4, "0")}.json`);
      writeFileSync(file, JSON.stringify({ url: res.url(), status: res.status(), body }, null, 2));
      console.log(`captured: ${res.url()}`);
    } catch {
      // Response body already consumed, or genuinely not JSON -- not every response on the page
      // matters (fonts, analytics, ads), so a skip here is expected, not an error.
    }
  });

  await page
    .goto("https://www.costco.com/myaccount/orderhistory/view-orders", { waitUntil: "domcontentloaded" })
    .catch(() => {
      // Costco may redirect to a login page instead -- fine, the instructions below cover that.
    });

  console.log("");
  console.log(`Profile: ${profile}`);
  console.log("A real browser window just opened.");
  console.log("  1. Log in if you're not already (including any 2FA/MFA Costco asks for).");
  console.log("  2. Go to Order & Purchase History / Digital Receipts.");
  console.log("  3. Scroll / page through as much history as you want captured -- every page it");
  console.log("     loads is saved automatically in the background as you go.");
  console.log("  4. Come back to this window and press Enter when you're done.");
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter when finished browsing... ");
  rl.close();

  try {
    const html = await page.content();
    writeFileSync(join(captureDir, "page.html"), html);
  } catch {
    // Page may already be closed/navigated away by the time we get here -- the JSON captures
    // above are the primary artifact, so a missing HTML fallback isn't fatal.
  }

  await context.close();
  console.log(`\nDone. Saved ${seq} JSON response(s) to:\n  ${captureDir}`);
}

main();
