$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
$runtime = Join-Path $state 'runtime'

# Read-only. Searches the WHOLE App vault (no date/number filter) for any
# transaction whose guid or tallyGuid matches one of the given Tally GUIDs.
# Never writes anything.

function Read-DpapiSecret([string]$Name) {
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing encrypted credential: $Name" }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$node   = (Get-Content -Raw -LiteralPath (Join-Path $state 'node-path.txt')).Trim()
$script = Join-Path $runtime 'find-by-guid.js'
if (-not (Test-Path -LiteralPath $node))   { throw "Local Node runtime was not found: $node" }
if (-not (Test-Path -LiteralPath $script)) { throw "find-by-guid.js was not found in the runtime folder: $script" }

$guids = $args
if (-not $guids -or $guids.Count -eq 0) { $guids = @(Read-Host 'Tally GUID(s) to search for (space-separated)') -split '\s+' }

Write-Host 'FINTECH BY DK - FIND-BY-GUID (read-only, US book)' -ForegroundColor Cyan
Write-Host 'This does not need Tally open -- it only reads the App vault.' -ForegroundColor Yellow
Write-Host ''

$env:PL_SITE_PASSWORD  = Read-DpapiSecret 'site'
$env:PL_VAULT_PASSWORD = Read-DpapiSecret 'us-vault'

try {
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $node $script 'us' @guids 2>&1 | ForEach-Object { Write-Host $_ }
  $ErrorActionPreference = $prevPref
} finally {
  $env:PL_SITE_PASSWORD  = $null
  $env:PL_VAULT_PASSWORD = $null
}

Read-Host 'Press Enter to close'
