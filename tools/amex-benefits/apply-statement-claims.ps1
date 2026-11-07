# apply-statement-claims.ps1
# Same DPAPI-secret pattern as import-to-vault.ps1 -- reads the three secrets already provisioned
# for Amex Benefits on this machine and runs apply-statement-claims.mjs, which pushes whatever's in
# statement-claims.json / statement-credits.json straight into the vault.

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'

function Read-DpapiSecret([string]$Name) {
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) {
    throw "Missing secret file: $file -- see import-to-vault.ps1's one-time setup comment."
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
  node apply-statement-claims.mjs
  $exitCode = $LASTEXITCODE
  Pop-Location
  exit $exitCode
} finally {
  $env:PL_SITE_PASSWORD = $null
  $env:PL_VAULT_PASSWORD = $null
  $env:PL_ACCESS_CODE = $null
}
