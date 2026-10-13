# Native Android client, local-first on-device storage

> **Superseded by [0012](0012-web-only-client-supersedes-native-android.md).** The client is now a plain React web app; native Android is retired. Kept for the record — its reasoning for local-first logging still informs the outbox design, but its platform choice no longer holds.

RepCoach's client is a **native Android app** (not a PWA). The workout Log is captured mid-workout, often on poor gym connectivity, so logging must never depend on a live round-trip: the Log is stored **local-first** on the device (SQLite / Room) and written to immediately, syncing to the home-server backend opportunistically when a connection is available.

Native was chosen over a PWA because it removes the PWA's hard blockers and unlocks the roadmap: direct HTTPS to Anthropic with no CORS proxy, first-class push, Health Connect reachability for the deferred objective-data signals, and SQLite as a cleaner home for the Scaffold than IndexedDB. It also positions RepCoach for a possible future where each user rides their own Claude subscription on-device (see [0005](0005-deliberation-on-agent-sdk-subscription.md)).

## Considered Options

- **PWA.** Rejected: browsers block direct calls to `api.anthropic.com` (CORS), can't reach Health Connect, and IndexedDB is a clumsier store. PWA's only edge was instant browser dogfooding, which doesn't outweigh the above.
- **Native client that also runs Deliberation on-device.** Rejected for the personal phase — see [0005](0005-deliberation-on-agent-sdk-subscription.md): it would drop the Agent SDK and weaken background proactivity for a benefit (per-user subscriptions) that only materializes if Anthropic officially enables OAuth reuse.

## Consequences

- Local store is SQLite/Room; the phone copy is the interactive source of truth, the home server holds a replica used for Deliberation.
- Objective device data (Health Connect) is now *reachable*, but remains **deferred by choice** to v2 (Intake Check-ins + Context notes cover v1 — see `CONTEXT.md`), not blocked by the platform.
- Derived analytics are computed on-device from the Log + Exercise catalog.
- The LLM runs server-side at Anthropic regardless, so the device is an HTTP/sync client — no on-device inference cost.
