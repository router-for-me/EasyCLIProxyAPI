[CmdletBinding()]
param(
    [int]$BuildJobs,

    [string]$GitCodeGuiRepository = 'lzt404/EasyCLIProxyAPI',

    [string]$GitCodeCoreRepository = 'lzt404/CLIProxyAPI',

    [switch]$SkipCopy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = $PSScriptRoot
$TargetDir = Join-Path $RootDir 'src-tauri\target'
$BuildRootMarker = Join-Path $TargetDir '.build-workspace-root'
$AppBin = Join-Path $TargetDir 'release\cpa-gui.exe'
$CopyScript = Join-Path $RootDir 'copy.ps1'

Set-Location -LiteralPath $RootDir

function Test-StaleTauriBuildCache {
    param([string]$BuildDir, [string]$TargetDir)

    if (-not (Test-Path -LiteralPath $BuildDir -PathType Container)) {
        return $false
    }

    $TargetPrefix = $TargetDir.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    foreach ($directory in Get-ChildItem -LiteralPath $BuildDir -Directory -Filter 'tauri-*') {
        $output = Join-Path $directory.FullName 'output'
        if (-not (Test-Path -LiteralPath $output -PathType Leaf)) {
            continue
        }
        foreach ($line in [IO.File]::ReadLines($output)) {
            $marker = 'PERMISSION_FILES_PATH='
            $position = $line.IndexOf($marker, [StringComparison]::Ordinal)
            if ($position -lt 0) {
                continue
            }
            $permissionPath = $line.Substring($position + $marker.Length).Trim()
            if (-not $permissionPath.StartsWith($TargetPrefix, [StringComparison]::OrdinalIgnoreCase) -or
                -not (Test-Path -LiteralPath $permissionPath)) {
                return $true
            }
        }
    }
    return $false
}

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

$CachedRoot = if (Test-Path -LiteralPath $BuildRootMarker -PathType Leaf) {
    (Get-Content -LiteralPath $BuildRootMarker -Raw).Trim()
}
else {
    ''
}
if (-not $CachedRoot.Equals($RootDir, [StringComparison]::OrdinalIgnoreCase) -and
    (Test-StaleTauriBuildCache -BuildDir (Join-Path $TargetDir 'release\build') -TargetDir $TargetDir)) {
    $ExpectedTargetDir = [IO.Path]::GetFullPath((Join-Path $RootDir 'src-tauri\target'))
    $ResolvedTargetDir = (Resolve-Path -LiteralPath $TargetDir).Path
    if (-not $ResolvedTargetDir.Equals($ExpectedTargetDir, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean an unexpected Cargo target directory: $ResolvedTargetDir"
    }
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        throw 'cargo is required to refresh the stale Tauri build cache.'
    }
    Write-Host 'Tauri release cache references a previous workspace path; rebuilding its generated permissions.'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        & cargo clean --manifest-path (Join-Path $RootDir 'src-tauri\Cargo.toml') --target-dir $TargetDir -p tauri --release
        if ($LASTEXITCODE -eq 0) {
            break
        }
        if ($attempt -eq 3) {
            throw "Failed to refresh the Tauri release cache (exit code $LASTEXITCODE)."
        }
        Start-Sleep -Seconds $attempt
    }
}

& bun install
if ($LASTEXITCODE -ne 0) {
    throw "bun install failed with exit code $LASTEXITCODE."
}

$PreviousBuildJobs = $env:CARGO_BUILD_JOBS
$PreviousCargoTargetDir = $env:CARGO_TARGET_DIR
$PreviousGitCodeGuiRepository = $env:GITCODE_GUI_REPOSITORY
$PreviousGitCodeCoreRepository = $env:GITCODE_CORE_REPOSITORY
try {
    $env:CARGO_BUILD_JOBS = [string]$BuildJobs
    $env:CARGO_TARGET_DIR = $TargetDir
    $env:GITCODE_GUI_REPOSITORY = $GitCodeGuiRepository
    $env:GITCODE_CORE_REPOSITORY = $GitCodeCoreRepository
    & bun tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE."
    }
    [IO.File]::WriteAllText($BuildRootMarker, $RootDir, [Text.UTF8Encoding]::new($false))
}
finally {
    if ($null -eq $PreviousCargoTargetDir) {
        Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
    }
    else {
        $env:CARGO_TARGET_DIR = $PreviousCargoTargetDir
    }
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
if ($SkipCopy) {
    Write-Host 'Portable copy skipped; run .\copy.ps1 after closing the running app.'
}
else {
    & $CopyScript
}
