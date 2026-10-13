# An actual is retracted by a tombstone, never deleted

Un-logging a Set appends a **retraction** — a `logged_set_actual` row that says "this Set was not performed after all" — rather than deleting or mutating the row it retracts. The net state of a Set is its **last** row by application order; a retraction in that position means unlogged. Nothing is ever removed from the table.

This settles the row-level question in [#83](https://github.com/astefanovic/repcoach/issues/83) and, by giving it a primitive, the session-level one in [#122](https://github.com/astefanovic/repcoach/issues/122): "empty a half-done Logged Session back to zero" is N retractions, not a second mechanism.

## The rule this replaces was never decided

`Logging.tsx` carried a comment asserting that "an actual is an append-only fact keyed by commandId (**ADR 0006**), so 'undo' would mean either a delete command the contract does not have or a silent local lie". [ADR 0006](./0006-logging-is-pure-actual-capture.md) says no such thing — it is about the Plan-mutation boundary (logging never mints a [Change](../../CONTEXT.md)), and its own Consequences contemplate the opposite: _"Backfilling/editing a past Session may re-trigger its Session review."_

So the append-only guarantee existed in exactly one place — a code comment citing an ADR that did not contain it — and it blocked an affordance `docs/design/ui-surfaces.md` had already settled (_"Tapping a logged ✓ un-logs it"_, from [#63](https://github.com/astefanovic/repcoach/issues/63)). This ADR states the rule properly for the first time, and in stating it, keeps the append-only half while dropping the "therefore no undo" half that never followed from it.

## Why a tombstone rather than a delete

**A delete is unsafe under replay, and would break the one guarantee logging actually has.** Exactly-once rests on `logged_set_actual`'s `UNIQUE(command_id)` and `INSERT ... ON CONFLICT(command_id) DO NOTHING` ([migration 001](../../thin-client/packages/persistence/src/migrations/001_InitialSchema.ts)). Delete the row and that defence is gone with it: an outbox replay of the original `logSetActual` — the ordinary case after a dead spot, and the exact failure [#84](https://github.com/astefanovic/repcoach/issues/84) is about — finds no conflict, reinserts, and resurrects the Set the user just un-logged. The tombstone keeps every `commandId` permanently claimed, so both the original and its retraction are replay-idempotent on their own terms.

The shape is also already the house pattern, twice over:

- `logged_set_actual` has never been unique on `set_id`. Correcting a logged Set already works by appending another row for the same Set and letting the last one win — a retraction is that move with a different payload, not a new mechanism.
- [#114](https://github.com/astefanovic/repcoach/issues/114) reached the same conclusion for whole sessions one ticket earlier: `cancelled` is _"a third terminal status rather than a row delete, so the table stays append-only-ish and a future stats query can exclude it explicitly"_.

## The contract

A new command kind, `unlogSetActual`, carrying `{commandId, loggedSessionId, entryId, setId}` — no metric map. It travels the **same** path as every other capture: an outbox row, a strictly-ordered drain, `UNIQUE(command_id)` dedupe server-side. Storage is one column on the existing table (`retraction INTEGER NOT NULL DEFAULT 0`) and one migration; no new table, no FK, no lookup validation — consistent with [ADR 0017](./0017-unplanned-set-is-a-client-echoed-actual-only-node.md)'s finding that this write path validates nothing about the prescribed tree.

**A retraction is its own kind rather than a `logSetActual` with an empty `ActualMetricMap`.** An actual with no metrics means "performed, nothing recorded"; a retraction means "not performed". Those are different facts about a workout, and a representation that cannot tell them apart loses the distinction permanently.

**Order becomes load-bearing, so it is now stated.** `getLoggedSession` returns `actuals` and the client folds them into a map where the last entry for a `setId` wins ([useLoggedSession.ts](../../thin-client/apps/web/src/runtime/useLoggedSession.ts)). Corrections have relied on that ordering informally; a retraction makes it decisive, because `log → un-log → log` and `log → log → un-log` differ only by it. The server orders `actuals` by `applied_at`, `rowid` as tiebreak; the outbox's `seq` is what keeps the optimistic client view agreeing with the server's replay. Both halves need a test.

## What the coach sees

**Net state.** [Deliberation](../../CONTEXT.md) reads a Logged Session with retracted Sets simply absent — not as evidence of a mis-tap. The rows remain for audit, and an analytics query that wants them can have them, but nothing surfaces a retraction as signal.

This follows [ADR 0002](./0002-deliberation-pipeline-not-live-chat.md)'s posture against a twitchy coach: a fat-finger corrected three seconds later is noise, and a Session review that reasons about it is reasoning about the user's hands, not their training. It is, however, decided on reasoning alone — see the watchlist entry in [uat-watchlist.md](../design/uat-watchlist.md), which asks whether a _deliberate_ retraction (not a mis-tap) ever needed to be visible.

## Considered Options

- **Hard delete the row.** Rejected on the replay hazard above — it silently disarms `ON CONFLICT(command_id)`, which is the whole of gate 1.
- **Remove the Set from the Logged Session's prescribed copy** ([#122](https://github.com/astefanovic/repcoach/issues/122)'s second shape). Rejected: it makes "un-log" structurally different from "correct" when the user experiences them as the same gesture, and it cannot express a mis-tap on a Set the user is still about to perform. It also mutates the frozen prescription copy, whose immutability is what makes swap- and skip-provenance free ([ADR 0007](./0007-minimal-plan-is-degenerate-manual-plan.md)).
- **Client-local un-log, never sent.** Rejected as the "silent local lie" the old comment correctly named. It is also the precise failure mode [#84](https://github.com/astefanovic/repcoach/issues/84) is about, from the other direction: a status strip is only worth having if what it reports is what the server holds.
- **A `voided_at` column on the original row** (update in place rather than append). Rejected: it is a mutation, so it needs its own idempotency story separate from `commandId`, and it cannot represent `log → un-log → log` without either a second column or losing the middle event.

## Consequences

- The outbox schema takes another version bump and a fifth command kind; the flusher gains one arm. The manager, storage seam and persist-before-reflect discipline are untouched, as they were by [#80](https://github.com/astefanovic/repcoach/issues/80) and [#130](https://github.com/astefanovic/repcoach/issues/130) — a retraction is just another thing with a `commandId`.
- `GET /__test__/logged-actuals` keeps its literal contract — **every applied row, retractions included**, with the discriminator exposed. It is a durability lever, not a UI one; collapsing retractions there would hide exactly the exactly-once property it exists to prove.
- **#122 stops being a design question.** Cancel's zero-actuals rule reads net state instead of row count, and "empty to zero" is N retractions through the surface that already exists.
- The `Logging.tsx` comment asserting the opposite is removed as part of [#83](https://github.com/astefanovic/repcoach/issues/83); the rule now lives here.
- Whether un-logging dismisses the rest timer the confirm raised is a **runtime** predicate, not a component one — it belongs beside `Timer.*` with a Rung 1 test, per [#118](https://github.com/astefanovic/repcoach/issues/118)'s rule. Deciding it in `SetRow` would recreate the untestable-decision shape that ticket was written around.
- Backfill (deferred) inherits an undo for free, which is what [#63](https://github.com/astefanovic/repcoach/issues/63) expected when it chose tap-to-un-log over a long-press.
