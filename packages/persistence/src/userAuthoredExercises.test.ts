import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { ExerciseId } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { SEEDED_SESSION_ID, Store, type DecisionRecord } from "./store.ts";

/**
 * User-authored exercises (#102, ADR 0016), run against BOTH `Store` layers
 * through one shared assertion body so the in-memory and SQLite layers cannot
 * drift on a write the Plan then depends on.
 *
 * Black-box throughout: create or rename, then read the catalog back through
 * `getExerciseCatalog` — the same method the picker calls. Nothing here
 * asserts on a row or a column.
 */

const id = (value: string): ExerciseId => value as ExerciseId;

const catalogNames = (catalog: { readonly exercises: ReadonlyArray<{ readonly name: string }> }) =>
  catalog.exercises.map((exercise) => exercise.name);

const runSuite = (withStore: <A, E>(effect: Effect.Effect<A, E, Store>) => Promise<A>) => {
  it("mints a name-only row that the picker then lists", async () => {
    const { created, catalog } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const created = yield* store.createExercise({
          exerciseId: id("exercise-zercher-squat"),
          name: "Zercher Squat",
        });
        return { created, catalog: yield* store.getExerciseCatalog };
      }),
    );

    expect(created.name).toBe("Zercher Squat");
    // Name only: the coach supplies the metadata later, and *empty* is what
    // marks the row un-enriched (ADR 0016).
    expect(created.trackedMetrics).toEqual([]);
    expect(catalogNames(catalog)).toContain("Zercher Squat");
  });

  it("keeps the Exercise library link through a read-back and a rename", async () => {
    const { created, afterRename, catalog } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const created = yield* store.createExercise({
          exerciseId: id("exercise-barbell-bench"),
          name: "Barbell Bench Press",
          libraryId: "0025",
        });
        const afterRename = yield* store.renameExercise({
          exerciseId: id("exercise-barbell-bench"),
          name: "Bench Press",
        });
        return { created, afterRename, catalog: yield* store.getExerciseCatalog };
      }),
    );

    expect(created.libraryId).toBe("0025");
    // A library pick is still name-only: the link says which animation, not
    // what the exercise tracks, so the coach still enriches it.
    expect(created.trackedMetrics).toEqual([]);
    expect(afterRename.libraryId).toBe("0025");
    expect(catalog.exercises.find((exercise) => exercise.id === "exercise-barbell-bench")?.libraryId).toBe(
      "0025",
    );
  });

  it("leaves a typed-by-name row unlinked", async () => {
    const created = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.createExercise({ exerciseId: id("exercise-zercher-squat"), name: "Zercher Squat" });
      }),
    );

    expect(created).not.toHaveProperty("libraryId");
  });

  it("is idempotent on the client-minted id, so a retry cannot mint two exercises", async () => {
    const catalog = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const input = { exerciseId: id("exercise-zercher-squat"), name: "Zercher Squat" };
        yield* store.createExercise(input);
        yield* store.createExercise(input);
        return yield* store.getExerciseCatalog;
      }),
    );

    expect(catalogNames(catalog).filter((name) => name === "Zercher Squat")).toHaveLength(1);
  });

  it("does not let a replayed create clobber a name the user has since fixed", async () => {
    const catalog = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({ exerciseId: id("exercise-typo"), name: "Zercer Squat" });
        yield* store.renameExercise({ exerciseId: id("exercise-typo"), name: "Zercher Squat" });
        yield* store.createExercise({ exerciseId: id("exercise-typo"), name: "Zercer Squat" });
        return yield* store.getExerciseCatalog;
      }),
    );

    expect(catalogNames(catalog)).toContain("Zercher Squat");
    expect(catalogNames(catalog)).not.toContain("Zercer Squat");
  });

  it("writes no Change and no Decision — creating an exercise changed no Plan", async () => {
    const { before, after } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const before: ReadonlyArray<DecisionRecord> = yield* store.listDecisionsForTest;
        yield* store.createExercise({
          exerciseId: id("exercise-zercher-squat"),
          name: "Zercher Squat",
        });
        yield* store.renameExercise({
          exerciseId: id("exercise-zercher-squat"),
          name: "Zercher Squat (SSB)",
        });
        return { before, after: yield* store.listDecisionsForTest };
      }),
    );

    expect(after.map((decision) => decision.id)).toEqual(before.map((decision) => decision.id));
  });

  it("renames in place: the id is unchanged, so the Plan follows the row", async () => {
    const { renamed, entryExerciseId, catalog } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({ exerciseId: id("exercise-typo"), name: "Zercer Squat" });
        yield* store.applyUserPlanChange({
          operation: {
            _tag: "addEntry",
            sessionId: SEEDED_SESSION_ID,
            blockId: "block-new" as never,
            entryId: "entry-new" as never,
            exerciseId: "exercise-typo" as never,
          },
        } as never);
        const renamed = yield* store.renameExercise({
          exerciseId: id("exercise-typo"),
          name: "Zercher Squat",
        });
        const plan = yield* store.getPlan;
        const entryExerciseId = plan.sessions
          .flatMap((session) => session.blocks)
          .flatMap((block) => block.entries)
          .find((entry) => entry.id === "entry-new")?.exerciseId;
        return { renamed, entryExerciseId, catalog: yield* store.getExerciseCatalog };
      }),
    );

    expect(renamed.id).toBe("exercise-typo");
    expect(renamed.name).toBe("Zercher Squat");
    // The Plan Entry still points at the same row — no migration, no rewrite.
    expect(entryExerciseId).toBe("exercise-typo");
    expect(catalogNames(catalog)).toContain("Zercher Squat");
    expect(catalogNames(catalog)).not.toContain("Zercer Squat");
  });

  it("marks a renamed row for re-enrichment by emptying the metadata that described the old name", async () => {
    const renamed = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        // A seeded row, so there IS enriched metadata to lose.
        return yield* store.renameExercise({
          exerciseId: id("exercise-back-squat"),
          name: "Safety Bar Squat",
        });
      }),
    );

    expect(renamed.name).toBe("Safety Bar Squat");
    expect(renamed.trackedMetrics).toEqual([]);
  });

  it("fails rather than inventing a row when the id names no exercise", async () => {
    const failure = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store
          .renameExercise({ exerciseId: id("exercise-nobody"), name: "Whatever" })
          .pipe(Effect.flip);
      }),
    );

    expect(failure._tag).toBe("ExerciseNotFoundError");
  });
};

describe("User-authored exercises (#102) — in-memory Store", () => {
  const withStore = <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runSuite(withStore);
});

describe("User-authored exercises (#102) — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-user-exercises-${randomUUID()}.sqlite`);

  const cleanupDbFile = (dbPath: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };

  const withStore = <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> => {
    const dbPath = tempDbPath();
    return effect
      .pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise)
      .finally(() => cleanupDbFile(dbPath));
  };

  runSuite(withStore);
});
