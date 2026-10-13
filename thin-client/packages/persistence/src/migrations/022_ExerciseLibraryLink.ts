import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A catalog row's link to the vendored **Exercise library** (contracts
 * `LibraryExerciseId`) — which upstream exercise, and so which animation,
 * the row was picked from.
 *
 * Nullable, with no backfill: every row that exists today was typed by name
 * or authored by the coach, and a NULL link is exactly what those are. It is
 * a pointer to reference media, not catalog metadata, so a rename keeps it
 * and enrichment never touches it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE exercise_catalog ADD COLUMN library_id TEXT`;
});
