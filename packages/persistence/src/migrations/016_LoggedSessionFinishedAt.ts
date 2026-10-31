import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Issue #114 — `logged_session` never recorded when a session finished, only
 * whether. `finalizeSession` (2B slice 4) flips `status` to `finished` and
 * stops there, because nothing needed the timestamp until now: `listSessions`
 * (Part 2) orders History reverse-chronologically by it, and `before`-pages
 * against it, so it has to be a real column rather than derived at read
 * time — no other row on the session carries "when did this end."
 *
 * `status` itself stays a plain `TEXT` (no `CHECK` constraint exists to
 * widen — see migration `001`) — `cancelled` (the third status this issue
 * adds, alongside `active`/`finished`) needs no schema change, only the
 * application-level literal union in `loggedSession.ts` to grow.
 *
 * Nullable: every existing row is `active` or `finished` with no recorded
 * finish time. Backfilling a fabricated timestamp would misrepresent
 * history; a `finished` row from before this migration simply sorts as
 * "oldest" (NULL) in History rather than claiming a false time. New
 * `finished` rows always set it going forward — `finalizeSession` is
 * updated alongside this migration.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE logged_session ADD COLUMN finished_at TEXT`;
});
