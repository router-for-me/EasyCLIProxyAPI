[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = $PSScriptRoot
$BinDir = Join-Path $RootDir 'bin-work'
$AppBin = Join-Path $BinDir 'Easy_CLIProxyAPI.exe'

if (-not (Test-Path -LiteralPath $AppBin -PathType Leaf)) {
    Write-Host "Executable not found: $AppBin"
    Write-Host 'Run .\build.ps1 first.'
    exit 1
}

$Process = Start-Process -FilePath $AppBin -WorkingDirectory $BinDir -PassThru -Wait

exit $Process.ExitCode
