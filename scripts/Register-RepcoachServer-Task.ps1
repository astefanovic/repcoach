<#
.SYNOPSIS
  Register the RepCoach server as a Windows Scheduled Task so it runs
  independently of any terminal / agent session and starts at logon
  (Step 2A / task 2A.5). No Administrator or NSSM required.

.DESCRIPTION
  The recurring failure during development was the server dying whenever the
  shell that launched it (an agent background task) was torn down -- so the
  phone would time out. A Scheduled Task is owned by Task Scheduler, not by the
  launching process tree, so it survives session teardown, logoff, and reboot.

  Runs as the CURRENT user (so per-user nvm Node / pnpm / Tailscale resolve),
  at LogOn, with restart-on-failure. Binding TCP 4020 needs no elevation.
  Re-runnable: replaces any existing task of the same name.

.PARAMETER TaskName
  Scheduled Task name. Default "RepcoachServer".

.PARAMETER Port
  Port passed through to Start-RepcoachServer.ps1. Default 4020.

.PARAMETER StartNow
  Start the task immediately after registering (default true).
#>
[CmdletBinding()]
param(
  [string]$TaskName = "RepcoachServer",
  [int]$Port = 4020,
  [bool]$StartNow = $true
)

$ErrorActionPreference = "Stop"
$startScript = Join-Path $PSScriptRoot "Start-RepcoachServer.ps1"
if (-not (Test-Path $startScript)) { throw "missing $startScript" }

$psExe = (Get-Command powershell.exe).Source
$action = New-ScheduledTaskAction -Execute $psExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -Port $Port"
$trigger = New-ScheduledTaskTrigger -AtLogOn
# Run as the current interactive user, non-elevated.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "[repcoach] replacing existing task '$TaskName'..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "RepCoach persistent RPC/SQLite server (Step 2A), fronted for the tailnet." | Out-Null
Write-Host "[repcoach] registered scheduled task '$TaskName' (runs at logon as $env:USERNAME)."

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "[repcoach] started task now. It will keep running after this shell/agent exits."
}
