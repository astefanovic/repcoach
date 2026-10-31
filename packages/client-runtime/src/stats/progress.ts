import { estimateOneRepMax, type ExerciseProgress } from "@repcoach/contracts";

/**
 * The Progress surface's derivations over `stats.getExerciseProgress`: per
 * session, the best estimated one-rep max, the Set that produced it, the
 * working volume, and whether it set a record. Pure, so rung 1 reaches every
 * number the chart draws.
 *
 * Warmups count for nothing here, as everywhere else in analytics
 * (ui-surfaces "Warmup sets: … excluded from analytics by default").
 */
export interface ProgressPoint {
  readonly loggedSessionId: string;
  readonly performedAt: string;
  /** Best e1RM of the session's non-warmup Sets; `undefined` when none had a load and 1–12 reps. */
  readonly e1rm: number | undefined;
  /** The Set behind `e1rm`. */
  readonly topSet: { readonly load: number; readonly reps: number } | undefined;
  /** Σ load × reps over non-warmup Sets with both. 0 for a session of bodyweight Sets. */
  readonly volume: number;
  /** Non-warmup Sets performed. */
  readonly setCount: number;
  /** `e1rm` beat every earlier session's. The first session with an e1RM is not a record — there was nothing to beat. */
  readonly isPr: boolean;
}

export function progressPoints(exercise: ExerciseProgress): ReadonlyArray<ProgressPoint> {
  let best: number | undefined;
  return [...exercise.sessions]
    .sort((a, b) => a.performedAt.localeCompare(b.performedAt))
    .map((session) => {
      let e1rm: number | undefined;
      let topSet: ProgressPoint["topSet"];
      let volume = 0;
      let setCount = 0;
      for (const set of session.sets) {
        if (set.setType === "warmup") continue;
        setCount += 1;
        if (set.load !== undefined && set.reps !== undefined) volume += set.load * set.reps;
        const estimate = estimateOneRepMax(set.load, set.reps);
        if (estimate !== undefined && (e1rm === undefined || estimate > e1rm)) {
          e1rm = estimate;
          topSet = { load: set.load as number, reps: set.reps as number };
        }
      }
      const isPr = e1rm !== undefined && best !== undefined && e1rm > best + 1e-9;
      if (e1rm !== undefined && (best === undefined || e1rm > best)) best = e1rm;
      return {
        loggedSessionId: session.loggedSessionId,
        performedAt: session.performedAt,
        e1rm,
        topSet,
        volume,
        setCount,
        isPr,
      };
    });
}

/**
 * Whether a Set logged right now is a personal record: its e1RM beats the
 * best of every finished session (`bestE1rm` from `lastActualForExercise`).
 * No history, no record — the first time is a baseline, not a PR, which is
 * also what keeps a freshly added exercise from lighting up every row.
 */
export function isPersonalRecord(
  actual: { readonly load?: number; readonly reps?: number },
  setType: string,
  bestE1rm: number | undefined,
): boolean {
  if (setType === "warmup" || bestE1rm === undefined) return false;
  const estimate = estimateOneRepMax(actual.load, actual.reps);
  return estimate !== undefined && estimate > bestE1rm + 1e-9;
}

/** Exercises with something to chart, most recently performed first. */
export function chartableExercises(
  exercises: ReadonlyArray<ExerciseProgress>,
): ReadonlyArray<ExerciseProgress> {
  const last = (exercise: ExerciseProgress) =>
    exercise.sessions.reduce((latest, s) => (s.performedAt > latest ? s.performedAt : latest), "");
  return exercises
    .filter((exercise) => exercise.sessions.some((s) => s.sets.some((set) => set.setType !== "warmup")))
    .slice()
    .sort((a, b) => last(b).localeCompare(last(a)));
}

/**
 * Plot coordinates for a line chart of `values` across a `width × height`
 * box, x evenly spaced by position (sessions, not calendar time — a gap of
 * three weeks is not a slope) and y scaled to the series' own range with a
 * little headroom, so a lift that moved 5 kg in a year still reads as a line
 * rather than a flat bar along the floor. `undefined` values are skipped.
 */
export function plotSeries(
  values: ReadonlyArray<number | undefined>,
  box: { readonly width: number; readonly height: number },
  /** Scale against these values' range too — a second series drawn on the same axes. */
  alsoFit: ReadonlyArray<number> = [],
): {
  readonly points: ReadonlyArray<{ readonly index: number; readonly x: number; readonly y: number; readonly value: number }>;
  readonly min: number;
  readonly max: number;
} {
  const present = values.flatMap((value, index) => (value === undefined ? [] : [{ value, index }]));
  if (present.length === 0) return { points: [], min: 0, max: 0 };
  const lo = Math.min(...present.map((p) => p.value), ...alsoFit);
  const hi = Math.max(...present.map((p) => p.value), ...alsoFit);
  const span = hi - lo;
  const pad = span === 0 ? Math.max(1, Math.abs(hi) * 0.05) : span * 0.1;
  const min = lo - pad;
  const max = hi + pad;
  const steps = Math.max(1, values.length - 1);
  return {
    points: present.map(({ value, index }) => ({
      index,
      value,
      x: values.length === 1 ? box.width / 2 : (index / steps) * box.width,
      y: box.height - ((value - min) / (max - min)) * box.height,
    })),
    min,
    max,
  };
}
