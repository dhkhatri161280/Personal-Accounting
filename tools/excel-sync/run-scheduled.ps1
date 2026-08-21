# run-scheduled.ps1
# Called by Windows Task Scheduler at 6 AM daily.
# Runs the Excel updater and appends output to sync-log.txt.
#
# A failure here (e.g. the target .xls being open elsewhere) previously only
# got logged to sync-log.txt, which nobody checks day to day -- the script
# itself always exited cleanly, so Task Scheduler kept reporting "success"
# even when the write silently failed. This now writes a clear pass/fail
# status file and exits non-zero on failure so the task's own Last Result
# reflects reality.

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile    = Join-Path $scriptDir 'sync-log.txt'
$statusFile = Join-Path $scriptDir 'last-sync-status.json'
$runner     = Join-Path (Split-Path -Parent $scriptDir) 'run-excel-updater.ps1'
$stamp      = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

Add-Content -Path $logFile -Value "`n========== $stamp =========="

try {
  & $runner 2>&1 | Tee-Object -FilePath $logFile -Append
  @{ status = 'success'; timestamp = $stamp; message = 'Sync completed successfully.' } |
    ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
} catch {
  $errMsg = $_.Exception.Message
  Add-Content -Path $logFile -Value "ERROR: $_"
  @{ status = 'error'; timestamp = $stamp; message = $errMsg } |
    ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
  exit 1
}
