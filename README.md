# RepCoach

A phone-first weight-training log with a Claude-powered coach whose
citations are checked by a second agent before you see them.

You log your workouts in a fast, one-tap web app. After each workout, a Claude
agent reviews what you actually did against what your plan prescribed, and
records a cited **Decision**: an Observation ("watching your bench, two stalled
sessions") or a Proposal ("drop a set on squats next week, here's why"). A
second agent then fetches and reads every source the first one cited and
rewrites the Decision in place, stripping any citation that doesn't support its
claim. Each remaining citation is labelled with a trust level.

The coach never edits your plan on its own. Proposals wait for you to accept,
dismiss or **Revise** them, and every Decision stays in an append-only log you
can read back.

> **Status:** a personal project, used daily by its author on Android Chrome
> over Tailscale. It assumes a single user on a private network. Read the
> [Security model](#security-model) before you run it.

## What it does

**Logging, offline-first.** A Plan of prescribed sessions, a fast in-workout
logger (straight sets, supersets, drop sets, unplanned sets, swaps), a rest
timer that alerts off-tab, a screen wake lock, a plate calculator, "last time"
suggestions, pounds or kilograms. Sets you log offline queue locally and sync
when the connection returns.

**Coaching with an audit trail.**

- **Intake** builds your first Plan from a short form plus an interactive
  conversation with the coach.
- A **Session review** runs after every finished workout, and a heavier
  **Cycle review** runs at plan boundaries. Both run in the background, ahead
  of time, rather than as a live chatbot.
- Every Decision carries its citations and a trust level: `corpus-verified`
  (from a small, hand-vetted [evidence base](docs/evidence/evidence-base-seed.md))
  or `retrieved-unverified` (found by live web retrieval and checked by the
  adversarial sweep). Where no checkable source exists, the coach says
  "reasoning only, uncited" instead of inventing one.

**Self-hosted data.** Everything is stored in one SQLite file on your own
machine. You can import from Strong or Hevy, and export everything as JSON from
Settings.

The vocabulary (Plan, Decision, Observation, Proposal, Deliberation, …) is
defined in [`CONTEXT.md`](CONTEXT.md), and the reasoning behind each
design choice is in [`docs/adr/`](docs/adr/).

## How it fits together

```
phone browser ──(Tailscale)──> home server (Node)
                                 ├─ serves the built web client
                                 ├─ WS /rpc  (Effect RPC)
                                 ├─ SQLite   (~/.repcoach/repcoach.sqlite)
                                 └─ Claude Agent SDK sessions
                                      (deliberator → adversarial sweep)
```

| Path | What |
|---|---|
| `apps/web` | The web client (Vite + React). |
| `apps/server` | The server: RPC, static hosting, pairing, Tailscale and the agent runners. `src/hosting/cli.ts` is the production entrypoint (`pnpm repcoach …`), `src/devMain.ts` the canned dev/test server. |
| `packages/` | Shared contracts, the client runtime, and SQLite persistence. |
| `e2e` | Playwright acceptance specs. |
| `scripts/` | Windows helpers that start the server and keep it running. |

## Requirements

- **Node.js 22.16 or newer** (the server uses the built-in `node:sqlite`) and
  **pnpm 10**.
- **Claude Code, signed in** on the machine that runs the server. The coach
  runs through the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview),
  which uses that login, so coaching spends your Claude subscription quota.
- **[Tailscale](https://tailscale.com)** on the server and your phone, with
  [HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) turned on
  for the tailnet. It is how the phone reaches the server.

## Quick start

### Try it locally, without spending quota

The dev server runs canned (scripted) agents, so you can click through
everything, the coach included, with no Claude login:

```sh
pnpm install
pnpm --filter @repcoach/server dev   # RPC on http://localhost:4010
pnpm --filter @repcoach/web dev      # web client on http://localhost:5173
```

Open <http://localhost:5173>. Each dev-server boot starts a fresh throwaway
database seeded with a demo plan, so nothing you log there is kept.

### Run it for real

```sh
pnpm install
pnpm repcoach install
```

This builds the web client, starts the server on `127.0.0.1:4020` and opens
**Settings → Server** in your browser, already paired. From there:

- **Phone access.** The server puts Tailscale Serve in front of itself and shows
  the `https://<machine>.<tailnet>.ts.net/` URL to open on your phone. If
  something is missing, such as HTTPS certificates being off for the tailnet,
  it says what to fix and checks again every minute.
- **Pair a device.** Shows a QR code. Scan it with your phone, then add the page
  to your home screen.
- **Install as background service.** Keeps the server running after you close
  the terminal, starts it at logon and restarts it if it stops. Windows, Linux
  (systemd) and macOS (launchd), no admin rights needed.

`pnpm repcoach status` and `pnpm repcoach pair` do the same from a terminal.
The full walkthrough, including backups, is in
**[docs/self-hosting.md](docs/self-hosting.md)**.

## Security model

RepCoach is built for one person on a private network:

- **Devices have to be paired.** The server answers only browsers that have
  redeemed a one-time pairing code, from Settings or `pnpm repcoach pair`.
  Paired devices are listed in Settings, where you can revoke them. There are
  no accounts: every paired device has full access.
- **Tailscale is the network boundary.** The server binds to `127.0.0.1` and
  Tailscale Serve exposes it to your tailnet only, over HTTPS. Never put it on
  the public internet, and never use `tailscale funnel` with it.
- **Coaching agents run tools on the server.** Agent sessions run with Bash and
  web access and without permission prompts, from an empty scratch directory,
  against a read-only snapshot of your data. This is not a sandbox, so run
  the server as a user with access to nothing else you need to protect.

Details are in [docs/self-hosting.md](docs/self-hosting.md#security).

## Development

```sh
pnpm test          # Vitest (unit + integration)
pnpm typecheck
pnpm --filter @repcoach/e2e test   # Playwright e2e; boots its own servers
```

Testing runs in three rungs (unit, adversarial e2e, then human UAT on a phone),
described in [docs/agents/testing.md](docs/agents/testing.md).

RepCoach isn't accepting contributions yet. Bug reports are welcome as
[issues](https://github.com/astefanovic/repcoach/issues).

## License

[GNU Affero General Public License v3.0](LICENSE). If you run a modified
version as a network service, the AGPL requires you to offer its source code
to the people using it.
