# Amex Platinum Benefits Tracker

Goal: track what you pay (the annual fee) against what you actually utilize (the card's
statement credits -- Uber Cash, digital entertainment, airline fee credit, etc.), using REAL
data from your own Amex account, not guessed amounts or stale terms from an outside source.

## How it works now: credit-matching from real card transactions

Amex posts a statement credit with a distinct, stable transaction name (e.g.
`Platinum Uber One Credit`, `AMEX Airline Fee Reimbursement`) the moment a benefit credit
actually applies -- `lib/amex-credit-match.ts` matches these against **real Amex card
transactions** (already-connected via Plaid, same as the app's own Bank Recon) and fills in
`AmexBenefit.statementCredits` directly. No login to americanexpress.com, no browser automation,
no shared debug-Chrome session against Amex's own login -- works from any device that can open
the app, phone included.

**Confirmed exact names** (cross-validated against this card's real statement totals -- see
`lib/amex-credit-match.ts`'s own comment): Uber One Credit, Airline Fee Credit, lululemon Credit,
Resy Credit, Walmart+ Membership Credit, Oura Ring Credit, CLEAR+ Credit. **Not yet confirmed**
(never posted on this card, so the real name is unknown): Digital Entertainment Credit, Lodging
Credit -- these stay unmatched until a real example posts; send me the real transaction name the
first time either one shows up and I'll add it to `AMEX_BENEFIT_CREDIT_NAMES`.

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

## Retired: browser-capture automation

Earlier versions of this tool drove a scheduled, unattended debug-Chrome session against
americanexpress.com to scrape the Benefits page daily (`attach.mjs`, `auto-capture.mjs`,
`parse.mjs`, `import-to-vault.mjs`/`.ps1`, `run-scheduled.ps1`, `trigger-check.ps1`,
`silent-launch.vbs`, the `/api/amex-sync-status` endpoint, and the "Amex benefits sync failed"
Needs Attention banner). This was retired on 2026-11-08 in favor of the Plaid-based matching
above -- it needed too much manual babysitting (re-logging into the debug Chrome whenever the
session dropped), was laptop-only, and kept a standing automated session against Amex's own
login that's worth minimizing. The Windows Scheduled Tasks that ran it (`Amex Benefits Refresh`,
`Amex Benefits Trigger Check`) and the scripts/API route/banner code behind them have all been
removed -- nothing from this era should still be running or showing up in the app.
