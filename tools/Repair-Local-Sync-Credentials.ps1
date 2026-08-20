$ErrorActionPreference = 'Stop'

$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
$runtime = Join-Path $state 'runtime'

if (-not (Test-Path -LiteralPath (Join-Path $runtime 'unattended-cycle.ps1'))) {
  throw "FinTech by DK local sync runtime was not found at $runtime"
}

function Save-DpapiSecret([string]$Name, [string]$Prompt) {
  $secret = Read-Host $Prompt -AsSecureString
  $payload = ConvertFrom-SecureString -SecureString $secret
  if ($payload -notmatch '^[0-9A-Fa-f]+$') {
    throw "Windows DPAPI did not return the expected encrypted format for $Name"
  }
  Set-Content -LiteralPath (Join-Path $state "$Name.dpapi") -Value $payload -Encoding ascii
}

Write-Host 'FINTECH BY DK - REPAIR LOCAL SYNC CREDENTIALS' -ForegroundColor Cyan
Write-Host 'This changes encrypted local credentials only. It does not alter Tally or cloud accounting data.' -ForegroundColor Yellow
Write-Host 'Credentials are protected by Windows DPAPI for this Windows user.' -ForegroundColor Cyan

Save-DpapiSecret 'site' 'Enter the FinTech by DK website password'
Save-DpapiSecret 'india-vault' 'Enter the INDIA encrypted vault password'
Save-DpapiSecret 'us-vault' 'Enter the US encrypted vault password'

foreach ($name in 'site','india-vault','us-vault') {
  $file = Join-Path $state "$name.dpapi"
  $payload = (Get-Content -Raw -LiteralPath $file).Trim()
  if ($payload -notmatch '^[0-9A-Fa-f]+$') { throw "Credential verification failed for $name" }
  $null = ConvertTo-SecureString -String $payload -ErrorAction Stop
}

Write-Host 'SUCCESS: Local encrypted credentials repaired for India and US sync.' -ForegroundColor Green
Write-Host "Stored under: $state" -ForegroundColor Gray
Write-Host 'No Tally or cloud accounting data was changed.' -ForegroundColor Gray
Read-Host 'Press Enter to close'
