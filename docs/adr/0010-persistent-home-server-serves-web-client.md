# The persistent home server serves the thin client as a web app over Tailscale

The thin-client track ([ADR 0009](0009-thin-client-experiment-parallel-track.md)) is delivered in production as a **web build served by the always-on home server itself**, opened in the phone's browser over Tailscale — **not** Expo Go, and **not** an installed native (EAS) build. The server is a single Node/Effect process that serves both the static client (`GET /`, SPA-fallback) and the RPC channel (`WS /rpc`, NDJSON) from one origin, backed by **SQLite** (`node:sqlite`) at `~/.repcoach/repcoach.sqlite`. This is the t3code delivery model. The UX contract: *start the server, open its URL in any tailnet browser, done* — no Metro, no QR, no app install, no build-time URL baking.

This decision was made during **Step 2A** (making the backend persistent — replacing the in-memory dev-server). The persistence work and the delivery-model choice landed together because both are properties of the same always-on home server ([ADR 0005](0005-deliberation-on-agent-sdk-subscription.md)).

The operational detail — scripts, the always-on story, and three hard-won traps (an effect@4 export-bundler bug, Windows Firewall block rules, `tailscale serve` enablement) — lives in [docs/ops/repcoach-server.md](../ops/repcoach-server.md) and is not repeated here.

## Considered Options

- **Expo Go** (dev client). Rejected for production: needs Metro running on the host and is a development harness, not a delivery mechanism.
- **Native build via EAS / local Gradle**, installed on the phone. Rejected *for now*: adds a build step, bakes the server URL at build time, and requires (re)installing the app to change it. The RN codebase still supports this later if a native shell is ever wanted; it is not the path for the experiment.
- **Server serves the web build; open over Tailscale (chosen).** Zero install, single origin (so no CORS and no URL baking — the client derives its server URL from `window.location.origin`), and it exactly mirrors t3code, whose connection layer we already reuse.

## Consequences

- **No app install and no Metro for the user.** Delivery is a URL. Updating the client is rebuilding `dist/` on the host, not reinstalling anything.
- **Same-origin resolution.** The web build reads its server URL from `window.location.origin` (`Connection.resolveServerBaseUrls`); explicit `EXPO_PUBLIC_DEV_SERVER_*` still wins for the deliberately cross-origin Playwright e2e harness, and localhost defaults cover dev.
- **Durable single source of truth.** SQLite on the home host survives restarts (the G5 durability artifact; `productionDurability.test.ts`). `logSetActual` idempotency (G1) is enforced at the DB layer via a UNIQUE `command_id`.
- **The production build exposes no `/__test__/*` control channel** — that lever is dev/test-only; a prod server offering `reset`/`drop-socket` on the tailnet would let anyone wipe real data.
- **A bundler workaround is load-bearing.** `expo export` crashes an effect@4 web bundle (Effect-TS/effect#6252), so the web client is built via `scripts/Build-WebClient.ps1`, not a plain export. Retire it when that upstream bug is fixed. See the ops doc.
- **Refines, does not replace, ADR 0009.** ADR 0009's "thin Expo/RN client" stands as the codebase; this ADR fixes how it is *delivered* in production. The experiment's premise, gates (G1–G5), and parallel-track relationship to the native app ([ADR 0004](0004-native-android-local-first.md)) are unchanged.
- **Deliberation (Step 2B) is still pending** — the server persists and serves real data, but Decisions/Proposals are seeded until 2B, which remains gated on grilling the open Deliberation-internals question.
</content>
