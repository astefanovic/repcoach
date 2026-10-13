import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Step 2A / task 2A.1 — the full persistence schema from the handoff
 * ("Persistence schema"), faithful to CONTEXT.md. JSON-shaped columns
 * (`*_json`) hold the contracts' schema-encoded shape as TEXT; ordering
 * within a parent (Plan sessions, Block entries, Entry sets) is authored
 * order via `order_index`, never claimed to be cyclic (CONTEXT `Plan`).
 *
 * `logged_set_actual.logged_session_id` is nullable for now: real Logged
 * Session instantiation (`startSession`) is task 2A.2's job. Until then
 * `logSetActual` still carries a *prescribed* `sessionId` (mirroring the
 * in-memory dev-server stub it replaces), so a `session_id` column is added
 * here too — a deliberate, additive deviation from the handoff's column
 * list, kept nullable/non-authoritative so 2A.2 can migrate onto
 * `logged_session_id` without a breaking change.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS plan (
      id TEXT PRIMARY KEY,
      plan_model TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS prescribed_session (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plan(id),
      order_index INTEGER NOT NULL,
      label TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_prescribed_session_plan
    ON prescribed_session(plan_id, order_index)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS block (
      id TEXT PRIMARY KEY,
      prescribed_session_id TEXT NOT NULL REFERENCES prescribed_session(id),
      order_index INTEGER NOT NULL,
      format TEXT NOT NULL,
      params_json TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_block_session
    ON block(prescribed_session_id, order_index)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS entry (
      id TEXT PRIMARY KEY,
      block_id TEXT NOT NULL REFERENCES block(id),
      order_index INTEGER NOT NULL,
      exercise_id TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_entry_block
    ON entry(block_id, order_index)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS prescribed_set (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES entry(id),
      order_index INTEGER NOT NULL,
      set_type TEXT NOT NULL,
      target_json TEXT NOT NULL,
      rest_sec INTEGER
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_prescribed_set_entry
    ON prescribed_set(entry_id, order_index)
  `;

  // Which metrics an Exercise tracks — drives the logging field layout
  // (CONTEXT `Exercise catalog`). Not yet joined into `getPrescribedSession`
  // (that's task 2A.3); seeded here so the table/data exist end-to-end.
  yield* sql`
    CREATE TABLE IF NOT EXISTS exercise_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tracked_metrics_json TEXT NOT NULL,
      muscles_json TEXT,
      movement_pattern TEXT
    )
  `;

  // A deep copy on instantiation (copy-on-instantiate — ADR 0006/0007);
  // populated for real starting task 2A.2's `startSession`.
  yield* sql`
    CREATE TABLE IF NOT EXISTS logged_session (
      id TEXT PRIMARY KEY,
      prescribed_session_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS logged_set_actual (
      id TEXT PRIMARY KEY,
      logged_session_id TEXT REFERENCES logged_session(id),
      session_id TEXT,
      entry_id TEXT NOT NULL,
      set_id TEXT NOT NULL,
      set_type TEXT NOT NULL,
      actual_json TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `;

  // The UNIQUE constraint on `command_id` above is how `logSetActual` stays
  // idempotent (exactly-once — G1) at the DB layer: an `INSERT ... ON
  // CONFLICT(command_id) DO NOTHING` followed by a read-back always returns
  // the one canonical stored row for a given `commandId`.

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_logged_set_actual_session
    ON logged_set_actual(logged_session_id)
  `;

  // The append-only Decision log (CONTEXT `Decision`). A `pending`
  // proposal-kind Decision *is* a Proposal (`getProposals` reads
  // `kind = 'proposal'`).
  yield* sql`
    CREATE TABLE IF NOT EXISTS decision (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      rationale TEXT NOT NULL,
      citations_json TEXT,
      data_window_json TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_decision_kind_status
    ON decision(kind, status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS coaching_feed_entry (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      proposal_id TEXT REFERENCES decision(id)
    )
  `;
});
