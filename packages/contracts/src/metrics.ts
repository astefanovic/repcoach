import * as Schema from "effect/Schema";

/**
 * Set (CONTEXT.md): the atomic unit inside an Entry, carrying **two** metric
 * maps over {reps, load, duration, distance, rpe/rir, tempo} — a prescribed
 * target map and a logged actual map — plus a shared set-type tag.
 *
 * A prescribed target value is an **interval** `{min?, max?}` (both bounds
 * equal = exact target, differing = a range, one-sided = "8+" or a "<= RPE 8"
 * cap, and an entirely open `{}` means "report effort, no target"). An actual
 * value is always a scalar.
 */

/** rpe/rir is modeled as a single metric field per CONTEXT's metric-map list. */
export const MetricName = Schema.Literals([
  "reps",
  "load",
  "duration",
  "distance",
  "rpe",
  "tempo",
]);
export type MetricName = typeof MetricName.Type;

export const PrescribedTargetInterval = Schema.Struct({
  min: Schema.optionalKey(Schema.Number),
  max: Schema.optionalKey(Schema.Number),
});
export type PrescribedTargetInterval = typeof PrescribedTargetInterval.Type;

/**
 * Prescribed metric map: every present metric is an interval. A metric key
 * may be entirely absent (exercise doesn't track it — CONTEXT `Exercise
 * catalog`), or present as an *open* interval `{}` ("report effort, no
 * target" — e.g. an open `rpe: {}`).
 */
export const PrescribedMetricMap = Schema.Struct({
  reps: Schema.optionalKey(PrescribedTargetInterval),
  load: Schema.optionalKey(PrescribedTargetInterval),
  duration: Schema.optionalKey(PrescribedTargetInterval),
  distance: Schema.optionalKey(PrescribedTargetInterval),
  rpe: Schema.optionalKey(PrescribedTargetInterval),
  tempo: Schema.optionalKey(PrescribedTargetInterval),
});
export type PrescribedMetricMap = typeof PrescribedMetricMap.Type;

/**
 * Actual metric map: every present metric is a scalar number. Used only for
 * logged actuals (ADR 0006) — never carries a prescribed interval.
 */
export const ActualMetricMap = Schema.Struct({
  reps: Schema.optionalKey(Schema.Number),
  load: Schema.optionalKey(Schema.Number),
  duration: Schema.optionalKey(Schema.Number),
  distance: Schema.optionalKey(Schema.Number),
  rpe: Schema.optionalKey(Schema.Number),
  tempo: Schema.optionalKey(Schema.Number),
});
export type ActualMetricMap = typeof ActualMetricMap.Type;

/** Set-type tag, shared by both the prescribed and actual side of a Set. */
export const SetType = Schema.Literals([
  "working",
  "warmup",
  "drop",
  "myo-cluster",
  "rest-pause",
]);
export type SetType = typeof SetType.Type;
