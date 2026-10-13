# Plan authoring is one operation union on one RPC, and set runs are derived

The Plan view is the only Plan-authoring path ([ADR 0007](./0007-minimal-plan-is-degenerate-manual-plan.md)) and every edit auto-applies as a `user-direct` Change ([ADR 0008](./0008-plan-changes-carry-origin-and-status.md)). This decides the **shape of the seam** those edits travel through: a single RPC (`plan.applyUserChange`) carrying a discriminated union of **Plan operations**, with the authoring logic — coalescing Sets into runs, applying an operation, generating its summary, inverting it for undo — in one pure module (`@repcoach/client-runtime/plan`) that both `Store` layers and the editor share.

## Why one seam rather than a dozen RPCs

Twelve endpoints would mean twelve places to validate, twelve chances for the in-memory store and the SQLite store to disagree, and twelve things the UI has to learn. One union gives **one place to validate, one Change per accepted call, and one thing to test**. The operation union is also the ubiquitous language: `groupEntries` is what the code, the Change summary and the design doc all call grouping.

The pure applier is what makes the single seam cheap. `applyPlanOperation(plan, operation, catalog)` returns the next `PlanSnapshot` plus its summary; the SQLite store loads the Plan, applies it, and writes the tree back wholesale. At single-user scale ([ADR 0005](./0005-deliberation-on-agent-sdk-subscription.md)) that rewrite is a handful of rows, and the payoff is that there is exactly **one implementation of the structural rules** — a Block of one collapses, grouping is by adjacency, a new Entry inherits its catalog metrics — rather than one per storage layer.

## Set runs are derived, never stored

The editor's unit is `4 × 5–8 reps @ 80 kg` ([#45](https://github.com/astefanovic/repcoach/issues/45): you author set *runs*, not set rows). That is **presentation over an ordered Set list, not a schema change**. CONTEXT's `Session` requires the prescribed and logged sides to be the same node types so prescribed-vs-actual is a row-for-row alignment rather than a join; a Prescribed Session that stored runs would break that alignment and re-introduce exactly the parallel structure ADR 0007 rejected.

So a run is computed by coalescing consecutive Sets that share set type, target map and rest, and an edit to a run expands back into that many Sets, reusing the existing Set ids positionally so a count change does not renumber the Sets that did not move.

## Whole-value operations, not positional ones

`orderSessions` / `orderEntries` / `orderBlocks` carry the entire ordered id list, and `replaceEntrySets` carries an Entry's entire ordered Set list. This is deliberate:

- It makes every one of them **idempotent and last-write-wins**, so replaying a queued edit after a gym dead spot is safe with no merge logic — which matters because local-first is a project value, not a nicety.
- It eliminates the index-drift class of bug that per-item positional edits invite.
- `replaceEntrySets` subsumes add-set, remove-set, change-count, change-target, change-rest and change-set-type into one operation. It is also how the editor's Entry-level "rest default" is written: rest lives on the Set and nowhere else (CONTEXT `Set`), so the affordance writes `restSec` across the Entry's Sets rather than adding an Entry-level field.

**The client supplies the id of anything it creates** — the same discipline as the outbox's `commandId`. A retry replays identical ids, so a flaky link cannot duplicate a Session, and the caller can render optimistically without waiting for the server to hand an id back.

The original narrow `{ setId, target }` edit is retained as a member of the payload union so nothing already built regresses.

## Change semantics

Every accepted operation mints exactly one Change: origin `user-direct`, born `applied`, carrying a generated human summary ("Added Face Pull", "Grouped Bench Press + Face Pull into a superset"). Two rules keep the record legible:

- **Ordering operations coalesce via `superseded`.** A new ordering Change on the same container marks the previous live one on that container `superseded`. ADR 0008 already has that status, so no new vocabulary: five reorder taps leave one live Change and the coach reads the net intent rather than five intermediate states.
- **Undo is not a new primitive.** The client sends the *inverse* operation — which, because the operations are whole-value, is just "the previous value" it already holds — as a new `user-direct` Change, naming the original so the server marks it `superseded`. The server keeps a linear applied history with no special-cased rollback path. `deleteSession` deliberately has no single-operation inverse, so the UI cannot offer undo for it as though it were free.

## Considered Options

- **One RPC per affordance.** Rejected above: N validation sites, N drift opportunities, and the union is the thing #72's UI wants anyway.
- **Storing set runs in the schema.** Rejected: it breaks the row-for-row prescribed-vs-actual alignment CONTEXT requires, and per-set variation (ramps, top-set + backoff, drop phases) would then need a side-channel of overrides.
- **Per-Set positional operations** (`insertSetAfter`, `moveSet`). Rejected: not idempotent, unsafe to replay, and index drift is a bug class we would be choosing to own.
- **Server-generated ids.** Rejected: a retry would mint a second Session, and the client would have to wait a round trip before it could render what the user just created.
- **Undo as a server-side rollback primitive.** Rejected: it would need a stored pre-image per Change and a second, privileged mutation path. The inverse-as-a-new-Change formulation reuses the ordinary one.

## Consequences

- A structural edit is atomic: an operation naming an entity that is no longer there is rejected whole, leaving the Plan untouched, so a stale client cannot silently corrupt it.
- Structural Changes are distinguishable from target edits in the Decision log by their recorded operation name, so "he reordered his week" and "he added 2.5 kg" are not the same signal.
- `PrescribedSession` gains an optional `name`. It is optional rather than required because Sessions predating Plan authoring carry no label; clients fall back to a positional "Session 3".
- `packages/persistence` now depends on `@repcoach/client-runtime/plan`. The name reads oddly server-side, but a duplicated applier would be worse — the alternative is two implementations of the structural rules and a standing drift risk.
- **~~Offline Plan editing is not shipped.~~ Superseded by [#80](https://github.com/astefanovic/repcoach/issues/80).** As originally written: *the edit carries the outbox's `commandId` and the server applies it exactly once, so the server half of local-first is done; generalising the client outbox's queued-command model (currently typed for Set actuals) is not. Plan authoring is therefore online-only for now, which the connectivity-gated state of [#63](https://github.com/astefanovic/repcoach/issues/63)'s status strip can express.*

  #80 took the other branch and generalised the outbox rather than gating the editor. The queued row is now a `kind`-discriminated command carrying either a logged Set or a `PlanOperation`, so Plan edits queue, survive a reload, and replay on reconnect exactly as logged Sets do. What made this cheap is recorded above: because the client already supplied the id of anything it creates and the ordering operations are whole-value, replay was **already** safe — the only thing missing was a stable `commandId` across retries, which a queued command has by construction. The server half named here needed no change at all.

  The watchlist question this raised is therefore no longer "how often is a Plan edited away from signal" — that question is moot once edits queue. What replaced it is the cost of the generalisation itself: see the [uat-watchlist](../design/uat-watchlist.md) entry on whether one queue for two command kinds stays coherent as more kinds arrive.
- How far back the change ledger reaches, and therefore how much undo a user actually gets, is left open — a product call, not a code one.
