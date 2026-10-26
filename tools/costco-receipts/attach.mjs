#!/usr/bin/env node
// Alternative to capture.mjs -- attaches to a real Chrome window YOU launch and log into
// yourself, instead of driving a fresh Playwright-managed browser. Costco's own bot detection
// (confirmed live: login silently did nothing in the Playwright-launched window, even though it
// accepted the same ID/password in a normal browser) flags a freshly-automated browser even
// without typing/clicking being scripted -- but it has nothing to flag here, because every
// click and keystroke is really coming from you in your own Chrome. This script only listens to
// network responses over Chrome's remote debugging protocol; it never drives the page at all.
//
// Setup (do this once per capture session):
//   1. Fully quit Chrome -- check Task Manager too, a background Chrome process will block this.
//   2. Launch Chrome with remote debugging enabled, using YOUR real profile (so you're already
//      logged into everything, Costco included, if you normally stay logged in):
//
//        "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\dikhatri\AppData\Local\Google\Chrome\User Data"
//
//   3. In that Chrome window, go to costco.com, log in if needed (normally -- no automation
//      involved), and navigate to Order & Purchase History / Digital Receipts.
//   4. Run this script -- it attaches to that already-open Chrome and starts capturing.
//
// Usage:
//   npm run attach -- --label=dignesh

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

const label = arg("label", "capture");
if (!/^[a-z0-9_-]+$/i.test(label)) {
  console.error("Usage: npm run attach -- --label=<name>   (letters/numbers/-/_ only, e.g. --label=dignesh)");
  process.exit(1);
}

const captureDir = join(__dirname, ".captures", label, new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(captureDir, { recursive: true });

let seq = 0;
function wireUp(page) {
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
    console.error("Make sure you fully quit Chrome first, then relaunched it with:");
    console.error(
      '  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\Users\\dikhatri\\AppData\\Local\\Google\\Chrome\\User Data"\n'
    );
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error("Chrome is running, but no browser window/tab was found to attach to.");
    process.exit(1);
  }

  // Wire up every tab already open, AND any new tab opened later (e.g. clicking a link that
  // opens a new tab, or navigating to a different page in the same tab still fires on the same
  // page object so this isn't strictly needed for that case, but covers new-tab navigation too).
  for (const page of context.pages()) wireUp(page);
  context.on("page", wireUp);

  console.log("");
  console.log(`Attached to your Chrome window (label: ${label}).`);
  console.log("Browse to Order & Purchase History / Digital Receipts and click into a few real");
  console.log("orders yourself, normally -- every JSON response that loads is captured automatically");
  console.log("in the background as you go.");
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter when finished browsing... ");
  rl.close();

  await browser.close(); // only detaches the CDP connection -- does NOT close your Chrome window.
  console.log(`\nDone. Saved ${seq} JSON response(s) to:\n  ${captureDir}`);
}

main();
