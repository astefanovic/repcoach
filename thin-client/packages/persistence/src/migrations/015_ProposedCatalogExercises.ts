import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The catalog rows a coach Proposal needs to exist before its operations can
 * be applied (ADR 0016) — the review-cadence half of what Intake already had.
 *
 * `materializeDraftPlan` has always minted a catalog row for every
 * `exerciseId` an accepted Intake draft names that the catalog lacks, so at
 * cold start the coach could author an Exercise. A review cadence proposes
 * ADR 0015 operations instead, and `addEntry` carries an `exerciseId` and
 * nothing else — so proposing a movement the catalog had never held applied
 * anyway, into an Entry pointing at a row that did not exist. The UI rendered
 * the raw id as the exercise name, logging had no metrics to lay out, and
 * per-muscle volume counted the work as zero, permanently: the orphan is not
 * in `exercise_catalog`, so the enrichment roster never sees it either.
 *
 * One nullable column holds the rows to create, verbatim as the agent emitted
 * them. They are **not** Plan operations and are deliberately not in that
 * union (ADR 0016 §3): creating an Exercise changes no Plan and mints no
 * Change, so it cannot ride in a vocabulary where every member does.
 *
 * They live on the Proposal rather than being written when the run committed
 * because catalog rows are **permanent** — renameable, never deleted, since
 * past Logged Sessions reference them. Writing them at commit time would
 * leave a row behind every Proposal the user rejects. `resolveProposal`
 * writes them only on Accept, immediately before the operations that name
 * them. (This is the one place they differ from `catalog_enrichments`, which
 * writes back at run time because the row it describes already exists.)
 *
 * NULL is the common case and carries meaning: this Proposal introduces no
 * new Exercise. Nothing may back-fill `'[]'`.
 *
 * No index — read on a row already being fetched by id, as with 007/008/009.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE decision ADD COLUMN catalog_exercises_json TEXT`;
});
