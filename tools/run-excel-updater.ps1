# run-excel-updater.ps1
# Updates Personal Finance USA.xls from the US accounting vault.
# Node.js computes the cell changes; Excel COM applies them — formatting is fully preserved.
#
# Usage:
#   .\run-excel-updater.ps1           — full update (backup + write via Excel COM)
#   .\run-excel-updater.ps1 -DryRun   — compute only, print what would change, write nothing
#   .\run-excel-updater.ps1 -Inspect  — dump sheet structure, no vault fetch

param(
  [switch]$DryRun,
  [switch]$Inspect,
  [switch]$Accounts,
  [string]$Sheet = ''
)

$ErrorActionPreference = 'Stop'

# ─── PATHS ────────────────────────────────────────────────────────────────────

$state     = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$syncDir   = Join-Path $scriptDir 'excel-sync'
$updater   = Join-Path $syncDir 'excel-updater.js'
$changesFile = Join-Path $syncDir 'pending-changes.json'

# Locate node
$nodePathFile = Join-Path $state 'node-path.txt'
if (Test-Path -LiteralPath $nodePathFile) {
  $node = (Get-Content -Raw -LiteralPath $nodePathFile).Trim()
} else {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $node = if ($nodeCmd) { $nodeCmd.Source } else { $null }
}
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  throw "Node.js not found. Expected path file: $nodePathFile"
}
if (-not (Test-Path -LiteralPath $updater)) {
  throw "excel-updater.js not found at: $updater"
}

# ─── DPAPI SECRET READER ──────────────────────────────────────────────────────

function Read-DpapiSecret([string]$Name) {
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) {
    throw "Missing credential: $file`nRun Repair-Local-Sync-Credentials.ps1 to re-enter credentials."
  }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr    = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try   { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# ─── NPM INSTALL ──────────────────────────────────────────────────────────────

$xlsxDir = Join-Path $syncDir 'node_modules\xlsx'
if (-not (Test-Path -LiteralPath $xlsxDir)) {
  Write-Host 'Installing xlsx package (first run)...' -ForegroundColor Cyan
  $npm = Join-Path (Split-Path $node) 'npm.cmd'
  if (-not (Test-Path -LiteralPath $npm)) { $npm = 'npm' }
  Push-Location $syncDir
  try { & $npm install --prefer-offline 2>&1 | Write-Host }
  finally { Pop-Location }
  if (-not (Test-Path -LiteralPath $xlsxDir)) { throw 'npm install failed' }
  Write-Host 'Package installed.' -ForegroundColor Green
}

# ─── BUILD NODE ARGS ──────────────────────────────────────────────────────────

Write-Host 'FINTECH BY DK - EXCEL UPDATER' -ForegroundColor Cyan

$nodeArgs = @($updater)
if ($DryRun)          { $nodeArgs += '--dry-run' }
if ($Inspect)         { $nodeArgs += '--inspect' }
if ($Accounts)        { $nodeArgs += '--accounts' }
if ($Sheet -ne '')    { $nodeArgs += $Sheet }

# ─── STEP 1: RUN NODE (compute changes) ───────────────────────────────────────

try {
  if (-not $Inspect) {
    $env:PL_SITE_PASSWORD  = Read-DpapiSecret 'site'
    $env:PL_VAULT_PASSWORD = Read-DpapiSecret 'us-vault'
  }
  & $node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "excel-updater.js failed (exit $LASTEXITCODE)" }
} finally {
  $env:PL_SITE_PASSWORD  = $null
  $env:PL_VAULT_PASSWORD = $null
}

# Dry-run and inspect stop here — no Excel COM needed
if ($DryRun -or $Inspect -or $Accounts) { Write-Host "`nDone." -ForegroundColor Green; return }

# ─── STEP 2: APPLY VIA EXCEL COM (preserves all formatting) ──────────────────

if (-not (Test-Path -LiteralPath $changesFile)) {
  throw "pending-changes.json not found. Node step may have failed."
}

$payload  = Get-Content -Raw -LiteralPath $changesFile | ConvertFrom-Json
$excelPath = $payload.excelPath
$changes   = $payload.changes

Write-Host "Applying $($changes.Count) cell update(s) via Excel COM..." -ForegroundColor Cyan

# Backup before touching anything
$stamp      = Get-Date -Format 'yyyy-MM-dd'
$backupPath = $excelPath -replace '\.xls$', "_backup_$stamp.xls"
Copy-Item -LiteralPath $excelPath -Destination $backupPath -Force
Write-Host "Backup: $(Split-Path -Leaf $backupPath)"

$excel = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible        = $false
  $excel.DisplayAlerts  = $false
  $excel.ScreenUpdating = $false

  # Open with UpdateLinks=0, ReadOnly=false, Password=''
  $wb = $excel.Workbooks.Open($excelPath, 0, $false)

  # Group changes by sheet
  $bySheet = @{}
  foreach ($ch in $changes) {
    if (-not $bySheet.ContainsKey($ch.sheet)) { $bySheet[$ch.sheet] = [System.Collections.Generic.List[object]]::new() }
    $bySheet[$ch.sheet].Add($ch)
  }

  foreach ($sheetName in $bySheet.Keys) {
    $ws = $wb.Sheets[$sheetName]
    if (-not $ws) { Write-Warning "Sheet not found: $sheetName"; continue }

    # Unprotect if needed (try empty password first)
    if ($ws.ProtectContents) {
      try { $ws.Unprotect('') } catch {}
    }

    $ok = 0; $skip = 0
    foreach ($ch in $bySheet[$sheetName]) {
      try {
        $ws.Cells[[int]$ch.row, [int]$ch.col].Value2 = [double]$ch.value
        $ok++
      } catch {
        $skip++
      }
    }
    $msg = "  $sheetName`: $ok cell(s) written"
    if ($skip -gt 0) { $msg += " ($skip skipped - protected)" }
    Write-Host $msg
  }

  # Force save even if Excel thinks nothing changed
  $wb.Saved = $false
  $wb.Save()
  $wb.Close($false)
  Write-Host ('Saved: ' + $excelPath) -ForegroundColor Green

} finally {
  if ($excel) {
    try { $excel.Quit() } catch {}
    [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  }
  if (Test-Path -LiteralPath $changesFile) { Remove-Item -LiteralPath $changesFile -Force }
}

Write-Host 'Done.' -ForegroundColor Green
