import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Step 2B / issue #81 — widens `cadence_model_setting` (migration `004`) with
 * an optional reasoning-effort override per cadence, alongside the model id
 * ("also give the model selector an effort option where applicable"). A
 * separate migration rather than editing `004` in place: that migration has
 * already run on any existing database, and ALTER TABLE ADD COLUMN is the
 * additive, non-destructive way to widen a shipped table.
 *
 * Nullable: not every model supports an effort level, and absence means "let
 * the SDK/model default apply" — the same posture `model` itself has when no
 * setting has ever been written.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE cadence_model_setting ADD COLUMN effort TEXT`;
});
