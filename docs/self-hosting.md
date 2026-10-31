# Self-hosting RepCoach

> **This guide is a stub.** It covers what the author has actually run: one
> always-on Windows machine, one user, a phone on the same tailnet. The Linux
> (systemd) and macOS (launchd) service paths are implemented but have not been
> run by the author.

RepCoach is one Node process. It serves the built web client, speaks RPC over
a WebSocket on the same origin, keeps everything in one SQLite file, and runs
the coaching agents through the Claude Agent SDK. The client is the server's
URL opened in your phone's browser.

## Security

- **Devices have to be paired.** The server answers `/rpc` and its admin
  routes only for browsers holding a paired session. A device pairs by opening
  a one-time link (a QR code in Settings, or `pnpm repcoach pair`): the link
  works once, for 15 minutes, and gives that browser an httpOnly session
  cookie. Settings → Server lists every paired device and can revoke any of
  them. There are no accounts and no permission levels: a paired device can do
  everything, including pairing more devices and installing the service.
- **Treat pairing links like passwords** until they are used or expire. Don't
  paste them into chats, screenshots or bug reports.
- **Tailscale is the network boundary.** The server binds `127.0.0.1`, and
  Tailscale Serve makes it reachable to devices on your tailnet, over HTTPS.
  Keep it that way:
  - never port-forward it or put it behind a public reverse proxy;
  - never expose it with `tailscale funnel`;
  - if you share your tailnet with other people, use
    [Tailscale ACLs](https://tailscale.com/kb/1018/acls) to limit who can
    reach this machine.
- **The pairing secret and sessions live beside the database**
  (`server-secret`, `repcoach.auth.json`). Anyone who can read `server-secret` can mint
  pairing links. Sessions are stored hashed.
- **The coaching agents run with tools and without permission prompts.**
  Deliberation and Intake sessions can use `Bash`, `Read`, `Grep`, `WebSearch`
  and `WebFetch`, run from an empty scratch directory
  (`~/.repcoach/agent-workdir`) and read a read-only snapshot of your
  database. This is not a sandbox: an agent with `Bash` can reach anything the
  server's OS user can, including the pairing secret. Text you type into
  the app (notes, Revise requests, Intake answers) reaches those agents.
  **Run the server as a dedicated, low-privilege user** whose home directory
  holds nothing else you need to protect.

## Requirements

| | |
|---|---|
| Node.js | 22.16 or newer (needs the built-in `node:sqlite`) |
| pnpm | 10.x |
| Claude Code | installed and signed in (`claude`, then `/login`) as the user that runs the server |
| Tailscale | on the server and on your phone, both on the same tailnet, with [HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) enabled for the tailnet |

**Why HTTPS matters.** On a plain `http://` origin, browsers silently disable
notifications (the rest-timer alert), the screen wake lock and service
workers. The server therefore never offers a plain-http URL: until Tailscale
Serve works, it is reachable from its own machine only.

**About quota.** The production server spends Claude subscription quota as soon
as it starts: it lists the available models, polls your plan's rate limits
and runs a review after each workout you finish. The Agent SDK also accepts
an `ANTHROPIC_API_KEY` instead of a Claude Code login; that path is untested
here.

## Install

```sh
git clone https://github.com/astefanovic/repcoach.git
cd repcoach/thin-client
pnpm install
pnpm repcoach install
```

`pnpm repcoach install` builds the web client if needed, starts the server in
that terminal, and opens **Settings → Server** in this machine's browser,
already paired. Everything else happens on that page:

1. **Phone access.** The server sets up Tailscale Serve in front of itself,
   then fetches its own `https://…ts.net/` URL to prove it works. If it can't,
   the page says why and what to do: Tailscale not installed, signed out, or
   HTTPS certificates off for the tailnet. HTTPS certificates are a switch in
   the [Tailscale admin console](https://login.tailscale.com/admin/dns) that
   only the tailnet owner can flip. The server checks again every minute, so
   the URL appears without a restart.
2. **Pair a device.** Shows a QR code. Scan it with your phone, then use the
   browser's *Add to home screen*.
3. **Install as background service.** Until you do this, the server stops when
   its terminal closes. The button installs a per-user service, hands the
   running server over to it, and the page reconnects a few seconds later.

| Platform | Service | Starts | Restarts if it stops |
|---|---|---|---|
| Windows | hidden launcher in the Startup folder, running a restart loop | at logon | yes, after 5 s |
| Linux | systemd user unit `repcoach.service` (tries `loginctl enable-linger`) | at boot with linger, otherwise at login | yes |
| macOS | LaunchAgent `com.repcoach.server` | at login | yes |

None of these needs admin rights. The service pins the Node binary and the
settings (`PORT`, `REPCOACH_DB_PATH`, …) the server was running with when you
installed it. Install again from a server started with different settings to
change them. Settings → Server also has **Restart server** and **Remove
service**. The log is `~/.repcoach/logs/server.log`.

On Windows, `scripts/Install-RepcoachServer-Service.ps1` (NSSM) and
`scripts/Register-RepcoachServer-Task.ps1` (Scheduled Task) still exist for a
server that must run with nobody logged in. Both need an elevated shell.
[`docs/ops/repcoach-server.md`](ops/repcoach-server.md) covers known problems
with the Windows setup.

### From a terminal

| Command (from `thin-client/`) | What it does |
|---|---|
| `pnpm repcoach install` | Start (or reuse) the server and open Settings, paired. |
| `pnpm repcoach start` | Run the server in the foreground. What the service runs. |
| `pnpm repcoach pair` | Print a pairing QR code and link for another device. |
| `pnpm repcoach status` | Running or not, the phone URL, the service, the log path. |

`scripts/Start-RepcoachServer.ps1` is a Windows wrapper over `start`.

## Configuration

All settings are environment variables, documented on
`thin-client/apps/dev-server/src/productionMain.ts`.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4020` | TCP port. |
| `HOST` | `127.0.0.1` | Bind address. Leave it on loopback and let Tailscale Serve front it. |
| `REPCOACH_DB_PATH` | `~/.repcoach/repcoach.sqlite` | The database. Beside it: the pairing secret, `<db>.auth.json` (paired devices), `<db>.runtime.json` and `logs/`. |
| `REPCOACH_STATIC_DIR` | `thin-client/apps/web/dist` | The built web client. If missing, the server serves `/rpc` only. |
| `REPCOACH_AGENT_CWD` | `~/.repcoach/agent-workdir` | Where agent sessions run from. The server refuses the repo and the database's own directory. |
| `REPCOACH_TAILSCALE_SERVE` | on | `0` leaves Tailscale Serve alone. |
| `REPCOACH_TAILSCALE_SERVE_PORT` | `443` | The HTTPS port Serve publishes on. A second server on the same machine uses another one. |
| `REPCOACH_AGENT_RECORD_DIR` | unset | When set, every live agent session is written there as a replay fixture. Leave unset in normal use. |

The server never takes over a Serve port that already points at something
still running, so a second server on the same machine leaves the first one's
URL alone.

## Your data

- **Backups.** Everything lives in the one SQLite file at `REPCOACH_DB_PATH`.
  Stop the server and copy it, or back it up live with
  `sqlite3 ~/.repcoach/repcoach.sqlite ".backup repcoach-backup.sqlite"`.
- **Export.** Settings → *Your data* → *Export my data (JSON)* downloads
  everything you've logged.
- **Import.** Workout history from Strong or Hevy can be imported from the app.

## Updating

```sh
git pull
cd thin-client
pnpm install
```

Then **Restart server** in Settings, or restart it however you started it. The
web client is rebuilt on start when its sources changed. Database migrations
run automatically at startup, so back up the database first.

## Troubleshooting

- **The phone shows "Pair this device".** It has no session with this server:
  either it was never paired, it was revoked, or its browser data was cleared.
  Run `pnpm repcoach pair` on the server and scan the code.
- **The phone can't connect at all.** `pnpm repcoach status` on the server.
  If it isn't running, start it (and install the service). Then check the phone
  is on the tailnet and is using the `https://` URL.
- **Settings shows a phone-access problem.** It names the fix. "Already points
  at … which is still running" means another server owns that Serve port: stop
  it, or give this one its own `REPCOACH_TAILSCALE_SERVE_PORT`.
- **Rest-timer alerts or the wake lock don't work.** You're on an `http://`
  URL. Open the `https://…ts.net` one and re-add it to the home screen.
- **Coaching never runs, or reports "not signed in".** Sign in to Claude Code
  again as the user that runs the server (`claude`, then `/login`) and restart
  it.
