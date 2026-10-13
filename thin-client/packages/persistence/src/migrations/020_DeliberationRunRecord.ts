import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The Deliberation run as a **row of its own** — the record of a run, not of
 * its output (ADR 0011 §8, the Coach run-history feature).
 *
 * The cheaper option was to derive a run from the `data_window_json` every
 * Decision it committed already carries, and group on it. That was rejected
 * because it can only ever show the runs that *said something*, and the two
 * states the whole surface exists for are the other two:
 *
 * - **A run that looked and had nothing to say.** `commitDeliberationOutput`
 *   loops over `runOutput.decisions`; zero decisions writes zero rows, so a
 *   restrained run is today indistinguishable from a run that never happened.
 *   ADR 0011 §4 names that exact failure mode — restraint is the anti-twitchy
 *   mechanism, and a mechanism nobody can see is not one the user can trust.
 * - **A run that failed.** Its `failureReason` lived only in the runner's
 *   in-memory `runStateRef` and died on restart, so "the coach has been quiet"
 *   and "the coach has been crashing" read identically.
 *
 * Neither is derivable from rows that were never written, so the run gets a
 * row. Two rules from ADR 0011 §3/§6 govern who writes it, and they are the
 * same two the run ledger (migration 012) already follows: **the runner is the
 * only writer**, and **a failed write here must never fail the run it is
 * recording** — losing the record of a Decision must not cost the Decision.
 *
 * `data_window_json` is duplicated from the Decisions the run commits rather
 * than normalised out of them, and deliberately so: a run that commits nothing
 * still has a window it read over, and that window is precisely what makes a
 * silent run legible ("read 3 sessions, said nothing"). Normalising it would
 * put the provenance of a run behind the existence of its output again.
 *
 * `decision.run_id` is the tie back. It is **nullable and stays nullable** —
 * every Decision written before this migration has none, and the read path
 * falls back to grouping those by their shared `data_window_json` so the
 * record predating run rows is not silently truncated. A null `run_id` is
 * history, not an error.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS deliberation_run (
      id TEXT PRIMARY KEY,
      cadence TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT,
      data_window_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_deliberation_run_started_at
    ON deliberation_run(started_at)
  `;

  yield* sql`ALTER TABLE decision ADD COLUMN run_id TEXT`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_decision_run_id
    ON decision(run_id)
  `;
});
