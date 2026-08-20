$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
$runtime = Join-Path $state 'runtime'

function Read-DpapiSecret([string]$Name) {
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing encrypted credential: $Name" }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$node = (Get-Content -Raw -LiteralPath (Join-Path $state 'node-path.txt')).Trim()
$runner = Join-Path $runtime 'dual-port-engine-runner.js'
if (-not (Test-Path -LiteralPath $node)) { throw "Local Node runtime was not found: $node" }
if (-not (Test-Path -LiteralPath $runner)) { throw "Sync runner was not found: $runner" }

Write-Host 'FINTECH BY DK - TWO-WAY SYNC SAFETY VALIDATION' -ForegroundColor Cyan
Write-Host 'READ ONLY: This cannot alter Tally or cloud data.' -ForegroundColor Yellow
$env:PL_SITE_PASSWORD = Read-DpapiSecret 'site'
try {
  foreach ($book in 'india','us') {
    Write-Host "`n=== $($book.ToUpper()) READ-ONLY PLAN ===" -ForegroundColor Cyan
    $env:PL_VAULT_PASSWORD = Read-DpapiSecret "$book-vault"
    & $node $runner preview $book
    if ($LASTEXITCODE -ne 0) { throw "$book preview failed with exit code $LASTEXITCODE" }
  }
  Write-Host "`nSUCCESS: Both read-only plans completed. No accounting data was changed." -ForegroundColor Green
} finally {
  $env:PL_SITE_PASSWORD = $null
  $env:PL_VAULT_PASSWORD = $null
  $env:PL_APPLY_CONFIRM = $null
}
Read-Host 'Press Enter to close'
