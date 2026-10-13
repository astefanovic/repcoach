<#
.SYNOPSIS
  Launch the persistent RepCoach server (Step 2A) the way t3code works: the
  server serves the web client itself, reachable from any tailnet device.
  When it's running, open the printed URL in the browser on your phone --
  that's the whole setup.

.DESCRIPTION
  1. Pins the system Node (nvm's symlink -- needs the node:sqlite builtin,
     Node >= 22.16) and fails fast if node:sqlite is missing.
  2. Ensures the thin client's web build exists (Vite, `apps/web`); the
     server serves it at / and the app connects back same-origin.
  3. Tries to front the loopback port with `tailscale serve` (HTTPS + MagicDNS,
     mirroring t3code's @t3tools/tailscale). If the tailnet hasn't enabled the
     Serve feature, it does NOT block -- it falls back to binding the server
     directly on all interfaces and prints a plain-http tailnet URL instead
     (tailnet traffic is WireGuard-encrypted either way).
  4. Runs the production entrypoint (apps/dev-server/src/prodIndex.ts) in the
     foreground -- the process a supervisor (NSSM, see
     Install-RepcoachServer-Service.ps1) keeps alive across reboots.

.PARAMETER Port
  TCP port the Node server binds. Default 4020.

.PARAMETER ServePort
  HTTPS port `tailscale serve` listens on across the tailnet. Default 443.

.PARAMETER DbPath
  SQLite file. Default %USERPROFILE%\.repcoach\repcoach.sqlite.

.PARAMETER AgentCwd
  Working directory the Deliberation/Intake Agent SDK sessions run from
  (REPCOACH_AGENT_CWD). Default: the server's own default, a sibling of the DB
  (<db dir>\agent-workdir). Never the repo and never the DB's own directory --
  the server refuses both (issue #93, agentWorkingDirectory.ts).

.PARAMETER PortableNodeDir
  A Node install with an inbound-firewall Allow rule, used only when
  direct-binding and Windows Firewall has Block rules against the system
  node.exe (see the firewall section below). Default
  %USERPROFILE%\node-portable\node-v22.23.1-win-x64; ignored if absent.

.PARAMETER BuildClient
  Force a rebuild of the web client even if a build already exists.

.PARAMETER SkipTailscaleServe
  Don't attempt `tailscale serve`; go straight to the direct-bind fallback.

.PARAMETER RequireHttps
  Refuse to boot at all unless `tailscale serve` is fronting this server over
  HTTPS. Without it the script still falls back to plain http (so a broken
  tailnet can never lock you out of your own server) but says loudly what that
  costs: an insecure origin has no `Notification`, no `navigator.wakeLock` and
  no service workers, and browsers withdraw all three silently.
#>
[CmdletBinding()]
param(
  [int]$Port = 4020,
  [int]$ServePort = 443,
  [string]$DbPath = (Join-Path $env:USERPROFILE ".repcoach\repcoach.sqlite"),
  [string]$AgentCwd,
  [string]$PortableNodeDir = (Join-Path $env:USERPROFILE "node-portable\node-v22.23.1-win-x64"),
  [switch]$BuildClient,
  [switch]$SkipTailscaleServe,
  [switch]$RequireHttps
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Join-Path $repoRoot "thin-client"

# --- Pin the system Node (nvm's symlink at C:\Program Files\nodejs) ----------
$systemNodeDir = "C:\Program Files\nodejs"
if (Test-Path (Join-Path $systemNodeDir "node.exe")) {
  $env:Path = "$systemNodeDir;$env:Path"
}
$nodeVersion = (& node --version) 2>$null
Write-Host "[repcoach] node $nodeVersion"
# node:sqlite is the whole reason we need >= 22.16 -- fail fast if it's missing.
& node -e "require('node:sqlite')" 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "This Node ($nodeVersion) lacks the node:sqlite builtin (need >= 22.16). Fix the nvm/system Node before starting the server."
}

# --- Ensure the web client build the server serves at / ----------------------
# Built with a plain Vite build -- no workaround needed (the old `expo export`
# white-screen bug and its Build-WebClient.ps1 workaround died with apps/expo,
# see ADR 0012 / #53).
#
# The check is FRESHNESS, not presence (issue #111). It used to be
# `-not (Test-Path $webIndex)`, which meant a `dist` built at any point in the
# past booted happily forever. The server runs the TypeScript source through
# tsx, so it is always current; the bundle is whatever was last built. Two days
# of drift was enough for `TokenUsage` to be widened underneath it, after which
# every Intake failed at the client's decode of a perfectly good reply -- the
# socket healthy throughout, the agent session billed in full, and the card on
# screen blaming the connection.
#
# So: rebuild when the build is missing OR older than anything it is built
# from. Cheap (a directory walk against one mtime), and it fails safe -- if the
# scan cannot read the sources it rebuilds rather than assuming the best.
$webIndex = Join-Path $workspaceRoot "apps\web\dist\index.html"

function Test-WebClientStale {
  param([string]$IndexPath)

  if (-not (Test-Path $IndexPath)) { return $true }

  try {
    $builtAt = (Get-Item $IndexPath -ErrorAction Stop).LastWriteTimeUtc
    # Everything the bundle is compiled from: the app, and every workspace
    # package it imports. `packages/*/src` is what carries the contracts, which
    # is where the drift that motivated this actually lives.
    $sourceRoots = @(
      (Join-Path $workspaceRoot "apps\web\src"),
      (Join-Path $workspaceRoot "apps\web\index.html"),
      (Join-Path $workspaceRoot "apps\web\vite.config.ts"),
      (Join-Path $workspaceRoot "packages")
    ) | Where-Object { Test-Path $_ }

    foreach ($root in $sourceRoots) {
      $newer = Get-ChildItem $root -Recurse -File -ErrorAction Stop |
        Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\' } |
        Where-Object { $_.LastWriteTimeUtc -gt $builtAt } |
        Select-Object -First 1
      if ($newer) {
        Write-Host "[repcoach] web build is stale ($($newer.Name) is newer than dist) -- rebuilding."
        return $true
      }
    }
    return $false
  } catch {
    Write-Warning "couldn't compare the web build against its sources ($($_.Exception.Message)) -- rebuilding to be safe."
    return $true
  }
}

if ($BuildClient -or (Test-WebClientStale -IndexPath $webIndex)) {
  Push-Location $workspaceRoot
  try {
    & pnpm --filter "@repcoach/web" build
    if ($LASTEXITCODE -ne 0) {
      throw "web client build failed (pnpm --filter @repcoach/web build exited $LASTEXITCODE)"
    }
  } finally {
    Pop-Location
  }
}

# --- Tailnet exposure ---------------------------------------------------------
# Preferred: `tailscale serve` (HTTPS + stable MagicDNS URL, t3code's approach;
# server stays loopback-only). The plain-http direct-bind is a FALLBACK, and a
# costly one -- see the banner below.
#
# **Why https is not cosmetic here.** `https://<magicdns>` is a secure context;
# `http://<magicdns>:4020` is not, and browsers switch off a whole class of web
# platform API on insecure origins -- silently, with no error the app can catch
# and report:
#
#   - `Notification`      -- the rest timer's off-tab alert (#116 part 2)
#   - `navigator.wakeLock`-- keeping the screen alive mid-set
#   - service workers     -- anything offline-first beyond the in-page cache
#
# The failure mode this guards against is a phone that bookmarked the fallback
# URL during a period when Serve was unavailable and then kept using it long
# after Serve started working, with those features quietly dead the whole time.
# So the fallback still exists (never lock the owner out of their own server)
# but it announces exactly what it costs, and `-RequireHttps` turns it into a
# hard failure for anyone who would rather not boot at all than boot insecure.
$bindHost = "127.0.0.1"
$phoneUrl = $null
$dns = $null
$tailnetIp = $null
$certDomains = @()

$tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue)
if ($null -ne $tailscale) {
  try {
    $status = (& tailscale.exe status --json | Out-String) | ConvertFrom-Json
    $dns = "$($status.Self.DNSName)".TrimEnd('.')
    $tailnetIp = @($status.Self.TailscaleIPs) | Where-Object { "$_" -match '^100\.' } | Select-Object -First 1
    # Populated only once HTTPS Certificates are enabled for the tailnet, which
    # is the same admin toggle `tailscale serve --https` needs. Reading it lets
    # us tell "not set up yet" from "set up but failing" BEFORE running a
    # command that would otherwise block for ten seconds waiting on a click.
    $certDomains = @($status.CertDomains)
  } catch {
    Write-Warning "couldn't read tailscale status ($($_.Exception.Message))."
  }
}

# Is `tailscale serve` ALREADY proxying our port? Serve config is persistent
# across reboots, so on every run after the first there is nothing to do -- and
# checking is much cheaper than re-issuing the command. The proxy target is
# matched explicitly rather than just looking for "some handler on 443": a
# stale config pointing at a different port would otherwise be read as success
# and we would print a URL that answers with somebody else's app.
function Test-ServeAlreadyBound {
  param([string]$Dns, [int]$HttpsPort, [int]$LocalPort)

  try {
    $serve = (& tailscale.exe serve status --json 2>$null | Out-String)
    if (-not $serve.Trim()) { return $false }
    $parsed = $serve | ConvertFrom-Json
    $handler = $parsed.Web."${Dns}:${HttpsPort}".Handlers."/"
    return ($null -ne $handler) -and ("$($handler.Proxy)" -eq "http://127.0.0.1:$LocalPort")
  } catch {
    return $false
  }
}

$serveOk = $false
$serveHint = $null
if (-not $SkipTailscaleServe -and $null -ne $tailscale -and $dns) {
  if (Test-ServeAlreadyBound -Dns $dns -HttpsPort $ServePort -LocalPort $Port) {
    $serveOk = $true
    Write-Host "[repcoach] tailscale serve already fronts 127.0.0.1:$Port on :$ServePort -- nothing to do."
  } elseif ($certDomains.Count -eq 0) {
    # No cert domains means the tailnet has never had HTTPS Certificates
    # enabled. Running `tailscale serve` now would just block for ten seconds
    # printing an enable link, so skip straight to telling the user what to
    # click -- that step is an authenticated admin-console action and no
    # script can do it for them.
    $serveHint = "https://login.tailscale.com/admin/dns"
    Write-Warning 'HTTPS Certificates are not enabled for this tailnet, so "tailscale serve" cannot issue a certificate.'
  } else {
    $serveOut = Join-Path $env:TEMP "repcoach-tailscale-serve-out.txt"
    $serveErr = Join-Path $env:TEMP "repcoach-tailscale-serve-err.txt"
    $proc = Start-Process -FilePath $tailscale.Source `
      -ArgumentList @("serve", "--bg", "--https=$ServePort", "http://127.0.0.1:$Port") `
      -NoNewWindow -PassThru -RedirectStandardOutput $serveOut -RedirectStandardError $serveErr
    if ($proc.WaitForExit(15000)) {
      # Trust the config, not the exit code: re-read `serve status` so a
      # command that "succeeded" without actually binding cannot print an
      # https URL that nothing answers.
      $serveOk = ($proc.ExitCode -eq 0) -and
        (Test-ServeAlreadyBound -Dns $dns -HttpsPort $ServePort -LocalPort $Port)
      if (-not $serveOk) {
        $serveHint = (Get-Content $serveErr, $serveOut -ErrorAction SilentlyContinue |
            Select-String -Pattern 'https://login\.tailscale\.com\S*' |
            Select-Object -First 1).Matches.Value
        Write-Warning "tailscale serve exited $($proc.ExitCode) without binding :$ServePort. $((Get-Content $serveErr -ErrorAction SilentlyContinue) -join ' ')"
      }
    } else {
      # Blocking means the CLI is waiting for an admin to click an enable
      # link. Don't hang.
      try { $proc.Kill() } catch {}
      $serveHint = (Get-Content $serveErr, $serveOut -ErrorAction SilentlyContinue |
          Select-String -Pattern 'https://login\.tailscale\.com\S*' |
          Select-Object -First 1).Matches.Value
      Write-Warning "tailscale serve is waiting on an admin approval and did not return."
    }
  }
}

if ($serveOk) {
  $portSuffix = if ($ServePort -eq 443) { "" } else { ":$ServePort" }
  $phoneUrl = "https://$dns$portSuffix"
} elseif ($dns -or $tailnetIp) {
  # Direct fallback: bind all interfaces so the tailnet IP reaches the server.
  # (This also exposes the port on the local LAN -- fine for a home host.)
  $bindHost = "0.0.0.0"
  $phoneUrl = if ($dns) { "http://${dns}:$Port" } else { "http://${tailnetIp}:$Port" }
} else {
  Write-Warning "Tailscale unavailable -- the server will be loopback-only (http://127.0.0.1:$Port)."
}

# --- Say plainly which URL this boot produced, and what it can do -------------
if ($phoneUrl) {
  Write-Host ""
  if ($serveOk) {
    Write-Host "[repcoach] ==> open  $phoneUrl  in the browser on your phone (same tailnet)." -ForegroundColor Green
    Write-Host "[repcoach]     Secure context: notifications, wake lock and service workers all available." -ForegroundColor DarkGray
    Write-Host "[repcoach]     This is the ONLY URL to bookmark. The server binds loopback, so no http URL answers." -ForegroundColor DarkGray
  } else {
    Write-Host "  !!  INSECURE FALLBACK -- this is not the URL you want  !!" -ForegroundColor Black -BackgroundColor Yellow
    Write-Host ""
    Write-Host "[repcoach] ==> open  $phoneUrl  in the browser on your phone (same tailnet)." -ForegroundColor Yellow
    if ($tailnetIp) {
      Write-Host "[repcoach]     (or by IP: http://${tailnetIp}:$Port)" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "[repcoach] Traffic is still WireGuard-encrypted, but this is a plain-http origin, and" -ForegroundColor Yellow
    Write-Host "[repcoach] browsers disable these on insecure origins -- silently, with no error on screen:" -ForegroundColor Yellow
    Write-Host "[repcoach]   * Notification      -- the rest timer cannot alert you off-tab" -ForegroundColor Yellow
    Write-Host "[repcoach]   * navigator.wakeLock-- the screen cannot be held awake mid-set" -ForegroundColor Yellow
    Write-Host "[repcoach]   * service workers   -- no offline install" -ForegroundColor Yellow
    Write-Host "[repcoach] Do NOT leave this bookmarked on the phone once https works." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "[repcoach] To fix it (one-time, and only you can do it -- it is an authenticated admin action):" -ForegroundColor Cyan
    Write-Host "[repcoach]   1. Open $(if ($serveHint) { $serveHint } else { 'https://login.tailscale.com/admin/dns' })" -ForegroundColor Cyan
    Write-Host "[repcoach]   2. Enable HTTPS Certificates for the tailnet." -ForegroundColor Cyan
    Write-Host "[repcoach]   3. Re-run this script. It will pick up the change and print the https URL." -ForegroundColor Cyan
    Write-Host "[repcoach]      (Re-bookmark on the phone: the http URL stops answering once it binds loopback.)" -ForegroundColor Cyan
    Write-Host ""
    if ($RequireHttps) {
      throw "-RequireHttps was given and tailscale serve is not fronting this server. Refusing to boot on a plain-http origin."
    }
  }
  Write-Host ""
}

# --- Firewall-aware runtime pick for direct binding --------------------------
# Windows Firewall has (auto-created) BLOCK rules against the nvm-resolved
# system node.exe -- Block beats Allow, so inbound tailnet connections to a
# 0.0.0.0-bound server on that node hang (blank page on the phone) even though
# local probes work. The portable Node has an Allow rule (and node:sqlite), so
# prefer it when direct-binding. `tailscale serve` mode is unaffected: the
# connection terminates in tailscaled and is proxied to loopback.
if ($bindHost -eq "0.0.0.0") {
  try {
    $resolvedNodeDir = (Get-Item $systemNodeDir -ErrorAction Stop).Target
    $resolvedNode = if ($resolvedNodeDir) { Join-Path $resolvedNodeDir "node.exe" } else { Join-Path $systemNodeDir "node.exe" }
    $blockRules = Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction Stop |
      Get-NetFirewallApplicationFilter -ErrorAction Stop |
      Where-Object { $_.Program -and ($_.Program -ieq $resolvedNode) }
    if ($blockRules) {
      $portableNode = $PortableNodeDir
      if (Test-Path (Join-Path $portableNode "node.exe")) {
        Write-Warning "Inbound firewall BLOCK rules exist for $resolvedNode -- running the server on the portable Node ($portableNode) which has an Allow rule. To fix properly (elevated): Get-NetFirewallRule -Direction Inbound -Action Block | Where-Object { (`$_ | Get-NetFirewallApplicationFilter).Program -ieq '$resolvedNode' } | Remove-NetFirewallRule"
        $env:Path = "$portableNode;$env:Path"
      } else {
        Write-Warning "Inbound firewall BLOCK rules exist for $resolvedNode and no portable Node fallback found -- the phone will NOT reach this server until the rules are removed (elevated PowerShell)."
      }
    }
  } catch {
    Write-Warning "couldn't inspect firewall rules ($($_.Exception.Message)) -- if the phone can't connect, check inbound Block rules for node.exe."
  }
}

# --- Run the production server (foreground; supervised by NSSM in service mode)
$env:PORT = "$Port"
$env:HOST = $bindHost
$env:REPCOACH_DB_PATH = $DbPath
if ($AgentCwd) { $env:REPCOACH_AGENT_CWD = $AgentCwd }
$env:NODE_OPTIONS = "--no-warnings"
Write-Host "[repcoach] node in use: $((Get-Command node).Source)"
Write-Host "[repcoach] db path : $DbPath"
# The Agent SDK sessions hold Bash+Read; where they run from is a commissioned
# decision, not an accident of how the server was launched (issue #93). The
# server creates and validates it at boot and prints the resolved path.
$agentCwdShown = if ($AgentCwd) { $AgentCwd } else { "$(Join-Path (Split-Path -Parent $DbPath) 'agent-workdir') (server default)" }
Write-Host "[repcoach] agent cwd: $agentCwdShown"
Write-Host "[repcoach] starting production server on ${bindHost}:$Port ..."

Set-Location $workspaceRoot
& pnpm --filter "@repcoach/dev-server" start
exit $LASTEXITCODE
