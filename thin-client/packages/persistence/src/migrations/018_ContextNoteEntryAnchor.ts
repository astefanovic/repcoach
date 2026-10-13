import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Issue #130 — wires "add a note", the one item in the per-Entry sheet that
 * is not a Set. A Context note (`003_CoachingInputs.ts`) was, until now,
 * flat and unanchored: free-text life context with only a timestamp,
 * deliberately not scoped to anything structured. #130 needs the opposite —
 * a note the user attaches to a specific Entry ("left elbow twinged on set
 * 3" said of overhead press, not of the day) — while still landing in the
 * exact same `## Recent Context notes` seed section, because the ticket
 * forbids a second prompt-side channel for user prose.
 *
 * Rather than fork the concept, `context_note` gains two optional anchors:
 * `entry_id` (which Entry) and `logged_session_id` (which workout, so
 * `getLoggedSession` can answer "does this session have a note" without a
 * join through `entry`/`block`). Both NULL is the pre-existing unanchored
 * Context note; both present is an Entry-anchored one. There is no state
 * where exactly one is set — `Logging.tsx` only ever mints a note against a
 * live Logged Session's Entry.
 *
 * **No new idempotency column.** `logged_set_actual` dedupes outbox replay
 * via a separate `command_id` UNIQUE constraint because its primary key is
 * a server-minted row id and `setId` (the real domain identity) lives in
 * its own column. `context_note.id` has no such split — nothing else
 * anchors to it — so an Entry-anchored note simply uses its own
 * client-minted `commandId` AS its `id`. `INSERT ... ON CONFLICT(id) DO
 * NOTHING` against the table's existing PRIMARY KEY is then exactly-once
 * for free, the same way an unplanned Set's client-minted `setId` makes
 * replay a no-op without any extra column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE context_note ADD COLUMN entry_id TEXT`;
  yield* sql`ALTER TABLE context_note ADD COLUMN logged_session_id TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_context_note_logged_session_id
      ON context_note(logged_session_id) WHERE logged_session_id IS NOT NULL
  `;
});
