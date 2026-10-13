# RepCoach production server & web client — the full Step 2A setup

**Audience: the next agent (or human) touching the always-on home-server setup.**
This is the single explainer for how the phone-facing production deployment
works, every non-obvious decision in it, and the traps that already bit us.
Read this before changing anything under `thin-client/apps/dev-server`,
`scripts/*.ps1`, or the web build.

## The model (copied from t3code)

The UX contract: **start the server, open its URL in any tailnet browser
(the Pixel 7), done.** No Metro, no Expo Go, no QR, no build-time URL baking.

```
Pixel 7 browser ──(tailnet)──> production server (Windows home host)
   GET /            ── serves the built web client (apps/web dist/, Vite)
   GET /assets/…    ── static, SPA-fallback to index.html
   WS  /rpc         ── Effect-RPC NDJSON — the same origin that served the page
   ↳ SQLite at %USERPROFILE%\.repcoach\repcoach.sqlite  (survives restarts)
```

- **Server**: `thin-client/apps/dev-server/src/prodIndex.ts` (`pnpm --filter
  @repcoach/dev-server start`). Serves `/rpc` + the static client
  (`staticFiles.ts`, mirrored from t3code's `staticAndDevRouteLayer`).
  **No `/__test__/*` control channel in this build** — that's dev-only, and a
  prod server exposing reset/drop-socket would let anyone on the tailnet wipe
  real logged data. Config via env: `PORT` (4020), `HOST` (127.0.0.1),
  `REPCOACH_DB_PATH`, `REPCOACH_STATIC_DIR` (default `apps/web/dist`).
- **Client**: `apps/web`, a plain Vite + React web app (ADR 0012 — the native
  Android app and the Expo/React Native thin client are both retired). It
  derives its server URL from `window.location.origin` in production builds
  (`Connection.resolveServerBaseUrls`, mirroring t3code's
  `primary/target.ts`). Precedence: explicit dev-server env overrides (used by
  the deliberately cross-origin Playwright e2e harness) → same-origin
  (production build) → localhost dev defaults.

## Scripts (repo `scripts/`)

| Script | What it does |
|---|---|
| `Start-RepcoachServer.ps1` | The one command. Pins Node, builds the web client if missing (`pnpm --filter @repcoach/web build`), sets up tailnet exposure (serve or fallback), prints the phone URL, runs the server in the foreground. |
| `Install-RepcoachServer-Startup.ps1` | **No-admin persistence** (default). Drops a logon launcher in the Startup folder so the server auto-starts every logon, independent of any terminal/agent. `-StartNow` launches it immediately. |
| `Install-RepcoachServer-Service.ps1` | Elevated; NSSM Windows service (survives reboot even with no logon). Needs NSSM + admin. |
| `Register-RepcoachServer-Task.ps1` | Scheduled Task at logon. **Requires elevation on this host** (`Register-ScheduledTask`/`schtasks` both return Access Denied non-elevated). |

## Keeping it running (the #1 recurring failure)

**Symptom seen repeatedly:** the phone hangs/times out even though every
server-side check passes. Root cause was almost always **the server process
being gone by the time the phone connects** — during development it was
launched as an *agent background task*, which the harness kills on session
teardown. It is NOT (usually) a code, firewall, or Tailscale problem.

**Fix — pick one, all independent of any agent session:**
- `./scripts/Install-RepcoachServer-Startup.ps1 -StartNow` — no admin;
  auto-starts every logon. **Default.** (Launch the Startup `.cmd` by
  double-click, or `Start-Process`, to start it now without logging out —
  launching via `explorer.exe <cmd>` did NOT work, use the `.cmd` directly.)
- Run `./scripts/Start-RepcoachServer.ps1` in your own PowerShell window and
  leave it open — simplest, survives as long as the window is open.
- Elevated + reboot-proof-without-logon: `Install-RepcoachServer-Service.ps1`
  (NSSM) or `Register-RepcoachServer-Task.ps1` (Scheduled Task).

Verify it's actually up and owned by something other than your shell:
`Get-NetTCPConnection -LocalPort 4020 -State Listen` → PID's parent should be
`node.exe`/`explorer.exe`, not your terminal.

## Trap 1 (retired) — the `expo export` blank-screen bug

The native/Expo React Native client, and with it the `expo export` white-screen
bug that used to crash on module load (`Schema` reading `.reasons` off an
undefined issue; upstream [Effect-TS/effect#6252](https://github.com/Effect-TS/effect/issues/6252)),
is gone (ADR 0012, #53). `apps/web` builds with a plain Vite production build
and has never needed a workaround for it. This section is kept only as a
pointer for anyone who finds a reference to it in old history — there is
nothing left to re-check or retire.

## Trap 2 — Windows Firewall silently blocks the phone

**Symptom:** every local probe works (even against the tailnet IP — loopback
doesn't traverse the firewall), but the phone hangs forever connecting.

**Cause:** auto-created inbound **Block** rules for
`%USERPROFILE%\AppData\Roaming\nvm\v26.5.0\node.exe` (a dismissed Windows
firewall popup). Block beats Allow. The firewall matches the **resolved**
path — the `C:\Program Files\nodejs` symlink's Allow rules don't help.

**Status (2026-07-17): RESOLVED** — the user approved node network access via
the Windows popup, which replaced the Block rules with Allow rules for the nvm
node on Private+Public. The server now runs fine on the system Node 26.5.0 when
direct-binding. The guard below stays as a safety net in case the Block rules
ever reappear.

**Guard:** when direct-binding (`HOST=0.0.0.0`),
`Start-RepcoachServer.ps1` detects Block rules against the resolved system
node and runs the server on the **portable Node**
(`%USERPROFILE%\node-portable\node-v22.23.1-win-x64`, has an Allow rule and
`node:sqlite`). The proper fix if they reappear (elevated, one-time):

```powershell
Get-NetFirewallRule -Direction Inbound -Action Block |
  Where-Object { ($_ | Get-NetFirewallApplicationFilter).Program -ieq "$env:USERPROFILE\AppData\Roaming\nvm\v26.5.0\node.exe" } |
  Remove-NetFirewallRule
```

`tailscale serve` mode does not have this problem at all — tailscaled owns
the inbound connection and proxies to loopback.

## Trap 3 (resolved) — `tailscale serve` blocks forever when the tailnet gate is off

The first-ever `tailscale serve` on a tailnet needs an admin to enable HTTPS
Certificates (the CLI prints an enable link and then **polls forever**).

**Resolved 2026-08-25**: `tailscale serve status` shows
`https://<host>.<tailnet>.ts.net` → `http://127.0.0.1:4020`, and
`tailscale status --json` reports a non-empty `CertDomains`. Serve config is
persistent, so this stays true across reboots and the script now *detects* it
rather than re-issuing the command — see the next section.

## The https URL is not cosmetic — it is the only one with working web APIs

This is the trap that replaced trap 3, and it is nastier because nothing on
screen reports it.

A tailnet host can answer on **two** URLs at once:

| URL | Origin | Reaches the app? |
| --- | --- | --- |
| `https://<magic-dns>` (via `tailscale serve`) | **secure context** | yes |
| `http://<magic-dns>:4020` (direct bind) | insecure | yes |

Browsers withdraw a whole class of API on an insecure origin, **silently** —
no exception the app can catch, no error state it can render:

- `Notification` — the rest timer's off-tab alert (#116 part 2) is dead
- `navigator.wakeLock` — the screen cannot be held awake mid-set
- service workers — no offline install

The realistic way to get bitten: the phone bookmarked the `http` URL during
the period when Serve was still pending, and kept using it long after Serve
started working. **When a web-platform capability seems inexplicably broken on
the phone, check which URL the phone actually has bookmarked before debugging
any code.**

What `Start-RepcoachServer.ps1` does about it:

- Checks `tailscale serve status --json` first and reuses an existing binding,
  matching the proxy target explicitly so a stale config pointing at another
  port is not mistaken for success.
- Reads `CertDomains` from `tailscale status --json` to tell "never set up"
  from "set up but failing", so it can skip a command that would only block.
- Verifies the binding after running `tailscale serve`, rather than trusting
  the exit code.
- On success, binds loopback and prints exactly one URL — the `http` one stops
  answering, which is the point.
- On failure, still falls back (a broken tailnet must never lock you out of
  your own server) but prints a yellow banner naming each API being lost and
  the exact admin-console steps to fix it. `-RequireHttps` turns that fallback
  into a hard failure instead.

**The admin-console step is yours, not an agent's**: enabling HTTPS
Certificates at <https://login.tailscale.com/admin/dns> is an authenticated
account-settings action. Everything after it — the CLI call, the verification,
the URL — the script handles.

## Node runtime matrix

| Node | Where | node:sqlite | Inbound firewall | Used for |
|---|---|---|---|---|
| nvm 26.5.0 (system, `C:\Program Files\nodejs` symlink) | resolved `…\Roaming\nvm\v26.5.0` | yes | **BLOCKED** | builds; server in tailscale-serve (loopback) mode |
| portable 22.23.1 (`%USERPROFILE%\node-portable\…`) | fixed path | yes | Allowed | server in direct-bind mode; vitest/tsc (see memory) |
| old MSI 22.11 | uninstalled | no | — | (gone; used to occupy nvm's symlink path) |

## Verification checklist (after any change here)

```powershell
# 1. unit/integration: 120+ tests incl. static serving, same-origin resolver,
#    restart durability (productionDurability.test.ts), no-test-channel
cd thin-client; pnpm exec vitest run
# 2. typecheck (warm first — TS6310 on cold cache is a known repo quirk)
pnpm -w exec tsc -b; pnpm -w exec tsc -b --noEmit
# 3. real page render (catches bundler regressions the unit tests can't) —
#    the Playwright suite under thin-client/e2e/ is the tool for this now.
pnpm exec playwright test --config e2e/playwright.config.ts
```

## Phone flow (rung-3 UAT)

1. `./scripts/Start-RepcoachServer.ps1` (or the NSSM service).
2. Open the printed URL in the phone's browser (same tailnet). It must be the
   `https://` one — if the script printed a yellow INSECURE FALLBACK banner
   instead, fix that first or the rest timer cannot notify you off-tab.
3. Log a set → restart the server → reload → the set must still be there
   (that's the G5 durability artifact; automated equivalent:
   `productionDurability.test.ts`).

## The real agent path (commissioned 2026-08-05, issue #93)

Until this, **no live Agent SDK session had ever run**. The dev server and every
test/e2e flow wire the *canned* agents, so the whole live path — OAuth under a
server process, where the sessions run from, model ids, what a run costs — was
unverified. It has now been run end to end on this host. This section is the
repeatable configuration plus what a real run actually does.

### Agents cannot start this server

The production wiring is live by construction and spends subscription quota just
by booting — `RealModelCatalog` calls `supportedModels()` on a live `query()`,
`QuotaServiceLive` polls the plan's rate limits, and the Cycle-review schedule
is running. So a PreToolUse hook
(`.claude/hooks/block-live-agent-runs.sh`, issue #95) blocks every spelling of
starting it — this script, `prodIndex.ts`, `pnpm … dev-server start`, and the
`commissioning` entry in `.claude/launch.json` — from a coding-agent session.
**The owner starts it, in their own shell, where the hook does not apply.** An
agent that needs a server to test against uses the dev-server
(`pnpm --filter @repcoach/dev-server dev`), which is canned throughout.

### Run it

```powershell
# a THROWAWAY db, not ~/.repcoach/repcoach.sqlite — Intake only happens once
# per database, and a commissioning run writes genuine rows
./scripts/Start-RepcoachServer.ps1 -Port 4031 -SkipTailscaleServe `
  -DbPath $env:USERPROFILE\.repcoach\commissioning.sqlite
```

Then open the printed URL, go to `/intake`, and drive: draft → answer the
coach's question → **Review the sources** → **Accept**. Finish a session from
Today to fire a live Session review. `.claude/launch.json`'s `commissioning`
entry is the same thing for the Browser pane.

Delete the DB (`Remove-Item ~/.repcoach/commissioning.sqlite*`) to run Intake
again — the accepted Plan is what closes that door.

### Where the sessions run — decided, not inherited

The sessions hold `Bash` and `Read`. Production passed **no `cwd`**, so they
inherited the server process's directory: on this host, the repo. They now run
from `~/.repcoach/agent-workdir` — created and validated at boot, overridable
with `REPCOACH_AGENT_CWD`, and the server **refuses to start** if that
directory is the live DB's own directory or sits inside a git working tree
(`agentWorkingDirectory.ts`). The boot line prints the resolved path.

This is a deliberate default, not a sandbox: `Bash` can `cd` anywhere the
server's user can. Data integrity rests on the read-only snapshot's `chmod`
(ADR 0011 §3), not on this.

### OAuth under a server process

Works, unattended. The SDK spawns
`…/@anthropic-ai/claude-agent-sdk-win32-x64/claude` and picks up the logged-in
profile's subscription credentials with no interactive step — verified across
a server started from a detached PowerShell window, several restarts, and
sessions opened ~40 minutes after boot.

**Not yet verified: a run started after the initial token would have expired.**
That is the exact risk ADR 0005 names, and it needs a server left up across a
token lifetime, not a long session. Until someone does that, treat "the
always-on server survives token expiry" as unproven. The failure would surface
as `could-not-start` (issue #90) — a killed run with a logged reason, not a
silent hang.

### Models

| Setting | What actually runs |
|---|---|
| no per-cadence setting | `claude-sonnet-5` (the SDK default) |
| `claude-haiku-4-5-20251001` | honoured |
| `claude-opus-5` | honoured |
| a typo | the session returns prose — *"There's an issue with the selected model"* — and then throws. Loud, but it is **not** a typed "unknown model" error |

Family aliases (`opus`, `sonnet`, `haiku`) are what the Settings picker
persists, and **the installed Agent SDK decides what they resolve to**, not
this repo. Keeping "Opus" pointing at the newest Opus means keeping
`@anthropic-ai/claude-agent-sdk` current: 0.3.214 sent `opus` to Opus 4.8,
0.3.280 to Opus 5, 0.3.281 to Opus 5.5. To check what an installed SDK does,
read `resolvedModel` off `supportedModels()`. That call is a control
request, not a model turn, so it spends no quota.

`.github/workflows/agent-sdk-update.yml` does the upkeep every Monday. It
moves to the newest SDK release that is at least a day old, which is pnpm's
`minimumReleaseAge`, so no exclusions are needed
(`thin-client/scripts/bump-agent-sdk.mjs`). It then runs typecheck, vitest
and the `@agents` replay specs, and commits to master if they pass. **The
running server only picks up the new SDK after your next pull, `pnpm install`
and restart.**

There is no Settings UI yet (`/settings` still says "not built"), so a
per-cadence model can only be set through the `cadence.setModel` RPC.

### What a run costs

| Run | Wall clock | Tokens (SDK-reported) |
|---|---|---|
| Intake cold draft | ~60–90 s | ~8 k |
| Intake follow-up turn | ~20–30 s | ~3 k |
| Intake convergence sweep | ~2–4 min | ~5 k (16.6 k cumulative for the whole Intake) |
| Session review (deliberator + sweep) | ~2–3 min | — |

The kill-guard defaults (40 turns, 10 min wall clock, per session) are
**generous but not wrong** — the longest thing observed was a convergence sweep
at roughly a third of the wall-clock budget, and nothing came near the turn
cap. Left as they are.

### Recording a live run for the replay fixtures (#95)

Set `REPCOACH_AGENT_RECORD_DIR` and every Agent SDK session this server runs is
written there as a replay cassette — the refresh path for rung 2a's fixtures
(`docs/agents/testing.md` → *Agent-backed rung 2*). Off by default: a production
server does not write transcripts of its own runs to disk unless asked.

```powershell
$env:REPCOACH_AGENT_RECORD_DIR = "$PWD\thin-client\e2e\fixtures\agent-cassettes"
# same THROWAWAY-db posture as the commissioning run above
./scripts/Start-RepcoachServer.ps1 -Port 4031 -SkipTailscaleServe `
  -DbPath $env:USERPROFILE\.repcoach\commissioning.sqlite
```

Each turn is flushed as it completes, so a session that dies partway still
leaves the transcript worth having. Review what lands before committing it — a
cassette carries the prompt in full, which includes whatever the seed dug out of
that database.

### Deviations from the output contract (for #94)

Recorded whether or not they broke a run:

1. **`"citationId": null` where the contract wants the key absent.** Killed a
   complete drafted Plan on the first live Intake. Every optional field in these
   contracts is `Schema.optionalKey`, and a real model very often spells
   "omitted" as `null`. Fixed at the decode boundary for all four adapters
   (`dropNullValues`) — `null` and absent mean the same thing, so collapsing
   them softens nothing that ADR 0011 §6 protects.
1. **Required keys omitted when there was nothing to put in them.** Two
   consecutive Session reviews did all their reasoning and then died on
   `Missing key at ["decisions"][0]["reasoning_only_points"]` and then
   `…["surface"]`. `citations`/`reasoning_only_points` are lists whose empty
   value is unambiguous, and `surface` is meaningless on a Proposal (the prompt
   *tells* the model it only matters for Observations, and §6 gives every
   Proposal a feed entry). All three are now defaulted at the decode boundary
   (`defaultEmptyDecisionLists`; Proposal → `surface: true`, Observation →
   `false`). The three **working** fields are deliberately never defaulted.
2. **Invented exercise ids.** The coach drafted around `exercise-deadlift` and
   `exercise-barbell-row` — ids shaped exactly like the real ones. The plan
   converged, the user accepted, and **Accept** rejected the whole thing with
   `DraftPlanExerciseUnknownError` at the last tap. The catalog is now injected
   into the Intake seed as an explicit closed set.
3. **No bare-JSON drift observed.** Across five live sessions, every final
   message was a clean single object — the failure #94 was written against did
   not occur here. That is evidence about frequency, not safety.
4. **A failed Intake was silent server-side.** The user-facing card can only say
   "the draft didn't come back"; there was no server trace at all. Now logged
   with its phase and an excerpt of the reply that failed to decode.

### What #94 did about them, and why that shape

Issue #94 asked for the fix to be chosen from the drift above rather than
guessed at. The evidence points two ways at once, so the answer is two layers,
ordered by what they cost:

**Layer 1 — the extraction, free, on every message.** The whole defence used to
be one regex stripping a single ```-fence: it covers a bare object and a
```json fence and nothing else. It now tries the whole message, then any fence
(three-or-more backticks *or* tildes, any language tag, and one the model opened
and never closed), then string-aware balanced `{…}` spans longest-first — so
prose either side of the object, or a `{8}` quoted inside a summary, no longer
kill a run. This costs nothing and is why deviation 5 above ("no bare-JSON drift
observed") did **not** argue for doing nothing: five sessions is evidence about
frequency, not about safety, and the free fix has no downside to weigh it
against.

**Layer 2 — one repair turn, only after layer 1 has already failed.** Bounded by
construction, not by a setting: exactly one attempt, no tools, one turn, two
minutes, and the second failure is terminal. The one-shot agents open a tiny
fresh session holding the unreadable message; the held-open Intake session just
resumes itself, which is cheaper and cannot lose the draft. The repair is told to
re-emit and explicitly **not** to re-reason — the value being rescued is the work
already done. Both turns' tokens and cost are summed onto the same ledger row, so
a model that needs repairing on every run shows up in the numbers rather than
hiding in them.

Layer 2 is aimed at the drift this host actually produced. Deviations 1 and 2
were contract-shaped, three times in five sessions, and each threw away a
finished run; `dropNullValues`/`defaultEmptyDecisionLists` absorb those two named
cases, and the repair turn is the general form of the same rescue for the fourth
deviation nobody has seen yet. Whether it ever fires is on the UAT watchlist
(entry 7) — it is machinery justified by reasoning, not by an observation.

An output that survives neither layer now fails as a **typed** failure carrying
which way it failed (`no-json` / `invalid-json` / `contract`), on the agent
ports themselves rather than as a defect thrown past them. The runner still
converts it to the loud died-run path issue #90 built, in one place, so a failed
run reads the same on the phone as it always did — with a better reason line.

### The retrieval trap: three reviews in a row read nothing

The first three live Session reviews **read no data at all**. Each said so
honestly in its rationale ("This review's tooling could not read the
Log/logged_set_actual data") rather than fabricating — the good failure — but
the runs were worthless: retrieval-on-demand is half of ADR 0011 §2, and it was
inert in production. Three separate causes, all of them invisible until a real
session ran:

1. **No `sqlite3` on this host.** The seed's pointers named that CLI and nothing
   else. The seed now leads with a Node recipe (`node -e` + `node:sqlite`,
   read-only) — Node is the one query engine guaranteed present, since it is
   what the server runs on — and keeps `sqlite3` as the shorter path where it
   exists. Installing `sqlite3` makes it the fast path again; nothing depends
   on it.
2. **Nobody to answer a permission prompt.** Every `Bash` call came back
   `This command requires approval`: a `query()` session prompts by default,
   and a background server process has no approver. The sessions now run
   `permissionMode: 'bypassPermissions'`. The safety boundary is, and always
   was, the OS-read-only snapshot (§3) plus the commissioned working directory —
   not a prompt nobody can answer. `dontAsk` would have failed identically
   (deny rather than ask).
3. **A Windows path pasted into git-bash.** The snapshot lives at
   `C:\Users\…\Temp\…`; the backslashes were eaten as escapes and the query
   failed with "unable to open database file", which reads exactly like "the
   data isn't there". The seed now renders the path with forward slashes,
   quoted.

With all three fixed, a live Session review reads the Log properly — the
committed Decision cites real entry ids and per-session rep counts and fills
`measurements_json` with actual numbers.

## Open items for the next agent

- **Tailscale serve enablement** — DONE (verified 2026-08-25). The script now
  binds loopback and prints `https://<host>.<tailnet>.ts.net`, so the
  firewall trap is irrelevant in the normal path. Remaining action is on the
  *phone*: re-bookmark the https URL and delete any `http://…:4020` one, or
  notifications and wake lock stay silently disabled.
- **Firewall Block rules** — REMOVED (user approved the node popup 2026-07-17);
  system Node direct-bind works. Guard remains if they reappear.
- **Persistence** — a Startup-folder launcher is installed
  (`Install-RepcoachServer-Startup.ps1`), so the server auto-starts at logon.
  An elevated NSSM service / Scheduled Task is still the only reboot-proof-
  without-logon option (both blocked non-elevated on this host).
- **Playwright 14-flow suite** — GREEN as of 2026-07-19: all 14 flows pass
  against the merged same-origin build (cross-origin env override preserved
  for the e2e harness). Re-run after any web-build or contract change.

## Teardown

```powershell
nssm stop RepcoachServer; nssm remove RepcoachServer confirm   # if installed
tailscale serve --https=443 off                                # if serve was set
```
