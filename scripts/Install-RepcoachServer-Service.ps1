<#
.SYNOPSIS
  Install the RepCoach server as an always-on Windows service via NSSM
  (Step 2A / task 2A.5).

.DESCRIPTION
  t3code fronts its server with `tailscale serve` but, as an interactive CLI,
  doesn't supervise a long-running process -- so the "always-on" half (survive
  reboot/logout, restart-on-crash) is handled here with NSSM, wrapping
  Start-RepcoachServer.ps1.

  Run this from an **elevated** PowerShell. Prefer running the service as your
  own user (-Password): the server needs your per-user nvm Node, pnpm, and
  Tailscale login on PATH, which LocalSystem does not have.

  Install NSSM first if missing:  winget install NSSM.NSSM

.PARAMETER ServiceName
  Windows service name. Default "RepcoachServer".

.PARAMETER Port
  Loopback port passed through to Start-RepcoachServer.ps1. Default 4020.

.PARAMETER Password
  Password for the current user, so the service runs under your account
  (recommended). Omit to run as LocalSystem (PATH/nvm/Tailscale may not
  resolve -- a warning is printed).
#>
[CmdletBinding()]
param(
  [string]$ServiceName = "RepcoachServer",
  [int]$Port = 4020,
  [string]$Password
)

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this from an elevated (Administrator) PowerShell -- NSSM service install requires it."
}

$nssm = (Get-Command nssm.exe -ErrorAction SilentlyContinue)
if ($null -eq $nssm) {
  throw "nssm.exe not found on PATH. Install it (e.g. winget install NSSM.NSSM) and re-run."
}

$startScript = Join-Path $PSScriptRoot "Start-RepcoachServer.ps1"
$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:USERPROFILE ".repcoach\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$psExe = (Get-Command powershell.exe).Source
$psArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -Port $Port"

# Remove any prior install so this script is re-runnable.
if (& nssm.exe status $ServiceName 2>$null) {
  Write-Host "[repcoach] removing existing service '$ServiceName'..."
  & nssm.exe stop $ServiceName 2>$null | Out-Null
  & nssm.exe remove $ServiceName confirm | Out-Null
}

Write-Host "[repcoach] installing service '$ServiceName'..."
& nssm.exe install $ServiceName $psExe $psArgs
& nssm.exe set $ServiceName AppDirectory $repoRoot
& nssm.exe set $ServiceName DisplayName "RepCoach persistent server"
& nssm.exe set $ServiceName Description "RepCoach RPC/SQLite server (Step 2A), fronted by tailscale serve."
& nssm.exe set $ServiceName Start SERVICE_AUTO_START
& nssm.exe set $ServiceName AppStdout (Join-Path $logDir "server.out.log")
& nssm.exe set $ServiceName AppStderr (Join-Path $logDir "server.err.log")
& nssm.exe set $ServiceName AppRotateFiles 1
# Restart on crash, with a short backoff so a boot-time flap doesn't hot-loop.
& nssm.exe set $ServiceName AppExit Default Restart
& nssm.exe set $ServiceName AppRestartDelay 3000

if ($Password) {
  $account = "$env:USERDOMAIN\$env:USERNAME"
  Write-Host "[repcoach] service will run as $account"
  & nssm.exe set $ServiceName ObjectName $account $Password
} else {
  Write-Warning "No -Password given: service runs as LocalSystem, which likely lacks your nvm Node / pnpm / Tailscale login on PATH. If it fails to start, re-run with -Password to run as your user."
}

Write-Host "[repcoach] starting service..."
& nssm.exe start $ServiceName
& nssm.exe status $ServiceName
Write-Host "[repcoach] logs: $logDir"
