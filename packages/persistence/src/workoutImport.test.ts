import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ImportedWorkout } from "@repcoach/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import { importedLoggedSessionId } from "./importedSessions.ts";
import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/** Imported history: finished, reviewed, swap-free sessions, idempotent per workout, on both Store layers. */
const workout = (importKey: string, startedAt: string, load: number): ImportedWorkout => ({
  importKey,
  name: "Push A",
  startedAt,
  finishedAt: new Date(Date.parse(startedAt) + 3_600_000).toISOString(),
  entries: [
    {
      exerciseId: "import-test-bench" as never,
      trackedMetrics: ["reps", "load"],
      sets: [
        { setType: "warmup", actual: { reps: 10, load: 20 } },
        { setType: "working", actual: { reps: 5, load } },
      ],
    },
  ],
});

const scenario = Effect.gen(function* () {
  const store = yield* Store;
  const first = yield* store.importWorkouts({
    workouts: [workout("strong|2024-01-01 09:00:00|Push A", "2024-01-01T09:00:00.000Z", 100)],
  });
  // A later export containing the earlier workout: one skipped, one new.
  const second = yield* store.importWorkouts({
    workouts: [
      workout("strong|2024-01-01 09:00:00|Push A", "2024-01-01T09:00:00.000Z", 100),
      workout("strong|2024-01-03 09:00:00|Push A", "2024-01-03T09:00:00.000Z", 105),
    ],
  });
  const loggedSession = yield* store.getLoggedSession(
    importedLoggedSessionId("strong|2024-01-03 09:00:00|Push A") as never,
  );
  const history = yield* store.listSessions({});
  const pendingReview = yield* store.listSessionsPendingReview;
  const progress = yield* store.getExerciseProgress;
  return { first, second, loggedSession, history, pendingReview, progress };
});

const expectScenario = (result: Effect.Success<typeof scenario>) => {
  expect(result.first).toEqual({ imported: 1, skipped: 0 });
  expect(result.second).toEqual({ imported: 1, skipped: 1 });
  const session = Option.getOrThrow(result.loggedSession);
  expect(session.status).toBe("finished");
  expect(session.session.name).toBe("Push A");
  expect(session.actuals.map((actual) => actual.retraction === false && actual.actual.load)).toEqual([20, 105]);
  const imported = result.history.sessions.filter((summary) => summary.loggedSessionId.startsWith("import-"));
  expect(imported.map((summary) => summary.finishedAt)).toEqual([
    "2024-01-03T10:00:00.000Z",
    "2024-01-01T10:00:00.000Z",
  ]);
  expect(imported.every((summary) => summary.loggedSetCount === 2 && summary.totalSetCount === 2)).toBe(true);
  expect(result.pendingReview.filter((id) => id.startsWith("import-"))).toEqual([]);
  const bench = result.progress.exercises.find((exercise) => exercise.exerciseId === "import-test-bench");
  expect(bench?.sessions.length).toBe(2);
};

describe("workout import", () => {
  it("in-memory Store", async () => {
    expectScenario(await scenario.pipe(Effect.provide(Store.layer), Effect.runPromise));
  });

  it("SqlStore", async () => {
    const dbPath = path.join(os.tmpdir(), `repcoach-import-${randomUUID()}.sqlite`);
    try {
      expectScenario(
        await scenario.pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise),
      );
    } finally {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });
});
