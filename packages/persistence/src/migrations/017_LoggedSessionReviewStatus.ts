import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Issue #132 — nothing durable recorded whether a finished session had been
 * *reviewed*, only whether it had been *finished*, and `finishWorkout` used
 * the second fact as a proxy for the first.
 *
 * `finalizeSession`'s `transitioned` flag was the only guard on re-running a
 * Session review (#29's "a double-tap must not double-review"). It conflates
 * two different facts: *"this session has already been finished"* and *"this
 * session has already been reviewed"*. When the synchronous review that
 * followed the transition failed, the transition stayed committed, every
 * retry reported `transitioned: false`, and the review became permanently
 * unreachable — three sessions and 103 logged sets were never reviewed, and
 * `runSessionReview` has exactly one caller, so no code path could ever pick
 * them up again.
 *
 * `review_status` separates the two. It is written in the **same UPDATE** as
 * the status flip, so the pair cannot diverge — a session that is `finished`
 * is always either `pending` or `reviewed`, never neither.
 *
 * **The marker IS the queue.** The runner's deferral queue is in-memory
 * (`Queue.unbounded`), so a restart while a review was queued lost it the
 * same way a failed run did. Rather than persist that queue, the drain
 * re-derives its work from `review_status = 'pending'` on every tick — the
 * same reasoning migration `011` applied to the Cycle-review schedule ("a
 * home server reboots, and a monthly timer that resets on every boot never
 * fires"). Durable state that a poll re-reads survives a restart for free.
 *
 * **Nullable, and NULL means "no review is owed".** `active` rows have not
 * finished, and `cancelled` rows must never trigger a review (#114's rule) —
 * neither carries a marker.
 *
 * **The backfill is the recovery.** Every existing `finished` row is
 * backfilled to `pending`, which is what makes the drain pick up the sessions
 * already stranded in the live DB rather than leaving them unreviewed
 * forever. `finished_at IS NULL` rows (there is one, predating migration
 * `016`) are included deliberately: the session happened and was never
 * reviewed, and a missing finish timestamp says nothing about whether it
 * deserves a review.
 *
 * Cancelled rows are excluded by the `status = 'finished'` predicate, so the
 * backfill cannot resurrect a session the user explicitly unmade.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE logged_session ADD COLUMN review_status TEXT`;
  yield* sql`UPDATE logged_session SET review_status = 'pending' WHERE status = 'finished'`;
});
