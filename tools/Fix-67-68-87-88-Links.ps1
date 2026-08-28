$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
$runtime = Join-Path $state 'runtime'

# One-off fix for the specific swapped-link bug found on 2026-08-28:
# App's #67/#68 records were unlinked, and App's #87/#88 records were
# linked to the WRONG Tally vouchers (Tally's real #67/#68 instead of
# their own #87/#88). This corrects exactly those 4 links, and only
# after verifying content matches exactly. No Tally writes, no content
# changes anywhere.

function Read-DpapiSecret([string]$Name) {
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing encrypted credential: $Name" }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$node   = (Get-Content -Raw -LiteralPath (Join-Path $state 'node-path.txt')).Trim()
$script = Join-Path $runtime 'set-explicit-links.js'
if (-not (Test-Path -LiteralPath $node))   { throw "Local Node runtime was not found: $node" }
if (-not (Test-Path -LiteralPath $script)) { throw "set-explicit-links.js was not found in the runtime folder: $script" }

$pairs = @(
  '27dbd946-92fd-4864-8fbd-0732f7564ca4=a2e69a3e-fc1e-420e-bf39-133be7d45e7a-00002553',
  '9e93b8d5-982a-48aa-9b37-2f9cd0dcde99=a2e69a3e-fc1e-420e-bf39-133be7d45e7a-00002554',
  '1ebda271-f72b-4bc4-8d71-2e53e4f2ef06=a2e69a3e-fc1e-420e-bf39-133be7d45e7a-00002567',
  'e62ecab7-f7cf-4b39-b89d-2897dd3bbfac=a2e69a3e-fc1e-420e-bf39-133be7d45e7a-00002568'
)

Write-Host 'FINTECH BY DK - FIX SWAPPED LINKS (67/68/87/88, US book)' -ForegroundColor Cyan
Write-Host 'Only writes if App content exactly matches the target Tally voucher. Never writes to Tally.' -ForegroundColor Yellow
Write-Host 'Tally must be open on port 9001.' -ForegroundColor Yellow
Write-Host ''

$env:PL_SITE_PASSWORD  = Read-DpapiSecret 'site'
$env:PL_VAULT_PASSWORD = Read-DpapiSecret 'us-vault'

try {
  $env:PL_APPLY_CONFIRM = ''
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $preview = & $node $script 'us' @pairs 2>&1 | Out-String
  $ErrorActionPreference = $prevPref
  Write-Host $preview.Trim()

  $match = [regex]::Match($preview, 'To apply, re-run with confirmation set to exactly:\s*(SETLINKS\s+\S+\s+\d+)')
  if (-not $match.Success) {
    Write-Host ''
    Write-Host 'Could not build a plan -- see any error above. Nothing was changed.' -ForegroundColor Yellow
    return
  }

  $expected = $match.Groups[1].Value.Trim()
  Write-Host ''
  $confirm = Read-Host "Review the plan above. Type exactly `"$expected`" to apply, anything else to abort"
  if ($confirm -ne $expected) { Write-Host 'Aborted. Nothing was changed.' -ForegroundColor Yellow; return }

  $env:PL_APPLY_CONFIRM = $expected
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $result = & $node $script 'us' @pairs 2>&1 | Out-String
  $ErrorActionPreference = $prevPref
  Write-Host $result.Trim()
  if ($LASTEXITCODE -ne 0) { throw 'set-explicit-links failed -- see message above' }
} finally {
  $env:PL_SITE_PASSWORD  = $null
  $env:PL_VAULT_PASSWORD = $null
  $env:PL_APPLY_CONFIRM  = $null
}

Read-Host 'Press Enter to close'
