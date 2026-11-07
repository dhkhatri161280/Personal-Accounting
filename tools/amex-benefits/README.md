# Amex Platinum Benefits Tracker

Goal: track what you pay (the annual fee) against what you actually utilize (the card's
statement credits -- Uber Cash, digital entertainment, airline fee credit, etc.), using REAL
data from your own Amex account, not guessed amounts or stale terms from an outside source.
Amex's own benefit terms/amounts change over time (the Platinum Card had a major revision in
September 2025), so this is deliberately built to read what YOUR account actually says right
now, not a hardcoded list.

## Why a browser capture, not an API

Amex has no public API for "list my card's benefits and how much I've used of each" -- this is
the same situation `../costco-receipts` was already built to handle for Costco (no public API
there either), so this reuses that exact proven approach: connect to a real, already-logged-in
Chrome window over its remote debugging protocol and listen to the JSON responses Amex's own
account pages load, while you browse normally. Nothing is driven or automated -- every click and
keystroke is genuinely yours.

## This is built in two phases

**Phase 1 (done):** `attach.mjs` -- captures the RAW JSON responses from your Benefits page, so
we can see Amex's real data shape (field names, how usage/remaining/reset-date are represented)
before writing anything that parses it. Guessing field names instead of reading real captured
data first is exactly the mistake this app's own Costco tooling learned not to make early on.

**Phase 2 (next, once we have real captures):** a `parse.mjs` that turns the captured JSON into
a clean `benefits.json`, an `import-to-vault.mjs`/`.ps1` to push it into the encrypted vault
(same pattern as costco-receipts), and a new in-app report showing annual fee vs. total
benefit value utilized, per-benefit status, and days until each credit resets.

## Setup (shares the SAME debug Chrome `../costco-receipts` already uses)

No separate browser or profile needed -- if you've already set up the debug Chrome for Costco,
just log into `americanexpress.com` in that same window too.

**If it's not already running**, launch it:
```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\dikhatri\ChromeDebugProfile"
```

Then:
```bash
cd tools/amex-benefits
npm install
```

## Usage

```bash
# 1. In the debug Chrome, log into americanexpress.com if you aren't already.
# 2. Navigate to your account's Benefits page (sometimes called "Your Benefits" or
#    "Benefits Overview" -- wherever Amex shows your Platinum Card's individual credits and
#    how much of each you've used). Click into a few individual benefits too, if the page shows
#    more detail on click.
# 3. Run the capture:
node attach.mjs
# (browse normally, press Enter in the terminal when done)
```

This saves every JSON response into `.captures/<timestamp>/*.json` -- gitignored, never
committed (real financial benefit data). Send these to me (or just tell me to look at them,
if I have access to this machine) once you've captured a real session, and I'll read the real
shape before writing the parser.

## Phase 2 (done): parse, import, and a fully automated daily refresh

`parse.mjs` turns the raw captures into `benefits.json` -- scoped to real statement credits only
("usage" category trackers, MONETARY amounts; Amex's data also carries "spend"/"access" trackers
for lounge-tier progress and visit counts, which aren't dollars-back benefits and are left out).

`import-to-vault.mjs` / `.ps1` push `benefits.json` straight into the encrypted vault (same
DPAPI-secret pattern as `../costco-receipts`), or import it by hand via Masters -> Amex Benefits.
Each benefit is deduped by Amex's own `benefitId` -- re-importing refreshes the numbers in place.

### Fully automated refresh (no manual browsing needed)

`auto-capture.mjs` does the whole capture step with zero clicking -- it navigates the debug
Chrome's existing, already-logged-in session directly to the real Benefits pages
(`card-benefits/view-all` and `card-benefits/activity`) and captures the same JSON `attach.mjs`
does. This works the same way `../costco-receipts/auto-capture.mjs` already does against Costco:
a plain page visit reusing a session that's already signed in, never an automated login. No Amex
username/password is ever typed or stored anywhere by this tool -- if the debug Chrome's Amex
session ever signs out (normal expiry, a security check), this will capture 0 real trackers that
run and say so plainly in the log; log into americanexpress.com in the debug Chrome by hand and
the next scheduled run picks back up on its own.

`run-scheduled.ps1` chains all three steps (capture -> parse -> import) into one unattended run,
with the same launch-the-debug-Chrome-if-needed and success/failure status-file pattern as
`../costco-receipts/run-scheduled.ps1`.

**Test it once manually first:**
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File run-scheduled.ps1
```
Check `sync-log.txt` and `last-sync-status.json` afterward to confirm it worked.

**Register it with Windows Task Scheduler** (daily, 7 AM -- adjust as you like):
```powershell
schtasks /create /tn "Amex Benefits Refresh" /tr "wscript.exe \"C:\Users\dikhatri\Documents\Codex\personal-accounting-app\tools\amex-benefits\silent-launch.vbs\"" /sc daily /st 07:00 /f
```

To remove it later: `schtasks /delete /tn "Amex Benefits Refresh" /f`

### Retry sync from the app

`run-scheduled.ps1` also publishes its real result (success, or the actual reason it failed --
e.g. a genuine Amex sign-out vs. a cold-start timeout) to the Worker via `/api/amex-sync-status`,
using the same DPAPI `sync-secret` `../tally-sync` already uses on this machine. The app's own
"Needs Attention" banner reads that and shows the real reason, with a **Retry sync** button.

That button just sets a flag (`/api/sync-trigger?book=amex`, same mechanism `../tally-sync`
already uses for its own "Sync Now") -- something on this machine has to actually be polling for
it, or tapping Retry would silently do nothing until tomorrow's scheduled run. `trigger-check.ps1`
is that poller: a cheap no-op most of the time, and only runs `run-scheduled.ps1` immediately when
the flag is set.

**Register the poller** (every 5 minutes -- frequent enough that a Retry tap feels responsive,
cheap enough it's a non-issue to run that often):
```powershell
schtasks /create /tn "Amex Benefits Trigger Check" /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\Users\dikhatri\Documents\Codex\personal-accounting-app\tools\amex-benefits\trigger-check.ps1\"" /sc minute /mo 5 /f
```
To remove it later: `schtasks /delete /tn "Amex Benefits Trigger Check" /f`

So after a real sign-out: log into americanexpress.com in the debug Chrome window, then either
wait up to 5 minutes for the poller to notice on its own, or tap **Retry sync** in the app's
Needs Attention banner to force it immediately.

## Output

`.captures/<timestamp>/<NNNN>.json` -- one file per captured JSON response, each with `url`,
`status`, and the raw `body`. `benefits.json` is the clean, ready-to-import result.

## Credit-matching from transactions (no browser capture needed)

For most tracked benefits, Amex posts a statement credit with a distinct, stable transaction name
(e.g. `Platinum Uber One Credit`, `AMEX Airline Fee Reimbursement`) the moment the credit actually
applies -- `lib/amex-credit-match.ts` matches these against **real Amex card transactions**
(already-connected via Plaid, same as the app's own Bank Recon) and fills in
`AmexBenefit.statementCredits` directly. No login to americanexpress.com, no debug Chrome, works
from any device that can open the app (phone included) -- this exists specifically to reduce how
often the browser-capture approach above needs to run at all, since that approach uses a shared
automated Chrome session against Amex's own login that's worth minimizing.

**Confirmed exact names** (cross-validated against this card's real, scraped tracker totals --
see `lib/amex-credit-match.ts`'s own comment): Uber One Credit, Airline Fee Credit, lululemon
Credit, Resy Credit, Walmart+ Membership Credit, Oura Ring Credit, CLEAR+ Credit. **Not yet
confirmed** (never posted on this card, so the real name is unknown): Digital Entertainment
Credit, Lodging Credit -- these stay on the browser-capture path above until a real example is
captured (via a statement download, see below) and added to `AMEX_BENEFIT_CREDIT_NAMES`.

**Day to day:** click **Sync credits from card transactions** on the Amex Benefits report in the
app (Masters → Amex Benefits). Safe to click any time, from any device -- it dedupes against
what's already on file.

**One-time backfill from a full statement** (further back than Plaid's own ~500-transaction
window reaches): download your Amex account's activity as CSV (`Statements & Activity → Download`,
custom date range, CSV format), then:
```powershell
node --import tsx backfill-credits-from-statement.mjs "C:\path\to\activity.csv"
./apply-statement-claims.ps1
```
The CSV itself is never read by anything except this one local script and is never committed --
treat it like any other downloaded statement.
