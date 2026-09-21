param(
  [ValidateSet('india','us','both')]
  [string]$Book = 'both'
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
$runtime = Join-Path $state 'runtime'
$logs = Join-Path $state 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# Retention: transcript logs accumulate one file per cycle -- delete anything older than 30 days
# so this directory does not grow unbounded (each cycle runs every few minutes).
try {
  Get-ChildItem -Path $logs -Filter "unattended-cycle-*.log" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
} catch {}

$node = (Get-Content -Raw -LiteralPath (Join-Path $state 'node-path.txt')).Trim()
$siteUrl = 'https://personal-ledger-dk.digneshkhatri.workers.dev'

$transcriptStarted = $false
try {
  $logFile = Join-Path $logs ("unattended-cycle-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Start-Transcript -Path $logFile -Force | Out-Null
  $transcriptStarted = $true
} catch {}

function Log([string]$m) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

function Read-DpapiSecret([string]$Name) {
  $file = Join-Path $state "$Name.dpapi"
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Quote-Arg([string]$x) {
  if ($x -match '[\s"]') { return '"' + ($x -replace '"','\"') + '"' }
  return $x
}

function Invoke-Node([string[]]$NodeArgs, [int]$TimeoutSec = 180) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $outFile = Join-Path $env:TEMP "pl-node-$stamp.out"
  $errFile = Join-Path $env:TEMP "pl-node-$stamp.err"
  $argText = (($NodeArgs | ForEach-Object { Quote-Arg $_ }) -join ' ')

  $p = Start-Process -FilePath $node `
    -ArgumentList $argText `
    -WorkingDirectory $runtime `
    -NoNewWindow `
    -PassThru `
    -RedirectStandardOutput $outFile `
    -RedirectStandardError $errFile

  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    try { $p.Kill() } catch {}
    return [pscustomobject]@{ ExitCode = 124; Text = "Timeout after ${TimeoutSec}s: node $argText" }
  }

  $out = if (Test-Path $outFile) { Get-Content -Raw -LiteralPath $outFile } else { '' }
  $err = if (Test-Path $errFile) { Get-Content -Raw -LiteralPath $errFile } else { '' }
  Remove-Item $outFile,$errFile -Force -ErrorAction SilentlyContinue

  $text = ($out + "`n" + $err).Trim()
  $p.Refresh()
$exitCode = $p.ExitCode
if ($null -eq $exitCode) { $exitCode = 0 }
return [pscustomobject]@{ ExitCode = [int]$exitCode; Text = $text }
}

function Parse-Plan([string]$Text) {
  $m = [regex]::Match($Text, 'PLAN_JSON:(\{[^\r\n]+\})')
  if ($m.Success) {
    $j = $m.Groups[1].Value | ConvertFrom-Json
    return [pscustomobject]@{
      matched = [int]$j.matched
      tallyToApp = [int]$j.tallyToApp
      appToTally = [int]$j.appToTally
      conflicts = [int]$j.conflicts
    }
  }

  $m = [regex]::Match($Text, 'PLAN:\s*(\d+)\s+matched,\s*(\d+)\s+Tally-to-App,\s*(\d+)\s+App-to-Tally,\s*(\d+)\s+conflicts')
  if ($m.Success) {
    return [pscustomobject]@{
      matched = [int]$m.Groups[1].Value
      tallyToApp = [int]$m.Groups[2].Value
      appToTally = [int]$m.Groups[3].Value
      conflicts = [int]$m.Groups[4].Value
    }
  }

  return [pscustomobject]@{ matched = 0; tallyToApp = 0; appToTally = 0; conflicts = 0 }
}

function Get-AppConfirm([string]$Text, [string]$BookName) {
  $m = [regex]::Match($Text, 'APP(?:\s+\w+)?\s*->\s*TALLY:\s*[^|]*\|\s*([A-Za-z]+)\s+([^|\s]+)\s*\|')
  if (-not $m.Success) { return $null }
  return "APPLY $($BookName.ToUpperInvariant()) $($m.Groups[1].Value.ToUpperInvariant()) $($m.Groups[2].Value)"
}

function Get-TallyConfirm([string]$Text, [string]$BookName) {
  $m = [regex]::Match($Text, 'TALLY(?:\s+\w+)?\s*->\s*APP:\s*[^|]*\|\s*([A-Za-z]+)\s+([^|\s]+)\s*\|')
  if (-not $m.Success) { return $null }
  return "APPLY $($BookName.ToUpperInvariant()) $($m.Groups[1].Value.ToUpperInvariant()) $($m.Groups[2].Value)"
}

function Publish-Health([string]$BookName, [string]$Status, $Plan, [string]$Message) {
  $body = [ordered]@{
    book = $BookName
    status = $Status
    lastCheckedAt = (Get-Date).ToUniversalTime().ToString('o')
    matched = [int]$Plan.matched
    tallyToApp = [int]$Plan.tallyToApp
    appToTally = [int]$Plan.appToTally
    conflicts = [int]$Plan.conflicts
    errors = 0
    message = $Message
  } | ConvertTo-Json -Compress

  try {
    Invoke-WebRequest "$siteUrl/api/sync-status?book=$BookName" `
      -Method PUT `
      -Headers @{ Authorization = "Bearer $($env:PL_SYNC_SECRET)" } `
      -ContentType 'application/json' `
      -Body $body `
      -UseBasicParsing | Out-Null
  } catch {
    Log "Status publish failed for ${BookName}: $($_.Exception.Message)"
  }
}

function Sync-Book([string]$BookName, [string]$VaultName, [string]$Port) {
  $lockPath = Join-Path $state "sync-$BookName.lock"
  $lock = $null

  try {
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    Log "$BookName sync already running; skipping this cycle"
    return
  }

  try {
    Log "=== $BookName voucher cycle ==="

    $env:PL_SITE_PASSWORD = Read-DpapiSecret 'site'
    $env:PL_VAULT_PASSWORD = Read-DpapiSecret $VaultName
    $env:PL_ACCESS_CODE = Read-DpapiSecret 'access-code'
    $env:PL_SYNC_SECRET = Read-DpapiSecret 'sync-secret'
    $env:PL_TALLY_PORT = $Port

    $zero = [pscustomobject]@{ matched = 0; tallyToApp = 0; appToTally = 0; conflicts = 0 }

    $master = Invoke-Node @('dual-port-engine-runner.js','master-sync',$BookName) 180
    if ($master.Text) { Write-Host $master.Text }
    $masterErr = [regex]::Match($master.Text, 'MASTER_SYNC_ERROR:\s*(.+)')
    if ($masterErr.Success) {
      $msg = $masterErr.Groups[1].Value.Trim()
      if ($msg.Length -gt 180) { $msg = $msg.Substring(0,180) }
      Publish-Health $BookName 'error' $zero "Master sync: $msg"
    }
    if ($master.ExitCode -ne 0 -and $master.Text -notmatch 'MASTER_SYNC_CLEAN') {
      Publish-Health $BookName 'error' $zero "Master sync failed"
      return
    }

    for ($i = 1; $i -le 25; $i++) {
      $preview = Invoke-Node @('dual-port-engine-runner.js','preview',$BookName) 180
      if ($preview.Text) { Write-Host $preview.Text }

      $plan = Parse-Plan $preview.Text

      if ($preview.ExitCode -ne 0) {
        Publish-Health $BookName 'error' $plan "Preview failed"
        return
      }

      if ($plan.conflicts -gt 0) {
        Publish-Health $BookName 'error' $plan "Conflict requires review"
        return
      }

      if ($plan.tallyToApp -eq 0 -and $plan.appToTally -eq 0) {
        Publish-Health $BookName 'success' $plan "Already synchronized"
        Log "$BookName plan matched=$($plan.matched) tallyToApp=0 appToTally=0 conflicts=0"
        return
      }

      Publish-Health $BookName 'pending' $plan "Sync in progress"

      if ($plan.appToTally -gt 0) {
        $confirm = Get-AppConfirm $preview.Text $BookName
        if (-not $confirm) {
          Publish-Health $BookName 'error' $plan "Could not identify App-to-Tally confirmation"
          return
        }

        Log "$BookName applying App-to-Tally: $confirm"
        $env:PL_APPLY_CONFIRM = $confirm
        $env:PL_APP_CONFIRM = $confirm
        $env:PL_CONFIRM = $confirm

        try {
          $apply = Invoke-Node @('apply-one-app-change.js',$BookName) 180
        } finally {
          $env:PL_APPLY_CONFIRM = $null
          $env:PL_APP_CONFIRM = $null
          $env:PL_CONFIRM = $null
        }

        if ($apply.Text) { Write-Host $apply.Text }
        if ($apply.ExitCode -ne 0 -or $apply.Text -match '(?m)^ERROR:') {
          Publish-Health $BookName 'error' $plan "App-to-Tally apply failed"
          return
        }

        continue
      }

      if ($plan.tallyToApp -gt 0) {
        $confirm = Get-TallyConfirm $preview.Text $BookName
        if (-not $confirm) {
          Publish-Health $BookName 'error' $plan "Could not identify Tally-to-App confirmation"
          return
        }
        Log "$BookName applying Tally-to-App: $confirm"
        $env:PL_APPLY_CONFIRM = $confirm
        $env:PL_TALLY_CONFIRM = $confirm
        $env:PL_CONFIRM = $confirm
        try {
          $pull = Invoke-Node @('dual-port-engine-runner.js','tally-to-app',$BookName) 180
        } finally {
          $env:PL_APPLY_CONFIRM = $null
          $env:PL_TALLY_CONFIRM = $null
          $env:PL_CONFIRM = $null
        }
        if ($pull.Text) { Write-Host $pull.Text }
        if ($pull.ExitCode -ne 0 -or $pull.Text -match '(?m)^ERROR:') {
          Publish-Health $BookName 'error' $plan "Tally-to-App apply failed"
          return
        }
        continue
      }
    }

    Publish-Health $BookName 'error' $zero "Cycle loop limit reached"
  } catch {
    $zero = [pscustomobject]@{ matched = 0; tallyToApp = 0; appToTally = 0; conflicts = 0 }
    Publish-Health $BookName 'error' $zero $_.Exception.Message
    Log "ERROR: $($_.Exception.Message)"
  } finally {
    $env:PL_SITE_PASSWORD = $null
    $env:PL_VAULT_PASSWORD = $null
    $env:PL_ACCESS_CODE = $null
    $env:PL_SYNC_SECRET = $null
    $env:PL_TALLY_PORT = $null
    if ($lock) { $lock.Dispose() }
  }
}

try {
  switch ($Book.ToLowerInvariant()) {
    'india' { Sync-Book 'india' 'india-vault' '9000' }
    'us' { Sync-Book 'us' 'us-vault' '9001' }
    default {
      Sync-Book 'india' 'india-vault' '9000'
      Sync-Book 'us' 'us-vault' '9001'
    }
  }

  Log "cycle complete for $Book"
} finally {
  if ($transcriptStarted) {
    try { Stop-Transcript | Out-Null } catch {}
  }
}
