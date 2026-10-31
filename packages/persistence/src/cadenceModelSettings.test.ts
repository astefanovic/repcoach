import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/**
 * Per-cadence model settings storage (ADR 0011 §4, issue #31 — 2B slice 6;
 * widened with an optional reasoning-effort override by issue #81), proven
 * against BOTH `Store` layers behind the shared tag: the in-memory
 * `Store.layer` and the durable `SqlStore.layer` (migration `004`, effort
 * column added by migration `014`). The durability leg — set a model, close
 * the store, reopen a fresh `SqlStore` over the SAME file, read it back — is
 * the thing the in-memory store cannot prove and the whole reason the setting
 * lives in a table + migration.
 */

const tempDbPath = (): string =>
  path.join(os.tmpdir(), `repcoach-cadence-model-${randomUUID()}.sqlite`);

const cleanupDbFile = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

const runAgainstFreshLayer = <A, E>(dbPath: string, effect: Effect.Effect<A, E, Store>): Promise<A> =>
  effect.pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);

describe("per-cadence model settings (ADR 0011 §4, issue #31; effort, issue #81)", () => {
  it("in-memory Store: getCadenceModel is empty until set, then reflects the set model per cadence", async () => {
    const result = await Effect.gen(function* () {
      const store = yield* Store;
      const beforeSession = yield* store.getCadenceModel("session-review");
      const beforeCycle = yield* store.getCadenceModel("cycle-review");

      const setting = yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-strong" });
      yield* store.setCadenceModel({ cadence: "session-review", model: "model-cheap" });

      const afterSession = yield* store.getCadenceModel("session-review");
      const afterCycle = yield* store.getCadenceModel("cycle-review");
      return { beforeSession, beforeCycle, setting, afterSession, afterCycle };
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(result.beforeSession).toEqual({ model: undefined, effort: undefined });
    expect(result.beforeCycle).toEqual({ model: undefined, effort: undefined });
    expect(result.setting).toEqual({ cadence: "cycle-review", model: "model-strong" });
    // Independent per cadence — no cross-talk.
    expect(result.afterSession).toEqual({ model: "model-cheap", effort: undefined });
    expect(result.afterCycle).toEqual({ model: "model-strong", effort: undefined });
  });

  it("in-memory Store: setCadenceModel replaces (never accumulates) the model for a cadence", async () => {
    const model = await Effect.gen(function* () {
      const store = yield* Store;
      yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-v1" });
      yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-v2" });
      return yield* store.getCadenceModel("cycle-review");
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(model).toEqual({ model: "model-v2", effort: undefined });
  });

  it("in-memory Store: persists an optional reasoning-effort override alongside the model", async () => {
    const result = await Effect.gen(function* () {
      const store = yield* Store;
      const setting = yield* store.setCadenceModel({ cadence: "intake", model: "model-a", effort: "high" });
      const read = yield* store.getCadenceModel("intake");
      return { setting, read };
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(result.setting).toEqual({ cadence: "intake", model: "model-a", effort: "high" });
    expect(result.read).toEqual({ model: "model-a", effort: "high" });
  });

  it("SqlStore: a cadence model (and effort) survives closing the store and reopening a fresh SqlStore over the same file", async () => {
    const dbPath = tempDbPath();
    try {
      await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-durable", effort: "low" });
        }),
      );

      // Fresh layer over the SAME file — a real process-restart analogue.
      const reread = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const cycle = yield* store.getCadenceModel("cycle-review");
          const session = yield* store.getCadenceModel("session-review");
          return { cycle, session };
        }),
      );

      expect(reread.cycle).toEqual({ model: "model-durable", effort: "low" });
      expect(reread.session).toEqual({ model: undefined, effort: undefined });
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("SqlStore: setCadenceModel upserts (replaces) rather than duplicating a cadence's row", async () => {
    const dbPath = tempDbPath();
    try {
      const model = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.setCadenceModel({ cadence: "session-review", model: "model-a" });
          yield* store.setCadenceModel({ cadence: "session-review", model: "model-b" });
          return yield* store.getCadenceModel("session-review");
        }),
      );
      expect(model).toEqual({ model: "model-b", effort: undefined });
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});
