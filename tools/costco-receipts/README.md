# Costco Receipt Capture (price-match watchlist, Phase 1)

Goal: know which Costco purchases are still inside the 30-day (sometimes longer, e.g. TVs)
price-adjustment window, and what's currently price-matchable, so nothing gets missed.

This app has no itemized purchase data today -- Day Book only has voucher totals like
"Shopping @ Costco -- $363.01", not item names/prices. Getting item-level data means pulling it
from Costco's own Order & Purchase History, and Costco has no public API for that -- so this tool
watches a real browser session to capture it.

Two ways to do that -- **use `attach.mjs` (Method A) first.** `capture.mjs` (Method B) was the
original approach and is kept for reference, but Costco's own bot detection blocked it live
(login silently did nothing in the Playwright-launched window, even though the same ID/password
worked fine in a normal browser) -- a freshly-automated browser gets flagged even with nothing
scripted beyond opening it.

## Method A -- attach to your real Chrome (recommended, use this)

No automation drives anything here -- every click and keystroke is genuinely you, in your own
Chrome, already logged into Costco from however you normally browse. This script only listens to
network responses over Chrome's remote debugging protocol; Costco has nothing to flag as a bot
because nothing is acting like one.

**Setup (one time):**
```bash
cd tools/costco-receipts
npm install
```
(no `playwright install chromium` needed for this method -- it attaches to your existing Chrome
install, not a Playwright-managed one)

**Each time you want a capture:**
1. Fully quit Chrome -- check Task Manager too; a background Chrome process will block the next
   step from attaching to your real profile.
2. Launch Chrome with remote debugging enabled, using your real profile (so you're already logged
   into everything, Costco included, if you normally stay logged in):
   ```bash
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\dikhatri\AppData\Local\Google\Chrome\User Data"
   ```
3. In that Chrome window, go to costco.com, log in normally if needed, and navigate to
   **Order & Purchase History / Digital Receipts**. Click into a few real orders so the
   itemized detail (not just the order summary list) actually loads.
4. In a separate terminal, run:
   ```bash
   npm run attach -- --label=dignesh
   ```
   (`--label` is just for naming the output folder -- use `--label=hiral` for the other account;
   since this is just watching whatever's logged into that Chrome window, log out/in as the other
   person in the same window between captures, or use Chrome's own "Add person" profile switcher)
5. Keep browsing in the Chrome window -- every JSON response it loads is captured automatically.
6. Come back to the terminal and press Enter when done. This only disconnects the capture
   listener -- your Chrome window stays open.

## Method B -- Playwright-managed browser (fallback, likely blocked by Costco)

```bash
npx playwright install chromium   # one-time, only needed for this method
npm run capture -- --profile=dignesh
```

A Chromium window opens to Costco's order history page and you log in there -- see
`capture.mjs`'s own header comment for details. Kept in case Method A isn't workable for some
reason, but expect Costco's bot detection to interfere with actually logging in.

## Output

Both methods write to `.captures/<name>/<timestamp>/` -- one `.json` file per captured API
response (`capture.mjs` also adds a `page.html` fallback snapshot). `.profiles/` (session
cookies, Method B only) and `.captures/` (real purchase data) are both gitignored and must never
be committed.

## Next step (Phase 2, not built yet)

Once a real capture exists:
1. Read the captured JSON to find the actual item/price/purchase-date fields Costco's API
   returns.
2. Write a parser turning that into a clean itemized-purchase list (item name, price paid,
   purchase date, warehouse vs. costco.com).
3. Add a "Costco Price Match Watchlist" view (likely alongside the existing Costco Executive 2%
   Reward section in Spend Report -- `components/reports/SpendReport.tsx`) showing items still
   inside their 30/90-day adjustment window.
4. Current-price lookups for watchlist items still need to happen live (per item, when you ask) --
   there's no way to keep re-checking Costco's current pricing in the background from within this
   app either.
