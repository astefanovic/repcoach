import type { MetricName } from "@repcoach/contracts";

/**
 * `exercise_catalog` seed rows (Step 2A / task 2A.1) — one row per
 * `exerciseId` the seeded Prescribed Session (`store.ts`
 * `seedPrescribedSession`) actually references, with `trackedMetrics`
 * matching the grid's current field layout: back-squat and leg-press are
 * reps+load, bench-press is reps+load, plank is duration-only (CONTEXT
 * `Exercise catalog` — "drives the logging field layout"). Not yet joined
 * into `getPrescribedSession`/the grid (that wiring is task 2A.3) — this is
 * schema + seed only, so the table and its data exist end-to-end starting
 * now.
 */
export interface ExerciseCatalogSeedRow {
  readonly id: string;
  readonly name: string;
  readonly trackedMetrics: ReadonlyArray<MetricName>;
}

export const seedExerciseCatalog = (): ReadonlyArray<ExerciseCatalogSeedRow> => [
  { id: "exercise-back-squat", name: "Back Squat", trackedMetrics: ["reps", "load"] },
  { id: "exercise-bench-press", name: "Bench Press", trackedMetrics: ["reps", "load"] },
  { id: "exercise-plank", name: "Plank", trackedMetrics: ["duration"] },
  { id: "exercise-leg-press", name: "Leg Press", trackedMetrics: ["reps", "load"] },
];
