import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/**
 * The RPE capture control (#63, issue #81) — three states, stored server-side
 * (migration `013`), proven against BOTH `Store` layers: the in-memory
 * `Store.layer` and the durable `SqlStore.layer`.
 */

const tempDbPath = (): string => path.join(os.tmpdir(), `repcoach-rpe-setting-${randomUUID()}.sqlite`);

const cleanupDbFile = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

const runAgainstFreshLayer = <A, E>(dbPath: string, effect: Effect.Effect<A, E, Store>): Promise<A> =>
  effect.pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);

describe("the RPE capture control (#63, issue #81)", () => {
  it("in-memory Store: defaults to flagged-only, and setRpeCaptureMode replaces (never accumulates)", async () => {
    const result = await Effect.gen(function* () {
      const store = yield* Store;
      const before = yield* store.getRpeCaptureMode;
      const setResult = yield* store.setRpeCaptureMode("every-set");
      const after = yield* store.getRpeCaptureMode;
      yield* store.setRpeCaptureMode("off");
      const afterSecond = yield* store.getRpeCaptureMode;
      return { before, setResult, after, afterSecond };
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(result.before).toBe("flagged-only");
    expect(result.setResult).toBe("every-set");
    expect(result.after).toBe("every-set");
    expect(result.afterSecond).toBe("off");
  });

  it("SqlStore: the mode survives closing the store and reopening a fresh SqlStore over the same file", async () => {
    const dbPath = tempDbPath();
    try {
      await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.setRpeCaptureMode("off");
        }),
      );

      const reread = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getRpeCaptureMode;
        }),
      );

      expect(reread).toBe("off");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("SqlStore: a fresh database with no row written yet defaults to flagged-only", async () => {
    const dbPath = tempDbPath();
    try {
      const mode = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getRpeCaptureMode;
        }),
      );
      expect(mode).toBe("flagged-only");
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});
