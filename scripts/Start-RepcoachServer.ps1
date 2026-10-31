<#
.SYNOPSIS
  Start the RepCoach server in this window. A thin wrapper over
  `pnpm repcoach start` (thin-client/apps/dev-server/src/cli.ts), kept so the
  NSSM/Scheduled Task scripts and old launchers keep working.

.DESCRIPTION
  Everything this script used to do in PowerShell now lives in the server and
  its CLI, on every platform:

  - the web client is rebuilt when it is older than its sources (cli.ts);
  - Tailscale Serve is set up and verified by the server itself, re-checked
    every minute, and shown in Settings -> Server (tailscaleExposure.ts);
  - there is no plain-http fallback any more: if Serve is not working the
    server stays on loopback and Settings says what to fix.

  For first-time setup prefer `pnpm repcoach install` (from thin-client/): it
  starts the server and opens Settings, where the background service is one
  button.

.PARAMETER Port
  TCP port the server binds. Default 4020.

.PARAMETER ServePort
  HTTPS port Tailscale Serve publishes on. Default 443.

.PARAMETER DbPath
  SQLite file. Default %USERPROFILE%\.repcoach\repcoach.sqlite.

.PARAMETER AgentCwd
  Working directory the agent sessions run from (REPCOACH_AGENT_CWD).

.PARAMETER SkipTailscaleServe
  Leave Tailscale Serve alone (REPCOACH_TAILSCALE_SERVE=0).

.PARAMETER Open
  Also open Settings in this machine's browser, already paired.
#>
[CmdletBinding()]
param(
  [int]$Port = 4020,
  [int]$ServePort = 443,
  [string]$DbPath,
  [string]$AgentCwd,
  [switch]$SkipTailscaleServe,
  [switch]$Open,
  # Retired: accepted so existing launchers keep working, and otherwise ignored.
  [switch]$BuildClient,
  [switch]$RequireHttps,
  [string]$PortableNodeDir
)

$ErrorActionPreference = "Stop"
$workspaceRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "thin-client"

if ($RequireHttps) { Write-Warning "-RequireHttps is retired: the server never falls back to plain http any more." }
if ($PortableNodeDir) { Write-Warning "-PortableNodeDir is retired: the server binds loopback only, so the firewall no longer matters." }
if ($BuildClient) { Write-Warning "-BuildClient is retired: the web client is rebuilt whenever its sources are newer." }

# nvm's symlink, so a service started at logon finds the same Node as a shell.
$systemNodeDir = "C:\Program Files\nodejs"
if (Test-Path (Join-Path $systemNodeDir "node.exe")) { $env:Path = "$systemNodeDir;$env:Path" }

$env:PORT = "$Port"
if ($ServePort -ne 443) { $env:REPCOACH_TAILSCALE_SERVE_PORT = "$ServePort" }
if ($DbPath) { $env:REPCOACH_DB_PATH = $DbPath }
if ($AgentCwd) { $env:REPCOACH_AGENT_CWD = $AgentCwd }
if ($SkipTailscaleServe) { $env:REPCOACH_TAILSCALE_SERVE = "0" }
$env:NODE_OPTIONS = "--no-warnings"

Set-Location $workspaceRoot
$command = if ($Open) { "install" } else { "start" }
& pnpm repcoach $command
exit $LASTEXITCODE
