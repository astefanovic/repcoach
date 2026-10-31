# Testing & UAT

RepCoach is tested in three ascending rungs. A feature is not "done" until every
rung below it is green.

| Rung | What | Tool | Runs on | Who writes it |
|------|------|------|---------|---------------|
| 1. Unit / integration | Behavior at code seams | **Vitest** (`thin-client/`) | Node | Implementer, via `/tdd` |
| 2. E2E acceptance | User journeys, black-box | **Playwright** (`thin-client/e2e/`) | Browser (Chromium) | **Adversarial author agent** |
| 2a. Agent-backed e2e | The same journeys, against the **real agents** — replayed or live | Playwright, `REPCOACH_AGENT_MODE` | Browser (Chromium) | Implementer (#95) |
| 3. UAT | Real build, real hardware | Open the served URL | Phone browser over Tailscale | Human |

Rungs 1 and 2 are **fully automated** and gate the feature. Rung 2a runs on
demand rather than on every commit — see [Agent-backed rung 2](#agent-backed-rung-2)
for why it is a half-step rather than a rung of its own. Rung 3 is the human
sign-off on the physical phone and happens last.

The client is a plain React web app served by the always-on home server
([ADR 0010](../adr/0010-persistent-home-server-serves-web-client.md), [ADR
0012](../adr/0012-web-only-client-supersedes-native-android.md)) and opened in a
browser on phone or desktop — there is no native build, no emulator, and no
device-install step anywhere in these rungs.

---

## Rung 2 — the adversarial e2e loop

The point of this rung is an acceptance test that cannot cheat. It is written by an
**adversarial author agent that has never seen the implementation**, so the only
thing it can assert on is what a user actually sees. Playwright enforces this by
convention rather than structurally (a spec is TypeScript, so nothing stops it from
reaching into the DOM) — the contract is upheld by what the author is forbidden to
read and by review of the diff, not by the tool.

### Two roles, kept apart

- **Author agent (adversarial).** Input: the feature's issue / spec (the *behavior*)
  and the app's visible vocabulary — headings, button labels, empty-state copy. It
  is **forbidden to read the client source** under `thin-client/apps/web/src/**`
  (and `thin-client/packages/**`). Output: Playwright specs in `thin-client/e2e/flows/`
  that encode "a user can do X and observe Y."
- **Implementer agent.** Full source access. Writes the app code (its own inner
  `/tdd` unit loop) to make those specs pass.

### The loop

1. Author writes a spec from the issue. It is **red** — the feature doesn't exist
   yet (`pnpm --filter @repcoach/e2e test flows/<new>.spec.ts`, run from
   `thin-client/`). No `--` before the path: pnpm hands a literal `--` on to
   Playwright, which then ignores the path and runs the whole suite.
2. Implementer builds the feature until the spec is **green**.
3. Repeat per journey. The feature is done when the whole suite is green:
   `pnpm --filter @repcoach/e2e test` (from `thin-client/`), which boots the
   dev-server and the Vite client itself via Playwright's `webServer` config —
   no server needs to be started by hand first.

Because the author never saw the code, a green spec is evidence of real
user-observable behavior, not a test shaped around the implementation.

### How to enforce "no implementation access"

Spawn the author as a subagent whose prompt (a) hands it the issue text plus the
current visible-string inventory (headings, labels, empty states — read these off
`thin-client/apps/web/src/surfaces/**` component output or by running the app, not
by reading the components themselves), (b) explicitly forbids reading
`thin-client/apps/web/src/**` and `thin-client/packages/**`, and (c) restricts its
writes to `thin-client/e2e/flows/`. If you can't hard-sandbox the tools, the
forbiddance in the prompt plus review of the diff (specs only, no source reads) is
the contract.

### Writing specs

- One spec file per user journey; name it after the behavior, not the screen
  (`log-straight-session.spec.ts`, not `today.spec.ts`).
- Assert on visible text and ARIA roles only —
  `page.getByRole("heading", { name: "Today" })`, not a `data-testid` that encodes
  structure. If a control isn't reachable or nameable by a user, that's a finding to
  hand back — not a reason to add a test hook. (A handful of older, currently
  `.skip`'d specs from before the #42 IA settled still assert on `getByTestId`;
  treat that as a legacy pattern being retired, not the house style — new specs
  follow `renders-repcoach.spec.ts`.)
- **The app's small-caps chrome is a CSS transform, so match case-insensitively.**
  The DOM text is `sets`, `reps`, `What I measured`, `Coach output`;
  `text-transform: uppercase` does the rest. Playwright matches the *text*, so
  `getByText("Sets", { exact: true })` finds nothing — and reports "element not
  found", which reads as *the editor never opened* rather than *your casing was
  wrong*, sending you to debug the app instead of the locator. Every rung-2
  author has hit this once; it is written here so that is the last time.
- **Text order is not structure.** A Block's wrapper is a margin mark for the
  Entries that **follow** it, not a container that opens before its children
  (#45 — in a card-less language the wrapper cannot be a container), so
  `innerText` shows `[SUPERSET]` after the *previous* Entry's rows. Read
  `GET /__test__/plan` when the claim is about grouping.
- Use the dev-server's `/__test__/*` HTTP control channel (see
  `thin-client/apps/dev-server`) as the external lever for setup/teardown and for
  verifying server-side state (e.g. `GET /__test__/logged-actuals`) — never a
  client-side hook. When a state is too *fast* to observe rather than merely
  hard to reach, the lever still belongs on the server: `hold-deliberation` /
  `release-deliberation` and `quota-low` / `quota-available` (#77) exist because
  the canned deliberator returns instantly, so the Proposal card's in-flight
  lock and its queued-vs-running spinner would otherwise flicker past unseen.
  `POST /__test__/reset` restores every lever and **abandons** anything still in
  flight, so a flow that dies mid-hold cannot wedge the next one.
- Use `setOffline` from `thin-client/e2e/driver.ts` (a CDP-backed toggle) for the
  offline/G1/G2 flows rather than simulating network state some other way.
- Keep specs independent; any spec must pass run in isolation.

### Running the suite locally

**Kill the servers between full runs.** `reuseExistingServer` is on, so
Playwright adopts whatever is already listening on 4010/5173 instead of booting
a clean one — and the dev-server keeps its state **in memory**, with no database
file on disk to inspect or delete. A server left over from a previous suite run,
or started by hand to poke at something, therefore begins the next run already
dirty, and `POST /__test__/reset` is the only thing that ever launders it.

The failure this produces is the expensive kind: one or two specs go red,
somewhere unrelated to whatever you just changed, and they pass when re-run on
their own — so the obvious reading is "flaky suite" and the second-most obvious
is "my merge broke something distant." Both send you somewhere real work isn't.
`settings.spec.ts`'s RPE-capture case and
`create-a-user-authored-exercise.spec.ts`'s rename case have each been observed
failing this way and passing immediately against a fresh server.

```powershell
# from thin-client/ — clear the ports, then run
Get-NetTCPConnection -State Listen -LocalPort 4010,4011,5173,5174 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
pnpm --filter @repcoach/e2e test
```

Before believing a red spec is a real regression, re-run it against a clean
server. If it still fails, the cheap next check is whether it also fails on
`origin/master` — `git worktree add` a detached master, `pnpm install` (seconds,
against the shared store), and run the one spec file there. That separates "this
branch broke it" from "this was already broken" without unpicking your own work.

**The other cause: the host stalls loopback under full-suite load.** Measured on
the dev box, 2026-08-30. A probe opening a TCP connection to the dev-server
every 1.5s during a full run saw **13-18% of connects time out (>3s)** while the
server process was alive, listening and **idle** — 0.00-0.20s of CPU per
interval, peaking at four established sockets. With the suite stopped, 300
consecutive connects to a trivial listener all succeeded in under 24ms. So it is
not the app (an idle Node process drains its accept queue immediately), not
socket saturation, and not ephemeral-port exhaustion; it is the host's loopback
path under the combined load of Chromium, Vite and Node. Root cause not
isolated — the untested suspects are filter drivers (Defender, Tailscale).

What it cost was **bookkeeping, not assertions**: every one of those `ETIMEDOUT`
failures landed on `POST /__test__/reset` inside a `beforeEach`/`afterEach`,
failing tests whose own assertions had already passed. Two things absorb it now,
and neither hides a real failure:

- `resetServer()` in `e2e/driver.ts` retries the reset connect a few times. Use
  it rather than posting to `/__test__/reset` directly — a dev-server that is
  genuinely down still fails, about a second later.
- `retries: 1` in the Playwright config, so a flake is reported *as flaky*
  rather than being indistinguishable from a regression.

The evidence that this works is that the stalls did not stop: a run at an 18.2%
connect-timeout rate finished 95 passed, 1 flaky, 0 failed, where the same suite
before the change went 9 failed at a 13% rate.

### Current coverage

Re-commissioned by **#82**, which closed the last of the *E2E re-commissioning*
fog: every surface that has shipped now has a black-box flow, and the
placeholder assertions #39 left behind are gone.

| Flow | Covers |
|---|---|
| `intake-cold-start.spec.ts` | Intake end to end — empty state → form → exchange → `Review the sources` → swept Proposal → Accept → populated Today (#82) |
| `author-a-plan.spec.ts` | Plan authoring — create, catalog, set groups, adjacency grouping, reorder-as-a-mode, the change ledger and Undo (#82) |
| `the-coach-record.spec.ts` | Coach as the permanent record — ordering, per-item working, outcomes, offline, no actions (#82) |
| `revise-a-proposal.spec.ts` | The Revise journey and the Proposal card's actions (#77) |
| `offline-plan-edit.spec.ts` | A Plan edit made offline replays as exactly one Change (#80) |
| `g1-offline-outbox.spec.ts` | **ADR 0009 gate 1** — offline capture, no loss, no duplicates |
| `g3-offline-prefetch.spec.ts` | **ADR 0009 gate 3** — a whole session served from the prefetch |
| `log-straight-session` / `log-superset` / `log-drop-set` / `rest-timer` | The Logging surface, re-derived from #63's settled spec |
| `reload-keeps-logged-sets.spec.ts` | A reload mid-workout (a phone discarding the tab) comes back with every acked Set still logged |
| `add-an-exercise-mid-workout.spec.ts` | Adding an exercise to a workout in progress — catalog, library, new name, offline, reload |
| `suggest-last-time.spec.ts` | Each row suggests last time's Set over the plan's range, and gives way to an accepted Proposal's new number |
| `connection-blip-transparency.spec.ts` | ADR 0009 gate 2 |
| `renders-repcoach.spec.ts` | The app renders and survives an offline toggle |
| `weight-unit-pounds.spec.ts` | Per-device kg/lb — Plan, Logging and Progress in lb, lb typed and stored as kg, 2.5 kg / 5 lb steppers snapping to the lb grid |
| `plate-calculator.spec.ts` | The per-side plate readout in the load editor, empty bar, closest-makes, hidden for library dumbbell lifts, Settings' bar and plates |
| `export-my-data.spec.ts` | Settings' JSON export — dated filename, format/version/tables, what was logged is in it, disabled offline |
| `keep-the-screen-awake.spec.ts` | A screen wake lock while a workout is live (stubbed API), re-acquired on visibility, none for a backfill |
| `personal-records-and-progress.spec.ts` | PR badges by Epley e1RM against finished history (first session, 1–12 reps, warmups), and the Progress page |
| `log-bodyweight.spec.ts` | Bodyweight on Progress — log, replace today's, trend, remove |
| `import-from-strong-or-hevy.spec.ts` | Strong/Hevy CSV import — refusal, preview and name matching, import and re-import, History and Progress, no coach review, lb conversion |
| `agent-backed-intake.spec.ts` | **`@agents`, opt-in** — the same Intake journey against the REAL adapters, replayed or live (#95). Skipped in canned mode |

**Intake needs a coach, so the dev-server has one.** `CannedIntakeSessionAgent`
(`apps/dev-server/src/intakeSessionAgent.ts`) replaced the deliberately-unwired
agent in #82: with nothing wired, every path past the form was unreachable from
a browser, so the one flow a new user cannot skip was the one flow nothing
tested. It is deterministic and a function of the whole transcript, and it is
wired **only** through `makeDeliberationLevers` — production runs the real Agent
SDK session, and the unit rungs keep the unwired default so a suite that reaches
Intake by accident still fails loudly.

**Skips are records, never rot.** Each one names what unblocks it:

- un-logging a logged Set — **#83**, the behaviour is missing from the app
- an outbox command whose ack died with its socket — **#84**, likewise
- colour claims ("the Block label is never red", "only the deviating metric goes
  yellow") — no text, ARIA state or agreed token an e2e spec can name
- the rest pill dismissing itself at zero — needs a short prescribed rest in the
  seed, or a lever to shorten one
- `superseded by a later version` on the record — genuinely undecided: whether a
  superseded original is its own item or folds into its successor's history

#83 and #84 were both found *by this rung*, which is the argument for it: the
surfaces had shipped, rung 1 was green, and only a spec written from the settled
design rather than from the code went looking for behaviour that was never
built.

---

## Agent-backed rung 2

**The gap this closes (#95).** Every flow above runs against the canned layers,
because the dev-server wires them. That is the right default — the suite must
stay fast, deterministic and free — but it means rung 2 proves the wiring
*around* the agents and nothing about the agents. Prompt changes,
output-contract changes and sweep-behaviour changes used to land with no
automated signal at all: the first thing that exercised them was a human on a
phone, which is the rung that is supposed to be asking a different question.

The seam is `agentTransport.ts`: the four real adapters no longer call the Agent
SDK directly, they call a **transport**. Only the network call is swappable —
the prompt each adapter builds and the decode it performs (fence-strip →
`dropNullValues` → `defaultEmptyDecisionLists` → Schema) stay on the adapter's
side of it, so a replayed session runs the identical code a live one does. A
seam drawn one level up (a fake `DeliberationAgent`) would replay past all of
it, which is exactly what the canned layers already do.

### Three modes, selected from the environment

`REPCOACH_AGENT_MODE` — unset means `canned`, so nothing about the ordinary
suite changes.

| Mode | Agents | Deterministic | Costs quota |
|---|---|---|---|
| `canned` (default) | the scripted layers | yes | no |
| `replay` | the **real adapters**, answered from recorded transcripts | yes | no |
| `live` | the real adapters, real Agent SDK sessions | no | **yes** |

```powershell
# from thin-client/e2e — replay: real adapters, recorded transcripts, free
$env:REPCOACH_AGENT_MODE='replay'; pnpm --filter @repcoach/e2e test --grep '@agents'
```

```powershell
# live: real sessions, real subscription quota. THE OWNER'S SHELL ONLY — see
# "Live runs are the owner's to start" below; an agent session is refused.
$env:REPCOACH_AGENT_MODE='live'; pnpm --filter @repcoach/e2e test --grep '@agents'
```

Agent-backed runs move **both** ports (dev-server 4011, client 5174). That is
not fussiness: `reuseExistingServer` is on, and a canned dev-server already
listening on 4010 would be silently reused, producing a green "agent-backed" run
that never touched an agent. The first test in `agent-backed-intake.spec.ts`
reads `GET /__test__/agent-sessions` and asserts the mode, for the same reason.

**`replay` is for the `@agents` specs, never for the whole suite.** Every
command on this page pairs the mode with `--grep '@agents'`, and the pairing is
load-bearing rather than tidy: the canned flows predate the port move and still
inline `http://127.0.0.1:4010`, so under `replay` — where the dev-server is on
4011 — they fail at `POST /__test__/reset` with `ECONNREFUSED`, roughly eighty
of them, before asserting anything. It reads like a catastrophic regression and
is nothing of the kind. The two `@agents` specs pass in the same run, because
they reach the server through `REPCOACH_DEV_SERVER_HTTP_URL`, which does move
with the mode; that mixed result is the fingerprint of this mistake. The full
suite is a **canned** run, with `REPCOACH_AGENT_MODE` unset.

The flows tagged `@agents` assert on **structure and outcome only** — a draft
came back and is numbered, a turn advanced the revision, the sweep produced
something acceptable, Accept materialised a Plan server-side. Never on generated
prose: that is what varies, and a spec asserting it would go red on rephrasing,
which is how an agent-backed suite gets labelled flaky and switched off. The
adversarial-author constraint is untouched — these assert what a user sees.

### What replay actually catches, and where

Most of the value is in **rung 1**, not rung 2:
`apps/dev-server/src/agentCassette.contract.test.ts` pushes every committed
cassette through its real adapter on every commit. Tighten a contract, rename a
wire field, or delete one of the decode-boundary absorbers #93 added, and it
goes red in seconds — including for the deliberator and the sweep, which no
agent-backed browser flow drives yet. The e2e flow proves the *journey* survives
a real coach's output; the rung-1 test proves the *contract* does, and it is the
cheap one.

### The fixtures, and refreshing them

Cassettes live in `thin-client/e2e/fixtures/agent-cassettes/` — one file per
session, handed out per stage in filename order. See that directory's
`README.md`; the short version is that the committed ones are **hand-seeded**,
reproducing the deviations #93 recorded live (`"citationId": null`, omitted
`reasoning_only_points`/`surface`, a stray markdown fence), and every cassette
states its own provenance.

Refresh them from a genuine live run by pointing the **production** server at a
recording directory and driving the journey by hand:

```powershell
# a THROWAWAY db — a recording run writes genuine rows (see docs/ops/repcoach-server.md)
$env:REPCOACH_AGENT_RECORD_DIR="$PWD\thin-client\e2e\fixtures\agent-cassettes"
./scripts/Start-RepcoachServer.ps1 -Port 4031 -SkipTailscaleServe -DbPath $env:USERPROFILE\.repcoach\commissioning.sqlite
```

Then review what landed and commit it. The recorder flushes each turn as it
completes, so a session that dies partway still leaves the transcript worth
having.

**The staleness signal.** Each cassette stores a fingerprint of the stage's
static prompt scaffold. Replay *refuses* a cassette whose fingerprint no longer
matches this build — a recorded reply answers a question the code has stopped
asking, and the fixture rotting quietly is record-and-replay's known failure
mode. Two ways out, and they are not equivalent:

- **Re-record** (above). The honest answer.
- `pnpm --filter @repcoach/dev-server cassettes:restamp` — restamps without
  re-recording. Only for a prompt change that provably cannot invalidate the
  reply (a typo, a reordered paragraph). This is the one tool in the repo that
  can cause the silent rot the fingerprint exists to prevent.
- `REPCOACH_AGENT_ALLOW_STALE_CASSETTES=1` replays anyway, for the window where
  a prompt is deliberately mid-change.

### Live runs are the owner's to start

**Rule: live agents run when the owner asks, not when an agent decides to.**
Live sessions bill against a weekly subscription rate limit with no undo, so a
default of `canned` is not enough — a default stops an accident, not an agent
that has read this page. So the guard is in code (`agentMode.ts`):
`REPCOACH_AGENT_MODE=live` refuses to start when a coding-agent session marker
(`CLAUDECODE`, `AI_AGENT`, `CLAUDE_CODE_ENTRYPOINT`) is in the environment, and
the refusal names `replay` as the free equivalent. `REPCOACH_AGENT_LIVE_OK=1` is
the override, for the case where the owner has asked an agent to do a live run.

It is not a sandbox — an agent can clear its own environment. What it enforces
is that spending quota is never *incidental*: not inherited from a variable,
not copied from an example on this page. The ordinary dev-server, every test
rung and `replay` are untouched by it; they wire the canned catalog and canned
quota service and cannot open a session at all. The production server is live
by construction and has no such guard: booting it opens sessions
(`RealModelCatalog` calls `supportedModels()`, `QuotaServiceLive` polls rate
limits).

### Live mode: bounded, and legible when it fails

Spend is capped per server process — 24 sessions and $5 by default
(`REPCOACH_AGENT_MAX_SESSIONS` / `REPCOACH_AGENT_MAX_COST_USD`), counting each
turn of a held-open Intake as its own session, since that is where a runaway
loop would actually live. Exceeding a cap **stops** the next session rather than
warning about it, and the refusal is recorded.

Failure legibility is the other half. A live session that could not start (an
expired token, exhausted quota) shows up in a browser as a heading that never
appears — a locator timeout, which reads as flake. So every session is logged
server-side with its outcome and cost, readable at
`GET /__test__/agent-sessions`, and every step of the agent-backed flow attaches
that log to its failure. The report says *the intake-session session failed:
session could not start* rather than describing a missing element.

Two levers behave differently in an agent-backed run, both deliberately:
`hold-deliberation` / `release-deliberation` do **nothing** (they gate the
canned deliberator, which is not wired), while `quota-low` / `quota-available`
still work — the quota service stays canned so a replay run never opens a real
session just to read rate limits.

Whether any of this stays honest is [UAT watchlist entry
7](../design/uat-watchlist.md).

---

## Rung 3 — open it on the phone (final UAT)

Runs only after rung 2 is green. There is no build or push step: the home server
already serves the built web client at all times
([docs/ops/repcoach-server.md](../ops/repcoach-server.md)). UAT is just opening
that URL in the phone's browser over Tailscale and using the app for real.

```powershell
# Ensure the server is up — or `pnpm repcoach status` if the background service runs it:
cd thin-client; pnpm repcoach install
```

Then, on the phone, open the tailnet URL shown in Settings → Server. A phone that
isn't paired yet shows "Pair this device": scan the QR from Settings → Server →
Pair a device (or `pnpm repcoach pair`). No adb, no wireless-debugging setup.

---

## Tooling setup (this machine)

- **Node 22+** — see the thin-client-node-runtime memory note for the portable
  Node used on this machine (system Node lacks `node:sqlite`).
- **pnpm** — the thin-client workspace (`thin-client/`) is a pnpm workspace;
  install deps with `pnpm install` from `thin-client/`.
- **Playwright browsers** — `pnpm --filter @repcoach/e2e exec playwright install`
  (Chromium only is exercised by the current suite) if a fresh machine reports
  missing browser binaries.
- No JDK, Android SDK, Maestro, or emulator are needed anywhere in this pipeline —
  those were retired with the native app ([ADR 0012](../adr/0012-web-only-client-supersedes-native-android.md)).

### Commands

```powershell
# from thin-client/
pnpm test                                     # rung 1 — full Vitest suite
pnpm test:watch                               # rung 1 — watch mode
pnpm --filter @repcoach/e2e test              # rung 2 — full suite (canned; clear ports first)
pnpm --filter @repcoach/e2e test flows/<file>.spec.ts  # rung 2 — one spec file (no `--`)
$env:REPCOACH_AGENT_MODE='replay'             # rung 2a — real adapters, recorded
pnpm --filter @repcoach/e2e test --grep '@agents'      # ...and ONLY the @agents specs
pnpm --filter @repcoach/dev-server cassettes:restamp   # after a safe prompt edit
pnpm repcoach install                         # rung 3 — serve for UAT, opens Settings → Server
```
