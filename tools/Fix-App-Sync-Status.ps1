$ErrorActionPreference = "Stop"

$tsxPath = ".\components\VaultApp.tsx"
$cssPath = ".\app\globals.css"

if (!(Test-Path $tsxPath)) { throw "Missing $tsxPath" }

Copy-Item $tsxPath "$tsxPath.backup-sync-status-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
if (Test-Path $cssPath) {
  Copy-Item $cssPath "$cssPath.backup-sync-status-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
}

$tsx = Get-Content -Raw -LiteralPath $tsxPath

# Refresh cloud status every 10 seconds instead of 30.
$tsx = $tsx -replace 'setInterval\(check,\s*30000\)', 'setInterval(check,10000)'

# Voucher edit/create must become pending immediately.
$tsx = $tsx -replace '\.\.\.\(editTx\?\{tallyGuid:editTx\.tallyGuid,syncFingerprint:editTx\.syncFingerprint,syncStatus:editTx\.syncStatus,lastSyncedAt:editTx\.lastSyncedAt\}:\{\}\),', '...(editTx?{tallyGuid:editTx.tallyGuid,syncFingerprint:editTx.syncFingerprint,syncStatus:"pending",lastSyncedAt:undefined}:{syncStatus:"pending",lastSyncedAt:undefined}),'

# Remove duplicate syncState declaration if an earlier patch added it.
$tsx = [regex]::Replace($tsx, '\s*const\s+syncState\s*=\s*getSyncState\(data\);\s*const\s+syncTone\s*=\s*syncState\.tone;\s*const\s+syncLabel\s*=\s*syncState\.label;', '', 1)

# Replace status-color logic. Red wins over everything, yellow for pending/stale, green only for fresh clean status.
$new = 'const syncHealth=(data as any).syncHealth?.[book]||(data as any).syncHealth;const syncAge=syncHealth?.lastCheckedAt?Date.now()-Date.parse(syncHealth.lastCheckedAt):Infinity;const syncHealthFresh=Number.isFinite(syncAge)&&syncAge<5*60*1000;const syncConflicts=Number(syncHealth?.conflicts||0);const syncTallyToApp=Number(syncHealth?.tallyToApp||0);const syncAppToTally=Number(syncHealth?.appToTally||0);const syncLocalPending=(data.transactions||[]).filter((t:any)=>!t.historical&&(t.syncStatus==="pending"||t.deleted||(!t.tallyGuid&&!t.syncFingerprint))).length+(data.accounts||[]).filter((a:any)=>a.masterSyncStatus==="pending"||a.masterDeletePending).length+((data.groups||[]).filter((g:any)=>g.masterSyncStatus==="pending"||g.masterDeletePending).length);const syncTone=syncHealth?.status==="error"||syncConflicts>0?"error":(!syncHealthFresh||syncHealth?.status==="pending"||syncTallyToApp>0||syncAppToTally>0||syncLocalPending>0)?"pending":"success";const syncPending=syncTallyToApp+syncAppToTally+syncLocalPending;const syncErrors=syncConflicts||Number(syncHealth?.errors||0);const syncLabel=syncTone==="error"?`${syncErrors||1} sync issue${(syncErrors||1)===1?"":"s"}`:syncTone==="pending"?`${syncPending||1} pending sync`:"Sync successful";'

$old = 'const\s+syncErrors\s*=\s*[^;]+;\s*const\s+syncPending\s*=\s*[^;]+;\s*const\s+syncTone\s*=\s*[^;]+;\s*const\s+syncLabel\s*=\s*[^;]+;'
if ([regex]::IsMatch($tsx, $old)) {
  $tsx = [regex]::Replace($tsx, $old, $new, 1)
} elseif ($tsx -notmatch 'syncHealthFresh') {
  throw "Could not find sync status block in VaultApp.tsx"
}

Set-Content -LiteralPath $tsxPath -Value $tsx -Encoding UTF8

if (Test-Path $cssPath) {
  $css = Get-Content -Raw -LiteralPath $cssPath
  if ($css -notmatch '\.sync-lock-button\.success') {
    $css += @"

.sync-lock-button.success{background:#dcfce7!important;border-color:#86efac!important;color:#166534!important}
.sync-lock-button.pending{background:#fef9c3!important;border-color:#facc15!important;color:#854d0e!important}
.sync-lock-button.error{background:#fee2e2!important;border-color:#f87171!important;color:#991b1b!important}
"@
    Set-Content -LiteralPath $cssPath -Value $css -Encoding UTF8
  }
}

Write-Host "App sync status fix applied. Now run npm run build." -ForegroundColor Green
