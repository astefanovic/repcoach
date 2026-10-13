import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Issue #86 — a coach Proposal carries the Plan Change it proposes.
 *
 * Accepting a review-cadence Proposal used to apply a fixed stand-in (+2.5 kg
 * on every prescribed Set in the whole Plan) because the run-output contract
 * had nowhere to put a Change. A Proposal reading "add a fourth back squat
 * working set" therefore raised every load in the Plan and added no set.
 *
 * One nullable column holds the ADR 0015 operation array, verbatim, as the
 * agent emitted it. Deliberately the SAME union `plan.applyUserChange` writes
 * through, not a second bespoke payload shape: one applier, one set of
 * structural rules, and the coach held to the validation a user-direct edit is
 * held to.
 *
 * **Nullable is load-bearing.** A Proposal that proposes no Plan change — an
 * Observation-shaped finding, or an `answer` — has NULL here and resolves with
 * no Plan mutation at all. Nothing may back-fill it with `'[]'`: an empty array
 * would be a coach proposing "change nothing", which is a different claim from
 * "this Decision is not about a Plan change".
 *
 * It sits beside `intake_plan_json` (migration 006) rather than replacing it.
 * The two are the payload halves of one card: a review-cadence Proposal diffs
 * against the standing Plan, so it carries operations; the cold-start Intake
 * Proposal has no prior Plan to diff against (ADR 0014 §6), so it carries the
 * whole Plan.
 *
 * No index, for the same reason as migrations 007/008: the column is read on a
 * row already being fetched by id, never queried on its own.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE decision ADD COLUMN plan_operations_json TEXT`;
});
