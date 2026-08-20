# run-scheduled.ps1
# Called by Windows Task Scheduler at 6 AM daily.
# Runs the Excel updater and appends output to sync-log.txt.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile   = Join-Path $scriptDir 'sync-log.txt'
$runner    = Join-Path (Split-Path -Parent $scriptDir) 'run-excel-updater.ps1'
$stamp     = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

Add-Content -Path $logFile -Value "`n========== $stamp =========="

try {
  & $runner 2>&1 | Tee-Object -FilePath $logFile -Append
} catch {
  Add-Content -Path $logFile -Value "ERROR: $_"
}
