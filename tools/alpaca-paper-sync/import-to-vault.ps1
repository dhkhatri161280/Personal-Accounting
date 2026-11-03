# import-to-vault.ps1
# Runs ON THE MACHINE where the trading bot itself runs (the personal laptop) -- reads that
# machine's own DPAPI-encrypted secrets (%LOCALAPPDATA%\PersonalLedgerTallySync\*.dpapi -- site,
# us-vault, and access-code), sets them as env vars along with the path to the bot's trades.csv,
# and runs import-to-vault.mjs to push new/updated orders straight into the encrypted vault.
#
# Same DPAPI pattern as ../amex-benefits/import-to-vault.ps1 and ../costco-receipts/import-to-vault.ps1
# -- but DPAPI secrets are machine+user bound, so if this is a DIFFERENT machine than the one that
# already has site.dpapi/us-vault.dpapi (e.g. the personal laptop, not the work PC that set up
# Tally sync), you need the one-time setup below for ALL THREE secrets, not just access-code.
#
# One-time setup (run once per machine, before the first real sync):
#   New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\PersonalLedgerTallySync" | Out-Null
#   Read-Host -Prompt "Site password" -AsSecureString | ConvertFrom-SecureString |
#     Set-Content -LiteralPath "$env:LOCALAPPDATA\PersonalLedgerTallySync\site.dpapi"
#   Read-Host -Prompt "US vault password" -AsSecureString | ConvertFrom-SecureString |
#     Set-Content -LiteralPath "$env:LOCALAPPDATA\PersonalLedgerTallySync\us-vault.dpapi"
#   Read-Host -Prompt "Access token" -AsSecureString | ConvertFrom-SecureString |
#     Set-Content -LiteralPath "$env:LOCALAPPDATA\PersonalLedgerTallySync\access-code.dpapi"
#
# Also set $TradesCsvPath below to the real path to the bot's trades.csv on this machine
# (e.g. "C:\Users\<you>\Documents\trading-bot\trades.csv").

$ErrorActionPreference = 'Stop'

$TradesCsvPath = "$env:USERPROFILE\Documents\trading-bot\trades.csv"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'

function Read-DpapiSecret([string]$Name) {
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) {
    throw "Missing secret file: $file -- see the one-time setup comment at the top of this script."
  }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$env:PL_SITE_PASSWORD = Read-DpapiSecret 'site'
$env:PL_VAULT_PASSWORD = Read-DpapiSecret 'us-vault'
$env:PL_ACCESS_CODE = Read-DpapiSecret 'access-code'
$env:ALPACA_TRADES_CSV = $TradesCsvPath

try {
  Push-Location $scriptDir
  node import-to-vault.mjs
  $exitCode = $LASTEXITCODE
  Pop-Location
  exit $exitCode
} finally {
  $env:PL_SITE_PASSWORD = $null
  $env:PL_VAULT_PASSWORD = $null
  $env:PL_ACCESS_CODE = $null
  $env:ALPACA_TRADES_CSV = $null
}
