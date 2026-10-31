import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Step 2A / task 2A.2 — real Logged Session instantiation (copy-on-
 * instantiate, ADR 0006/0007): `startSession` deep-copies the Prescribed
 * Session tree it was called with and freezes that copy as JSON on the new
 * `logged_session` row, so later Plan edits can never reach an already
 * -instantiated Logged Session (mirrors the client's own frozen-in-flight
 * prescription cache, Task 5).
 *
 * `logged_session` is always empty at the point this migration runs (no
 * prior task ever inserted a row into it — `startSession` is 2A.2's own new
 * write path), so the `NOT NULL DEFAULT '{}'` here is only to satisfy
 * SQLite's `ALTER TABLE ... ADD COLUMN` requirement that a `NOT NULL`
 * column carry a default; it is never actually read as a live value.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE logged_session ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'
  `;
});
