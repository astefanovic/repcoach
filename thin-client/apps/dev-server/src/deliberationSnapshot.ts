import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The read-only Deliberation snapshot provider (ADR 0011 §3, issue #27 —
 * 2B slice 2): handing a free-reasoning agent a `Bash`+`sqlite3` shell over
 * the LIVE production DB is unacceptable, so every run's native-tool
 * pointers target a throwaway COPY instead. `withSnapshot` copies the live
 * SQLite file (plus its `-wal`/`-shm` sidecars, if the live DB is open in
 * WAL mode, so an in-flight write isn't silently dropped from the copy) to
 * `os.tmpdir()`, then `chmod`s the copy to owner-read-only (`0o444`) at the
 * OS level — this is the actual enforcement point: it is what makes the
 * agent's raw `sqlite3` CLI (not just our own `node:sqlite` client) unable
 * to write through it, since the agent has no custom tool surface to
 * intercept (ADR 0011 §2, "no custom MCP tools"). The copy is deleted again
 * once `use` completes, whether it succeeds or fails.
 *
 * The runner remains the ONLY writer to the live DB (ADR 0011 §3) — nothing
 * about this provider grants any write path back to `liveDbPath`, live or
 * otherwise.
 */
export class DeliberationSnapshot extends Context.Service<
  DeliberationSnapshot,
  {
    /**
     * Copies the live DB to a throwaway read-only path, runs `use` with
     * that path, and guarantees cleanup afterward (`Effect.acquireUseRelease`
     * semantics — cleanup runs on success, failure, AND interruption).
     */
    readonly withSnapshot: <A, E, R>(
      use: (snapshotPath: string) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("@repcoach/dev-server/DeliberationSnapshot") {}

const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

const copySnapshot = (liveDbPath: string): Effect.Effect<string> =>
  Effect.sync(() => {
    const snapshotPath = path.join(os.tmpdir(), `repcoach-deliberation-snapshot-${randomUUID()}.sqlite`);
    fs.copyFileSync(liveDbPath, snapshotPath);
    for (const suffix of SIDECAR_SUFFIXES) {
      const sidecar = `${liveDbPath}${suffix}`;
      if (fs.existsSync(sidecar)) {
        fs.copyFileSync(sidecar, `${snapshotPath}${suffix}`);
      }
    }
    // The load-bearing line: an OS-enforced read-only file means every
    // write path is closed, including the agent's raw `sqlite3` CLI (which
    // never goes through our own `node:sqlite` client at all).
    fs.chmodSync(snapshotPath, 0o444);
    return snapshotPath;
  });

const removeIfPresent = (filePath: string): void => {
  try {
    // Some platforms refuse to unlink an owner-read-only file even for the
    // owner; restore write permission first so cleanup can't itself fail.
    fs.chmodSync(filePath, 0o644);
  } catch {
    // File doesn't exist (e.g. no WAL/SHM sidecar was ever copied) — fine.
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already gone — fine.
  }
};

const cleanupSnapshot = (snapshotPath: string): Effect.Effect<void> =>
  Effect.sync(() => {
    removeIfPresent(snapshotPath);
    for (const suffix of SIDECAR_SUFFIXES) {
      removeIfPresent(`${snapshotPath}${suffix}`);
    }
  });

/**
 * The real provider: copies `liveDbPath` per run. This is the layer
 * `makeProductionServer` provides in place of any test double — tests get
 * their own `Layer.succeed(DeliberationSnapshot)({...})` fixtures instead of
 * touching the filesystem (see `deliberationSnapshot.test.ts`).
 */
export const DeliberationSnapshotLive = (liveDbPath: string): Layer.Layer<DeliberationSnapshot> =>
  Layer.succeed(DeliberationSnapshot)({
    withSnapshot: (use) => Effect.acquireUseRelease(copySnapshot(liveDbPath), use, cleanupSnapshot),
  });

/**
 * A no-op stand-in for tests that exercise `DeliberationRunner` over the
 * in-memory `Store` (no live SQLite file exists to snapshot). Hands `use` a
 * clearly-fake path rather than touching the filesystem at all — the real
 * copy/chmod/cleanup behavior is covered directly by
 * `deliberationSnapshot.test.ts` against `DeliberationSnapshotLive`.
 */
export const NoopDeliberationSnapshotForTest: Layer.Layer<DeliberationSnapshot> = Layer.succeed(
  DeliberationSnapshot,
)({
  withSnapshot: (use) => use("(no live db in this test — DeliberationSnapshotLive is not under test here)"),
});
