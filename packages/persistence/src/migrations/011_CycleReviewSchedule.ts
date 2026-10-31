import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Step 2B / issue #91 — the monthly Cycle-review schedule (ADR 0011 §4).
 *
 * The schedule has to survive the thing it runs on: the coach lives on an
 * always-on home server (ADR 0005) that reboots, and a monthly timer held in
 * a process's memory resets on every boot — which for a monthly cadence means
 * it never fires at all. So the schedule's only state is this row: **when the
 * last Cycle review was claimed**. Due-ness is then derived from the
 * persisted timestamp rather than from process uptime, which makes a restart
 * a non-event and a boot after a missed window fire the review instead of
 * skipping it.
 *
 * A fixed-id singleton (`id = 1`, the `goal` table's shape from migration
 * `003`): there is exactly one schedule. `last_run_at` is the ISO timestamp
 * of the most recent CLAIM, written by `Store.claimDueCycleReview`'s single
 * conditional `UPDATE` — that statement's atomicity is what stops two pollers
 * (or a poll racing a restart) from double-firing one due window.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cycle_review_schedule (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_run_at TEXT NOT NULL
    )
  `;
});
