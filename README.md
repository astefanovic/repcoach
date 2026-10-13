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
| `thin-client/apps/web` | The web client (Vite + React). |
| `thin-client/apps/dev-server` | The server: RPC, static hosting, and the agent runners. `src/prodIndex.ts` is the production entrypoint, `src/index.ts` the dev/test server. |
| `thin-client/packages/` | Shared contracts, the client runtime, and SQLite persistence. |
| `thin-client/e2e` | Playwright acceptance specs. |
| `scripts/` | Windows helpers that start the server and keep it running. |

## Requirements

- **Node.js 22.16 or newer** (the server uses the built-in `node:sqlite`) and
  **pnpm 10**.
- **Claude Code, signed in** on the machine that runs the server. The coach
  runs through the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview),
  which uses that login, so coaching spends your Claude subscription quota.
- **[Tailscale](https://tailscale.com)** on the server and your phone. It is
  how the phone reaches the server, and it is the only access control the
  server has.

## Quick start

### Try it locally, without spending quota

The dev server runs canned (scripted) agents, so you can click through
everything, the coach included, with no Claude login:

```sh
cd thin-client
pnpm install
pnpm --filter @repcoach/dev-server dev     # RPC on http://localhost:4010
pnpm --filter @repcoach/web dev            # web client on http://localhost:5173
```

Open <http://localhost:5173>. Each dev-server boot starts a fresh throwaway
database seeded with a demo plan, so nothing you log there is kept.

### Run it for real

```sh
cd thin-client
pnpm install
pnpm --filter @repcoach/web build
pnpm --filter @repcoach/dev-server start   # serves app + RPC on 127.0.0.1:4020
tailscale serve --bg 4020                  # https://<machine>.<tailnet>.ts.net
```

Open the `https://…ts.net` URL on your phone and add it to your home screen.
On Windows, `scripts/Start-RepcoachServer.ps1` does all of the above for you.

The full walkthrough, including keeping the server running and backing up
your data, is in **[docs/self-hosting.md](docs/self-hosting.md)**.

## Security model

RepCoach is built for one person on a private network:

- **There is no login.** Anyone who can reach the server can read and change
  every workout, and can start coaching runs that spend your Claude quota.
- **Tailscale is the access control.** The server binds to `127.0.0.1` by
  default and `tailscale serve` exposes it to your tailnet only. Never put it
  on the public internet, and never use `tailscale funnel` with it.
- **Coaching agents run tools on the server.** Agent sessions run with Bash and
  web access and without permission prompts, from an empty scratch directory,
  against a read-only snapshot of your data. This is not a sandbox, so run
  the server as a user with access to nothing else you need to protect.

Details are in [docs/self-hosting.md](docs/self-hosting.md#security).

## Development

```sh
cd thin-client
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
