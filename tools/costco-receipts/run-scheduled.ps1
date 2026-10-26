# run-scheduled.ps1
# Meant to be called by Windows Task Scheduler (weekly) -- see README.md "Scheduled run" section
# for how to register it. Auto-discovers new Costco receipts (LIST only -- dates/warehouses/
# totals, no itemized item detail, no clicking) and flags which recent ones still need a manual
# "View Receipt" click. Itemized detail isn't auto-fetched here on purpose -- see auto-capture.mjs's
# own header comment for why (Kasada anti-bot protection on that specific endpoint).
#
# Same success/failure status-file pattern as ../excel-sync/run-scheduled.ps1 -- a failure here
# (e.g. Chrome not logged in, the debug profile stale) should be visible in last-sync-status.json,
# not just buried in sync-log.txt where nobody looks day to day.

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile    = Join-Path $scriptDir 'sync-log.txt'
$statusFile = Join-Path $scriptDir 'last-sync-status.json'
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profileDir = "C:\Users\dikhatri\ChromeDebugProfile"
$label      = "dignesh"
$stamp      = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

Add-Content -Path $logFile -Value "`n========== $stamp =========="

try {
  # Launch the debug Chrome only if it isn't already listening on 9222 -- this is a SEPARATE
  # profile directory from the user's everyday Chrome (see README.md), so launching it doesn't
  # require closing anything else first, unlike the one-time robocopy refresh step.
  $debugReady = $false
  try {
    $resp = Invoke-WebRequest -Uri "http://localhost:9222/json/version" -UseBasicParsing -TimeoutSec 3
    $debugReady = $resp.StatusCode -eq 200
  } catch {
    $debugReady = $false
  }

  if (-not $debugReady) {
    Add-Content -Path $logFile -Value "Debug Chrome not running -- launching it."
    Start-Process -FilePath $chromePath -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=`"$profileDir`""
    Start-Sleep -Seconds 8
  }

  Push-Location $scriptDir
  $output = & node auto-capture.mjs "--label=$label" 2>&1
  Pop-Location
  Add-Content -Path $logFile -Value ($output | Out-String)

  @{ status = 'success'; timestamp = $stamp; message = 'Receipt list refreshed.' } |
    ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
} catch {
  $errMsg = $_.Exception.Message
  Add-Content -Path $logFile -Value "ERROR: $_"
  @{ status = 'error'; timestamp = $stamp; message = $errMsg } |
    ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
  exit 1
}
