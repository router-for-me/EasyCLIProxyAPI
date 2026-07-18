[CmdletBinding()]
param(
    [int]$BuildJobs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = $PSScriptRoot
$AppBin = Join-Path $RootDir 'src-tauri\target\release\cpa-gui.exe'
$BinDir = Join-Path $RootDir 'bin-work'
$BinOut = Join-Path $BinDir 'cpa-gui.exe'
$PreparePortable = Join-Path $RootDir 'scripts\prepare-portable.mjs'

Set-Location -LiteralPath $RootDir

if (-not $PSBoundParameters.ContainsKey('BuildJobs')) {
    $BuildJobs = if ($env:CARGO_BUILD_JOBS) {
        [int]$env:CARGO_BUILD_JOBS
    }
    else {
        16
    }
}
if ($BuildJobs -lt 1 -or $BuildJobs -gt 256) {
    throw 'BuildJobs must be between 1 and 256.'
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'bun is not installed or not in PATH.'
}

Write-Host "Cargo build jobs: $BuildJobs"

& bun install
if ($LASTEXITCODE -ne 0) {
    throw "bun install failed with exit code $LASTEXITCODE."
}

$PreviousBuildJobs = $env:CARGO_BUILD_JOBS
try {
    $env:CARGO_BUILD_JOBS = [string]$BuildJobs
    & bun tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE."
    }
}
finally {
    if ($null -eq $PreviousBuildJobs) {
        Remove-Item Env:CARGO_BUILD_JOBS -ErrorAction SilentlyContinue
    }
    else {
        $env:CARGO_BUILD_JOBS = $PreviousBuildJobs
    }
}

if (-not (Test-Path -LiteralPath $AppBin -PathType Leaf)) {
    throw "Build finished, but executable not found: $AppBin"
}

& bun $PreparePortable --binary $AppBin --output $BinDir
if ($LASTEXITCODE -ne 0) {
    throw "Portable preparation failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $BinOut -PathType Leaf)) {
    throw "Portable preparation finished, but executable not found: $BinOut"
}

Write-Host "Built: $AppBin"
Write-Host "Copied: $BinOut"
