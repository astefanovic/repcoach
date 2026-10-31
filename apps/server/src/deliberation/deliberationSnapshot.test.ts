import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import { DeliberationSnapshot, DeliberationSnapshotLive } from "./deliberationSnapshot.ts";

/**
 * Snapshot-isolation coverage (ADR 0011 §3, issue #27 — 2B slice 2): proves
 * the guarantee the acceptance criteria actually cares about — "the agent
 * reads a read-only snapshot; it cannot write to the live DB" — as a
 * deterministic, filesystem-level assertion, not a model-behavior one. Uses
 * a REAL `node:sqlite` file (loaded the same `createRequire` way
 * `NodeSqliteClient.ts` does, for the same reason: a static `import
 * "node:sqlite"` fails to resolve under Vitest's Vite-based transform).
 */
const nodeSqlite = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;

const makeLiveDb = (): { readonly dbPath: string; readonly db: NodeSqlite.DatabaseSync } => {
  const dbPath = path.join(os.tmpdir(), `repcoach-snapshot-test-live-${randomUUID()}.sqlite`);
  const db = new nodeSqlite.DatabaseSync(dbPath);
  db.exec("CREATE TABLE widget (id TEXT PRIMARY KEY, label TEXT NOT NULL)");
  db.prepare("INSERT INTO widget (id, label) VALUES (?, ?)").run("w1", "original");
  return { dbPath, db };
};

const cleanupPaths: Array<string> = [];
afterEach(() => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop();
    if (p === undefined) continue;
    try {
      fs.chmodSync(p, 0o644);
    } catch {
      // already gone
    }
    try {
      fs.unlinkSync(p);
    } catch {
      // already gone
    }
  }
});

describe("DeliberationSnapshotLive (ADR 0011 §3 read-only snapshot)", () => {
  it("yields a readable copy of the live DB, at a different path", async () => {
    const { dbPath, db } = makeLiveDb();
    cleanupPaths.push(dbPath);
    db.close();

    const snapshotPath = await Effect.gen(function* () {
      const snapshot = yield* DeliberationSnapshot;
      return yield* snapshot.withSnapshot((p) =>
        Effect.sync(() => {
          expect(p).not.toBe(dbPath);
          expect(fs.existsSync(p)).toBe(true);

          const snapshotDb = new nodeSqlite.DatabaseSync(p, { readOnly: true });
          const rows = snapshotDb.prepare("SELECT label FROM widget WHERE id = ?").all("w1") as unknown as ReadonlyArray<{
            readonly label: string;
          }>;
          snapshotDb.close();
          expect(rows).toHaveLength(1);
          expect(rows[0]?.label).toBe("original");
          return p;
        }),
      );
    }).pipe(Effect.provide(DeliberationSnapshotLive(dbPath)), Effect.runPromise);

    // Cleanup ran: the snapshot file must be gone once `withSnapshot` returns.
    expect(fs.existsSync(snapshotPath)).toBe(false);
  });

  it("the agent CANNOT write through the snapshot — the copy is OS-enforced read-only", async () => {
    const { dbPath, db } = makeLiveDb();
    cleanupPaths.push(dbPath);
    db.close();

    await Effect.gen(function* () {
      const snapshot = yield* DeliberationSnapshot;
      yield* snapshot.withSnapshot((p) =>
        Effect.sync(() => {
          // Opening the snapshot file for writing and attempting an INSERT
          // must fail — this is the actual enforcement mechanism (an
          // OS-level read-only file), the same one a raw `sqlite3` CLI
          // invocation (the agent's real tool) would hit.
          expect(() => {
            const writable = new nodeSqlite.DatabaseSync(p, { readOnly: false });
            try {
              writable.prepare("INSERT INTO widget (id, label) VALUES (?, ?)").run("w2", "should-not-land");
            } finally {
              writable.close();
            }
          }).toThrow();
        }),
      );
    }).pipe(Effect.provide(DeliberationSnapshotLive(dbPath)), Effect.runPromise);
  });

  it("mutating the live DB after a snapshot was taken never reaches the snapshot (point-in-time copy, not a live view)", async () => {
    const { dbPath, db } = makeLiveDb();
    cleanupPaths.push(dbPath);

    await Effect.gen(function* () {
      const snapshot = yield* DeliberationSnapshot;
      yield* snapshot.withSnapshot((p) =>
        Effect.sync(() => {
          // Mutate the LIVE db while the snapshot is open.
          db.prepare("UPDATE widget SET label = ? WHERE id = ?").run("mutated-after-snapshot", "w1");

          const snapshotDb = new nodeSqlite.DatabaseSync(p, { readOnly: true });
          const rows = snapshotDb.prepare("SELECT label FROM widget WHERE id = ?").all("w1") as unknown as ReadonlyArray<{
            readonly label: string;
          }>;
          snapshotDb.close();
          expect(rows[0]?.label).toBe("original");
        }),
      );
    }).pipe(Effect.provide(DeliberationSnapshotLive(dbPath)), Effect.runPromise);

    db.close();
  });

  it("cleans up the snapshot even when `use` fails", async () => {
    const { dbPath, db } = makeLiveDb();
    cleanupPaths.push(dbPath);
    db.close();

    let capturedPath: string | undefined;
    const failure = Effect.gen(function* () {
      const snapshot = yield* DeliberationSnapshot;
      return yield* snapshot.withSnapshot((p) =>
        Effect.sync(() => {
          capturedPath = p;
        }).pipe(Effect.flatMap(() => Effect.fail("boom" as const))),
      );
    }).pipe(Effect.provide(DeliberationSnapshotLive(dbPath)), Effect.runPromiseExit);

    const exit = await failure;
    expect(exit._tag).toBe("Failure");
    expect(capturedPath).toBeDefined();
    if (capturedPath !== undefined) {
      expect(fs.existsSync(capturedPath)).toBe(false);
    }
  });

  it("live DB stays fully writable throughout — the runner keeps its own write path", async () => {
    const { dbPath, db } = makeLiveDb();
    cleanupPaths.push(dbPath);

    await Effect.gen(function* () {
      const snapshot = yield* DeliberationSnapshot;
      yield* snapshot.withSnapshot(() =>
        Effect.sync(() => {
          // The runner (never the agent) is the only writer, but this
          // provider must not itself lock/restrict the LIVE file — prove a
          // normal write against the live db still succeeds while a
          // snapshot is open.
          expect(() =>
            db.prepare("INSERT INTO widget (id, label) VALUES (?, ?)").run("w3", "runner-write"),
          ).not.toThrow();
        }),
      );
    }).pipe(Effect.provide(DeliberationSnapshotLive(dbPath)), Effect.runPromise);

    db.close();
  });
});
