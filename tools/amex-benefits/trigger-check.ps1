# trigger-check.ps1
# Meant to be called by Windows Task Scheduler every few minutes (see README.md "Retry sync from
# the app" section) -- NOT the same task as run-scheduled.ps1's daily 7am run. This just polls
# /api/sync-trigger?book=amex (consumed, not re-triggered on the next poll -- same flag mechanism
# ../tally-sync already uses) and, if the app's "Retry sync" button was tapped, runs
# run-scheduled.ps1 immediately instead of making the user wait for tomorrow's scheduled run.
#
# Cheap no-op the overwhelming majority of the time: one small unauthenticated GET, nothing else,
# unless the flag is actually set.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$siteUrl   = 'https://personal-ledger-dk.digneshkhatri.workers.dev'
$logFile   = Join-Path $scriptDir 'trigger-check-log.txt'

try {
  $resp = Invoke-RestMethod -Uri "$siteUrl/api/sync-trigger?book=amex" -Method GET -TimeoutSec 10
} catch {
  # A network hiccup here is not worth logging every few minutes -- run-scheduled.ps1's own
  # sync-log.txt is the real audit trail; this file only records actual triggered runs.
  exit 0
}

if ($resp.triggered -eq $true) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $logFile -Value "[$stamp] Retry requested from the app -- running now."
  & (Join-Path $scriptDir 'run-scheduled.ps1')
}
