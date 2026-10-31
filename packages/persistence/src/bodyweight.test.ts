import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/** Bodyweight: one reading per local day, an upsert, on both Store layers. */
const scenario = Effect.gen(function* () {
  const store = yield* Store;
  yield* store.logBodyweight({ date: "2026-01-02", weightKg: 80.4 });
  yield* store.logBodyweight({ date: "2026-01-01", weightKg: 81 });
  // A second reading for a day replaces the first.
  yield* store.logBodyweight({ date: "2026-01-02", weightKg: 80.1 });
  const afterLogs = yield* store.listBodyweight;
  yield* store.removeBodyweight({ date: "2026-01-01" });
  // Removing a day with no reading is not an error.
  yield* store.removeBodyweight({ date: "2025-12-31" });
  const afterRemove = yield* store.listBodyweight;
  return { afterLogs, afterRemove };
});

const expectScenario = ({ afterLogs, afterRemove }: Effect.Success<typeof scenario>) => {
  expect(afterLogs.entries.map(({ date, weightKg }) => ({ date, weightKg }))).toEqual([
    { date: "2026-01-01", weightKg: 81 },
    { date: "2026-01-02", weightKg: 80.1 },
  ]);
  expect(afterRemove.entries.map((entry) => entry.date)).toEqual(["2026-01-02"]);
};

describe("bodyweight log", () => {
  it("in-memory Store", async () => {
    expectScenario(await scenario.pipe(Effect.provide(Store.layer), Effect.runPromise));
  });

  it("SqlStore", async () => {
    const dbPath = path.join(os.tmpdir(), `repcoach-bodyweight-${randomUUID()}.sqlite`);
    try {
      expectScenario(
        await scenario.pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise),
      );
    } finally {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });
});
