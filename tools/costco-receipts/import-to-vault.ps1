# import-to-vault.ps1
# Reads the DPAPI-encrypted secrets tools/tally-sync's own scheduled sync already uses on this
# machine (%LOCALAPPDATA%\PersonalLedgerTallySync\*.dpapi -- site, us-vault, and access-code),
# sets them as env vars, and runs import-to-vault.mjs to push .captures/receipts.json and
# price-checks.json straight into the encrypted vault. Same DPAPI pattern as unattended-cycle.ps1
# (never plaintext on disk, never printed) -- reused rather than inventing a second secret store.
#
# One-time setup, if access-code.dpapi doesn't exist yet:
#   Read-Host -Prompt "Access token" -AsSecureString | ConvertFrom-SecureString |
#     Set-Content -LiteralPath "$env:LOCALAPPDATA\PersonalLedgerTallySync\access-code.dpapi"
# (site.dpapi and us-vault.dpapi already exist on this machine from the Tally sync setup.)

$ErrorActionPreference = 'Stop'

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
}
