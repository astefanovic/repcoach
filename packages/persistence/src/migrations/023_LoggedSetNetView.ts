import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `logged_set_net` — the performed Sets of every Logged Session, one row per
 * Set, as the app itself shows them.
 *
 * `logged_set_actual` is an append-only stream: correcting a logged Set's
 * load or reps appends a new row for the same `set_id`, and un-logging one
 * appends a retraction (migration `021`, ADR 0019). Its row count is not a
 * set count. The coach reads the raw DB with `sqlite3`, and before this view
 * it counted rows: three Sets with two corrections each became "7 sets", and
 * a typo fixed three seconds later became a load PR — enough to draft a
 * Proposal raising every compound from 3 to 5 sets on volume the user never
 * did.
 *
 * The view is the SQL twin of `foldNetActuals` (`@repcoach/contracts`): per
 * `(logged_session_id, set_id)` — Set ids are copied from the Plan, so the
 * same id recurs across sessions — the last row in application order
 * (`applied_at`, `rowid` as tiebreak), dropped when that row is a
 * retraction. A view rather than a table, so it needs no backfill and covers
 * every row already logged; the deliberation snapshot is a file copy of the
 * live DB, so the coach sees it with no further wiring.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE VIEW logged_set_net AS
    SELECT logged_session_id, entry_id, set_id, set_type, actual_json, applied_at
    FROM (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY logged_session_id, set_id ORDER BY applied_at DESC, rowid DESC
        ) AS rn
      FROM logged_set_actual
    )
    WHERE rn = 1 AND retraction = 0
  `;
});
