#!/usr/bin/env node
// Attaches to the SAME debug Chrome already set up for ../costco-receipts (same
// --remote-debugging-port=9222, same --user-data-dir="C:\Users\dikhatri\ChromeDebugProfile") --
// no separate browser/profile needed. Only ever listens to network responses over Chrome's remote
// debugging protocol; it never drives the page, clicks anything, or types anything -- every click
// and keystroke browsing your real Amex account is genuinely yours, so there's nothing for Amex's
// own bot detection to flag (same reasoning as costco-receipts/attach.mjs, which this is a direct
// copy of the mechanism of).
//
// Setup (do this once per capture session):
//   1. Launch the debug Chrome if it isn't already running (same command as costco-receipts):
//        "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\dikhatri\ChromeDebugProfile"
//   2. In that window, go to americanexpress.com and log in (normally -- no automation involved)
//      if you aren't already. Navigate to your account's Benefits page (sometimes called "Your
//      Benefits", "Benefits Overview", or similar -- wherever Amex shows your Platinum Card's
//      individual credits and how much of each you've used).
//   3. Run this script -- it attaches to that already-open Chrome and starts capturing every JSON
//      response that loads as you browse.
//
// Usage:
//   npm run attach
//
// This is phase 1 only: it captures the RAW responses so we can see Amex's real data shape before
// writing a parser (see this folder's README -- guessing field names instead of reading real
// captured JSON first is exactly the mistake this app's own tooling has learned not to make,
// confirmed repeatedly in tools/costco-receipts' own history).

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

const captureDir = join(__dirname, ".captures", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(captureDir, { recursive: true });

let seq = 0;
function wireUp(page) {
  page.on("response", async (res) => {
    try {
      // Scoped to americanexpress.com only -- the shared debug Chrome may have other tabs open
      // (Costco, anything else), and this tool only wants Amex's own data.
      if (!/(^|\.)americanexpress\.com$/i.test(new URL(res.url()).hostname)) return;
      const contentType = res.headers()["content-type"] || "";
      if (!contentType.includes("application/json")) return;
      const body = await res.json().catch(() => null);
      if (!body) return;
      seq += 1;
      const file = join(captureDir, `${String(seq).padStart(4, "0")}.json`);
      writeFileSync(file, JSON.stringify({ url: res.url(), status: res.status(), body }, null, 2));
      console.log(`captured: ${res.url()}`);
    } catch {
      // Not every response matters (fonts, analytics, ads) -- a skip here is expected.
    }
  });
}

async function main() {
  let browser;
  try {
    browser = await chromium.connectOverCDP("http://localhost:9222");
  } catch (err) {
    console.error("\nCouldn't connect to Chrome on port 9222.");
    console.error("Launch the debug Chrome first (same one costco-receipts uses):");
    console.error(
      '  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\Users\\dikhatri\\ChromeDebugProfile"\n'
    );
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error("Chrome is running, but no browser window/tab was found to attach to.");
    process.exit(1);
  }

  for (const page of context.pages()) wireUp(page);
  context.on("page", wireUp);

  console.log("");
  console.log("Attached to your Chrome window.");
  console.log("Go to americanexpress.com, log in if needed, and browse to your Benefits page --");
  console.log("every JSON response Amex's own site loads is captured automatically in the background.");
  console.log("Click into a few individual benefits too, if the page shows more detail on click.");
  console.log("");

  // Two ways to stop: press Enter in an interactive terminal, OR (when run in the background with
  // no real stdin to wait on) create a ".captures/STOP" file -- polled every second.
  const stopFile = join(__dirname, ".captures", "STOP");
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter when finished browsing... ");
    rl.close();
  } else {
    console.log(`(non-interactive -- create "${stopFile}" to stop capturing)`);
    while (!existsSync(stopFile)) await new Promise((r) => setTimeout(r, 1000));
    rmSync(stopFile, { force: true });
  }

  await browser.close(); // only detaches the CDP connection -- does NOT close your Chrome window.
  console.log(`\nDone. Saved ${seq} JSON response(s) to:\n  ${captureDir}`);
}

main();
