# The server owns its own exposure, and devices pair

Refines [ADR 0010](./0010-persistent-home-server-serves-web-client.md), which made the home server serve the web client over Tailscale and left everything around that (Tailscale Serve, the plain-http fallback, staying up across logoffs) to a 348-line Windows launcher script. Compared against t3code's current remote-access model and cut down to one user.

## The state before

- **Tailscale was the only access control.** Anything on the tailnet could read and change every workout and start coaching runs, and those runs hold `Bash`.
- **Exposure lived in PowerShell.** `Start-RepcoachServer.ps1` read `tailscale status`, ran `tailscale serve`, and fell back to binding `0.0.0.0` on plain http, with a Windows Firewall workaround that switched to a portable Node. Linux and macOS had a hand-written, untested systemd snippet.
- **Keeping it running took three scripts** (Startup folder, NSSM, Scheduled Task). The ops doc's #1 recurring failure was still "the server is gone when the phone connects".
- **None of it was visible in the app.** The phone URL, and whether it was the https one, existed only in a terminal window.

## The decision

1. **The server sets up and watches its own phone access.** At boot and every minute it checks Tailscale, runs `tailscale serve` when needed, and proves the result by fetching its own `https://…ts.net/.well-known/repcoach/server` and matching a per-process id. It never takes a Serve port whose target still answers, and it leaves the mapping in place on shutdown so the phone's bookmark survives a restart. **There is no plain-http fallback**: an insecure origin silently loses notifications, the wake lock and service workers. Until Serve works, the server is reachable from its own machine only, and Settings says what to fix.

2. **Devices pair.** `/rpc` and the admin routes answer only a browser holding a session cookie, issued by redeeming a one-time, 15-minute, HMAC-signed pairing code. Paired devices are listed in Settings and revocable there. There are no scopes and no accounts: one user, one level of access. There is no loopback exemption, because Serve proxies from 127.0.0.1 too.

3. **Setup runs from the web UI.** `pnpm repcoach install` starts the server and opens Settings → Server in this machine's browser, already paired. Phone access, the pairing QR for the phone, and **Install as background service** are all on that page. The service is per user and needs no admin rights on any platform: a Startup-folder restart loop on Windows, a systemd user unit on Linux, a LaunchAgent on macOS.

4. **The CLI covers the same ground headless**: `install`, `start`, `pair`, `status`. `Start-RepcoachServer.ps1` becomes a wrapper over `start`, kept for the elevated NSSM and Scheduled Task scripts.

## Considered options

- **Trust the tailnet, as before.** Rejected: a shared tailnet, or any compromised device on it, reaches agents running `Bash` as the owner's user.
- **t3code's full model** — scoped permissions, bearer and DPoP tokens, T3 Connect relay, multiple routes per machine. Rejected as machinery for many users and many machines; nothing here needs more than "paired or not".
- **Trust loopback, pair only remote devices.** Rejected: behind Tailscale Serve every request comes from loopback.
- **Keep the plain-http fallback** so a broken tailnet never locks the owner out. Rejected: the owner is never locked out, since the server still answers on its own machine and that is where the fix is made. A fallback URL that silently loses web APIs got bookmarked once already.

## Consequences

- **Every existing device has to pair once** after this lands. Until then the app shows "Pair this device", and unsynced sets wait in the outbox.
- **The pairing secret is a credential.** `server-secret` sits beside the database. Anything that can read it, including the coaching agents' `Bash`, can mint pairing links. This is the same exposure the agents already have to the database itself, and it is stated in the security docs rather than defended against.
- **Commissioning servers keep their own devices.** Session and runtime files are named after the database (`repcoach.auth.json`, `commissioning.auth.json`), and a second server publishes on its own `REPCOACH_TAILSCALE_SERVE_PORT` rather than displacing the real one.
- **Windows handover goes through WMI.** A detached child did not survive the hand-started server's exit when that server ran inside a job object, so the launcher is created by `Win32_Process.Create`, outside it.
- **The Linux and macOS services are implemented and unit-tested but have not been run.**
