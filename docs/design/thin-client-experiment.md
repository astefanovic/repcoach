# Thin-client experiment (historical) — the RN-over-Tailscale design that won

> **Status: historical.** This document records the *original design intent*
> for what has since become **the** client, not a parallel track. [ADR
> 0009](../adr/0009-thin-client-experiment-parallel-track.md) (parallel-track
> bake-off) and [ADR 0004](../adr/0004-native-android-local-first.md) (native
> Android) are both superseded by [ADR
> 0012](../adr/0012-web-only-client-supersedes-native-android.md): the native
> app is retired, the bake-off was waived rather than won, and React Native/Expo
> itself is gone — the client that shipped is a plain React **web app**
> (`thin-client/apps/web`), not the Expo/RN app this doc describes. The
> architecture, reuse map and connection-layer reasoning below are still
> materially accurate (they describe `packages/client-runtime`, which is
> platform-agnostic Effect and survived the RN→web move untouched); read the
> RN/Expo-specific parts (the platform seam table, the delivery model) as the
> shape that was, not the shape that is. For the current shape, see [ADR
> 0012](../adr/0012-web-only-client-supersedes-native-android.md),
> [docs/design/ui-surfaces.md](./ui-surfaces.md) and
> [docs/ops/repcoach-server.md](../ops/repcoach-server.md).

Governing decision (superseded, see above): [ADR
0009](../adr/0009-thin-client-experiment-parallel-track.md). This doc carries the
architecture, the t3code reuse map, the requirements as acceptance tests, and the
build order, as they stood when the experiment was a **parallel track** that did
not touch or block the native Android app ([ADR
0004](../adr/0004-native-android-local-first.md)).

Reference repo: `pingdotgg/t3code` (cloned at `../t3code`). It is a "minimal web GUI for coding agents": an always-running server that hosts the agent, thin Expo/RN + web clients, connected over Tailscale. The client↔server resilience is exactly the problem RepCoach's gym-logging surface has, so we reuse its connection layer rather than re-inventing it.

> **Status (2026-07-17).** The client build (tasks 0–8) and **Step 2A** (persistent backend) are complete on the `thin-client` branch. Two things below have since been resolved and superseded by later decisions — read them as the original design intent, not the current shape:
> - **Delivery model:** production delivery is now the **web build served by the home server over Tailscale** (open a URL in the phone browser), not Expo Go / a native build — see [ADR 0010](../adr/0010-persistent-home-server-serves-web-client.md) and [docs/ops/repcoach-server.md](../ops/repcoach-server.md).
> - **The server:** the in-memory dev-server described here was replaced by a persistent **Node/Effect + SQLite** server behind the same `Store` seam; contracts and the client were untouched. Deliberation (Step 2B) is still pending.

---

## Why this is even plausible (the premise)

The naïve read is "their retry code is robust enough for a workout." That is half right, and the right half is **not** the retry. t3code survives disconnection through three distinct mechanisms:

1. **Connection supervisor** — `packages/client-runtime/src/connection/supervisor.ts`
   A state machine over `desired × network → connecting / connected / backoff / offline / blocked`:
   - exponential backoff `RETRY_DELAYS_MS = [1,2,4,8,16]s`, capped at 16s, **reset after 30s of stable connection** (`BACKOFF_RESET_AFTER_MS`);
   - **network-aware** — subscribes to OS connectivity; parks in `offline` (no wasted attempts) when the radio is down, wakes the instant it returns;
   - **resume health-probe** — on an `application-active` wakeup it fires a `serverGetConfig` probe (15s timeout) and tears down a zombie socket rather than trusting it;
   - the WebSocket itself has retries **disabled** (`retryPolicy: recurs(0)` in `rpc/session.ts`); all reconnection is the supervisor rebuilding a fresh session.

2. **Subscribe-and-replay** — `packages/client-runtime/src/rpc/client.ts` (`subscribe`)
   The session is a `SubscriptionRef<Option<RpcSession>>`; every subscription `switchMap`s over it, so on reconnect it **re-attaches and the server replays current state**. Reads cache nothing durably — the server is the source of truth. A sub-30s blip is invisible to the UI.

3. **Durable outbox** — `apps/mobile/src/state/thread-outbox-manager.ts` + `thread-outbox-model.ts`
   A persisted, schema-versioned, serialized queue of the user's *own composed input* (messages / task-creations), each with an idempotent `commandId`. Survives app kills; flushes when a session reappears. **This is the only durable write path in the whole client.**

**The load-bearing correction.** Mechanisms 1–2 only mask *blips*; a unary `request()` with no session fails immediately with "not connected." The reason t3code survives a real offline stretch is mechanism 3 — the outbox — because the one thing the server can't re-supply is *what the user just typed*.

That maps exactly onto RepCoach: **a logged Set is user-composed input the server cannot reconstruct.** So the pattern transfers — but it transfers *because we adopt the outbox*, i.e. durable local write buffering. This is the same conclusion the offline analysis reached independently, now confirmed in t3code's own source: they needed an outbox too.

### The enabling move: prescription prefetch

You don't need full history offline mid-workout — you need *today's prescription* (small, fetched once) plus *the ability to record actuals* (outbox). So: **at "Start workout", while connected, fetch and cache the Prescribed Session.** From then on logging runs entirely against the outbox and the cache; the network is optional until you next want to read server-owned state.

---

## Architecture

```
Expo/RN thin client                         Home server (ADR 0005)
┌───────────────────────────────┐           ┌────────────────────────────┐
│ client-runtime (vendored)     │  WS/RPC   │ Effect-RPC WS endpoint      │
│  • supervisor (reconnect)     │◄─────────►│  • serverGetConfig          │
│  • subscribe / request        │ Tailscale │  • getPrescribedSession     │
│  • rpc session                │           │  • logSetActual (idempotent)│
│                               │           │  • subscribe{Feed,Proposals}│
│ log outbox (AsyncStorage)     │           │                             │
│ prescription cache            │           │ source of truth: Plan,      │
│ RN UI (log grid, timer, feed) │           │ Decisions, feed, analytics  │
└───────────────────────────────┘           └────────────────────────────┘
```

The client holds **only** the outbox (pending un-synced writes) and a display cache. Everything authoritative stays on the server, unchanged from ADR 0002/0005.

## Reuse map

### Reused near-verbatim (pure Effect, no React/Expo imports)
- `packages/client-runtime/src/connection/*` — supervisor, connectivity interface, driver, wakeups.
- `packages/client-runtime/src/rpc/*` — session, `subscribe`/`request`, protocol.
- `apps/mobile/src/state/thread-outbox-*` — copied structurally, renamed to the **log outbox**: `QueuedThreadMessage → QueuedSetActual` (`commandId`, `sessionId`, `entryId`, `setId`, actual metric map, `createdAt`, `schemaVersion`). Serialized mutation queue, persist-before-reflect, and idempotent-id logic carry over unchanged.
- `packages/tailscale` — connection target; the supervisor already models a `RelayConnectionTarget`, so a tailnet DNS name drops in.

### Platform seam we supply (standard Expo modules)
| `client-runtime` interface | RN implementation |
|---|---|
| `Connectivity` (`connection/connectivity.ts`) | `@react-native-community/netinfo` → `online`/`offline` stream |
| `Socket.WebSocketConstructor` | RN global `WebSocket` |
| `ConnectionWakeups` (`connection/wakeups.ts`) | `AppState` → emit `application-active` on foreground |
| Outbox storage | `AsyncStorage` (data volume is trivial) — or `expo-sqlite` if we later want offline history |
| Credential / profile store | `expo-secure-store` |

### Net-new
1. **Contracts** — RepCoach RPC in the same Effect `Schema` / `RpcGroup` style as `packages/contracts`: `serverGetConfig`, `getPrescribedSession`, `logSetActual` (idempotent, keyed by `commandId`), and subscriptions `subscribeCoachingFeed` / `subscribeProposals` / `subscribePlan`. The reused client machinery is generic over these tags.
2. **Server endpoint** — the ADR-0005 home server grows an Effect-RPC WS server (mirror `apps/server`), applying `logSetActual` idempotently by client-id.
3. **Prescription prefetch + cache** — fetch on "Start workout", drive logging offline.
4. **UI** — RN logging grid, ghost text, rest timer (fully local off cached prescribed rest), coaching feed.

---

## Requirements as acceptance tests

Restates [ADR 0009](../adr/0009-thin-client-experiment-parallel-track.md)'s gates as things to actually run:

- **G1 — Offline capture (make-or-break).** Radio off mid-session → every Set logs, workout completes; radio on → outbox flushes with **zero duplicates, zero loss**. Verify by toggling airplane mode across several logged sets and diffing server state against what was entered.
- **G2 — Blip transparency.** Kill the WebSocket (not the radio) for <30s mid-log; the logging UI shows no error and no lost input.
- **G3 — Prefetch sufficiency.** Complete a full session in airplane mode from the prefetched cache — targets, ghost text, and rest timer all function with no network.
- **G4 — Server authority.** Plan/Decisions/feed/analytics are never authored on the client; the client only enqueues actuals and reads server state.
- **G5 — Bake-off parity.** On the Pixel 7 over real gym signal, logging friction and reliability meet or beat the native client.

## Build order

1. Server RPC WS + `serverGetConfig`, reachable over Tailscale.
2. Vendor `client-runtime`, wire the four platform impls, get supervisor → `connected` from an Expo app on the tailnet. **Milestone: reconnect survives an airplane-mode toggle** (G2 proven on real hardware).
3. Port the outbox → log outbox; implement idempotent `logSetActual`. **Milestone: log sets in airplane mode, flush cleanly on reconnect (G1).**
4. Prescription prefetch + logging UI + rest timer (G3).
5. Coaching feed / Proposals via `subscribe`.

Steps 2–3 are the whole bet. If G1 fails on real gym signal there, the track is abandoned and ADR 0004 continues unchanged (see ADR 0009).

## Risks / open edges

- **Tailscale liveness** — the tunnel needs the daemon up, key valid, and WireGuard UDP not blocked by captive-portal gym wifi. Failure here is indistinguishable from "offline" to the supervisor, so G1's outbox must cover it — which it does. Worth an explicit "not connected to home" UI state so the user knows writes are queued, not lost.
- **Server must be awake** — interactive logging makes the home server a synchronous dependency at *read* time (prefetch, feed) even though writes are buffered. Deliberation was only ever asynchronous; this raises the server's uptime bar.
- **Outbox schema evolution** — t3code versions the outbox schema (`THREAD_OUTBOX_SCHEMA_VERSION`); keep that discipline, since queued writes can outlive an app update.
- **Two-client drift** — the shared server contract is the guard; keep contract changes additive so both clients stay buildable during the bake-off.
</content>
