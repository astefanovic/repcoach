import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Bodyweight, one reading per local calendar day (`bodyweight.ts` in
 * contracts) — the day is the primary key, so logging a second reading for
 * a day replaces the first rather than averaging with it.
 *
 * Kilograms, like every load. `recorded_at` is when the reading was written,
 * for the export and for anyone wondering which of a day's two weigh-ins
 * survived.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bodyweight_entry (
      date TEXT PRIMARY KEY,
      weight_kg REAL NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
});
