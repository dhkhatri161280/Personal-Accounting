$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
$runtime = Join-Path $state 'runtime'

# Bulk identity-repair: links App vouchers to matching Tally vouchers by GUID
# ONLY when their content (date/type/narration/entries/amounts) already
# matches exactly -- e.g. you typed a voucher into Tally by hand, so it's
# correct in both places already, just not linked. This NEVER writes to
# Tally, and the only fields it ever touches in the App's vault are the link
# metadata (tallyGuid / syncFingerprint / syncStatus / lastSyncedAt) -- never
# date, amount, narration, or entries. Ambiguous matches (more than one
# candidate with identical content) are skipped and reported, never guessed.

function Read-DpapiSecret([string]$Name) {
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing encrypted credential: $Name" }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$node   = (Get-Content -Raw -LiteralPath (Join-Path $state 'node-path.txt')).Trim()
$script = Join-Path $runtime 'link-only-repair.js'
if (-not (Test-Path -LiteralPath $node))   { throw "Local Node runtime was not found: $node" }
if (-not (Test-Path -LiteralPath $script)) { throw "link-only-repair.js was not found in the runtime folder: $script" }

Write-Host 'FINTECH BY DK - LINK-ONLY IDENTITY REPAIR (US book)' -ForegroundColor Cyan
Write-Host 'This links already-matching vouchers by GUID only. It never writes to Tally and never changes any date, amount, narration, or entry on either side.' -ForegroundColor Yellow
Write-Host 'Tally must be open on port 9001 before continuing (a read-only export is used to compare).' -ForegroundColor Yellow
Write-Host ''

$env:PL_SITE_PASSWORD  = Read-DpapiSecret 'site'
$env:PL_VAULT_PASSWORD = Read-DpapiSecret 'us-vault'

try {
  $env:PL_APPLY_CONFIRM = ''
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $preview = & $node $script 'us' 2>&1 | Out-String
  $ErrorActionPreference = $prevPref
  Write-Host $preview.Trim()

  $match = [regex]::Match($preview, 'To apply, re-run with confirmation set to exactly:\s*(LINK\s+\S+\s+\d+)')
  if (-not $match.Success) {
    Write-Host ''
    Write-Host 'Nothing to link right now (either everything is already linked, or the plan needs a human look first).' -ForegroundColor Yellow
    return
  }

  $expected = $match.Groups[1].Value.Trim()
  Write-Host ''
  Write-Host 'Nothing has been changed yet. Review the WILL LINK pairs above carefully.' -ForegroundColor Cyan
  $confirm = Read-Host "Type exactly `"$expected`" to link them, anything else to abort"
  if ($confirm -ne $expected) { Write-Host 'Aborted. Nothing was changed.' -ForegroundColor Yellow; return }

  $env:PL_APPLY_CONFIRM = $expected
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $result = & $node $script 'us' 2>&1 | Out-String
  $ErrorActionPreference = $prevPref
  Write-Host $result.Trim()
  if ($LASTEXITCODE -ne 0) { throw 'link-only-repair failed -- see message above' }
} finally {
  $env:PL_SITE_PASSWORD  = $null
  $env:PL_VAULT_PASSWORD = $null
  $env:PL_APPLY_CONFIRM  = $null
}

Read-Host 'Press Enter to close'
