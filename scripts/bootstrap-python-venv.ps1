#requires -Version 7.0
<#
.SYNOPSIS
Bootstrap the dedicated Python virtual environment used by this plugin's
Python-backed components (currently the mo2-mcp sidecar).

.DESCRIPTION
Several parts of bgs-modding-superpowers shell out to Python. Before this
script existed the mo2-mcp TypeScript server spawned a bare `python` off PATH,
which meant the sidecar only worked if the user had already installed
`mo2-mcp-sidecar` (plus pyfomod and py7zr) into whatever interpreter happened
to be first on PATH — usually a global system Python. That is both fragile and
invasive.

This script instead creates one plugin-owned virtual environment and installs
the Python dependencies into it. Nothing is written to the system interpreter.

Default location:

  ~/.bgs-modding-superpowers/venv

That root is deliberately the same one the KB cache already uses. It lives
outside the plugin tree, so it survives plugin reinstalls and works when the
plugin itself is materialized read-only into a marketplace cache.

Discovery is automatic: `resolveSidecarPython()` in tools/mo2-mcp/src/
sidecar-client.ts probes $BGS_PYTHON, then this venv, then falls back to bare
`python`. No configuration step is needed after a successful bootstrap. Set
$env:BGS_PYTHON only to point at an interpreter somewhere else.

What gets installed:
  - mo2-mcp-sidecar   (from tools/mo2-mcp-sidecar in this repo)
  - pyfomod, py7zr    (its declared dependencies)

Without this, `sidecarReady` stays false and 11 mo2_* tools degrade:
mo2_install, mo2_reinstall_mod, mo2_remove_mod, mo2_rename_mod,
mo2_send_mod_to, mo2_toggle_mod, mo2_switch_profile, and the three
mo2_assets_* conflict tools.

.PARAMETER VenvPath
Where the virtual environment lives. Default:
~/.bgs-modding-superpowers/venv

.PARAMETER PythonExe
Interpreter used to CREATE the venv. Default: auto-detect the newest available
CPython >= 3.11 (the sidecar's requires-python floor), preferring the Windows
`py` launcher.

.PARAMETER Editable
Install the sidecar in editable mode (`pip install -e`). Use this in a dev
checkout so source edits take effect without reinstalling. Not appropriate for
an end-user install, where the source tree may move.

.PARAMETER SkipSidecar
Create and upgrade the venv but do not install the sidecar package. Useful when
you only want the interpreter provisioned.

.PARAMETER Force
Delete and recreate the venv if one already exists.

.EXAMPLE
pwsh scripts/bootstrap-python-venv.ps1

.EXAMPLE
pwsh scripts/bootstrap-python-venv.ps1 -Editable -Force

.EXAMPLE
pwsh scripts/bootstrap-python-venv.ps1 -VenvPath D:\venvs\bgs -PythonExe C:\Python312\python.exe
#>
[CmdletBinding()]
param(
  [string]$VenvPath,
  [string]$PythonExe,
  [switch]$Editable,
  [switch]$SkipSidecar,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$MinPython = [version]"3.11"
# Newest interpreter with binary wheels for the whole dependency set; see the
# lxml note in Resolve-CreatorPython.
$PreferredMaxPython = [version]"3.12"

function Write-Step {
  param([string]$Message)
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-DefaultVenvPath {
  # Mirror resolveSidecarPython() in tools/mo2-mcp/src/sidecar-client.ts and the
  # KB cache root in tools/bgs-kb-mcp/src/discovery/resolve-roots.ts. If this
  # default ever changes, change it in all three places or auto-discovery breaks.
  # NB: $HOME is a read-only PowerShell automatic variable — never assign to it.
  $userHome = [Environment]::GetFolderPath("UserProfile")
  if ([string]::IsNullOrWhiteSpace($userHome)) {
    throw "Could not resolve the user profile directory; pass -VenvPath explicitly."
  }
  return Join-Path $userHome ".bgs-modding-superpowers/venv"
}

function Get-VenvPython {
  param([string]$Root)
  # Windows venvs put the interpreter in Scripts/; POSIX venvs use bin/.
  $windows = Join-Path $Root "Scripts/python.exe"
  if (Test-Path -LiteralPath $windows) { return $windows }
  $posix = Join-Path $Root "bin/python"
  if (Test-Path -LiteralPath $posix) { return $posix }
  return $null
}

function Test-PythonCandidate {
  param([string]$Exe, [string[]]$PreArgs = @())
  # Returns the [version] the candidate reports, or $null if it is unusable.
  try {
    $argv = @($PreArgs) + @("-c", "import sys; print('%d.%d' % sys.version_info[:2])")
    $out = & $Exe @argv 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($out)) { return $null }
    return [version]($out.Trim())
  } catch {
    return $null
  }
}

function Resolve-CreatorPython {
  # Ordered candidates: the py launcher's explicit versions first (most precise
  # on Windows), then bare interpreters. First one meeting the floor wins.
  #
  # Deliberately NOT newest-first. The sidecar depends on pyfomod, which pins
  # lxml<5; lxml 4.x publishes no cp313 wheels, so on Python 3.13 pip falls back
  # to building lxml from source and fails unless libxml2 headers and a C
  # toolchain are present. 3.12 is the newest interpreter with a clean
  # binary-wheel path for the whole dependency set, so prefer it, then 3.11.
  # Newer versions stay in the list as a last resort for a machine that has
  # nothing else — the install may then need a build toolchain.
  $candidates = @(
    @{ Exe = "py";      PreArgs = @("-3.12") },
    @{ Exe = "py";      PreArgs = @("-3.11") },
    @{ Exe = "py";      PreArgs = @("-3.13") },
    @{ Exe = "py";      PreArgs = @("-3") },
    @{ Exe = "python3"; PreArgs = @() },
    @{ Exe = "python";  PreArgs = @() }
  )

  foreach ($candidate in $candidates) {
    $version = Test-PythonCandidate -Exe $candidate.Exe -PreArgs $candidate.PreArgs
    if ($null -ne $version -and $version -ge $MinPython) {
      if ($version -gt $PreferredMaxPython) {
        Write-Warning "Only Python $version was found. pyfomod pins lxml<5, which has no wheels for this version; the install may need to build lxml from source. Install Python $PreferredMaxPython if it fails."
      }
      return @{ Exe = $candidate.Exe; PreArgs = $candidate.PreArgs; Version = $version }
    }
  }

  throw "No CPython >= $MinPython found on PATH. Install Python $MinPython or newer, or pass -PythonExe."
}

# ---- 1. Resolve target paths ------------------------------------------------

if ([string]::IsNullOrWhiteSpace($VenvPath)) {
  $VenvPath = Get-DefaultVenvPath
}
$VenvPath = [IO.Path]::GetFullPath($VenvPath)

Write-Step "Target venv: $VenvPath"

if ($Force -and (Test-Path -LiteralPath $VenvPath)) {
  Write-Host "  -Force given; removing existing venv"
  Remove-Item -LiteralPath $VenvPath -Recurse -Force
}

# ---- 2. Create the venv if needed -------------------------------------------

$venvPython = Get-VenvPython -Root $VenvPath

if ($null -eq $venvPython) {
  if ([string]::IsNullOrWhiteSpace($PythonExe)) {
    $creator = Resolve-CreatorPython
    Write-Step "Creating venv with $($creator.Exe) $($creator.PreArgs -join ' ') (Python $($creator.Version))"
    $createArgs = @($creator.PreArgs) + @("-m", "venv", $VenvPath)
    & $creator.Exe @createArgs
  } else {
    $version = Test-PythonCandidate -Exe $PythonExe
    if ($null -eq $version) {
      throw "Could not run '$PythonExe'."
    }
    if ($version -lt $MinPython) {
      throw "'$PythonExe' is Python $version; the sidecar requires >= $MinPython."
    }
    Write-Step "Creating venv with $PythonExe (Python $version)"
    & $PythonExe -m venv $VenvPath
  }

  if ($LASTEXITCODE -ne 0) {
    throw "venv creation failed (exit $LASTEXITCODE)"
  }

  $venvPython = Get-VenvPython -Root $VenvPath
  if ($null -eq $venvPython) {
    throw "venv was created at $VenvPath but no interpreter was found inside it."
  }
} else {
  Write-Step "Reusing existing venv"
}

$venvVersion = Test-PythonCandidate -Exe $venvPython
if ($null -eq $venvVersion) {
  throw "The interpreter at $venvPython is not runnable. Re-run with -Force to recreate the venv."
}
if ($venvVersion -lt $MinPython) {
  throw "The existing venv is Python $venvVersion; the sidecar requires >= $MinPython. Re-run with -Force."
}
if ($venvVersion -gt $PreferredMaxPython) {
  Write-Warning "This venv is Python $venvVersion. pyfomod pins lxml<5, which has no wheels for this version; if the install below fails building lxml, re-run with -Force -PythonExe pointing at Python $PreferredMaxPython."
}
Write-Host "  Interpreter: $venvPython (Python $venvVersion)"

# ---- 3. Install the sidecar --------------------------------------------------

# setuptools is not optional here. Python 3.12 dropped distutils from the
# stdlib, and pyfomod 1.2.x still does `from distutils.version import
# LooseVersion` at import time. Modern setuptools ships a distutils shim
# (distutils-precedence.pth) that satisfies that import, and `python -m venv`
# does not install setuptools on 3.12+. Without this, the sidecar installs
# cleanly and then fails on first import.
Write-Step "Upgrading pip and setuptools"
& $venvPython -m pip install --upgrade pip setuptools --disable-pip-version-check --quiet
if ($LASTEXITCODE -ne 0) { throw "pip/setuptools upgrade failed (exit $LASTEXITCODE)" }

if ($SkipSidecar) {
  Write-Step "-SkipSidecar given; not installing mo2-mcp-sidecar"
} else {
  $sidecarSrc = Join-Path $RepoRoot "tools/mo2-mcp-sidecar"
  if (-not (Test-Path -LiteralPath (Join-Path $sidecarSrc "pyproject.toml"))) {
    throw "Sidecar source not found at $sidecarSrc"
  }

  if ($Editable) {
    Write-Step "Installing mo2-mcp-sidecar (editable) from $sidecarSrc"
    & $venvPython -m pip install --disable-pip-version-check -e $sidecarSrc
  } else {
    Write-Step "Installing mo2-mcp-sidecar from $sidecarSrc"
    & $venvPython -m pip install --disable-pip-version-check $sidecarSrc
  }
  if ($LASTEXITCODE -ne 0) { throw "sidecar install failed (exit $LASTEXITCODE)" }

  Write-Step "Verifying import"
  & $venvPython -c "import mo2_mcp_sidecar, pyfomod, py7zr; print('mo2_mcp_sidecar OK')"
  if ($LASTEXITCODE -ne 0) { throw "sidecar import check failed (exit $LASTEXITCODE)" }
}

# ---- 4. Report ---------------------------------------------------------------

Write-Host ""
Write-Host "Python environment ready." -ForegroundColor Green
Write-Host "  venv:        $VenvPath"
Write-Host "  interpreter: $venvPython"
Write-Host ""

$defaultPath = Get-DefaultVenvPath
if ([IO.Path]::GetFullPath($defaultPath) -ieq $VenvPath) {
  Write-Host "This is the default location, so mo2-mcp will discover it automatically."
  Write-Host "Restart the MCP server (or your agent session) to pick it up."
} else {
  Write-Host "This is a non-default location. Point mo2-mcp at it with:"
  Write-Host "  `$env:BGS_PYTHON = `"$venvPython`""
}
Write-Host ""
