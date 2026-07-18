[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
)
$RootPrefix = "$RootDir$([System.IO.Path]::DirectorySeparatorChar)"
$BinDir = Join-Path $RootDir 'bin-work'

Set-Location -LiteralPath $RootDir

$CleanTargets = @(
    (Join-Path $RootDir 'dist'),
    (Join-Path $RootDir 'src-tauri\target'),
    (Join-Path $RootDir 'src-tauri\gen'),
    $BinDir
)

foreach ($Target in $CleanTargets) {
    $ResolvedTarget = [System.IO.Path]::GetFullPath($Target)
    if (-not $ResolvedTarget.StartsWith(
        $RootPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing to clean a path outside the project: $ResolvedTarget"
    }

    if (Test-Path -LiteralPath $ResolvedTarget) {
        Remove-Item -LiteralPath $ResolvedTarget -Recurse -Force
    }
}

New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

Write-Host 'Cleaned build output.'
