import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Step 2B / issue #34 (seed-input storage) — real persistence for the six
 * Deliberation seed inputs that `seedContext.ts`'s `EMPTY_STUB_SEED_EXTRAS`
 * previously stood in for (ADR 0011 §2):
 *
 * - `goal` — the single current Goal (CONTEXT `Goal`). Singleton row, fixed
 *   `id = 'current'`; `setGoal` is a delete-then-insert replace, never an
 *   accumulating history (there is exactly one current Goal by definition).
 * - `standing_constraint` — durable hard/soft inputs (CONTEXT `Standing
 *   constraint`). User-authorable; `severity` is the hard/soft flag.
 * - `check_in` — the structured daily/pre-session self-report (CONTEXT
 *   `Check-in`): sleep/soreness/stress/energy, each a 1-5 rating. The
 *   canonical `CheckIn` READ shape (`@repcoach/contracts`) is a rendered
 *   summary line, computed from these columns at read time — see `store.ts`.
 * - `context_note` — free-text life context (CONTEXT `Context note`).
 * - `evidence_claim` — the Evidence-base roster (ADR 0003): `claim`/
 *   `source`/`applicability`/`trust`. Server-seeded, not user-authored (no
 *   RPC write path) — `trust` is always `'corpus-verified'` for a seed-corpus
 *   row (ADR 0003 §1/§2); a retrieved-but-unpromoted citation never lives
 *   here, only on a Decision's value-snapshot `citations_json`.
 *
 * `sessionsSinceLastReview`/`lastCycleReviewAt` (the pointer-digest history)
 * are DELIBERATELY not a table here — they are derived at read time from
 * `logged_session.started_at` + `decision.created_at`/`data_window_json`
 * (see `store.ts`'s `deriveDigestHistory`), per the issue #34 brief's
 * "prefer derivation over new storage where possible".
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS goal (
      id TEXT PRIMARY KEY,
      statement TEXT NOT NULL,
      proxies_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS standing_constraint (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      severity TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS check_in (
      id TEXT PRIMARY KEY,
      recorded_at TEXT NOT NULL,
      sleep INTEGER NOT NULL,
      soreness INTEGER NOT NULL,
      stress INTEGER NOT NULL,
      energy INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_check_in_recorded_at
    ON check_in(recorded_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS context_note (
      id TEXT PRIMARY KEY,
      recorded_at TEXT NOT NULL,
      text TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_context_note_recorded_at
    ON context_note(recorded_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS evidence_claim (
      id TEXT PRIMARY KEY,
      claim TEXT NOT NULL,
      source TEXT NOT NULL,
      applicability TEXT NOT NULL,
      trust TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
