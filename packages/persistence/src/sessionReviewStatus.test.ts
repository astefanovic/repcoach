import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import { SqlStore } from "./sqlStore.ts";
import { SEEDED_SESSION_ID, Store } from "./store.ts";

/**
 * Issue #132 — the durable half of the fix, proved against a real file.
 *
 * The in-memory `Store` cannot prove any of this: the whole bug was that a
 * review owed by an in-flight request evaporated, and the fix is that the debt
 * is a row. So these tests do what `sqlStore.test.ts` does — open a
 * `SqlStore.layer` over a temp **file**, close it for real, reopen a fresh
 * layer over the same path — and assert the pending marker is still there.
 *
 * A restart is exactly the condition that used to lose a queued review (the
 * runner's `deferralQueue` is in-memory), so "survives a reopen" is not a
 * generic durability nicety here; it is the mechanism.
 */

/**
 * `node:sqlite` via `createRequire`, not a static import — Vite cannot resolve
 * the bare specifier. Same workaround `NodeSqliteClient.ts` and
 * `deliberationSnapshot.adversarial.test.ts` already use.
 */
const nodeSqlite = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;

const tempDbPath = (): string =>
  path.join(os.tmpdir(), `repcoach-review-status-${randomUUID()}.sqlite`);

const cleanupDbFile = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

const runAgainstFreshLayer = <A, E>(dbPath: string, effect: Effect.Effect<A, E, Store>): Promise<A> =>
  effect.pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);

describe("logged_session.review_status (issue #132)", () => {
  it("a pending review survives closing the store and reopening a fresh SqlStore over the same file", async () => {
    const dbPath = tempDbPath();
    try {
      // "Process 1": finish a session. The review is now owed.
      const finalized = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          const result = yield* store.finalizeSession(loggedSessionId);
          return { loggedSessionId: loggedSessionId as string, result: Option.getOrThrow(result) };
        }),
      );
      expect(finalized.result.status).toBe("finished");
      expect(finalized.result.reviewStatus).toBe("pending");

      // "Process 2": the server restarted before the review ever ran — the
      // condition that used to lose it with the session already `finished`.
      const afterRestart = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return (yield* store.listSessionsPendingReview).map((id) => id as string);
        }),
      );
      expect(afterRestart).toEqual([finalized.loggedSessionId]);

      // "Process 3": the review commits, and that fact is durable too — a
      // later boot must not re-review it and spend quota again.
      await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.markSessionReviewed(finalized.loggedSessionId as never);
        }),
      );
      const afterReviewed = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return (yield* store.listSessionsPendingReview).length;
        }),
      );
      expect(afterReviewed).toBe(0);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("the status flip and the review marker land together — a finished session is never marker-less", async () => {
    const dbPath = tempDbPath();
    try {
      const [status, pendingIds] = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);

          // Before finishing: not finished, and owes nothing.
          const before = yield* store.listSessionsPendingReview;
          expect(before).toHaveLength(0);

          yield* store.finalizeSession(loggedSessionId);
          const session = yield* store.getLoggedSession(loggedSessionId);
          const pending = yield* store.listSessionsPendingReview;
          return [Option.getOrThrow(session).status, pending.map((id) => id as string)] as const;
        }),
      );
      // Both facts, from one write. A `finished` row with no marker would be
      // invisible to the drain — #132 in a new shape.
      expect(status).toBe("finished");
      expect(pendingIds).toHaveLength(1);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("a re-finish of a session whose review never ran still reports pending", async () => {
    const dbPath = tempDbPath();
    try {
      const statuses = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          const first = Option.getOrThrow(yield* store.finalizeSession(loggedSessionId));
          const second = Option.getOrThrow(yield* store.finalizeSession(loggedSessionId));
          return [
            [first.transitioned, first.reviewStatus] as const,
            [second.transitioned, second.reviewStatus] as const,
          ] as const;
        }),
      );
      // The second call did not transition anything — and that used to be the
      // end of it, which is what lost the review. It still owes one.
      expect(statuses[0]).toEqual([true, "pending"]);
      expect(statuses[1]).toEqual([false, "pending"]);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("a re-finish AFTER the review committed reports reviewed, so a double-tap spends no quota", async () => {
    const dbPath = tempDbPath();
    try {
      const result = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.finalizeSession(loggedSessionId);
          yield* store.markSessionReviewed(loggedSessionId);
          return Option.getOrThrow(yield* store.finalizeSession(loggedSessionId));
        }),
      );
      expect(result.reviewStatus).toBe("reviewed");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("a cancelled session never appears as pending (issue #114's rule holds through the marker)", async () => {
    const dbPath = tempDbPath();
    try {
      const pending = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.cancelSession(loggedSessionId);
          return (yield* store.listSessionsPendingReview).length;
        }),
      );
      expect(pending).toBe(0);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("markSessionReviewed is idempotent and total — an unknown, active or already-reviewed session is a no-op", async () => {
    const dbPath = tempDbPath();
    try {
      const pending = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;

          // Unknown id: must not throw. A drain racing a reset would otherwise
          // take the poll loop down with it.
          yield* store.markSessionReviewed("does-not-exist" as never);

          // An `active` session: marking it must not silently retire a review
          // that was never owed and is about to be.
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.markSessionReviewed(loggedSessionId);
          yield* store.finalizeSession(loggedSessionId);
          const afterFinish = (yield* store.listSessionsPendingReview).length;
          expect(afterFinish).toBe(1);

          // Twice in a row: the second is a no-op, not an error.
          yield* store.markSessionReviewed(loggedSessionId);
          yield* store.markSessionReviewed(loggedSessionId);
          return (yield* store.listSessionsPendingReview).length;
        }),
      );
      expect(pending).toBe(0);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("migration 017 backfills already-finished sessions to pending, which is what recovers the stranded ones", async () => {
    const dbPath = tempDbPath();
    try {
      // Simulate the live DB's state: a session finished under the OLD code,
      // so its row has no `review_status`. Clearing the column back to NULL is
      // the only honest way to reproduce a pre-migration row through the store
      // API, since `finalizeSession` now always writes the marker.
      const loggedSessionId = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.finalizeSession(loggedSessionId);
          return loggedSessionId as string;
        }),
      );

      // A `finished` row whose marker is NULL must be treated as owing a
      // review, not as already reviewed. Getting this backwards would leave the
      // three real stranded sessions unreviewed forever — the migration's
      // backfill and this default are the same decision in two places.
      const db = new nodeSqlite.DatabaseSync(dbPath);
      db.prepare("UPDATE logged_session SET review_status = NULL WHERE id = ?").run(loggedSessionId);
      db.close();

      const finalizeReport = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return Option.getOrThrow(yield* store.finalizeSession(loggedSessionId as never));
        }),
      );
      expect(finalizeReport.reviewStatus).toBe("pending");
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});
