# Costco Receipt Capture & Price Match Watchlist

Goal: know which Costco purchases are still inside the 30-day (sometimes longer, e.g.
electronics) price-adjustment window, what the real current price is, and feed real itemized
data into the Costco Executive 2% Reward calculation -- all from real Costco data, not guessed
from Day Book narration.

This app has no itemized purchase data on its own -- Day Book only has voucher totals like
"Shopping @ Costco -- $363.01", not item names/prices. Costco has no public API, so this toolset
drives a real, already-logged-in Chrome session through Costco's own site to get it.

## The debug Chrome (needed by everything below)

Every script here connects to a real Chrome window running with remote debugging enabled, using
its own SEPARATE profile folder (`C:\Users\dikhatri\ChromeDebugProfile`) -- not your everyday
Chrome. That separation matters: it means launching it never requires closing your normal
browsing, and it's a one-time setup.

**First time only** -- seed the debug profile from your real one (picks up your Costco login):
```bash
robocopy "C:\Users\dikhatri\AppData\Local\Google\Chrome\User Data" "C:\Users\dikhatri\ChromeDebugProfile" /E /XD "Cache" "Code Cache" "GPUCache" "CacheStorage" "blob_storage" "shared_proto_db" "component_crx_cache" "extensions_crx_cache" "Crashpad" "ShaderCache" "GrShaderCache" "Service Worker" "IndexedDB"
```

**Every time you want to use any script below** -- launch it:
```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\dikhatri\ChromeDebugProfile"
```
If it's not already logged into Costco, log in there once (check "Keep me signed in") -- it'll
stay logged in across future launches. Also confirm **My Warehouse** (top of costco.com) is set
to the real store you shop at -- it drives real in-warehouse pricing (see check-prices.mjs).

## Setup (one time)

```bash
cd tools/costco-receipts
npm install
```

## The scripts

### `auto-capture.mjs` -- find new receipts, zero clicking
```bash
node auto-capture.mjs --label=dignesh
```
Calls Costco's own receipt-LIST API directly (the same thing Order & Purchase History loads on
its own) and tells you exactly which **recent** receipts (inside the price-match window) still
need a manual click for item detail -- not the whole history, just what's actually actionable.
Safe to run anytime, including on a schedule (see below) -- it never clicks anything itself, so
there's nothing to go wrong.

It deliberately does NOT auto-fetch itemized detail per receipt. Costco protects that endpoint
with Kasada (anti-bot), which issues a fresh cryptographic token per request -- replaying a
captured token for a different request is flatly rejected (confirmed live: every attempt 400'd).
That's Costco's security working correctly; this script doesn't try to get around it.

### `attach.mjs` -- capture item detail (still needs your actual clicks)
```bash
node attach.mjs --label=dignesh
```
Attaches to the debug Chrome and silently records every JSON response while **you** browse --
every click and keystroke is genuinely yours, so there's nothing for Costco to flag. Go to
**Order & Purchase History**, click "View Receipt" on whichever receipts `auto-capture.mjs` just
told you still need it, then press Enter in the terminal when done.

### `check-prices.mjs` -- live current-price check, zero clicking
```bash
node check-prices.mjs
```
For every item still in the price-match window (from `.captures/watchlist.json`), searches
costco.com and pulls the REAL current price -- preferring the true in-warehouse price (at
whichever store "My Warehouse" is set to) over the online/delivery price, which can legitimately
differ. Fully automated, no clicking.

### `parse.mjs` -- turn raw captures into clean, importable files
```bash
node parse.mjs
```
Reads everything under `.captures/<name>/`, writes `.captures/receipts.json` and
`.captures/price-checks.json` (either import these into **Masters → Costco Receipts** in the app
by hand, or use `import-to-vault.ps1` below to skip that step) and `.captures/watchlist.json`
(used by `check-prices.mjs`).

### `import-to-vault.ps1` -- push receipts/price-checks straight into the vault, no browser step
```powershell
powershell -File import-to-vault.ps1
```
Writes `.captures/receipts.json` and `.captures/price-checks.json` directly into the encrypted
US-book vault -- same merge rules as the Masters → Costco Receipts upload, just skipping the
manual file-picker. Reads the vault/site/access-token credentials from the same DPAPI-encrypted
secret files `../tally-sync`'s own scheduled sync already uses on this machine
(`%LOCALAPPDATA%\PersonalLedgerTallySync\*.dpapi`). One-time setup if `access-code.dpapi` doesn't
exist yet (the other two already do, from the Tally sync setup):
```powershell
Read-Host -Prompt "Access token" -AsSecureString | ConvertFrom-SecureString |
  Set-Content -LiteralPath "$env:LOCALAPPDATA\PersonalLedgerTallySync\access-code.dpapi"
```
Writes a timestamped encrypted backup of the whole vault (`encrypted-us-vault-before-costco-import-*.json`,
gitignored) before every write, same safety pattern as the Tally sync scripts.

## Typical workflow

```bash
# 1. Launch the debug Chrome (see above) if it's not already running.
# 2. See what's new:
node auto-capture.mjs --label=dignesh
# 3. If it lists anything, click those few receipts in the Chrome window, then:
node attach.mjs --label=dignesh
# (click the listed receipts, press Enter when done)
# 4. Check current prices:
node check-prices.mjs
# 5. Build the clean output files:
node parse.mjs
# 6. Get it into the app -- either:
powershell -File import-to-vault.ps1
#    ...or manually import .captures/receipts.json and .captures/price-checks.json via
#    Masters -> Costco Receipts in the app.
```

## Scheduled run (optional)

`run-scheduled.ps1` + `silent-launch.vbs` run `auto-capture.mjs` automatically (launching the
debug Chrome itself if it isn't already running) -- same pattern as `../excel-sync`'s own
scheduled sync. This only ever runs the safe, zero-click list discovery; it never auto-clicks
through item detail.

**Test it once manually first:**
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File run-scheduled.ps1
```
Check `sync-log.txt` and `last-sync-status.json` afterward to confirm it worked.

**Register it with Windows Task Scheduler** (weekly, Monday 8 AM -- adjust as you like):
```powershell
schtasks /create /tn "Costco Receipt Discovery" /tr "wscript.exe \"C:\Users\dikhatri\Documents\Codex\personal-accounting-app\tools\costco-receipts\silent-launch.vbs\"" /sc weekly /d MON /st 08:00 /f
```

To remove it later: `schtasks /delete /tn "Costco Receipt Discovery" /f`

## Output

Everything lands in `.captures/<name>/<timestamp>/` -- one `.json` file per captured API
response. `.captures/receipts.json`, `.captures/watchlist.json`, and `.captures/price-checks.json`
are the three files `parse.mjs`/`check-prices.mjs` produce for import into the app. Both
`.profiles/` (session cookies, legacy `capture.mjs` only) and `.captures/` (real purchase data)
are gitignored and must never be committed.
