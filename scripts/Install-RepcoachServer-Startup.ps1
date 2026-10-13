<#
.SYNOPSIS
  Make the RepCoach server auto-start at every logon via the Windows Startup
  folder -- no Administrator, no NSSM, no scheduled-task permissions
  (Step 2A / task 2A.5, no-elevation fallback).

.DESCRIPTION
  Register-ScheduledTask / schtasks / NSSM all need elevation on this host.
  A launcher script in the per-user Startup folder does not: Explorer runs it
  at logon, so the server lives independently of any terminal or agent session
  (the thing that kept killing it) and comes back after a reboot.

  Drops a hidden-window launcher .cmd in:
    %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
  that runs Start-RepcoachServer.ps1. Pass -StartNow to also launch it
  immediately (detached from this shell via Explorer).

.PARAMETER Port
  Port passed to Start-RepcoachServer.ps1. Default 4020.

.PARAMETER StartNow
  Also launch the server now, detached, so you don't have to log out/in.
#>
[CmdletBinding()]
param(
  [int]$Port = 4020,
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$startScript = Join-Path $PSScriptRoot "Start-RepcoachServer.ps1"
if (-not (Test-Path $startScript)) { throw "missing $startScript" }

$startupDir = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $startupDir "RepcoachServer.cmd"
$body = "@echo off`r`n" +
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -Port $Port`r`n"
Set-Content -Path $launcher -Value $body -Encoding ASCII
Write-Host "[repcoach] installed logon launcher: $launcher"

if ($StartNow) {
  # Launch via Explorer so the process is re-parented out of this shell's job
  # object and survives the shell/agent exiting.
  Start-Process -FilePath "explorer.exe" -ArgumentList "`"$launcher`""
  Write-Host "[repcoach] launched now (detached via Explorer)."
}
