[CmdletBinding()]
param()

# Updates the installed Tim's AI Hub GUI in place, the same way the existing
# EasyCLIProxyAPI-backups/*/ snapshots suggest this has been done before: stop
# the GUI, back up its current exe, copy in the freshly built one, and
# relaunch -- back up and swap EasyCLIProxyAPI.exe ONLY.
#
# cli-proxy-api.exe (the actual proxy serving 127.0.0.1:8317) is left running
# throughout. The GUI and proxy are independent processes now (see
# core_runtime.rs: the proxy is no longer tied to the GUI's lifetime), and the
# GUI re-adopts the still-running proxy on relaunch instead of starting a
# duplicate -- so this script does NOT touch cli-proxy-api.exe, and anything
# depending on the proxy (e.g. Claude Desktop's third-party inference) is
# never interrupted by a GUI update.
#
# This only updates the GUI. If you ever need to update the proxy/kernel
# itself (a new CPA core version, not just this app's UI), that's a separate,
# genuinely disruptive operation -- not what this script does.
#
# Prerequisite: build first, e.g. from a 'Developer PowerShell' / terminal
# with cargo and bun on PATH:
#   bun tauri build --no-bundle
# (the GUI-only build; the NSIS installer isn't used for this flow since it
# can't tell personal-desk.N builds apart -- see below.)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\EasyCLIProxyAPI'
$NewExe = 'C:\Users\timmcclain\git\EasyCLIProxyAPI\src-tauri\target\release\cpa-gui.exe'
$TargetExe = Join-Path $InstallDir 'EasyCLIProxyAPI.exe'
$BackupRoot = Join-Path $env:LOCALAPPDATA 'Programs\EasyCLIProxyAPI-backups'
$BackupDir = Join-Path $BackupRoot "before-manual-update-$(Get-Date -Format yyyyMMdd-HHmmss)"

if (-not (Test-Path -LiteralPath $NewExe -PathType Leaf)) {
    throw "Build output not found at $NewExe. Build first with: bun tauri build --no-bundle"
}
if (-not (Test-Path -LiteralPath $TargetExe -PathType Leaf)) {
    throw "Installed app not found at $TargetExe."
}

Write-Host 'Stopping EasyCLIProxyAPI (GUI only -- cli-proxy-api is left running)...'
Get-Process -Name 'EasyCLIProxyAPI' -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

Write-Host "Backing up current exe to $BackupDir"
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
Copy-Item -LiteralPath $TargetExe -Destination (Join-Path $BackupDir 'EasyCLIProxyAPI.exe') -Force

Write-Host 'Installing new build...'
Copy-Item -LiteralPath $NewExe -Destination $TargetExe -Force

Write-Host 'Relaunching...'
Start-Process -FilePath $TargetExe -WorkingDirectory $InstallDir

Start-Sleep -Seconds 2
$version = (Get-Item -LiteralPath $TargetExe).VersionInfo.FileVersion
Write-Host "Done. Installed version is now: $version"
Write-Host "Backup of the previous exe kept at: $BackupDir"

$proxyRunning = $null -ne (Get-Process -Name 'cli-proxy-api' -ErrorAction SilentlyContinue)
$portListening = $null -ne (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 8317 })
if ($proxyRunning -and $portListening) {
    Write-Host 'cli-proxy-api was never stopped -- port 8317 stayed up throughout this update.'
} else {
    Write-Warning 'cli-proxy-api is not running / port 8317 is not listening. It may not have been running before this update either -- check if you expected it to be up.'
}
