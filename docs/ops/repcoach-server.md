# RepCoach production server & web client

**Audience: the next agent (or human) touching the always-on home-server setup.**
This is the single explainer for how the phone-facing production deployment
works, every non-obvious decision in it, and the traps that already bit us.
Read this before changing anything under `thin-client/apps/dev-server`,
`scripts/*.ps1`, or the web build. The owner-facing walkthrough is
[`docs/self-hosting.md`](../self-hosting.md); the decision is
[ADR 0024](../adr/0024-the-server-owns-its-own-exposure-and-devices-pair.md).

## The model (copied from t3code)

The UX contract: **`pnpm repcoach install`, then everything else from
Settings → Server.** The server publishes itself over Tailscale, pairs devices
and installs its own background service; no launcher script has to get any of
that right.

```
phone browser ──(tailnet, https)──> tailscale serve ──> production server (127.0.0.1:4020)
   GET /                            ── the built web client (apps/web dist/, Vite) — public
   GET /.well-known/repcoach/server ── identity probe — public
   GET/POST /api/auth/*             ── pairing — public
   WS /rpc, /api/server/*           ── paired devices only (session cookie)
   ↳ ~/.repcoach/: repcoach.sqlite · server-secret · repcoach.auth.json · repcoach.runtime.json · logs/
```

| File (`apps/dev-server/src/`) | Role |
|---|---|
| `productionMain.ts` | Boots everything below; env config. `prodIndex.ts` and `cli.ts` both call it. |
| `cli.ts` | `pnpm repcoach install / start / pair / status`. Rebuilds a stale web client before starting. |
| `serverAuth.ts` | Pairing codes (HMAC, one use, 15 min) and hashed sessions. |
| `serverAdmin.ts` | The auth gate (`HttpRouter.serve` middleware, so it sees WebSocket upgrades) and the admin routes. |
| `tailscale.ts`, `tailscaleExposure.ts` | Tailscale CLI calls (bounded, stderr reduced to a label) and the every-minute check that keeps Serve pointed here. |
| `serviceManager.ts` | Background service per platform: Startup-folder loop, systemd user unit, LaunchAgent. |
| `runtimeState.ts` | `<db>.runtime.json`: pid, port, instance id — how the CLI finds the running server. |

The client derives its server URL from `window.location.origin` in production
builds (`Connection.resolveServerBaseUrls`). The pairing gate and the Server
section in Settings switch themselves off for the dev-server and the
cross-origin e2e harness (`apps/web/src/runtime/serverAccess.ts`), which have
neither.

**No `/__test__/*` control channel in this build** — that's dev-only, and a
prod server exposing reset/drop-socket would let anyone wipe real logged data.

## Keeping it running (the #1 recurring failure)

**Symptom seen repeatedly:** the phone hangs/times out even though every
server-side check passes. Root cause was almost always **the server process
being gone by the time the phone connects** — launched from a terminal or an
agent background task that was later closed.

**Fix:** Settings → Server → **Install as background service**.
`pnpm repcoach status` says whether the running server is the service's or a
hand-started one.

**The handover trap.** Installing from the UI happens on a hand-started
server, which then has to start the service and exit. A child spawned with
`detached: true` did **not** survive that exit when the server was itself
started from an agent session: it died with the parent's job object. The
Windows flavour therefore has WMI (`Win32_Process.Create`) start the
launcher, which puts it outside the job, and the server waits for that call to
return before exiting. Verified live on 2026-10-31: install, handover, restart
and remove all worked from the UI against a scratch instance.

The elevated scripts remain for a server that must run with nobody logged in:
`Install-RepcoachServer-Service.ps1` (NSSM) and `Register-RepcoachServer-Task.ps1`
(Scheduled Task). Both run `Start-RepcoachServer.ps1`, now a thin wrapper over
`pnpm repcoach start`. Settings reports an NSSM install, and the old
Startup-folder `RepcoachServer.cmd`, as legacy launchers; installing the new
service deletes the `.cmd`.

## Phone access: https only, set up by the server

A tailnet host could once answer on **two** URLs at once:

| URL | Origin | Reaches the app? |
| --- | --- | --- |
| `https://<magic-dns>` (via `tailscale serve`) | **secure context** | yes |
| `http://<magic-dns>:4020` (direct bind) | insecure | yes |

Browsers withdraw a whole class of API on an insecure origin, **silently**:
`Notification` (the rest timer's off-tab alert), `navigator.wakeLock`, service
workers. So the plain-http fallback is gone. The server binds loopback, and
`tailscaleExposure.ts`:

- reads `tailscale status --json` and refuses to run `tailscale serve` while
  the tailnet has no HTTPS certificates (the node's `https` capability, or
  `CertDomains` on older CLIs) — `serve` blocks forever waiting on an admin
  click in that state;
- leaves an existing mapping to this port alone, and **never takes a Serve port
  whose target still answers** — the real server, seen from a commissioning
  run, or an older RepCoach without the identity route;
- proves success by fetching `https://…ts.net/.well-known/repcoach/server` and
  matching this process's `instanceId`, rather than trusting the exit code;
- does **not** remove the mapping on shutdown (unlike t3code): the phone's
  bookmark and home-screen app should survive a supervised restart;
- re-checks every minute, so turning on HTTPS certificates in the admin console
  takes effect without a restart. That click is the owner's, not an agent's.

When a web-platform capability seems inexplicably broken on the phone, still
check which URL it has bookmarked first: an old `http://…:4020` bookmark from
the fallback days stops answering once the server binds loopback.

## Pairing

Tailscale used to be the only access control. Now `/rpc` and `/api/server/*`
require a session cookie (`repcoach_session`, httpOnly, `SameSite=Strict`,
`Secure` behind Serve), issued by redeeming a one-time pairing code:

- Codes are `<expiry>.<nonce>.<hmac>` under `server-secret`, so the `pair` CLI
  mints them from the file without talking to the server. Spent nonces are
  recorded in `<db>.auth.json` until expiry.
- Sessions and runtime state are named after the **database**, not the
  directory: a commissioning server on `commissioning.sqlite` beside the real
  `repcoach.sqlite` keeps its own paired devices instead of overwriting them.
- Links put the code in the **fragment** (`/pair#code=…`): the server's request
  logger records full URLs, and a fragment is never sent.
- There is no loopback exemption — Tailscale Serve proxies from 127.0.0.1 too.
  `pnpm repcoach install` pairs this machine's browser by opening a pairing
  link instead.
- WebSocket upgrades and POSTs with a mismatched `Origin` are refused
  (cross-site WebSocket hijacking), compared against `X-Forwarded-Host` behind
  Serve.

## Node runtime

Any Node ≥ 22.16. The service pins the binary that was running `install`
(`process.execPath`), so an nvm switch later does not move it. The old
firewall trap (Windows auto-created inbound **Block** rules for nvm's
`node.exe`) only ever affected direct binding; with loopback-only binding,
tailscaled owns the inbound connection and the portable-Node workaround is
gone.

## Verification checklist (after any change here)

```powershell
cd thin-client
pnpm test                         # every unit/integration suite
pnpm -w exec tsc -b               # typecheck (warm; TS6310 on a cold cache is a known quirk)
pnpm --filter @repcoach/e2e test  # Playwright; clear ports 4010/4011/5173/5174 first
```

To exercise the admin flow live without touching the real server, run a
scratch instance on another port, Serve port and data directory. Setting
`APPDATA` to a scratch folder for that process also keeps a test service
install out of the real Startup folder:

```powershell
$env:PORT = "4041"; $env:REPCOACH_TAILSCALE_SERVE_PORT = "8443"
$env:REPCOACH_DB_PATH = "$env:TEMP\repcoach-scratch\repcoach.sqlite"
$env:APPDATA = "$env:TEMP\repcoach-scratch\appdata"
pnpm repcoach install
# afterwards: tailscale serve --https=8443 off
```

## Phone flow (rung-3 UAT)

1. `pnpm repcoach install` (or nothing, if the service runs).
2. Settings → Server → Pair a device; scan the QR with the phone. It must land
   on the `https://` URL.
3. Log a set → **Restart server** → reload → the set must still be there
   (the G5 durability artifact; automated equivalent:
   `productionDurability.test.ts`).

## The real agent path (commissioned 2026-08-05, issue #93)

Until this, **no live Agent SDK session had ever run**. The dev server and every
test/e2e flow wire the *canned* agents, so the whole live path — OAuth under a
server process, where the sessions run from, model ids, what a run costs — was
unverified. It has now been run end to end on this host. This section is the
repeatable configuration plus what a real run actually does.

### Booting it spends quota

The production wiring is live by construction and spends subscription quota just
by booting — `RealModelCatalog` calls `supportedModels()` on a live `query()`,
`QuotaServiceLive` polls the plan's rate limits, and the Cycle-review schedule
is running. When a server is only needed to test against, use the dev-server
(`pnpm --filter @repcoach/dev-server dev`), which is canned throughout.

### Run it

```powershell
# a THROWAWAY db, not ~/.repcoach/repcoach.sqlite — Intake only happens once
# per database, and a commissioning run writes genuine rows
./scripts/Start-RepcoachServer.ps1 -Port 4031 -SkipTailscaleServe `
  -DbPath $env:USERPROFILE\.repcoach\commissioning.sqlite
```

Add `-Open` to have it open this machine's browser already paired; otherwise
the page asks to pair, and a link comes from the same settings:
`$env:REPCOACH_DB_PATH = "$env:USERPROFILE\.repcoach\commissioning.sqlite"; pnpm repcoach pair`
(from `thin-client/`). Then go to `/intake` and drive: draft → answer the
coach's question → **Review the sources** → **Accept**. Finish a session from
Today to fire a live Session review. `.claude/launch.json`'s `commissioning`
entry is the same thing for the Browser pane — open the `pair` link there.

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

- **First pairing on the owner's phone** after this change: the phone shows
  "Pair this device" until `pnpm repcoach pair` (or Settings on the PC) is
  scanned. Unsynced sets stay in its outbox meanwhile.
- **Linux and macOS services** are implemented and unit-tested, not run.
- **Playwright suite** — re-run after any web-build or contract change.

## Teardown

```powershell
# Settings → Server → Remove service, or by hand:
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\RepcoachServer.vbs", "$env:USERPROFILE\.repcoach\service\run-server.cmd"
nssm stop RepcoachServer; nssm remove RepcoachServer confirm   # if installed
tailscale serve --https=443 off                                # if serve was set
```
