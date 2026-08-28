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

# Runs the runner with stderr redirected into the output stream (2>&1) WITHOUT the
# script-wide $ErrorActionPreference='Stop' converting every stderr line the runner writes
# into an uncatchable terminating error -- that's the exact crash class the "skip when nothing
# pending" fix above only patched for one specific message. Any other benign stderr text
# (a progress note, a differently-worded warning) at any of these call sites would still crash
# the whole script uncatchably without this. $LASTEXITCODE is checked explicitly by the caller
# instead of relying on PowerShell's blanket stderr-is-fatal behavior.
function Invoke-Runner([string[]]$RunnerArgs) {
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    return & $node $runner @RunnerArgs 2>&1 | Out-String
  } finally {
    $ErrorActionPreference = $prevPref
  }
}

Write-Host 'FINTECH BY DK - US BOOK SYNC' -ForegroundColor Cyan
Write-Host 'Tally must be open on port 9001 before continuing.' -ForegroundColor Yellow
Write-Host ''

$env:PL_SITE_PASSWORD  = Read-DpapiSecret 'site'
$env:PL_VAULT_PASSWORD = Read-DpapiSecret 'us-vault'

try {
  # ── Step 1: Preview ─────────────────────────────────────────────────────
  Write-Host '=== STEP 1: PREVIEW (read-only) ===' -ForegroundColor Cyan
  $previewOutput = Invoke-Runner @('preview', 'us')
  Write-Host $previewOutput.Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Preview failed' }

  # Parse the plan's own counts so Steps 2/3 can skip a phase entirely when the
  # preview already says there's nothing on that side -- the runner throws a hard
  # "Safety stop" error if asked to push/pull with zero real candidates instead of
  # just no-op'ing, so it's simplest to never call it in that case.
  $appToTallyCount = 0
  $tallyToAppCount = 0
  $planMatch = [regex]::Match($previewOutput, 'PLAN_JSON:(\{.*\})')
  if ($planMatch.Success) {
    try {
      $plan = $planMatch.Groups[1].Value | ConvertFrom-Json
      $appToTallyCount = [int]$plan.appToTally
      $tallyToAppCount = [int]$plan.tallyToApp
    } catch {
      Write-Host '  Could not parse plan counts -- will attempt both phases as before.' -ForegroundColor Yellow
      $appToTallyCount = 1
      $tallyToAppCount = 1
    }
  }

  # A "TALLY DELETE -> APP" line means an App-side voucher whose Tally link no longer resolves
  # (e.g. because it was deleted directly in Tally during manual cleanup) gets marked deleted
  # in the App too, on the theory that Tally's missing copy is authoritative. That's often
  # right, but it's genuinely destructive if it's actually a real, still-valid record that just
  # lost its link -- confirmed real risk of this exact thing happening. Never let this run
  # unattended: require a SEPARATE explicit confirmation, showing exactly what it wants to
  # delete, before Step 3 is allowed to touch anything.
  $deleteLines = [regex]::Matches($previewOutput, 'TALLY DELETE -> APP:.*(?:\r?\n(?!TALLY|APP).*)*')
  if ($deleteLines.Count -gt 0) {
    Write-Host ''
    Write-Host "WARNING: $($deleteLines.Count) voucher(s) above are proposed for DELETION from the App:" -ForegroundColor Red
    foreach ($m in $deleteLines) { Write-Host $m.Value.Trim() -ForegroundColor Red }
    Write-Host 'If any of these are real, still-valid records, do NOT confirm -- investigate first.' -ForegroundColor Yellow
    $deleteConfirm = Read-Host 'Type DELETE to allow these specific deletions in Step 3, anything else to skip Step 3 entirely'
    $allowTallyDeletes = ($deleteConfirm -eq 'DELETE')
  } else {
    $allowTallyDeletes = $true
  }

  Write-Host ''
  $confirm = Read-Host 'Review the plan above. Type YES to proceed with sync, anything else to abort'
  if ($confirm -ne 'YES') { Write-Host 'Aborted. No data was changed.' -ForegroundColor Yellow; return }

  # ── Step 2: App -> Tally (push app changes to Tally) ────────────────────
  Write-Host ''
  Write-Host '=== STEP 2: APP -> TALLY ===' -ForegroundColor Cyan
  $maxCycles = 60
  # REVERTED: this used to auto-retry a failed candidate up to 8 times with a settling delay.
  # Confirmed by direct observation that this caused genuine duplicate postings in Tally (e.g.
  # the same $3,033 NVDA dividend landing as two separate Tally vouchers) -- the runner's
  # dry-run/apply disagreement isn't a harmless race to retry past, it can mean a "failed"
  # attempt still partially went through. Stop immediately on any failure instead; a human
  # needs to check Tally for a partial write before trying that candidate again.
  if ($appToTallyCount -le 0) {
    Write-Host '  App->Tally: nothing pending per preview -- skipping.' -ForegroundColor Green
  } else {
  $cycle = 0
  do {
    $cycle++
    if ($cycle -gt $maxCycles) { throw "Safety stop: exceeded $maxCycles app-to-tally cycles" }

    # Dry-run to discover what confirmation string is needed
    $env:PL_APPLY_CONFIRM = ''
    $output = Invoke-Runner @('app-to-tally', 'us')

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
    $result = Invoke-Runner @('app-to-tally', 'us')
    Write-Host $result.Trim()

    if ($LASTEXITCODE -ne 0) { throw "app-to-tally failed on: $confirmStr -- CHECK TALLY for a partial duplicate before retrying" }

    # The vault lives in Cloudflare KV, which doesn't guarantee a write is visible everywhere
    # the instant it completes -- the very next dry-run (a few hundred ms later, in the next
    # loop iteration) was observed reading a stale copy that still thought this just-synced
    # voucher was pending, proposing it again, only for the apply call moments later to see the
    # real state and reject it. Give KV time to actually propagate before asking again. This is
    # ONLY a delay -- no auto-retry on failure -- so it can't reproduce the duplicate-posting
    # bug from the earlier auto-retry attempt.
    Start-Sleep -Seconds 10

    $remaining = [regex]::Match($result, 'QUEUE_REMAINING:\s*(\d+)')
    if ($remaining.Success -and [int]$remaining.Groups[1].Value -eq 0) { break }
    if ($result -notmatch 'QUEUE_REMAINING') { break }

  } while ($true)
  }

  # ── Step 3: Tally -> App (pull Tally changes into App) ──────────────────
  Write-Host ''
  Write-Host '=== STEP 3: TALLY -> APP ===' -ForegroundColor Cyan
  if (-not $allowTallyDeletes) {
    Write-Host '  Skipped -- deletions were not confirmed above. Re-run and type DELETE if you have verified they are safe.' -ForegroundColor Yellow
  } elseif ($tallyToAppCount -le 0) {
    Write-Host '  Tally->App: nothing pending per preview -- skipping.' -ForegroundColor Green
  } else {
  $cycle = 0
  do {
    $cycle++
    if ($cycle -gt $maxCycles) { throw "Safety stop: exceeded $maxCycles tally-to-app cycles" }

    $env:PL_APPLY_CONFIRM = ''
    $output = Invoke-Runner @('tally-to-app', 'us')

    $match = [regex]::Match($output, 'Expected exactly:\s*(APPLY\s+US\s+\S+\s+\S+)')
    if (-not $match.Success) {
      Write-Host $output.Trim()
      break
    }

    $confirmStr = $match.Groups[1].Value.Trim()
    Write-Host "  Applying: $confirmStr" -ForegroundColor White

    $env:PL_APPLY_CONFIRM = $confirmStr
    $result = Invoke-Runner @('tally-to-app', 'us')
    Write-Host $result.Trim()

    if ($LASTEXITCODE -ne 0) { throw "tally-to-app failed on: $confirmStr -- CHECK TALLY for a partial duplicate before retrying" }

    # Same KV-propagation reasoning as Step 2 above.
    Start-Sleep -Seconds 10

    $remaining = [regex]::Match($result, 'QUEUE_REMAINING:\s*(\d+)')
    if ($remaining.Success -and [int]$remaining.Groups[1].Value -eq 0) { break }
    if ($result -notmatch 'QUEUE_REMAINING') { break }

  } while ($true)
  }

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
