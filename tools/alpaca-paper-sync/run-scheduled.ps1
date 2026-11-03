# run-scheduled.ps1
# Meant to be called by Windows Task Scheduler on the personal laptop (where the trading bot
# itself runs) -- see README.md "Scheduled run" section for how to register it. Fully unattended:
# reads the bot's own trades.csv and writes new/updated orders straight into the encrypted vault
# (import-to-vault.mjs, via DPAPI secrets set up once on THIS machine -- see import-to-vault.ps1's
# own header comment for the one-time setup, since DPAPI secrets don't carry over from the work
# PC's Tally-sync setup).
#
# Same success/failure status-file pattern as ../amex-benefits/run-scheduled.ps1 -- a failure here
# (missing secrets, trades.csv not found, a rejected vault write) should be visible in
# last-sync-status.json, not just buried in sync-log.txt where nobody looks day to day.

$ErrorActionPreference = 'Stop'

$TradesCsvPath = "$env:USERPROFILE\Documents\trading-bot\trades.csv"

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile    = Join-Path $scriptDir 'sync-log.txt'
$statusFile = Join-Path $scriptDir 'last-sync-status.json'
$state      = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
$stamp      = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

function Read-DpapiSecret([string]$Name) {
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing encrypted credential: $Name -- see import-to-vault.ps1's one-time setup comment." }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

Add-Content -Path $logFile -Value "`n========== $stamp =========="

try {
  Push-Location $scriptDir

  $env:PL_SITE_PASSWORD = Read-DpapiSecret 'site'
  $env:PL_VAULT_PASSWORD = Read-DpapiSecret 'us-vault'
  $env:PL_ACCESS_CODE = Read-DpapiSecret 'access-code'
  $env:ALPACA_TRADES_CSV = $TradesCsvPath
  try {
    $importOutput = & node import-to-vault.mjs 2>&1
    Add-Content -Path $logFile -Value ($importOutput | Out-String)
    if ($LASTEXITCODE -ne 0) { throw ($importOutput | Out-String) }
  } finally {
    $env:PL_SITE_PASSWORD = $null
    $env:PL_VAULT_PASSWORD = $null
    $env:PL_ACCESS_CODE = $null
    $env:ALPACA_TRADES_CSV = $null
  }
  Pop-Location

  @{ status = 'success'; timestamp = $stamp; message = 'Paper trades refreshed.' } |
    ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
} catch {
  $errMsg = $_.Exception.Message
  Add-Content -Path $logFile -Value "ERROR: $_"
  @{ status = 'error'; timestamp = $stamp; message = $errMsg } |
    ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
  exit 1
}
