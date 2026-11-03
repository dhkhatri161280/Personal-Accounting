# Alpaca Paper Trading Sync

Pushes the standalone Alpaca paper-trading bot's real order history (its own `trades.csv`, from
`trade_log.py` in that separate project) straight into this app's encrypted US-book vault, so
every approved paper order shows up in Masters → Paper Trading / Reports → Paper Trading without
a manual file-picker upload each time.

This is **simulated money only** -- see `AlpacaPaperTrade`'s own comment in `lib/vault-types.ts`
for why it's a deliberately separate field from the real Schwab/Robinhood `trades` data
`TradingReport.tsx` tracks, and never gets blended into it.

## Where this runs

The bot (and its `trades.csv`) lives on the **personal laptop**, not this work machine -- so this
tool is meant to run there too. Copy this `tools/alpaca-paper-sync/` folder to the laptop (same
way the bot's own code gets there -- Google Drive, USB, etc.) alongside the trading-bot project.

## One-time setup (on the laptop)

DPAPI secrets are machine+user bound, so even though this reuses the same
`%LOCALAPPDATA%\PersonalLedgerTallySync\*.dpapi` convention as the work PC's Tally sync, the
laptop needs its own copies of all three secrets. See the setup block at the top of
`import-to-vault.ps1` for the exact commands (site password, US vault password, access token).

Then open `import-to-vault.ps1` and `run-scheduled.ps1` and check `$TradesCsvPath` points at the
real path to the bot's `trades.csv` on the laptop (defaults to
`%USERPROFILE%\Documents\trading-bot\trades.csv`).

## Manual run

```bash
cd tools/alpaca-paper-sync
powershell -ExecutionPolicy Bypass -File import-to-vault.ps1
```

Safe to re-run any time -- orders are deduped by Alpaca's own `order_id`; re-running after a
pending order fills just refreshes its status in place (e.g. `OrderStatus.ACCEPTED` →
`OrderStatus.FILLED`), it never double-counts.

## Scheduled run (set and forget)

Register `run-scheduled.ps1` in Task Scheduler on the laptop, e.g. once a day after market close:

```powershell
schtasks /create /tn "AlpacaPaperSync" /tr "powershell.exe -ExecutionPolicy Bypass -File C:\Users\<you>\Documents\personal-accounting-app\tools\alpaca-paper-sync\run-scheduled.ps1" /sc daily /st 17:00 /rl limited
```

(Avoid escaped inner quotes in `/tr` if the path has no spaces -- they've broken `schtasks`'
argument parsing before; see the trading bot's own Task Scheduler setup for the exact failure
mode.)

Logs to `sync-log.txt`; last outcome (success/error + message) is always in
`last-sync-status.json`, same pattern as `../amex-benefits` and `../costco-receipts`.

## Files

- `import-to-vault.mjs` -- reads `trades.csv`, merges into the vault's `alpacaPaperTrades`, writes
  back. A faithful Node port of `lib/alpaca-paper.ts`'s parse/merge functions (can't import
  TypeScript directly from a standalone script) -- keep both in sync by hand if those ever change.
- `import-to-vault.ps1` -- manual-run wrapper: loads DPAPI secrets + the CSV path, runs the above.
- `run-scheduled.ps1` -- unattended wrapper for Task Scheduler, with status-file logging.
