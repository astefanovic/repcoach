import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Issue #70 / ADR 0014 §6 — the **Intake marker**, and the drafted Plan it
 * carries.
 *
 * `intake_plan_json` holds the whole Plan the Intake exchange converged on, as
 * structured data. Slice 8 smuggled it through as a JSON string inside the
 * Proposal's `reasoning_only_points`, which meant the Proposal card could only
 * render it by doing string surgery on a prose field — and meant a run that
 * emitted no proposal quietly lost the Plan altogether.
 *
 * **One column, not two.** A separate `is_intake` boolean would be a second
 * copy of one fact, and two copies can disagree; the Plan's presence *is* the
 * marker. The store reads it for all three of ADR 0014 §6's rules: identify the
 * Intake Proposal afterwards, withhold it from the pending-Proposal and
 * Coaching-feed surfaces while it is still `pending`, and let a `supersede`
 * directive name only a still-pending Intake Proposal.
 *
 * Nullable by necessity — every Decision from the three fire-and-forget
 * cadences has no drafted Plan. The runner is the sole writer (ADR 0011 §3) and
 * it alone supplies the marker: it appears nowhere in the agent's
 * structured-output contract, so an agent reasoning slip cannot mint an
 * Intake-scoped row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE decision ADD COLUMN intake_plan_json TEXT
  `;

  // The hot read is "is the live Intake artifact hiding from this surface?",
  // which is a scan of pending proposals — already covered by
  // `idx_decision_kind_status`. Intake produces one row per lifetime, so a
  // dedicated index on the marker would earn nothing.
});
