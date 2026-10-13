import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Issue #83, ADR 0019 — un-logging a Set appends a **retraction** rather
 * than deleting or mutating the `logged_set_actual` row it retracts. One
 * column is all a tombstone needs: `retraction = 1` marks a row as "this Set
 * was not performed after all", `retraction = 0` (the default, matching
 * every pre-existing row) marks an ordinary logged actual.
 *
 * No new table, no FK, no lookup validation against the prescribed tree —
 * consistent with ADR 0017's finding that this write path validates nothing
 * about the prescribed tree. Nothing is ever deleted: a retraction's
 * `command_id` claims its own row permanently under the same `UNIQUE
 * (command_id)` / `INSERT ... ON CONFLICT(command_id) DO NOTHING` discipline
 * `logged_set_actual` already has (migration `001`), which is exactly what
 * keeps a replayed *original* `logSetActual` from resurrecting a Set the
 * user just un-logged (see the ADR's replay argument).
 *
 * Net state of a Set is its LAST `logged_set_actual` row by application
 * order (`applied_at`, `rowid` as tiebreak — `id` is a random UUID) — `retraction = 1` in that position
 * means unlogged. `getLoggedSession` reads this column straight through as
 * the `retraction` discriminator on each `actuals` entry (contracts
 * `LogSetActualResult`/`UnlogSetActualResult`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE logged_set_actual ADD COLUMN retraction INTEGER NOT NULL DEFAULT 0
  `;
});
