# One-time setup: adds the sync-secret DPAPI credential this machine was missing (it already had
# access-code/site/us-vault from earlier amex-benefits setup -- sync-secret specifically was only
# ever provisioned on the OTHER machine's Tally sync setup, never here, which is why
# run-scheduled.ps1's Publish-AmexHealth failed with "Missing encrypted credential: sync-secret").
# Only touches this one credential -- does NOT re-prompt for or overwrite the other four, unlike
# ../Repair-Local-Sync-Credentials.ps1 (which replaces all five and would be unnecessary disruption
# here since those four already work fine on this machine).
$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
New-Item -ItemType Directory -Force -Path $state | Out-Null

$secret = Read-Host 'Enter the SYNC_SECRET Worker secret (same value used for ../tally-sync)' -AsSecureString
$payload = ConvertFrom-SecureString -SecureString $secret
if ($payload -notmatch '^[0-9A-Fa-f]+$') {
  throw "Windows DPAPI did not return the expected encrypted format"
}
Set-Content -LiteralPath (Join-Path $state 'sync-secret.dpapi') -Value $payload -Encoding ascii

# Verify it round-trips before declaring success.
$check = (Get-Content -Raw -LiteralPath (Join-Path $state 'sync-secret.dpapi')).Trim()
$null = ConvertTo-SecureString -String $check -ErrorAction Stop
Write-Host "SUCCESS: sync-secret stored for this Windows user under $state" -ForegroundColor Green
