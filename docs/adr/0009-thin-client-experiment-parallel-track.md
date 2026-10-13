# A thin-client RN client is trialed in parallel to the native app

> **Superseded by [0012](0012-web-only-client-supersedes-native-android.md).** The parallel-track experiment is over: the thin client is now the only client, and its React Native basis has been dropped in favour of plain React web. The bake-off gate this ADR set was deliberately waived, not won — see 0012.

RepCoach explores a second client track — a **thin Expo/React Native client** that keeps no durable Log of its own and reaches the always-on home server ([ADR 0005](0005-deliberation-on-agent-sdk-subscription.md)) over Tailscale — built **in parallel** to the native Android local-first client ([ADR 0004](0004-native-android-local-first.md)), which it does **not** supersede. The track is modeled on t3code (`pingdotgg/t3code`), whose connection layer is reused directly. A bake-off on the real gym-signal profile decides whether the thin client ever replaces the native one; until then both are live and ADR 0004 stands.

The premise under test: t3code's connectivity robustness comes from three cooperating mechanisms whose combination is enough to log a full workout over a flaky link **without** an on-device Log replica —

- a **connection supervisor** (`client-runtime/src/connection/supervisor.ts`) — network-aware exponential backoff `[1,2,4,8,16]s`, reset after 30s stable, health-probe on foreground — that masks transport blips;
- **subscribe-and-replay** (`client-runtime/src/rpc/client.ts`) — the server is the source of truth for reads; subscriptions re-attach and the server replays on reconnect;
- a **durable outbox** (`apps/mobile/src/state/thread-outbox-manager.ts`) — t3code's *only* local durable write path, carrying idempotent client-ids — adopted here as a **log outbox** so every logged Set survives offline and flushes exactly-once.

The enabling design move is **prescription prefetch**: the Prescribed Session is fetched and cached at "Start workout" (while connected), so mid-set logging never needs the network — only the outbox.

## Considered Options

- **Supersede ADR 0004 outright.** Rejected: unproven on the actual constraint (gym connectivity), and the native app is already built through slice 4. A parallel track de-risks without discarding working code.
- **Reimplement the patterns in native Kotlin/Room.** Rejected *for this track*: it collapses back into ADR 0004 (a local store *is* Room) and reuses none of t3code. It remains the fallback if the thin-client premise fails, not the experiment.
- **Thin client with no outbox, relying on retry alone.** Rejected: retry masks blips but not a true offline stretch. A logged Set is user-composed data the server cannot reconstruct, so it must be buffered durably — the same reason t3code itself carries an outbox.

## Requirements (gates the track must clear)

1. **Offline capture.** With the radio off mid-workout, every Set logs to the outbox and the workout completes; on reconnect all writes flush with **no duplicates and no loss** (idempotent by client-id). *This is the make-or-break gate.*
2. **Blip transparency.** A transport drop under ~30s is invisible to the logging UI (supervisor reconnect + subscribe-replay).
3. **Prefetch sufficiency.** Everything needed mid-set — prescribed targets, ghost text, prescribed rest for the timer — comes from the session-start cache; no network dependency between sets.
4. **Server authority preserved.** Plan, Decisions, Coaching feed, and analytics stay server-owned ([ADR 0002](0002-deliberation-pipeline-not-live-chat.md)/[0005](0005-deliberation-on-agent-sdk-subscription.md)); the client adds only the outbox plus a display cache.
5. **Bake-off parity.** Logging friction and reliability meet or beat the native client on the Pixel 7 over real gym signal before any supersede is considered.

## Consequences

- **Review surfaces are online-only by design.** History browsing and derived analytics need a live link; only *today's* prescription and the log outbox work offline. Acceptable mid-workout; a real limit for at-rest review.
- **Two clients, one server contract.** The home server grows an Effect-RPC WebSocket endpoint (mirroring t3code `apps/server`) with an idempotent `logSetActual`; both clients can target it, so the contract work is not wasted whichever wins.
- **Native-only features are out of scope on this track** — Health Connect and first-class FCM (ADR 0004's deferred upside) are unreachable from the RN thin client without native modules. Deferred anyway, but the gap is now explicit.
- **Supersedes nothing yet.** If gate 1 fails on real gym signal, the track is abandoned and ADR 0004 continues unchanged. If gates 1 and 5 both pass, a future ADR supersedes ADR 0004.
- Detailed architecture, reuse map, and build order live in [docs/design/thin-client-experiment.md](../design/thin-client-experiment.md).
</content>
</invoke>
