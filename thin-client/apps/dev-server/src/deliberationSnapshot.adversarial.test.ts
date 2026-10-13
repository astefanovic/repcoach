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
 * ADVERSARIAL coverage for `DeliberationSnapshot.withSnapshot` (issue #27,
 * ADR 0011 §3) written BLACK-BOX against the spec and the exported
 * `withSnapshot`/`DeliberationSnapshotLive` contract only — the module's
 * implementation body was not consulted to shape these assertions. Targets
 * gaps the happy-path suite (`deliberationSnapshot.test.ts`) doesn't probe:
 * WAL-mode data visibility, sidecar cleanup, and schema-level (not just
 * data-level) write rejection.
 */
const nodeSqlite = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;

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

describe("DeliberationSnapshotLive — adversarial (ADR 0011 §3)", () => {
  it("WAL edge: data still sitting in the -wal sidecar (not yet checkpointed into the main file) is still readable via the snapshot", async () => {
    const dbPath = path.join(os.tmpdir(), `repcoach-adv-wal-${randomUUID()}.sqlite`);
    cleanupPaths.push(dbPath);
    cleanupPaths.push(`${dbPath}-wal`);
    cleanupPaths.push(`${dbPath}-shm`);

    const db = new nodeSqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE widget (id TEXT PRIMARY KEY, label TEXT NOT NULL)");
    // Deliberately do NOT checkpoint — under WAL mode this write lives in the
    // `-wal` sidecar only until a checkpoint (or close) folds it into the
    // main file. If the snapshot provider only copies the main `.sqlite`
    // file and ignores `-wal`, this row would silently vanish from reads
    // against the snapshot.
    db.prepare("INSERT INTO widget (id, label) VALUES (?, ?)").run("wal-only", "still-in-wal");

    // Confirm the WAL sidecar actually exists at snapshot time (i.e. this
    // test genuinely exercises the WAL-not-yet-checkpointed case, not a
    // no-op).
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);

    const readBack = await Effect.gen(function* () {
      const snapshot = yield* DeliberationSnapshot;
      return yield* snapshot.withSnapshot((p) =>
        Effect.sync(() => {
          const snapshotDb = new nodeSqlite.DatabaseSync(p, { readOnly: true });
          const rows = snapshotDb
            .prepare("SELECT label FROM widget WHERE id = ?")
            .all("wal-only") as unknown as ReadonlyArray<{ readonly label: string }>;
          snapshotDb.close();
          return rows;
        }),
      );
    }).pipe(Effect.provide(DeliberationSnapshotLive(dbPath)), Effect.runPromise);

    db.close();

    expect(readBack).toHaveLength(1);
    expect(readBack[0]?.label).toBe("still-in-wal");
  });

  it("deletes the -wal AND -shm sidecars, not just the main snapshot file, once withSnapshot returns", async () => {
    const dbPath = path.join(os.tmpdir(), `repcoach-adv-sidecar-${randomUUID()}.sqlite`);
    cleanupPaths.push(dbPath);
    cleanupPaths.push(`${dbPath}-wal`);
    cleanupPaths.push(`${dbPath}-shm`);

    const db = new nodeSqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE widget (id TEXT PRIMARY KEY, label TEXT NOT NULL)");
    db.prepare("INSERT INTO widget (id, label) VALUES (?, ?)").run("w1", "x");
    // Force both sidecars to exist at snapshot time.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);

    let snapshotPath = "";
    await Effect.gen(function* () {
      const snapshot = yield* DeliberationSnapshot;
      yield* snapshot.withSnapshot((p) =>
        Effect.sync(() => {
          snapshotPath = p;
        }),
      );
    }).pipe(Effect.provide(DeliberationSnapshotLive(dbPath)), Effect.runPromise);

    db.close();

    expect(snapshotPath).not.toBe("");
    expect(fs.existsSync(snapshotPath)).toBe(false);
    expect(fs.existsSync(`${snapshotPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${snapshotPath}-shm`)).toBe(false);
  });

  it("a schema-mutating statement (CREATE TABLE), not just a data write, is also rejected against the snapshot", async () => {
    const dbPath = path.join(os.tmpdir(), `repcoach-adv-ddl-${randomUUID()}.sqlite`);
    cleanupPaths.push(dbPath);

    const db = new nodeSqlite.DatabaseSync(dbPath);
    db.exec("CREATE TABLE widget (id TEXT PRIMARY KEY, label TEXT NOT NULL)");
    db.close();

    await Effect.gen(function* () {
      const snapshot = yield* DeliberationSnapshot;
      yield* snapshot.withSnapshot((p) =>
        Effect.sync(() => {
          expect(() => {
            const writable = new nodeSqlite.DatabaseSync(p, { readOnly: false });
            try {
              writable.exec("CREATE TABLE injected (id TEXT)");
            } finally {
              writable.close();
            }
          }).toThrow();
        }),
      );
    }).pipe(Effect.provide(DeliberationSnapshotLive(dbPath)), Effect.runPromise);
  });

  it("two concurrent-ish withSnapshot calls against the same live DB never collide on the same snapshot path", async () => {
    const dbPath = path.join(os.tmpdir(), `repcoach-adv-distinct-${randomUUID()}.sqlite`);
    cleanupPaths.push(dbPath);
    const db = new nodeSqlite.DatabaseSync(dbPath);
    db.exec("CREATE TABLE widget (id TEXT PRIMARY KEY, label TEXT NOT NULL)");
    db.close();

    const [pathA, pathB] = await Promise.all([
      Effect.gen(function* () {
        const snapshot = yield* DeliberationSnapshot;
        return yield* snapshot.withSnapshot((p) => Effect.succeed(p));
      }).pipe(Effect.provide(DeliberationSnapshotLive(dbPath)), Effect.runPromise),
      Effect.gen(function* () {
        const snapshot = yield* DeliberationSnapshot;
        return yield* snapshot.withSnapshot((p) => Effect.succeed(p));
      }).pipe(Effect.provide(DeliberationSnapshotLive(dbPath)), Effect.runPromise),
    ]);

    expect(pathA).not.toBe(pathB);
  });

  it("live DB row COUNT is unchanged after a run, even when the run's `use` throws mid-way (no accidental live mutation on error)", async () => {
    const dbPath = path.join(os.tmpdir(), `repcoach-adv-live-untouched-${randomUUID()}.sqlite`);
    cleanupPaths.push(dbPath);
    const db = new nodeSqlite.DatabaseSync(dbPath);
    db.exec("CREATE TABLE widget (id TEXT PRIMARY KEY, label TEXT NOT NULL)");
    db.prepare("INSERT INTO widget (id, label) VALUES (?, ?)").run("w1", "original");

    const countBefore = (
      db.prepare("SELECT COUNT(*) as c FROM widget").get() as unknown as { readonly c: number }
    ).c;

    const exit = await Effect.gen(function* () {
      const snapshot = yield* DeliberationSnapshot;
      return yield* snapshot.withSnapshot(() => Effect.fail("boom" as const));
    }).pipe(Effect.provide(DeliberationSnapshotLive(dbPath)), Effect.runPromiseExit);

    expect(exit._tag).toBe("Failure");

    const countAfter = (
      db.prepare("SELECT COUNT(*) as c FROM widget").get() as unknown as { readonly c: number }
    ).c;
    db.close();

    expect(countAfter).toBe(countBefore);
  });
});
