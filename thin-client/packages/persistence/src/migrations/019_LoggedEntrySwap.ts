import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Issue #131, ADR 0019 — recording that an Entry's Sets were actually
 * performed against a different Exercise than the prescribed one ("swap",
 * CONTEXT `Swap`).
 *
 * A **pure actual-side annotation**, disjoint from every Plan table
 * (`prescribed_session`/`block`/`entry`/`prescribed_set`) and from the
 * Logged Session's own frozen `snapshot_json` — a swap never overwrites
 * `entry.exerciseId` inside that snapshot, so the prescribed exercise stays
 * legible forever. This table is the only new fact a swap adds: which
 * Exercise was actually used, for which Entry, in which Logged Session.
 *
 * `command_id UNIQUE` is the idempotency guarantee `logSetActual` already
 * established for actual-capture (`INSERT ... ON CONFLICT(command_id) DO
 * NOTHING`, then a read-back by `command_id`), applied identically here.
 *
 * No FK to `entry_id`/`exercise_id`: exactly ADR 0017's discipline for
 * `logged_set_actual` — both are carried **by value**, with no lookup
 * against the prescribed tree or the catalog, because neither needs to
 * exist as a live reference for a swap to record what happened.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS logged_entry_swap (
      id TEXT PRIMARY KEY,
      logged_session_id TEXT NOT NULL REFERENCES logged_session(id),
      entry_id TEXT NOT NULL,
      exercise_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      swapped_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_logged_entry_swap_session
    ON logged_entry_swap(logged_session_id)
  `;
});
