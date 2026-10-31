import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Step 2B / issue #31 (2B slice 6) — per-cadence model settings (ADR 0011
 * §4): persist a model choice per Deliberation cadence so the frequent
 * Session review and the rare Cycle review can run on different models. The
 * runner reads the configured model (`Store.getCadenceModel`) and passes it
 * to that cadence's deliberator.
 *
 * `cadence` is the primary key — a per-cadence singleton, exactly one current
 * model choice per cadence (`setCadenceModel` is an upsert/replace, never an
 * accumulating history), mirroring the `goal` table's fixed-id singleton
 * shape from migration `003`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cadence_model_setting (
      cadence TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
