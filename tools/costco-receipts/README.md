# Costco Receipt Capture & Price Match Watchlist (retired)

This tool, and the app features it fed, were retired on 2026-11-12 at the user's explicit
request -- decommissioned the same way `tools/amex-benefits/`'s earlier debug-Chrome automation
was, but for a different reason: Amex's automation got replaced by a better (Plaid-based)
approach; this one has no replacement, because none is possible.

## Why this couldn't be made easier

Costco has no public API. Unlike a bank (Plaid) or Amex (its own account API), there is no
official, sanctioned way to pull a Costco purchase history programmatically -- the only way in
was driving a real, logged-in Chrome session through Costco's own website.

Worse: itemized receipt DETAIL (what you actually bought, not just a trip total) is actively
blocked from automation by Costco's own anti-bot protection (Kasada), which issues a fresh
cryptographic challenge per request that only resolves from genuine, human-driven browser
interaction -- confirmed live, every attempt to script around it was flatly rejected. The only
way to get item-level detail was clicking "View Receipt" on every purchase, by hand, forever.
Even the list-level discovery (which *was* fully automatable) still needed a dedicated, already
logged-in Chrome window kept around just for it.

Asked to weigh that ongoing manual burden against what it bought -- a cross-check on the
Executive 2% Reward estimate (which already works, less precisely, from voucher narration alone
with zero manual effort) and a Price Match Watchlist -- the user decided it wasn't worth it.
That's a reasonable call, not a failure of the tooling: this is a case where the honest answer is
"this app cannot make that effort go away," not "try harder."

## What was removed

- **Scripts** (`attach.mjs`, `auto-capture.mjs`, `capture.mjs`, `check-prices.mjs`, `parse.mjs`,
  `import-to-vault.mjs`/`.ps1`, `analyze-price-gaps.mjs`, `gap-log.mjs`, `run-scheduled.ps1`,
  `silent-launch.vbs`) and their `node_modules`/`package.json` -- all deleted.
- **The weekly Windows Scheduled Task** ("Costco Receipt Discovery") -- removed by the user
  directly (`schtasks /delete /tn "Costco Receipt Discovery" /f`).
- **App features that depended on imported receipt data**: the "Costco Price Match Watchlist"
  table and the receipt-verified reward cross-check (Reports -> Spend), the "Costco Receipts"
  upload section (Masters), the `search_costco_items` chat-assistant tool, and the
  `CostcoReceipt`/`CostcoPriceCheck` types and vault fields themselves (`lib/vault-types.ts`).
- **Local capture data** (`.captures/`, `.profiles/`, `last-sync-status.json`, `sync-log.txt`,
  gitignored vault backups) -- deleted; this was never committed to git in the first place.

## What was deliberately kept

- **The Costco Executive 2% Reward estimate** (`lib/costco-reward.ts`, shown on Reports -> Spend)
  -- this needs zero manual effort, works entirely from your existing voucher narration ("Shopping
  @ Costco -- $363.01"), and was never receipt-dependent. Still fully live.
- Whatever receipt/item data had already been imported into the vault before this retirement
  stays there as real historical data -- only the ongoing capture mechanism was removed, not
  anything already recorded.

If this is ever worth revisiting, the real options are: (a) accept the manual click-through as an
occasional light-touch habit (a few minutes, a few times a year) rather than a backlog to clear,
or (b) wait for Costco to ever offer a real API, which as of this writing it does not.
