# Thin-client implementation plan — sequential sub-agent tasks

Executes [ADR 0009](../adr/0009-thin-client-experiment-parallel-track.md) and [docs/design/thin-client-experiment.md](./thin-client-experiment.md). Each task below is a self-contained hand-off: a sub-agent picks up the **lowest-numbered incomplete task**, completes it to its Done-when bar, and stops. Tasks are strictly sequential — each depends on the one before.

Reference repo cloned at `../t3code`. Reused code paths cite it directly.

## Where the code lives

A new top-level **`thin-client/`** pnpm workspace in this repo (sibling to `app/`, invisible to Gradle). Keeps the ADRs and this plan adjacent to the code while staying fully parallel to the native app — nothing under `app/` is touched by any task here.

```
thin-client/
  packages/client-runtime/   # vendored from t3code, + our platform seam
  packages/contracts/        # our Effect-Schema RPC
  apps/expo/                 # the RN thin client (also runs as Expo web for e2e)
  apps/dev-server/           # controllable dev/test server (real home server later)
  e2e/                       # browser-driven acceptance flows (rung 2)
```

---

## Testing approach (how every task is verified)

Same three ascending rungs as the native app ([docs/agents/testing.md](../agents/testing.md)), re-homed for JS/RN. A task is not done until every rung it touches is green.

| Rung | What | Tool | Who writes it |
|------|------|------|---------------|
| 1. Unit / integration | Behavior at code seams | **Vitest** (mirrors t3code's `vitest`) | Implementer, TDD |
| 2. E2E acceptance | User journeys, black-box | **Browser driver on Expo web** | **Adversarial author agent** |
| 3. UAT | Real Expo build, real signal | Expo build on Pixel 7 over Tailscale | Human |

### Rung 2 is browser-driven — and more involved than Maestro on purpose

The thin client runs unchanged as **Expo web** (`expo start --web`), so acceptance flows drive it in a real browser via a Playwright-capable driver (the `mcp__t3-code__preview_*` tools, or Playwright directly). This buys the one thing Maestro-on-a-device cannot give us and which this feature lives or dies on: **programmatic network control.**

- **Offline capture (G1)** — the driver forces true offline via CDP (`Network.emulateNetworkConditions` / `context.setOffline(true)`), logs sets, restores the network, and asserts server state matches. No implementation hook — the browser lies to the app about the network, exactly like a dead gym signal.
- **Blip transparency (G2)** — kill only the WebSocket (via the dev-server's control channel, below) while the radio stays up; assert the UI never surfaces an error.
- **Assertions stay black-box** — the author asserts only on visible text / accessibility roles in the DOM, never on component internals, and reads network state through the browser and the dev-server control API, never through the client source.

### The adversarial separation (unchanged contract)

- **Author agent** — given the task's PRD/spec, the app's visible-string inventory, and the **dev-server control API** (its lever for inducing offline/blips). **Forbidden to read `thin-client/packages/client-runtime/**` and `thin-client/apps/expo/**`.** Writes only under `thin-client/e2e/`.
- **Implementer agent** — full source access; writes code and rung-1 tests until the author's flows go green.

The dev-server control channel (`POST /__test__/drop-socket`, `/__test__/pause-acks`, `/__test__/reset`) is an **external lever on the server**, not a hook in the client — so using it keeps the client black-box. It is built in Task 2 precisely so the adversarial author can induce failures without seeing client internals.

---

## Task 0 — Workspace + test harness skeleton

**Depends on:** nothing. **Advances:** tooling for all gates.

- Create the `thin-client/` pnpm workspace, TypeScript + Vitest + Effect, matching t3code's `tsconfig.base.json` / lint setup.
- Scaffold an empty Expo app (`apps/expo`) that runs on both device and `--web`.
- Stand up the rung-2 harness: a browser driver that can launch Expo web, navigate, snapshot the DOM, and toggle CDP offline. Prove it with a trivial "app renders 'RepCoach'" flow.
- **Rung 1:** CI runs `vitest` (no tests yet, green). **Rung 2:** the one trivial flow passes with an offline-toggle no-op exercised. **Rung 3:** n/a.
- **Done-when:** `pnpm test` and the harness's smoke flow both pass on Expo web; the offline-toggle primitive is demonstrably working.

## Task 1 — Contracts package

**Depends on:** 0. **Advances:** G4 (server authority). **ADR:** 0002, 0005, 0006.

- Define the RPC surface in Effect `Schema` / `RpcGroup` (style of t3code `packages/contracts`):
  - `serverGetConfig` (used by the supervisor's probe);
  - `getPrescribedSession(sessionId)` → the Prescribed Session (Scaffold shape from [ADR 0001](../adr/0001-plan-model-agnostic-scaffold.md): `Session → Block → Entry → Set`, prescribed side only);
  - `logSetActual` — **idempotent, keyed by client `commandId`**; carries `sessionId`, `entryId`, `setId`, actual metric map (per [ADR 0006](../adr/0006-logging-is-pure-actual-capture.md): actual capture only, never a Change);
  - subscriptions `subscribeCoachingFeed`, `subscribeProposals`, `subscribePlan`.
- Domain terms must match CONTEXT.md exactly (Prescribed/Logged Session, Entry, Set, Proposal).
- **Rung 1:** schema encode/decode round-trip tests; `logSetActual` input rejects a malformed metric map. **Rung 2/3:** n/a (no UI).
- **Done-when:** contracts compile, round-trip tests green, importable by both client and server packages.

## Task 2 — Dev server with idempotent apply + test-control channel

**Depends on:** 1. **Advances:** G1, G4. **ADR:** 0005.

- Effect-RPC WebSocket server (mirror t3code `apps/server`) implementing the Task 1 contracts against an in-memory store.
- `logSetActual` applies **exactly-once by `commandId`** — a replayed id is a no-op returning the same result. This is the server half of G1.
- **Test-control channel** (dev builds only): `drop-socket`, `pause-acks` (accept writes but withhold acknowledgements to simulate a half-open link), `reset`. This is the adversarial author's lever.
- Reachable over Tailscale (tailnet DNS name).
- **Rung 1:** idempotency test — the same `commandId` applied twice yields one stored actual; concurrent duplicate flush yields one. **Rung 2:** author drives a raw WS client (no UI yet) to prove drop/reset control works. **Rung 3:** n/a.
- **Done-when:** idempotent apply proven under duplicate + concurrent replay; control channel induces and clears a socket drop on demand.

## Task 3 — Connection layer (vendor client-runtime + platform seam)

**Depends on:** 2. **Advances:** G2 (blip transparency). **ADR:** 0009.

- Vendor `t3code/packages/client-runtime/src/{connection,rpc}` unchanged.
- Supply the RN platform seam (see the reuse-map table in the design doc): `Connectivity` from `@react-native-community/netinfo`; `WebSocketConstructor` from the RN/web global; `ConnectionWakeups` from `AppState` (`application-active` on foreground); credential store from `expo-secure-store`.
- Wire the supervisor to the Task 2 server over Tailscale; surface connection state (`connecting/connected/backoff/offline/blocked`) to the UI, including an explicit **"not connected to home"** indicator.
- **Rung 1:** supervisor state-transition tests against a fake driver — backoff schedule `[1,2,4,8,16]s`, 30s stable reset, offline parks attempts, resume-probe tears down a zombie socket. **Rung 2 (adversarial):** flow drives Expo web to `connected`, author calls `drop-socket`, asserts the UI recovers to `connected` within backoff and shows no error for a sub-30s drop. **Rung 3:** app reaches `connected` on the Pixel 7 over Tailscale; survives an airplane-mode toggle.
- **Done-when:** G2 green in the browser (sub-30s blip is invisible) and on the phone.

## Task 4 — Log outbox

**Depends on:** 3. **Advances:** G1 (make-or-break). **ADR:** 0006, 0009.

- Port `t3code/apps/mobile/src/state/thread-outbox-{manager,model}.ts` → a **log outbox**: `QueuedThreadMessage → QueuedSetActual` (`commandId`, `sessionId`, `entryId`, `setId`, actual metric map, `createdAt`, `schemaVersion`). Keep the serialized mutation queue, persist-before-reflect, schema versioning, and idempotent-id discipline.
- Backing store: `AsyncStorage` (web: its localStorage shim). Flush on session-available; dedupe against the server's idempotent apply.
- **Rung 1:** enqueue persists before UI reflect; flush is exactly-once; queue survives a simulated app kill (reload from store); schema-version migration path exercised. **Rung 2 (adversarial, the headline test):** author forces CDP **offline**, logs a sequence of sets through the (stub) UI or a thin harness screen, restores the network, and asserts server state equals exactly what was entered — **no loss, no duplicates**. Then repeats with `pause-acks` (half-open link) to prove the retry/replay path dedupes. **Rung 3:** log a full set sequence in airplane mode on the Pixel 7; reconnect; verify server state.
- **Done-when:** G1 green — offline logging flushes exactly-once in the browser and on the phone.

## Task 5 — Prescription prefetch + cache

**Depends on:** 4. **Advances:** G3 (prefetch sufficiency). **ADR:** 0001, 0007.

- On "Start workout" (while connected), fetch `getPrescribedSession` and cache it durably; logging thereafter reads targets, ghost-text source, and prescribed rest from the cache with **no network dependency between sets**.
- Cache invalidation only on next connected start — a session in progress is frozen (mirrors ADR 0006/0007: instantiation is a copy; later prescription edits don't reach an in-flight Logged Session).
- **Rung 1:** cache hit serves the full prescribed tree offline; a mid-session prescription change on the server does not mutate the cached in-flight session. **Rung 2 (adversarial):** author starts a session while online, goes CDP-offline, and completes the whole session (targets + ghost text visible, rest values present) with the network down. **Rung 3:** start a session, enable airplane mode, complete it on the phone.
- **Done-when:** G3 green — a full session completes offline from the prefetched cache.

## Task 6 — Logging UI

**Depends on:** 5. **Advances:** the primary surface. **ADR:** 0006, 0008; **UI:** [ui-surfaces.md](./ui-surfaces.md) "Logging (in-workout)".

- RN logging grid: prescribed-vs-actual row alignment, ghost text from the cache, one-tap confirm, special set-types and timed Block formats loggable, hidden straight-Block wrapper (per CONTEXT `Block`). Every actual write goes **through the outbox** (Task 4), never direct.
- Field layout is driven by the Exercise catalog's declared metrics (CONTEXT `Exercise catalog`).
- **Rung 1:** reducer/interaction tests for row alignment, ghost-text fill, confirm → outbox enqueue. **Rung 2 (adversarial):** the real user journeys — "log a straight session and see actuals persist", "log a superset", "log a drop set", each also run once **offline** to prove the UI path stays outbox-backed. Named after behavior, `clearState`-equivalent per flow, independent. **Rung 3:** log a realistic session on the Pixel 7.
- **Done-when:** logging journeys green online and offline; friction is hand-off ready for the G5 bake-off.

## Task 7 — Rest timer (fully local)

**Depends on:** 5 (cache). **Advances:** G3. **ADR:** 0006.

- Rest timer driven entirely from cached prescribed rest; **never touches the network**; absent prescribed rest = no timer (per CONTEXT `Set`).
- **Rung 1:** timer starts/counts/completes from a prescribed rest value; absent value = no timer. **Rung 2 (adversarial):** offline flow — rest timer fires and counts down correctly with the network down. **Rung 3:** timer works on the phone in airplane mode.
- **Done-when:** timer verified offline in browser and on phone.

## Task 8 — Coaching feed / Proposals (subscribe-and-replay)

**Depends on:** 3. **Advances:** review surfaces (online-only by design). **ADR:** 0002, 0008.

- Wire `subscribeCoachingFeed` / `subscribeProposals` via client-runtime's `subscribe`; accept/dismiss a Proposal (Plan mutates only on accept — ADR 0008). These surfaces are **online-only** and must degrade gracefully to the "not connected to home" state.
- **Rung 1:** subscription re-attaches on a new session (fake driver), replays state; accept → mutation request, dismiss → no mutation. **Rung 2 (adversarial):** feed renders live; `drop-socket` then recovery re-populates the feed without a manual refresh (proves subscribe-replay); offline shows the not-connected state, not stale-as-live. **Rung 3:** feed + a Proposal accept round-trip on the phone.
- **Done-when:** feed survives a reconnect transparently; offline degradation is explicit.

---

## Bake-off gate (G5) — after Task 8

Not a coding task. Run the full rung-2 suite green, then deploy the Expo build to the Pixel 7 over Tailscale and log real sessions on real gym signal alongside the native app. Only if logging reliability and friction meet or beat native does a **future ADR** supersede [ADR 0004](../adr/0004-native-android-local-first.md). If G1 regresses on real signal, the track is abandoned and the native app continues unchanged (ADR 0009).

## Sequencing summary

```
0 harness → 1 contracts → 2 dev-server(+control) → 3 connection(G2)
      → 4 outbox(G1) → 5 prefetch(G3) → 6 logging UI ─┐
                                     └→ 7 rest timer   ├→ G5 bake-off
                          3 ────────────→ 8 feed ──────┘
```
Tasks 6/7 and 8 can be parallelised once their deps land, but a single sub-agent should still take the lowest incomplete task to keep the chain deterministic.
</content>
