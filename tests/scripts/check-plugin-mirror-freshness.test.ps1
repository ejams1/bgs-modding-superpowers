$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Regression test for scripts/check-plugin-mirror-freshness.ps1 -- the local
# pre-push gate that fails when tools/, skills/, hooks/, or knowledge/
# changed without plugins/ being regenerated to match. See
# docs/internal/reviews/2026-09-14-inherited-project-review.md (L1, U5).
#
# Runs entirely against a throwaway scratch git repository (not this repo's
# own history or working tree) so it can construct both a "drifted" and a
# "caught up" commit graph deterministically.

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$checkScript = Join-Path $repoRoot 'scripts\check-plugin-mirror-freshness.ps1'

if (-not (Test-Path -LiteralPath $checkScript)) {
    throw "Check script not found: $checkScript"
}

$scratchRoot = Join-Path ([IO.Path]::GetTempPath()) ('bgs-mirror-freshness-test-' + [Guid]::NewGuid().ToString('N'))

function Invoke-GitScratch {
    param([Parameter(Mandatory)][string[]]$GitArgs)
    $output = & git -C $scratchRoot -c user.name='Test' -c user.email='test@example.invalid' @GitArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed in scratch repo: $output"
    }
    return $output
}

function Write-ScratchFile {
    param([Parameter(Mandatory)][string]$RelativePath, [Parameter(Mandatory)][string]$Content)
    $full = Join-Path $scratchRoot $RelativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $full) -Force | Out-Null
    [IO.File]::WriteAllText($full, $Content, [Text.UTF8Encoding]::new($false))
}

try {
    New-Item -ItemType Directory -Path $scratchRoot -Force | Out-Null
    Invoke-GitScratch @('init', '-q', '-b', 'main') | Out-Null

    # Commit 1: seed tools/ and a matching plugins/ mirror together, the way
    # a real "chore(plugin-pack): mirror ..." commit would.
    Write-ScratchFile 'tools/widget.txt' 'v1'
    Write-ScratchFile 'skills/widget/SKILL.md' 'v1'
    Write-ScratchFile 'hooks/run-hook.cmd' 'v1'
    Write-ScratchFile 'knowledge/pack.txt' 'v1'
    Write-ScratchFile 'plugins/bgs-modding-superpowers/tools/widget.txt' 'v1'
    Invoke-GitScratch @('add', '-A') | Out-Null
    Invoke-GitScratch @('commit', '-q', '-m', 'chore(plugin-pack): seed mirror') | Out-Null

    # Sanity check: freshly seeded, plugins/ should already be caught up.
    $freshExit = 0
    $freshOutput = & pwsh -NoProfile -File $checkScript -RepoRoot $scratchRoot 2>&1
    $freshExit = $LASTEXITCODE
    if ($freshExit -ne 0) {
        throw "Expected exit 0 immediately after seeding a matched commit, got $freshExit. Output:`n$freshOutput"
    }

    # Commit 2: change tools/ only -- this is the drift scenario. plugins/ is
    # now stale relative to this commit.
    Write-ScratchFile 'tools/widget.txt' 'v2 -- behavior change'
    Invoke-GitScratch @('add', '-A') | Out-Null
    Invoke-GitScratch @('commit', '-q', '-m', 'fix(widget): change behavior') | Out-Null

    $driftExit = 0
    $driftOutput = & pwsh -NoProfile -File $checkScript -RepoRoot $scratchRoot 2>&1
    $driftExit = $LASTEXITCODE
    if ($driftExit -eq 0) {
        throw "Expected a non-zero exit once tools/ drifted ahead of plugins/, got 0. Output:`n$driftOutput"
    }
    if (($driftOutput | Out-String) -notmatch 'fix\(widget\): change behavior') {
        throw "Drift output did not name the offending commit. Output:`n$driftOutput"
    }
    if (($driftOutput | Out-String) -notmatch 'build-portable-plugin\.ps1') {
        throw "Drift output did not point at scripts/build-portable-plugin.ps1 as the fix. Output:`n$driftOutput"
    }

    # Commit 3: regenerate the mirror to match -- drift should clear.
    Write-ScratchFile 'plugins/bgs-modding-superpowers/tools/widget.txt' 'v2 -- behavior change'
    Invoke-GitScratch @('add', '-A') | Out-Null
    Invoke-GitScratch @('commit', '-q', '-m', 'chore(plugin-pack): mirror widget change into plugins/') | Out-Null

    $caughtUpExit = 0
    $caughtUpOutput = & pwsh -NoProfile -File $checkScript -RepoRoot $scratchRoot 2>&1
    $caughtUpExit = $LASTEXITCODE
    if ($caughtUpExit -ne 0) {
        throw "Expected exit 0 after regenerating the mirror, got $caughtUpExit. Output:`n$caughtUpOutput"
    }

    # A change under skills/ with no plugins/ follow-up must also be caught.
    Write-ScratchFile 'skills/widget/SKILL.md' 'v2'
    Invoke-GitScratch @('add', '-A') | Out-Null
    Invoke-GitScratch @('commit', '-q', '-m', 'docs(skills): tweak widget skill') | Out-Null

    $skillsDriftExit = 0
    $skillsDriftOutput = & pwsh -NoProfile -File $checkScript -RepoRoot $scratchRoot 2>&1
    $skillsDriftExit = $LASTEXITCODE
    if ($skillsDriftExit -eq 0) {
        throw "Expected a non-zero exit once skills/ drifted ahead of plugins/, got 0. Output:`n$skillsDriftOutput"
    }

    Write-Host "check-plugin-mirror-freshness.ps1 checks passed (fresh=0, drift=$driftExit tools/, drift=$skillsDriftExit skills/, caught-up-again=0)."
}
finally {
    Remove-Item -LiteralPath $scratchRoot -Recurse -Force -ErrorAction SilentlyContinue
}
