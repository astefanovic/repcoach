# Self-hosting RepCoach

> **This guide is a stub.** It covers what the author has actually run: one
> always-on home machine, one user, a phone on the same tailnet. Linux and
> macOS follow the same steps but have been tested less than Windows.

RepCoach is one Node process. It serves the built web client, speaks RPC over
a WebSocket on the same origin, keeps everything in one SQLite file, and runs
the coaching agents through the Claude Agent SDK. The client is the server's
URL opened in your phone's browser.

## Security

- **There is no authentication.** The server has no accounts, passwords or
  tokens. Anyone who can reach its port can read and change all of your data,
  and can trigger coaching runs that spend your Claude quota.
- **Tailscale is the boundary.** By default the server binds `127.0.0.1`, and
  `tailscale serve` makes it reachable to devices on your tailnet, over HTTPS.
  Keep it that way:
  - never port-forward it or put it behind a public reverse proxy;
  - never expose it with `tailscale funnel`;
  - if you share your tailnet with other people, use
    [Tailscale ACLs](https://tailscale.com/kb/1018/acls) to limit who can
    reach this machine.
- **`HOST=0.0.0.0` exposes it to your LAN as well.** The Windows start script
  falls back to that when `tailscale serve` is unavailable. Prefer fixing
  Serve, or pass `-RequireHttps` to refuse to start without it.
- **The coaching agents run with tools and without permission prompts.**
  Deliberation and Intake sessions can use `Bash`, `Read`, `Grep`, `WebSearch`
  and `WebFetch`, run from an empty scratch directory
  (`~/.repcoach/agent-workdir`) and read a read-only snapshot of your
  database. This is not a sandbox: an agent with `Bash` can reach anything the
  server's OS user can. Text you type into
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
workers. The rest of the app keeps working. Always open
the `https://…ts.net` URL.

**About quota.** The production server spends Claude subscription quota as soon
as it starts: it lists the available models, polls your plan's rate limits
and runs a review after each workout you finish. The Agent SDK also accepts
an `ANTHROPIC_API_KEY` instead of a Claude Code login; that path is untested
here.

## Install and run (any OS)

```sh
git clone https://github.com/astefanovic/repcoach.git
cd repcoach/thin-client
pnpm install
pnpm --filter @repcoach/web build
pnpm --filter @repcoach/dev-server start
```

The server listens on `http://127.0.0.1:4020` and serves the app at `/`. In a
second terminal, put Tailscale in front of it:

```sh
tailscale serve --bg 4020
tailscale serve status        # shows https://<machine>.<tailnet>.ts.net
```

Serve config persists across reboots, so this is a one-time step. Open that
`https://` URL on your phone and add it to your home screen. There is no
account to create. The first launch walks you through
Intake.

## Install and run (Windows)

`scripts/Start-RepcoachServer.ps1` does the build, the Tailscale setup and
the server start in one command, and prints the URL to open on your phone:

```powershell
./scripts/Start-RepcoachServer.ps1 -RequireHttps
```

To start it automatically at every logon, without admin rights:

```powershell
./scripts/Install-RepcoachServer-Startup.ps1 -StartNow
```

`Install-RepcoachServer-Service.ps1` (NSSM) and
`Register-RepcoachServer-Task.ps1` (Scheduled Task) survive a reboot with
nobody logged in, but need an elevated shell. Run any script with `-?` for its
parameters. [`docs/ops/repcoach-server.md`](ops/repcoach-server.md) covers
known problems with the Windows setup.

## Keeping it running (Linux and macOS)

There is no packaged service file yet. Any supervisor works as long as it runs
`pnpm --filter @repcoach/dev-server start` from `thin-client/` as the user
whose Claude Code login the coach should use. A minimal systemd user unit:

```ini
# ~/.config/systemd/user/repcoach.service
[Unit]
Description=RepCoach server

[Service]
WorkingDirectory=%h/repcoach/thin-client
ExecStart=/usr/bin/env pnpm --filter @repcoach/dev-server start
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now repcoach
loginctl enable-linger "$USER"   # keep it running while you're logged out
```

This unit is a starting point and has not been run by the author.

## Configuration

All settings are environment variables read by
`thin-client/apps/dev-server/src/prodIndex.ts`.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4020` | TCP port. |
| `HOST` | `127.0.0.1` | Bind address. Leave it on loopback and let `tailscale serve` front it. |
| `REPCOACH_DB_PATH` | `~/.repcoach/repcoach.sqlite` | The database. Its directory is created on first start. |
| `REPCOACH_STATIC_DIR` | `thin-client/apps/web/dist` | The built web client. If missing, the server serves `/rpc` only. |
| `REPCOACH_AGENT_CWD` | `~/.repcoach/agent-workdir` | Where agent sessions run from. The server refuses the repo and the database's own directory. |
| `REPCOACH_AGENT_RECORD_DIR` | unset | When set, every live agent session is written there as a replay fixture. Leave unset in normal use. |

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
pnpm --filter @repcoach/web build
# then restart the server
```

Database migrations run automatically at startup. Back up the database first.

## Troubleshooting

- **The phone can't connect, but everything works on the server.** Check the
  server process is still running; a server started from a terminal or an
  agent session dies with it. Then check you're on the tailnet and using the
  `https://` URL.
- **Rest-timer alerts or the wake lock don't work.** You're on an `http://`
  URL. Re-bookmark the `https://…ts.net` one.
- **Coaching never runs, or reports "not signed in".** Sign in to Claude Code
  again as the user that runs the server (`claude`, then `/login`) and restart
  it.
