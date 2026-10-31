import * as Schema from "effect/Schema";

import { ExerciseId, IsoDateTime, LoggedSessionId } from "./baseSchemas.ts";
import { SetType } from "./metrics.ts";

/**
 * Estimated one-rep max (e1RM) — the Epley formula, `load × (1 + reps / 30)`,
 * with a single rep read as the load itself.
 *
 * The one definition both halves use: the server ranks a lift's history by it
 * (`bestE1rm` below, for Logging's PR badge) and the Progress surface charts
 * it, so a Set the badge calls a record is the same Set the chart puts on top.
 *
 * Only defined for 1–12 reps at a positive load. Past a dozen reps the
 * estimate stops meaning anything (a 20-rep set is an endurance number, not a
 * strength one), and a Set with no load is not a strength estimate at all.
 */
export function estimateOneRepMax(load: number | undefined, reps: number | undefined): number | undefined {
  if (load === undefined || reps === undefined) return undefined;
  if (!(load > 0) || !(reps >= 1) || reps > MAX_E1RM_REPS) return undefined;
  const whole = Math.round(reps);
  return whole === 1 ? load : load * (1 + whole / 30);
}

export const MAX_E1RM_REPS = 12;

/**
 * Everything the Progress surface charts, in one read: per performed
 * Exercise, every finished Logged Session that performed it, with its net
 * logged Sets' load and reps. Swap-aware and net-state exactly as
 * `lastActualForExercise` is (an Entry swapped to a leg press counts toward
 * the leg press), and raw rather than pre-aggregated — the e1RM, volume and
 * PR derivations live client-side in one place (`Stats` in client-runtime),
 * over `estimateOneRepMax` above.
 *
 * Finished sessions only, oldest first. No error channel: never having
 * trained is an empty `exercises`.
 */
export const ExerciseProgressSet = Schema.Struct({
  setType: SetType,
  load: Schema.optionalKey(Schema.Number),
  reps: Schema.optionalKey(Schema.Number),
});
export type ExerciseProgressSet = typeof ExerciseProgressSet.Type;

export const ExerciseProgressSession = Schema.Struct({
  loggedSessionId: LoggedSessionId,
  /** When the session finished (its start, for a row that predates `finished_at`). */
  performedAt: IsoDateTime,
  sets: Schema.Array(ExerciseProgressSet),
});
export type ExerciseProgressSession = typeof ExerciseProgressSession.Type;

export const ExerciseProgress = Schema.Struct({
  exerciseId: ExerciseId,
  sessions: Schema.Array(ExerciseProgressSession),
});
export type ExerciseProgress = typeof ExerciseProgress.Type;

export const GetExerciseProgressResult = Schema.Struct({
  exercises: Schema.Array(ExerciseProgress),
});
export type GetExerciseProgressResult = typeof GetExerciseProgressResult.Type;
