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

$siteUrl = 'https://personal-ledger-dk.digneshkhatri.workers.dev'

function Read-DpapiSecret([string]$Name) {
  $state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing encrypted credential: $Name" }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# Publishes the REAL result (success, or the actual reason it failed) to the Worker so the app's
# own "Amex benefits haven't updated" banner can show the true reason instead of guessing from
# staleness alone -- same PUT/Bearer-SYNC_SECRET pattern ../tally-sync's unattended-cycle.ps1
# already uses for /api/sync-status. Best-effort: a publish failure here (no internet, Worker
# down) must never make an otherwise-successful local run look like it failed, and the local
# last-sync-status.json below is still written either way as the fallback source of truth.
function Publish-AmexHealth([string]$Status, [string]$Message) {
  try {
    $body = @{ status = $Status; message = $Message } | ConvertTo-Json -Compress
    Invoke-WebRequest "$siteUrl/api/amex-sync-status" `
      -Method PUT `
      -Headers @{ Authorization = "Bearer $(Read-DpapiSecret 'sync-secret')" } `
      -ContentType 'application/json' `
      -Body $body `
      -TimeoutSec 15 `
      -UseBasicParsing | Out-Null
  } catch {
    Add-Content -Path $logFile -Value "Status publish to app failed (non-fatal): $($_.Exception.Message)"
  }
}

# A real sign-out is the ONE failure mode here that needs the user, not just a retry/wait --
# everything else (a cold-start timeout, a rejected vault write) is either self-healing or an
# engineering bug, neither of which the user can fix by looking at a screen. Shown ONLY for that
# specific case, right after the two-attempt capture both came back empty -- the debug Chrome is
# already open and sitting on the Benefits page at this point (auto-capture.mjs never closes the
# real window, only detaches its own CDP connection), so this popup is the whole fix: switch to
# that window, log in, done. No app round-trip, no Claude session needed to notice this.
function Show-LoginNeededAlert {
  try {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      "Amex Benefits sync couldn't load your Benefits page -- your Amex session has likely signed out.`n`nThe debug Chrome window is already open and on the Benefits page. Just switch to it and log into americanexpress.com -- the next scheduled run will pick it back up automatically, no other steps needed.",
      "Amex Benefits -- sign-in needed",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Warning
    ) | Out-Null
  } catch {
    # Best-effort only -- a machine with no interactive desktop session (e.g. this ran under a
    # non-interactive Task Scheduler context) can't show a popup at all. last-sync-status.json
    # still has the real error either way, so nothing is actually lost if this silently no-ops.
  }
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
    # 15s, not 8s -- a cold Chrome launch competing with whatever else is already running on this
    # machine (confirmed live: 48 other chrome.exe processes at once) can genuinely take longer
    # than 8s to be ready to navigate, and a scheduled 7am run landing late (machine was off/locked,
    # Task Scheduler catching up once it's back) is exactly the case most likely to hit this cold.
    Start-Sleep -Seconds 15
  }

  # One retry before concluding the Amex session is actually signed out -- confirmed live that a
  # cold Chrome launch can still fail its first navigation (20s page.goto timeout) even after the
  # Start-Sleep above, purely from being newly spun up, with the SAME session still perfectly
  # valid a few seconds later. Only the real "signed out" case (still 0 responses after a fresh,
  # already-warm attempt) should surface as an error.
  Push-Location $scriptDir
  $captureOutput = & node auto-capture.mjs 2>&1
  Add-Content -Path $logFile -Value ($captureOutput | Out-String)

  # Matches EITHER failure auto-capture.mjs can report: zero responses at all (a true cold
  # sign-out) or zero of the real benefits API responses specifically (confirmed live 2026-11-04:
  # a degraded session stuck on Amex's own device/passkey verification challenge still returns
  # plenty of OTHER JSON -- nav headers, marketing payloads -- so "any response at all" alone
  # silently passed for 3+ days straight while every benefit figure sat frozen on stale data).
  $captureFailed = { param($out) $out -join "`n" -match '0 responses captured|0 real benefits-trackers API' }

  if (& $captureFailed $captureOutput) {
    Add-Content -Path $logFile -Value "Capture didn't reach the real benefits data on the first attempt -- retrying once after a short wait (likely just a cold-start timing issue, not a real sign-out)."
    Start-Sleep -Seconds 10
    $captureOutput = & node auto-capture.mjs 2>&1
    Add-Content -Path $logFile -Value ($captureOutput | Out-String)
  }

  if (& $captureFailed $captureOutput) {
    Pop-Location
    Show-LoginNeededAlert
    throw "Didn't reach the real benefits data on two attempts -- the debug Chrome's Amex session has likely signed out or hit a verification challenge. Open it and log into americanexpress.com again."
  }

  $parseOutput = & node parse.mjs 2>&1
  Add-Content -Path $logFile -Value ($parseOutput | Out-String)

  # Two different messages parse.mjs can print for "found nothing usable" -- confirmed live
  # (2026-11-04) that restricting parse.mjs to the latest capture only (see its own comment) makes
  # the EARLIER, stricter "No benefit data found in any capture" message the one that actually
  # fires when the real benefits API wasn't reached at all, not the "No usage trackers found" one
  # this previously only checked for.
  if ($parseOutput -join "`n" -match 'No usage trackers found|No benefit data found') {
    Pop-Location
    Show-LoginNeededAlert
    throw "Parse found no usable benefit data in the latest capture -- the Benefits pages likely didn't load correctly (see auto-capture.mjs's own output above for why)."
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
  Publish-AmexHealth 'success' 'Amex benefits refreshed.'
} catch {
  $errMsg = $_.Exception.Message
  Add-Content -Path $logFile -Value "ERROR: $_"
  @{ status = 'error'; timestamp = $stamp; message = $errMsg } |
    ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
  Publish-AmexHealth 'error' $errMsg
  exit 1
}
