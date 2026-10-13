import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Step 2B / issue #81 — the RPE capture control (#63): three states (`off` /
 * `flagged-only` / `every-set`), not a toggle. Stored server-side, like the
 * cadence model settings (migration `004`), because `ui-surfaces.md` has
 * this setting change what the Plan *prescribes* — it must not live in one
 * browser's `localStorage`.
 *
 * A fixed-id singleton (`id = 1`, the same shape `cycle_review_schedule`
 * uses, migration `011`): there is exactly one current setting, defaulting to
 * `flagged-only` (#63's shipped default) until the owner changes it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS rpe_capture_setting (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
