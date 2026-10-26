# Costco Receipt Capture (price-match watchlist, Phase 1)

Goal: know which Costco purchases are still inside the 30-day (sometimes longer, e.g. TVs)
price-adjustment window, and what's currently price-matchable, so nothing gets missed.

This app has no itemized purchase data today -- Day Book only has voucher totals like
"Shopping @ Costco -- $363.01", not item names/prices. Getting item-level data means pulling it
from Costco's own Order & Purchase History, and Costco has no public API for that -- so this tool
drives a real browser under your own login to capture it.

## What this does -- and does NOT do

- **Does not handle your password at all.** `capture.mjs` never asks for or stores a Costco
  password. It opens a real, visible Chromium window under a persistent browser profile; you log
  in by hand (including any 2FA/MFA), the same as any normal browser tab. After that, the profile
  folder (`.profiles/<name>/`) keeps the session, so later runs should already be logged in.
- **Does not scrape by CSS selector.** Order-history pages are almost always backed by an
  internal JSON API. This just records every JSON response the page loads while you browse it --
  far more robust than guessing at a page layout that can change any time, and it means the
  captured data is already structured.
- **Does not parse the captures into itemized purchases yet.** Nobody (me included) has seen the
  real shape of Costco's response JSON. This is deliberately just the capture step -- once you've
  run it, share the `.captures/<profile>/<timestamp>/` folder (or just tell me it's ready to
  read, since it's a local file I can open) and the actual item/price/date parser gets built
  against real data instead of guessed blind.
- **Runs on your machine, under your login, at your own pace.** It is not scheduled or automatic
  by default -- run it whenever you want a fresh capture (e.g. after a Costco trip). If you later
  want it on a schedule, `tools/excel-sync/run-scheduled.ps1` + `silent-launch.vbs` is this repo's
  existing pattern for that (Windows Task Scheduler running a script silently) -- can be adapted
  here once Phase 2's parser exists and there's something worth scheduling.

## Setup (one time)

```bash
cd tools/costco-receipts
npm install
npx playwright install chromium
```

## Running it

```bash
npm run capture -- --profile=dignesh
```

(or `--profile=hiral` / any name you want, for the other Costco account -- each profile is fully
separate: its own browser profile, its own capture folder, no credential overlap between the two)

A Chromium window opens to Costco's order history page:
1. Log in if you're not already (including 2FA/MFA Costco asks for).
2. Go to Order & Purchase History / Digital Receipts.
3. Scroll / page through as much history as you want captured -- everything it loads is saved
   automatically in the background.
4. Come back to the terminal and press Enter when you're done.

Output lands in `.captures/<profile>/<timestamp>/` -- one `.json` file per captured API response,
plus a `page.html` fallback snapshot. Both `.profiles/` (session cookies) and `.captures/` (real
purchase data) are gitignored and must never be committed.

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
