# run-scheduled.ps1
# Meant to be called by Windows Task Scheduler (daily) -- see README.md "Scheduled run" section
# for how to register it. Fully unattended: launches the debug Chrome if needed, navigates it to
# the real Benefits pages (auto-capture.mjs), parses the captured data (parse.mjs), and writes it
# straight into the encrypted vault (import-to-vault.mjs, via the SAME DPAPI secrets
# ../tally-sync's own scheduled sync already uses on this machine). No manual steps, no typed
# credentials -- this only works because the debug Chrome profile stays signed into Amex between
# runs (same as it already does for Costco); see auto-capture.mjs's own header comment for what
# happens, and what doesn't happen automatically, when that session eventually expires.
#
# Same success/failure status-file pattern as ../costco-receipts/run-scheduled.ps1 -- a failure
# here (Chrome not logged in, the debug profile stale) should be visible in last-sync-status.json,
# not just buried in sync-log.txt where nobody looks day to day.

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile    = Join-Path $scriptDir 'sync-log.txt'
$statusFile = Join-Path $scriptDir 'last-sync-status.json'
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profileDir = "C:\Users\dikhatri\ChromeDebugProfile"
$stamp      = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

function Read-DpapiSecret([string]$Name) {
  $state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing encrypted credential: $Name" }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

Add-Content -Path $logFile -Value "`n========== $stamp =========="

try {
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
  $captureOutput = & node auto-capture.mjs 2>&1
  Add-Content -Path $logFile -Value ($captureOutput | Out-String)

  if ($captureOutput -join "`n" -match '0 responses captured') {
    Pop-Location
    throw "0 JSON responses captured -- the debug Chrome's Amex session has likely signed out. Open it and log into americanexpress.com again."
  }

  $parseOutput = & node parse.mjs 2>&1
  Add-Content -Path $logFile -Value ($parseOutput | Out-String)

  if ($parseOutput -join "`n" -match 'No usage trackers found') {
    Pop-Location
    throw "No usage trackers found in the capture -- the Benefits pages may not have loaded correctly."
  }

  $env:PL_SITE_PASSWORD = Read-DpapiSecret 'site'
  $env:PL_VAULT_PASSWORD = Read-DpapiSecret 'us-vault'
  $env:PL_ACCESS_CODE = Read-DpapiSecret 'access-code'
  try {
    $importOutput = & node import-to-vault.mjs 2>&1
    Add-Content -Path $logFile -Value ($importOutput | Out-String)
  } finally {
    $env:PL_SITE_PASSWORD = $null
    $env:PL_VAULT_PASSWORD = $null
    $env:PL_ACCESS_CODE = $null
  }
  Pop-Location

  @{ status = 'success'; timestamp = $stamp; message = 'Amex benefits refreshed.' } |
    ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
} catch {
  $errMsg = $_.Exception.Message
  Add-Content -Path $logFile -Value "ERROR: $_"
  @{ status = 'error'; timestamp = $stamp; message = $errMsg } |
    ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
  exit 1
}
