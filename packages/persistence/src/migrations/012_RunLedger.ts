import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Step 2B / issue #81 — the Deliberation run ledger (ADR 0011 §8 amendment).
 *
 * A LEDGER, not a counter: one row per agent SESSION (not per run), grouped
 * by `run_id` and discriminated by `stage` (`deliberator` / `sweep` /
 * `intake-draft` / `intake-turn`). A counter cannot be taken apart
 * afterwards, and every question the UAT watchlist asks (entries 1/2 —
 * "tokens per Revision run vs a Session review", "cold-draft tokens vs
 * per-turn tokens") needs the rows separable by run and by stage.
 *
 * `usage` carries all four SDK-reported token fields (issue #81 bug fix —
 * the previous `{prompt, completion}` pair silently discarded cache reads/
 * creations). `cost_usd` is stored (free off the SDK's `total_cost_usd`) but
 * is a write-only column for now — ADR 0011 §8 is explicit spend in dollars
 * is not rendered under subscription OAuth (ADR 0005), since the risk
 * actually being watched is quota, not dollars.
 *
 * `model` is nullable: a run whose cadence had no configured model still
 * writes a row (the agent ran on the SDK's own default), and the ledger must
 * not lose that a row happened just because nothing was configured.
 *
 * The runner owns the only write (ADR 0011 §3) via one private helper, and a
 * failed ledger write is best-effort — it must never fail the run it is
 * trying to record (losing a cost row should not lose a Decision).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS deliberation_run_ledger (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      cadence TEXT NOT NULL,
      stage TEXT NOT NULL,
      model TEXT,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_creation INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      ran_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_run_ledger_run_id
    ON deliberation_run_ledger(run_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_run_ledger_ran_at
    ON deliberation_run_ledger(ran_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_run_ledger_cadence
    ON deliberation_run_ledger(cadence)
  `;
});
