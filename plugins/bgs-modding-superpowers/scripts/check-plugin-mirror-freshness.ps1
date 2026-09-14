#requires -Version 7.0
<#
.SYNOPSIS
  Fail when tools/, skills/, hooks/, or knowledge/ changed without plugins/
  being regenerated to match.

.DESCRIPTION
  plugins/<name>/ is a tracked, generated mirror of tools/, skills/, hooks/,
  and knowledge/ (built by scripts/build-portable-plugin.ps1). Nothing
  enforces that a commit touching the source trees also regenerates the
  mirror -- see docs/internal/reviews/2026-09-14-inherited-project-review.md
  (L1, U5) for a case where the mirror drifted four commits behind and shipped
  stale, hang-prone code.

  This script is a local, opt-in gate, not CI: it finds the most recent
  commit that touched plugins/, then checks whether any commit after that
  touched tools/, skills/, hooks/, or knowledge/. If so, it exits non-zero.
  It does not (and cannot, from this repo alone) stop a GitHub-side push that
  skips the hook -- wire it up via `git config core.hooksPath .githooks` (see
  .githooks/pre-push) so it runs before every push from a checkout that opted
  in.

.PARAMETER RepoRoot
  Repository root to check. Defaults to the parent of this script's
  directory. Tests point this at a scratch worktree so the check never
  touches the real repo's history or working tree.

.PARAMETER Ref
  End of the commit range to check, exclusive of nothing -- i.e. commits up
  to and including this ref are considered "after" the last plugins/ commit.
  Defaults to "HEAD".

.EXAMPLE
  pwsh -NoProfile -File scripts/check-plugin-mirror-freshness.ps1

  Checks the real repo. Exits 0 if plugins/ is caught up, non-zero with a
  message listing the drifted commits otherwise.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$Ref = "HEAD"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
} else {
  $RepoRoot = (Resolve-Path $RepoRoot).Path
}

$watchedPaths = @("tools", "skills", "hooks", "knowledge")

function Invoke-Git {
  param([string[]]$GitArgs)
  $output = & git -C $RepoRoot @GitArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($GitArgs -join ' ') failed: $output"
  }
  return $output
}

# Most recent commit (up to $Ref) that touched the generated mirror.
$lastMirrorCommit = (Invoke-Git @("log", "-1", "--format=%H", $Ref, "--", "plugins/")) -join "`n"
$lastMirrorCommit = $lastMirrorCommit.Trim()

if ([string]::IsNullOrEmpty($lastMirrorCommit)) {
  # plugins/ has never been committed on this ref's history. Nothing to
  # compare against; let build-portable-plugin's own containment checks
  # handle first-time generation instead of failing this gate on it.
  Write-Host "check-plugin-mirror-freshness: plugins/ has no history on $Ref yet; skipping."
  exit 0
}

$range = "$lastMirrorCommit..$Ref"
$logArgs = @("log", "--oneline", $range, "--") + $watchedPaths
$driftLines = @(Invoke-Git $logArgs | Where-Object { $_ -ne "" })

if ($driftLines.Count -gt 0) {
  Write-Host "plugins/bgs-modding-superpowers/ is stale: the following commits changed tools/, skills/, hooks/, or knowledge/ since plugins/ was last regenerated at $($lastMirrorCommit.Substring(0, 12))." -ForegroundColor Red
  foreach ($line in $driftLines) {
    Write-Host "  $line" -ForegroundColor Red
  }
  Write-Host "Fix: pwsh -NoProfile -File scripts/build-portable-plugin.ps1 -OutputDir plugins -Force, then commit the regenerated tree." -ForegroundColor Red
  exit 1
}

Write-Host "check-plugin-mirror-freshness: plugins/ is caught up as of $($lastMirrorCommit.Substring(0, 12))."
exit 0
