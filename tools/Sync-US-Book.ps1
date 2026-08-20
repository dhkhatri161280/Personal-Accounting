$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'PersonalLedgerTallySync'
$runtime = Join-Path $state 'runtime'

function Read-DpapiSecret([string]$Name) {
  $file = Join-Path $state "$Name.dpapi"
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing encrypted credential: $Name" }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $file).Trim())
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$node   = (Get-Content -Raw -LiteralPath (Join-Path $state 'node-path.txt')).Trim()
$runner = Join-Path $runtime 'dual-port-engine-runner.js'
if (-not (Test-Path -LiteralPath $node))   { throw "Local Node runtime was not found: $node" }
if (-not (Test-Path -LiteralPath $runner)) { throw "Sync runner was not found: $runner" }

Write-Host 'FINTECH BY DK - US BOOK SYNC' -ForegroundColor Cyan
Write-Host 'Tally must be open on port 9001 before continuing.' -ForegroundColor Yellow
Write-Host ''

$env:PL_SITE_PASSWORD  = Read-DpapiSecret 'site'
$env:PL_VAULT_PASSWORD = Read-DpapiSecret 'us-vault'

try {
  # ── Step 1: Preview ─────────────────────────────────────────────────────
  Write-Host '=== STEP 1: PREVIEW (read-only) ===' -ForegroundColor Cyan
  & $node $runner preview us
  if ($LASTEXITCODE -ne 0) { throw 'Preview failed' }

  Write-Host ''
  $confirm = Read-Host 'Review the plan above. Type YES to proceed with sync, anything else to abort'
  if ($confirm -ne 'YES') { Write-Host 'Aborted. No data was changed.' -ForegroundColor Yellow; return }

  # ── Step 2: App -> Tally (push app changes to Tally) ────────────────────
  Write-Host ''
  Write-Host '=== STEP 2: APP -> TALLY ===' -ForegroundColor Cyan
  $maxCycles = 60
  $cycle = 0
  do {
    $cycle++
    if ($cycle -gt $maxCycles) { throw "Safety stop: exceeded $maxCycles app-to-tally cycles" }

    # Dry-run to discover what confirmation string is needed
    $env:PL_APPLY_CONFIRM = ''
    $output = & $node $runner app-to-tally us 2>&1 | Out-String

    # Parse "Expected exactly: APPLY US <TYPE> <NUMBER>" from the output
    $match = [regex]::Match($output, 'Expected exactly:\s*(APPLY\s+US\s+\S+\s+\S+)')
    if (-not $match.Success) {
      # No more app->tally pending, or all done
      if ($output -match 'QUEUE_REMAINING: 0' -or $output -match 'candidates\.length.*<.*1' -or $output -match 'Safety stop: expected at least one') {
        Write-Host '  App->Tally: nothing remaining.' -ForegroundColor Green
        break
      }
      # Check if it completed cleanly without queue
      if ($output -match 'SUCCESS:') {
        Write-Host $output.Trim()
        continue
      }
      Write-Host $output.Trim()
      break
    }

    $confirmStr = $match.Groups[1].Value.Trim()
    Write-Host "  Applying: $confirmStr" -ForegroundColor White

    $env:PL_APPLY_CONFIRM = $confirmStr
    $result = & $node $runner app-to-tally us 2>&1 | Out-String
    Write-Host $result.Trim()

    if ($LASTEXITCODE -ne 0) { throw "app-to-tally failed on: $confirmStr" }

    $remaining = [regex]::Match($result, 'QUEUE_REMAINING:\s*(\d+)')
    if ($remaining.Success -and [int]$remaining.Groups[1].Value -eq 0) { break }
    if ($result -notmatch 'QUEUE_REMAINING') { break }

  } while ($true)

  # ── Step 3: Tally -> App (pull Tally changes into App) ──────────────────
  Write-Host ''
  Write-Host '=== STEP 3: TALLY -> APP ===' -ForegroundColor Cyan
  $cycle = 0
  do {
    $cycle++
    if ($cycle -gt $maxCycles) { throw "Safety stop: exceeded $maxCycles tally-to-app cycles" }

    $env:PL_APPLY_CONFIRM = ''
    $output = & $node $runner tally-to-app us 2>&1 | Out-String

    $match = [regex]::Match($output, 'Expected exactly:\s*(APPLY\s+US\s+\S+\s+\S+)')
    if (-not $match.Success) {
      Write-Host $output.Trim()
      break
    }

    $confirmStr = $match.Groups[1].Value.Trim()
    Write-Host "  Applying: $confirmStr" -ForegroundColor White

    $env:PL_APPLY_CONFIRM = $confirmStr
    $result = & $node $runner tally-to-app us 2>&1 | Out-String
    Write-Host $result.Trim()

    if ($LASTEXITCODE -ne 0) { throw "tally-to-app failed on: $confirmStr" }

    $remaining = [regex]::Match($result, 'QUEUE_REMAINING:\s*(\d+)')
    if ($remaining.Success -and [int]$remaining.Groups[1].Value -eq 0) { break }
    if ($result -notmatch 'QUEUE_REMAINING') { break }

  } while ($true)

  # ── Step 4: Final verification ───────────────────────────────────────────
  Write-Host ''
  Write-Host '=== STEP 4: FINAL VERIFICATION ===' -ForegroundColor Cyan
  & $node $runner preview us
  if ($LASTEXITCODE -ne 0) { throw 'Final verification preview failed' }

  Write-Host ''
  Write-Host 'SYNC COMPLETE. Review the final plan above — should show 0 pending.' -ForegroundColor Green

} finally {
  $env:PL_SITE_PASSWORD  = $null
  $env:PL_VAULT_PASSWORD = $null
  $env:PL_APPLY_CONFIRM  = $null
}

Read-Host 'Press Enter to close'
