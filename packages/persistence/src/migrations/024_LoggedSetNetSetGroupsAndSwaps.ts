import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `logged_set_net`, second pass: what counts as a Set, and which exercise it
 * was. Recreates migration `023`'s view with three more columns.
 *
 * `023` stopped the coach counting correction rows, and the very next review
 * over-counted again by a different route. A Pull day logged as three working
 * Sets of curls, the last followed by two drop sets, was reported as "5
 * sets", and the same for triceps pushdowns. CONTEXT `Set` already settles
 * this: a drop / rest-pause / myo-cluster Set is a continuation of the
 * working Set before it, and that whole group counts once. The coach was never
 * told so, so it counted rows again. That review also named the exercise
 * "Incline DB Curl" for sessions where the user swapped to cable curls,
 * because `logged_entry_swap` was not in its data dictionary at all.
 *
 * Both are now columns rather than prose, because prose the coach can skip
 * is what failed twice:
 *
 * - `counts_as_set` — 1 for a working Set, 0 for a warmup or a continuation.
 *   A Set count is `SUM(counts_as_set)`.
 * - `prescribed_exercise_id` — the Entry's exercise in the session's frozen
 *   `snapshot_json` (the live `entry` table is today's Plan, not what was
 *   prescribed that day). NULL for an Entry the snapshot does not hold.
 * - `exercise_id` — what was performed: the latest swap for the Entry
 *   (`swapped_at`, `id` — the order `getLoggedSession` returns swaps in, and
 *   the client keeps the last), else the prescribed exercise.
 *
 * A malformed `snapshot_json` reads as no prescribed exercise rather than
 * failing the view: one bad row must not blind the coach to every session.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP VIEW IF EXISTS logged_set_net`;

  yield* sql`
    CREATE VIEW logged_set_net AS
    WITH latest AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY logged_session_id, set_id ORDER BY applied_at DESC, rowid DESC
        ) AS rn
      FROM logged_set_actual
    ),
    prescribed AS (
      SELECT ls.id AS logged_session_id,
        json_extract(e.value, '$.id') AS entry_id,
        json_extract(e.value, '$.exerciseId') AS exercise_id
      FROM logged_session ls,
        json_each(CASE WHEN json_valid(ls.snapshot_json) THEN ls.snapshot_json ELSE '{}' END, '$.blocks') b,
        json_each(b.value, '$.entries') e
    ),
    swap AS (
      SELECT logged_session_id, entry_id, exercise_id,
        ROW_NUMBER() OVER (
          PARTITION BY logged_session_id, entry_id ORDER BY swapped_at DESC, id DESC
        ) AS rn
      FROM logged_entry_swap
    )
    SELECT a.logged_session_id, a.entry_id, a.set_id, a.set_type,
      CASE WHEN a.set_type = 'working' THEN 1 ELSE 0 END AS counts_as_set,
      p.exercise_id AS prescribed_exercise_id,
      COALESCE(s.exercise_id, p.exercise_id) AS exercise_id,
      a.actual_json, a.applied_at
    FROM latest a
    LEFT JOIN prescribed p
      ON p.logged_session_id = a.logged_session_id AND p.entry_id = a.entry_id
    LEFT JOIN swap s
      ON s.logged_session_id = a.logged_session_id AND s.entry_id = a.entry_id AND s.rn = 1
    WHERE a.rn = 1 AND a.retraction = 0
  `;
});
