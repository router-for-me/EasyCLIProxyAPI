[CmdletBinding()]
param(
    [int]$BuildJobs,

    [string]$GitCodeGuiRepository = 'lzt404/EasyCLIProxyAPI',

    [string]$GitCodeCoreRepository = 'lzt404/CLIProxyAPI'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = $PSScriptRoot
$AppBin = Join-Path $RootDir 'src-tauri\target\release\cpa-gui.exe'
$CopyScript = Join-Path $RootDir 'copy.ps1'

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
if ($GitCodeGuiRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw 'GitCodeGuiRepository must use the owner/repository format.'
}
if ($GitCodeCoreRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw 'GitCodeCoreRepository must use the owner/repository format.'
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'bun is not installed or not in PATH.'
}

Write-Host "Cargo build jobs: $BuildJobs"
Write-Host "GitCode GUI fallback repository: $GitCodeGuiRepository"
Write-Host "GitCode core fallback repository: $GitCodeCoreRepository"

& bun install
if ($LASTEXITCODE -ne 0) {
    throw "bun install failed with exit code $LASTEXITCODE."
}

$PreviousBuildJobs = $env:CARGO_BUILD_JOBS
$PreviousGitCodeGuiRepository = $env:GITCODE_GUI_REPOSITORY
$PreviousGitCodeCoreRepository = $env:GITCODE_CORE_REPOSITORY
try {
    $env:CARGO_BUILD_JOBS = [string]$BuildJobs
    $env:GITCODE_GUI_REPOSITORY = $GitCodeGuiRepository
    $env:GITCODE_CORE_REPOSITORY = $GitCodeCoreRepository
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
    if ($null -eq $PreviousGitCodeGuiRepository) {
        Remove-Item Env:GITCODE_GUI_REPOSITORY -ErrorAction SilentlyContinue
    }
    else {
        $env:GITCODE_GUI_REPOSITORY = $PreviousGitCodeGuiRepository
    }
    if ($null -eq $PreviousGitCodeCoreRepository) {
        Remove-Item Env:GITCODE_CORE_REPOSITORY -ErrorAction SilentlyContinue
    }
    else {
        $env:GITCODE_CORE_REPOSITORY = $PreviousGitCodeCoreRepository
    }
}

if (-not (Test-Path -LiteralPath $AppBin -PathType Leaf)) {
    throw "Build finished, but executable not found: $AppBin"
}

Write-Host "Built: $AppBin"
& $CopyScript
