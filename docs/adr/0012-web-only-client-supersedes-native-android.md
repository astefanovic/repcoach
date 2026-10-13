# The client is a web app; native Android and React Native are dropped

**Supersedes [0004](0004-native-android-local-first.md) (native Android, local-first) and [0009](0009-thin-client-experiment-parallel-track.md) (thin-client RN experiment as a parallel track).**

RepCoach has **one client**: a plain **React web app**, served by the always-on home server ([ADR 0010](0010-persistent-home-server-serves-web-client.md)) and opened in a browser on both phone and desktop. The native Kotlin/Compose Android app is retired, and React Native/Expo is dropped along with it.

This resolves the two-client state ADR 0009 left open. ADR 0009 set a bake-off gate ("if gates 1 and 5 both pass, a future ADR supersedes ADR 0004"); that bake-off is **deliberately waived rather than won** — see Consequences.

## Why

The thin client already won on the ground. It is the client that actually reaches the deliberation pipeline, the Effect-RPC contract, the outbox and the prescription cache; the native app stopped at slice 4 and its `catalog`, `progress` and `plans` routes were never even reachable from on-screen controls. Maintaining two clients against one server contract was costing more than the second client returned.

Once native Android is gone, React Native has **no remaining purpose** — its entire value is targeting native, and the only target left is the browser. It was, on inspection, barely load-bearing: there are **zero** `react-native` imports outside `apps/expo`; `packages/contracts`, `packages/client-runtime`, `packages/persistence` and `apps/dev-server` are pure Effect; and inside the app the coupling is 5 files importing `react-native` plus one `expo-status-bar` over ~888 lines of components, sitting on a 6-file `src/platform/` layer that is already an injectable Effect `Layer` seam.

Meanwhile RN was charging real rent: the `expo export` white-screen workaround in `scripts/Build-WebClient.ps1` (confirmed still broken on `effect@4.0.0-beta.78` **and** `beta.101` — a Schema error path reading `.reasons` off an undefined issue at module init); a styling field distorted by the single-hashed-bundle constraint that workaround imposes; a `react-native-web` version skew; a navigation fork that exists only because RN has no routing; and Metro instead of a mainstream bundler.

ADR 0004's original case for native over PWA has also decayed. Its blockers do not bind this architecture:

- **CORS to `api.anthropic.com`** — moot. Deliberation runs server-side on the home server ([ADR 0005](0005-deliberation-on-agent-sdk-subscription.md)); the client never calls Anthropic.
- **SQLite over IndexedDB** — moot. The thin client keeps no durable Log ([ADR 0009](0009-thin-client-experiment-parallel-track.md)); the server owns the Scaffold, and the client carries only an outbox plus a display cache.
- **Health Connect** — was already deferred to v2 by choice, and already declared unreachable on the thin-client track by ADR 0009.
- **First-class push** — the one real loss; see Consequences.

## Considered Options

- **Keep the native Android app, drop only the RN thin client.** Rejected: it discards the client that actually works end-to-end against the current server contract, and re-opens work already done.
- **Drop native Android but keep Expo/RN-Web.** Rejected: it keeps every RN cost above while retaining a native escape hatch the roadmap no longer wants. RN-Web is a tax paid for optionality not being exercised.
- **Ship as a PWA immediately.** Not rejected, but sequenced later — installability and web push are additive to a working web client, not a precondition for one.
- **Run the ADR 0009 bake-off first.** Rejected on cost: the bake-off requires daily-driving a client that is not yet usable, and the whole point of this effort is to make one usable. Waiving it is a deliberate risk (below).

## Consequences

- **One client, one contract.** The Effect-RPC WebSocket contract, outbox and prescription cache are unchanged — this is a presentation-layer migration, not an architectural one. `packages/` and `apps/dev-server` are untouched.
- **The `expo export` workaround dies with RN.** `scripts/Build-WebClient.ps1` and its Metro-dev-server rebundling trick are deleted; the web app builds with a standard bundler. The upstream Effect Schema bug stops mattering to the build.
- **The offline profile is unchanged and untested at the gym.** The thin client is already local-first *for logging only* (durable outbox + prescription prefetch), with review surfaces online-only by design. Moving from RN to DOM does not change this — but ADR 0009's gate 1 ("radio off mid-workout, every Set logs and flushes with no duplicates or loss") is proven only by the Playwright suite, **not on real gym signal**. This is the accepted risk of waiving the bake-off. If offline logging fails in the gym, the fix is the outbox/service-worker layer, not a return to native.
- **Push regresses to web push.** ADR 0002 and [ADR 0011](0011-deliberation-internals-run-mechanics.md) assume the coaching feed arrives by push. Web push works on Android Chrome and on installed PWAs, but is weaker than FCM and requires the PWA step. Until then the feed is pull-only on open.
- **Health Connect is now out of reach, not merely deferred.** ADR 0004 listed it as reachable-but-deferred; it is now unavailable without re-adding a native client. Objective device data would need a separate ingestion path.
- **Testing rung 2 changes tool, not rigor.** Maestro (`.maestro/`, `Medium_Phone` emulator) is retired; the existing Playwright suite under `thin-client/e2e/` becomes rung 2. The adversarial-author contract survives intact — Playwright specs assert on visible text and roles, and the author agent stays forbidden from reading the client source. Rung 3 UAT moves from `Deploy-Phone.ps1` on the Pixel 7 to opening the served URL on the phone's browser.
- **The native app is deleted, not abandoned in place.** `app/`, the Gradle build, `.maestro/` and the emulator scripts are removed, with the last commit containing them tagged `archive/native-android` so the work stays recoverable.
- **Reversible in principle, expensive in practice.** The server contract is client-agnostic, so a native client could be rebuilt against it later — but it would be a rebuild, not a resumption.
