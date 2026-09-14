$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Regression test for the SessionStart hook dispatch shim.
#
# hooks/run-hook.cmd previously set BOOTSTRAP inside the `if /I "%HOOK_NAME%"==
# "session-start" ( ... )` block. cmd.exe expands %VAR% references when it
# parses a parenthesized block, before any `set` inside that same block runs,
# so `if exist "%BOOTSTRAP%"` always saw an empty string and the bootstrap
# SKILL.md was silently never emitted -- on every session start, /clear, and
# /compact. See docs/internal/reviews/2026-09-14-inherited-project-review.md
# (L2) for the original repro.

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$hookScript = Join-Path $repoRoot 'hooks\run-hook.cmd'
$bootstrapSkill = Join-Path $repoRoot 'skills\using-bgs-modding-superpowers\SKILL.md'

if (-not (Test-Path -LiteralPath $hookScript)) {
    throw "Hook script not found: $hookScript"
}
if (-not (Test-Path -LiteralPath $bootstrapSkill)) {
    throw "Bootstrap skill not found: $bootstrapSkill"
}

function Invoke-RunHookToFile {
    # Redirect cmd.exe's own stdout straight to a file instead of capturing
    # through PowerShell's pipeline: `&` + Out-String re-splits/re-joins
    # output as text lines and can alter byte-for-byte fidelity, which is
    # exactly what this test needs to preserve.
    param([Parameter(Mandatory)][string]$HookName, [Parameter(Mandatory)][string]$OutFile)
    cmd.exe /c "`"$hookScript`" $HookName > `"$OutFile`" 2>&1"
    return $LASTEXITCODE
}

$workDir = Join-Path ([IO.Path]::GetTempPath()) ('bgs-run-hook-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir -Force | Out-Null
try {
    $sessionStartOut = Join-Path $workDir 'session-start.out'
    $exitCode = Invoke-RunHookToFile -HookName 'session-start' -OutFile $sessionStartOut

    if ($exitCode -ne 0) {
        throw "run-hook.cmd session-start exited $exitCode."
    }
    if (-not (Test-Path -LiteralPath $sessionStartOut) -or (Get-Item -LiteralPath $sessionStartOut).Length -eq 0) {
        throw 'run-hook.cmd session-start produced no output (the batch variable-expansion regression has returned).'
    }

    # session-start must emit the bootstrap skill body verbatim, byte-for-byte.
    $expectedHash = (Get-FileHash -LiteralPath $bootstrapSkill -Algorithm SHA256).Hash
    $actualHash = (Get-FileHash -LiteralPath $sessionStartOut -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) {
        $expectedLen = (Get-Item -LiteralPath $bootstrapSkill).Length
        $actualLen = (Get-Item -LiteralPath $sessionStartOut).Length
        throw "run-hook.cmd session-start output does not match $bootstrapSkill verbatim. " +
            "Expected $expectedLen bytes (hash $expectedHash), got $actualLen bytes (hash $actualHash)."
    }

    # An unrecognized hook name is a silent no-op, not an error and not a dump
    # of the bootstrap skill.
    $unknownOut = Join-Path $workDir 'unknown.out'
    $unknownExit = Invoke-RunHookToFile -HookName 'not-a-real-hook' -OutFile $unknownOut
    if ($unknownExit -ne 0) {
        throw "run-hook.cmd not-a-real-hook exited $unknownExit; expected a silent no-op (exit 0)."
    }
    if ((Test-Path -LiteralPath $unknownOut) -and (Get-Item -LiteralPath $unknownOut).Length -gt 0) {
        throw "run-hook.cmd not-a-real-hook produced output; expected none."
    }

    Write-Host "run-hook.cmd session-start dispatch checks passed ($((Get-Item -LiteralPath $sessionStartOut).Length) bytes emitted, matches $bootstrapSkill)."
}
finally {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
