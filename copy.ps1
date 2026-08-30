[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = $PSScriptRoot
$AppBin = Join-Path $RootDir 'src-tauri\target\release\cpa-gui.exe'
$BinDir = Join-Path $RootDir 'bin-work'
$BinOut = Join-Path $BinDir 'EasyCLIProxyAPI.exe'
$PortableScript = Join-Path $RootDir 'scripts\portable.mjs'

Set-Location -LiteralPath $RootDir

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'bun is not installed or not in PATH.'
}

if (-not (Test-Path -LiteralPath $AppBin -PathType Leaf)) {
    throw "Executable not found: $AppBin. Run .\build.ps1 first."
}

& bun $PortableScript --binary $AppBin --output $BinDir --download true --preserve-runtime-config true
if ($LASTEXITCODE -ne 0) {
    throw "Portable preparation failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $BinOut -PathType Leaf)) {
    throw "Portable preparation finished, but executable not found: $BinOut"
}

$CoreOut = Join-Path $BinDir 'cpa-core'
$CoreArchives = @(
    Get-ChildItem -LiteralPath $CoreOut -File |
        Where-Object { $_.Name -match '^CLIProxyAPI_.+_windows_.+\.zip$' }
)
if ($CoreArchives.Count -ne 1) {
    throw "Portable core output must contain exactly one Windows core archive: $CoreOut"
}

Write-Host "Copied: $BinOut"
Write-Host "Bundled core archive: $($CoreArchives[0].FullName)"
