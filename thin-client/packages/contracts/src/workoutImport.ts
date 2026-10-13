import * as Schema from "effect/Schema";

import { ExerciseId, IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ActualMetricMap, MetricName, SetType } from "./metrics.ts";

/**
 * Importing workout history from another app (Strong, Hevy) — finished
 * Logged Sessions written straight into history, so the Progress charts, the
 * PR badges and the one-tap ✓ seed have something to stand on from day one.
 *
 * The CSV is parsed on the device (`Import` in `@repcoach/client-runtime`)
 * and exercise names are matched to the catalog there, with new names minted
 * through `catalog.createExercise` first; this payload carries only what the
 * server writes. Every exercise id is carried by value, the same discipline
 * as `logSetActual` (ADR 0017).
 *
 * **Re-importing is safe.** `importKey` is the source app's identity for a
 * workout (its start time and title); the Logged Session id is derived from
 * it, so importing the same file twice — or a later export that contains the
 * earlier one — skips every workout already here rather than duplicating it.
 *
 * Imported sessions land `finished` and already `reviewed`: they are history
 * the coach can read, not workouts it owes a Session review for.
 */
export const ImportedSet = Schema.Struct({
  setType: SetType,
  actual: ActualMetricMap,
});
export type ImportedSet = typeof ImportedSet.Type;

export const ImportedEntry = Schema.Struct({
  exerciseId: ExerciseId,
  /** What the source recorded for this exercise — the snapshot's `trackedMetrics`. */
  trackedMetrics: Schema.Array(MetricName),
  sets: Schema.Array(ImportedSet).check(Schema.isMinLength(1)),
});
export type ImportedEntry = typeof ImportedEntry.Type;

export const ImportedWorkout = Schema.Struct({
  importKey: TrimmedNonEmptyString,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  entries: Schema.Array(ImportedEntry).check(Schema.isMinLength(1)),
});
export type ImportedWorkout = typeof ImportedWorkout.Type;

export const ImportWorkoutsInput = Schema.Struct({
  workouts: Schema.Array(ImportedWorkout),
});
export type ImportWorkoutsInput = typeof ImportWorkoutsInput.Type;

export const ImportWorkoutsResult = Schema.Struct({
  /** Workouts written by this call. */
  imported: NonNegativeInt,
  /** Workouts skipped because an earlier import already wrote them. */
  skipped: NonNegativeInt,
});
export type ImportWorkoutsResult = typeof ImportWorkoutsResult.Type;
