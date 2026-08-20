$ErrorActionPreference = 'Stop'

$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
if (-not (Test-Path -LiteralPath $state)) {
  New-Item -ItemType Directory -Path $state -Force | Out-Null
}

function Save-DpapiSecret([string]$Name, [string]$Prompt) {
  $secret = Read-Host $Prompt -AsSecureString
  $payload = ConvertFrom-SecureString -SecureString $secret
  if ($payload -notmatch '^[0-9A-Fa-f]+$') {
    throw "Windows DPAPI did not return the expected encrypted format for $Name"
  }
  Set-Content -LiteralPath (Join-Path $state "$Name.dpapi") -Value $payload -Encoding ascii
}

Write-Host 'FINTECH BY DK - EXCEL SYNC CREDENTIAL SETUP' -ForegroundColor Cyan
Write-Host 'Stores the two secrets run-excel-updater.ps1 needs for the US book: site password and US vault password.' -ForegroundColor Yellow
Write-Host 'Credentials are protected by Windows DPAPI for this Windows user on this machine only.' -ForegroundColor Cyan

Save-DpapiSecret 'site' 'Enter the FinTech by DK website password'
Save-DpapiSecret 'us-vault' 'Enter the US encrypted vault password'

foreach ($name in 'site', 'us-vault') {
  $file = Join-Path $state "$name.dpapi"
  $payload = (Get-Content -Raw -LiteralPath $file).Trim()
  if ($payload -notmatch '^[0-9A-Fa-f]+$') { throw "Credential verification failed for $name" }
  $null = ConvertTo-SecureString -String $payload -ErrorAction Stop
}

Write-Host 'SUCCESS: Excel sync credentials stored.' -ForegroundColor Green
Write-Host "Stored under: $state" -ForegroundColor Gray
Read-Host 'Press Enter to close'
