$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
$logFile = Join-Path $logDir 'git-pull-log.txt'

if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Log([string]$msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $msg"
  Add-Content -LiteralPath $logFile -Value $line
}

try {
  Set-Location -LiteralPath $repoPath

  # Don't silently pull over uncommitted local changes -- if something was edited directly on
  # this laptop, surface that in the log instead of risking a lossy merge.
  $status = git status --porcelain
  if ($status) {
    Log "SKIPPED: uncommitted local changes present in $repoPath -- run 'git status' to review."
    exit 0
  }

  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  $before = (git rev-parse HEAD).Trim()
  $output = git pull --ff-only 2>&1 | Out-String
  $after = (git rev-parse HEAD).Trim()

  if ($before -eq $after) {
    Log "OK: already up to date ($branch @ $($before.Substring(0,7)))"
  } else {
    Log "OK: updated $branch $($before.Substring(0,7)) -> $($after.Substring(0,7))"
  }
} catch {
  Log "ERROR: $($_.Exception.Message)"
}
