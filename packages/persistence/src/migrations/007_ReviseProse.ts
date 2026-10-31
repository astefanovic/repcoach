import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Issue #66 slice 1 / ADR 0013 §1 — the user's **Revise prose** that produced
 * a Revision run.
 *
 * `revise_prose` holds the free text the user typed into the Revise affordance
 * — the highest-signal input the coach will ever get about the user's
 * preferences (§1), and the seed material for Standing-constraint promotions
 * (§8). ADR 0013 §9 requires the Proposal card to render the user's own words
 * alongside the coach's Answer as part of the exchange, so the prose must be
 * durable on the `decision` row itself, not held only in the runner's memory
 * for the duration of one run.
 *
 * **Stamped on every row a Revision run commits**, exactly as
 * `in_response_to_id` (migration 005) already is: the Answer, and the revised
 * Proposal when one is emitted, both carry the same prose because both are
 * responses to the ONE user turn that supplied it. The read model
 * (`ProposalExchange`, `feed.ts`) dedupes it back down to a single `revise`
 * entry per turn when walking the chain.
 *
 * Nullable by necessity — every Decision from a Session/Cycle review, and
 * every Intake Decision, is unprompted by a Revise turn and carries no prose.
 * The runner is the sole writer (ADR 0011 §3): `revisionProse` is present on
 * `CommitDeliberationOutputInput` only for `cadence: 'revision-run'`, supplied
 * by the runner alongside `reviseTargetProposalId`, never by the agent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE decision ADD COLUMN revise_prose TEXT
  `;

  // No dedicated index: the prose is read only by walking a lineage chain
  // already indexed on `in_response_to_id` (migration 005) — this column is
  // carried along for free on that same row fetch, never queried on its own.
});
