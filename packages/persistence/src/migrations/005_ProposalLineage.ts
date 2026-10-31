import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Issue #60 / ADR 0013 — **Proposal lineage**: the link that makes a Revise
 * exchange reconstructable.
 *
 * A Revision run commits an **Answer** and, optionally, a revised Proposal
 * that supersedes the one the user pushed back on. Both rows are stamped with
 * `in_response_to_id` = the Decision the run was invoked against, so the
 * Proposal card can render `[current Proposal] + [collapsed history]` by
 * walking the chain (ADR 0013 §9) instead of scanning the whole Decision log.
 *
 * **One column, not two.** "Which row superseded this Proposal?" is answered
 * by the `kind = 'proposal'` row whose `in_response_to_id` points at it — a
 * separate `supersedes_id` would be derivable from that plus the target's
 * `status = 'superseded'`, so it would be a second copy of one fact. The
 * broader name is deliberate: an Answer is part of the lineage even though it
 * supersedes nothing.
 *
 * Nullable by necessity — every Decision from a Session/Cycle review is
 * unprompted and has no subject. `REFERENCES decision(id)` is declared for
 * intent; SQLite does not enforce it without `PRAGMA foreign_keys`, and the
 * runner is the sole writer (ADR 0011 §3), so the constraint is documentation
 * rather than the guard. The real guard is `commitDeliberationOutput`, which
 * only ever writes an id the *runner* supplied.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE decision ADD COLUMN in_response_to_id TEXT REFERENCES decision(id)
  `;

  // Walking a lineage means "find the rows answering this one", so the index
  // is on the pointer, not the pointee.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_decision_in_response_to
    ON decision(in_response_to_id)
  `;
});
