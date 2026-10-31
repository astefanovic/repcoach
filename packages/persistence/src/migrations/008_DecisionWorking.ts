import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Issue #79 — the **working** behind a Decision, and the feed's route back to
 * the row it came from.
 *
 * CONTEXT's Decision log promises a layered explanation: "a quick cited
 * summary on top, deeper evidence and the rule that fired underneath". Only
 * the top layer was ever stored. `citations_json` and `data_window_json`
 * (migration 001) carry the sources and the run's provenance, but the
 * evidence the claim rests on, the rule that produced it, and the place the
 * coach says it could be wrong existed nowhere — the surface that renders
 * them was fixture-fed.
 *
 * Three nullable columns, matching `DecisionDraft`'s three optional fields.
 * **Nullable is load-bearing, not a migration convenience**: a run that has
 * nothing honest to say about its uncertainty omits it, and the card renders
 * one fewer block. Nothing may back-fill these with `''` or `'[]'`, which
 * would make "the coach said nothing here" indistinguishable from "the coach
 * said nothing useful here".
 *
 * `coaching_feed_entry.decision_id` closes a smaller gap: an entry pointed at
 * its Decision only when that Decision was a Proposal, so an Observation on
 * the Coach surface had no way to fetch its own working. Backfilled from
 * `proposal_id` where one exists; older Observation entries keep a NULL and
 * simply do not expand, since the id they would need was never written down.
 *
 * No indexes here, for the same reason as migration 007: every one of these
 * columns is read on a row already being fetched by id, never queried on its
 * own.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE decision ADD COLUMN measurements_json TEXT`;
  yield* sql`ALTER TABLE decision ADD COLUMN rule TEXT`;
  yield* sql`ALTER TABLE decision ADD COLUMN uncertainty TEXT`;

  yield* sql`ALTER TABLE coaching_feed_entry ADD COLUMN decision_id TEXT`;
  yield* sql`
    UPDATE coaching_feed_entry SET decision_id = proposal_id WHERE proposal_id IS NOT NULL
  `;
});
