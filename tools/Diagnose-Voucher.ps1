$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
$runtime = Join-Path $state 'runtime'

# Read-only diagnostic. Prints the raw internal guid/tallyGuid/syncFingerprint
# fields for the given voucher number(s) on both the App and Tally side.
# Never writes anything anywhere.

function Read-DpapiSecret([string]$Name) {
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing encrypted credential: $Name" }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$node   = (Get-Content -Raw -LiteralPath (Join-Path $state 'node-path.txt')).Trim()
$script = Join-Path $runtime 'diagnose-voucher.js'
if (-not (Test-Path -LiteralPath $node))   { throw "Local Node runtime was not found: $node" }
if (-not (Test-Path -LiteralPath $script)) { throw "diagnose-voucher.js was not found in the runtime folder: $script" }

$numbers = $args
if (-not $numbers -or $numbers.Count -eq 0) { $numbers = @(Read-Host 'Voucher number(s) to diagnose (space-separated)') -split '\s+' }

Write-Host 'FINTECH BY DK - VOUCHER DIAGNOSTIC (read-only, US book)' -ForegroundColor Cyan
Write-Host 'Tally must be open on port 9001.' -ForegroundColor Yellow
Write-Host ''

$env:PL_SITE_PASSWORD  = Read-DpapiSecret 'site'
$env:PL_VAULT_PASSWORD = Read-DpapiSecret 'us-vault'

try {
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $node $script 'us' @numbers 2>&1 | ForEach-Object { Write-Host $_ }
  $ErrorActionPreference = $prevPref
} finally {
  $env:PL_SITE_PASSWORD  = $null
  $env:PL_VAULT_PASSWORD = $null
}

Read-Host 'Press Enter to close'
