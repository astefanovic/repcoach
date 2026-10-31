import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import type { CatalogEnrichment, ExerciseId } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { SEEDED_SESSION_ID, Store, type DecisionRecord } from "./store.ts";

/**
 * Silent catalog enrichment (#104, ADR 0016) at the STORE seam, run against
 * BOTH `Store` layers through one shared assertion body — the roster the seed
 * is built from and the write the runner performs must not drift between
 * in-memory and SQLite, since the whole feature is "the row the user typed
 * quietly becomes a joinable one".
 *
 * What is asserted here is the write contract, not the coach's anatomy: which
 * rows are offered, what a write touches, what it refuses to touch, and that
 * none of it reaches the Decision log.
 */

const id = (value: string): ExerciseId => value as ExerciseId;

const ZERCHER = id("exercise-zercher-squat");

const enrichment = (overrides: Partial<CatalogEnrichment> = {}): CatalogEnrichment => ({
  exercise_id: ZERCHER,
  tracked_metrics: ["reps", "load"],
  muscles: ["quadriceps", "gluteus maximus", "upper back"],
  movement_pattern: "squat",
  ...overrides,
});

const rosterIds = (roster: ReadonlyArray<{ readonly id: string }>) => roster.map((row) => row.id);

const runSuite = (withStore: <A, E>(effect: Effect.Effect<A, E, Store>) => Promise<A>) => {
  it("offers a freshly minted name-only row, and stops offering it once it is filled in", async () => {
    const { before, after } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        const before = yield* store.listUnenrichedExercises;
        yield* store.enrichExercises({ enrichments: [enrichment()] });
        return { before, after: yield* store.listUnenrichedExercises };
      }),
    );

    expect(rosterIds(before)).toContain(ZERCHER);
    expect(rosterIds(after)).not.toContain(ZERCHER);
  });

  it("fills in muscles, movement pattern and tracked metrics, leaving the id and the user's name alone", async () => {
    const { enriched, catalogRow } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        yield* store.enrichExercises({ enrichments: [enrichment()] });
        const catalog = yield* store.getExerciseCatalog;
        return {
          enriched: yield* store.getExerciseEnrichmentForTest(ZERCHER),
          catalogRow: catalog.exercises.find((exercise) => exercise.id === ZERCHER),
        };
      }),
    );

    expect(Option.isSome(enriched)).toBe(true);
    const metadata = Option.getOrThrow(enriched);
    expect(metadata.trackedMetrics).toEqual(["reps", "load"]);
    expect(metadata.muscles).toEqual(["quadriceps", "gluteus maximus", "upper back"]);
    expect(metadata.movementPattern).toBe("squat");
    // The user owns the name; the coach owns everything else (ADR 0016).
    expect(catalogRow?.id).toBe(ZERCHER);
    expect(catalogRow?.name).toBe("Zercher Squat");
  });

  it("writes no Decision of any kind — enrichment is a plain write (ADR 0016)", async () => {
    const { before, after } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        const before: ReadonlyArray<DecisionRecord> = yield* store.listDecisionsForTest;
        yield* store.enrichExercises({ enrichments: [enrichment()] });
        return { before, after: yield* store.listDecisionsForTest };
      }),
    );

    expect(after.map((decision) => decision.id)).toEqual(before.map((decision) => decision.id));
  });

  it("renders the enriched tracked metrics on the Plan Entry, replacing the target-key fallback", async () => {
    const { beforeMetrics, afterMetrics } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({ exerciseId: id("exercise-farmers-carry"), name: "Farmer's Carry" });
        yield* store.applyUserPlanChange({
          operation: {
            _tag: "addEntry",
            sessionId: SEEDED_SESSION_ID,
            blockId: "block-carry",
            entryId: "entry-carry",
            exerciseId: "exercise-farmers-carry",
          },
        } as never);

        const entryMetrics = Effect.gen(function* () {
          const session = yield* store.getPrescribedSession(SEEDED_SESSION_ID);
          const entry = Option.getOrThrow(session)
            .blocks.flatMap((block) => block.entries)
            .find((candidate) => candidate.id === "entry-carry");
          return entry?.trackedMetrics;
        });

        const beforeMetrics = yield* entryMetrics;
        yield* store.enrichExercises({
          enrichments: [
            {
              exercise_id: id("exercise-farmers-carry"),
              tracked_metrics: ["load", "distance"],
              muscles: ["forearms", "trapezius"],
              movement_pattern: "carry",
            },
          ],
        });
        return { beforeMetrics, afterMetrics: yield* entryMetrics };
      }),
    );

    // Un-enriched: nothing to render from, so the grid falls back to the
    // Set's own target keys (ADR 0016's Consequences).
    expect(beforeMetrics ?? []).toEqual([]);
    // Enriched: a carry asks for load and distance, not reps and load.
    expect(afterMetrics).toEqual(["load", "distance"]);
  });

  it("repairs history: a session logged BEFORE enrichment joins to the muscles afterwards", async () => {
    const { exerciseIdInHistory, muscles } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        yield* store.applyUserPlanChange({
          operation: {
            _tag: "addEntry",
            sessionId: SEEDED_SESSION_ID,
            blockId: "block-zercher",
            entryId: "entry-zercher",
            exerciseId: "exercise-zercher-squat",
          },
        } as never);
        yield* store.applyUserPlanChange({
          operation: {
            _tag: "replaceEntrySets",
            entryId: "entry-zercher",
            sets: [
              {
                id: "set-zercher-1",
                setType: "working",
                target: { reps: { min: 5, max: 5 }, load: { min: 60, max: 60 } },
              },
            ],
          },
        } as never);

        // Trained hard, and — correctly, given what was stored — contributing
        // zero volume to every muscle at the moment it was logged.
        const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
        yield* store.logSetActual({
          commandId: "cmd-zercher-1",
          loggedSessionId,
          sessionId: SEEDED_SESSION_ID,
          entryId: "entry-zercher",
          setId: "set-zercher-1",
          setType: "working",
          actual: { reps: 5, load: 60 },
        } as never);

        yield* store.enrichExercises({ enrichments: [enrichment()] });

        // The join the coach's per-muscle volume query performs, over history
        // that predates the metadata: logged set -> Entry -> catalog row.
        const logged = Option.getOrThrow(yield* store.getLoggedSession(loggedSessionId));
        const loggedEntryId = logged.actuals[0]?.entryId;
        const exerciseIdInHistory = logged.session.blocks
          .flatMap((block) => block.entries)
          .find((entry) => entry.id === loggedEntryId)?.exerciseId;
        const metadata = yield* store.getExerciseEnrichmentForTest(String(exerciseIdInHistory));
        return {
          exerciseIdInHistory,
          muscles: Option.isSome(metadata) ? metadata.value.muscles : undefined,
        };
      }),
    );

    expect(exerciseIdInHistory).toBe(ZERCHER);
    expect(muscles).toContain("quadriceps");
  });

  it("puts a renamed row back on the roster, and re-enriches it against the corrected name", async () => {
    const { rosterAfterRename, metadataAfterReenrichment } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({ exerciseId: id("exercise-typo"), name: "Zercer Squat" });
        yield* store.enrichExercises({
          enrichments: [
            {
              exercise_id: id("exercise-typo"),
              tracked_metrics: ["duration"],
              muscles: ["nonsense"],
              movement_pattern: "nonsense",
            },
          ],
        });
        yield* store.renameExercise({ exerciseId: id("exercise-typo"), name: "Zercher Squat" });
        const rosterAfterRename = yield* store.listUnenrichedExercises;
        yield* store.enrichExercises({
          enrichments: [enrichment({ exercise_id: id("exercise-typo") })],
        });
        return {
          rosterAfterRename,
          metadataAfterReenrichment: yield* store.getExerciseEnrichmentForTest("exercise-typo"),
        };
      }),
    );

    expect(rosterIds(rosterAfterRename)).toContain("exercise-typo");
    const metadata = Option.getOrThrow(metadataAfterReenrichment);
    expect(metadata.trackedMetrics).toEqual(["reps", "load"]);
    expect(metadata.muscles).toContain("quadriceps");
    expect(metadata.movementPattern).toBe("squat");
  });

  it("refuses to overwrite a row that is already enriched", async () => {
    const metadata = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        yield* store.enrichExercises({ enrichments: [enrichment()] });
        yield* store.enrichExercises({
          enrichments: [
            enrichment({ tracked_metrics: ["duration"], muscles: ["calves"], movement_pattern: "carry" }),
          ],
        });
        return yield* store.getExerciseEnrichmentForTest(ZERCHER);
      }),
    );

    const enriched = Option.getOrThrow(metadata);
    expect(enriched.trackedMetrics).toEqual(["reps", "load"]);
    expect(enriched.muscles).toContain("quadriceps");
    expect(enriched.movementPattern).toBe("squat");
  });

  it("treats an id the catalog does not hold as a no-op, never a failure", async () => {
    const { written, catalogSize } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const before = (yield* store.getExerciseCatalog).exercises.length;
        const written = yield* store.enrichExercises({
          enrichments: [enrichment({ exercise_id: id("exercise-hallucinated") })],
        });
        const after = (yield* store.getExerciseCatalog).exercises.length;
        return { written, catalogSize: { before, after } };
      }),
    );

    expect(written).toEqual([]);
    // No phantom row invented to hang the metadata off.
    expect(catalogSize.after).toBe(catalogSize.before);
  });

  it("lands a partial answer's half rather than erasing the row back to name-only", async () => {
    const metadata = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        // The coach could say what it trains but not what to call the pattern.
        yield* store.enrichExercises({
          enrichments: [{ exercise_id: ZERCHER, muscles: ["quadriceps"] }],
        });
        // Still un-enriched (no tracked metrics), so a later review completes it.
        yield* store.enrichExercises({
          enrichments: [{ exercise_id: ZERCHER, tracked_metrics: ["reps", "load"] }],
        });
        return yield* store.getExerciseEnrichmentForTest(ZERCHER);
      }),
    );

    const enriched = Option.getOrThrow(metadata);
    expect(enriched.muscles).toEqual(["quadriceps"]);
    expect(enriched.trackedMetrics).toEqual(["reps", "load"]);
    expect(enriched.movementPattern).toBeUndefined();
  });

  it("does nothing at all when handed an empty enrichment list", async () => {
    const { written, roster } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        const written = yield* store.enrichExercises({ enrichments: [] });
        return { written, roster: yield* store.listUnenrichedExercises };
      }),
    );

    expect(written).toEqual([]);
    expect(rosterIds(roster)).toContain(ZERCHER);
  });
};

describe("Catalog enrichment (#104) — in-memory Store", () => {
  const withStore = <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runSuite(withStore);
});

describe("Catalog enrichment (#104) — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-catalog-enrichment-${randomUUID()}.sqlite`);

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
