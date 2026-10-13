import type {
  ActualMetricMap,
  MetricName,
  PrescribedMetricMap,
  PrescribedTargetInterval,
} from "@repcoach/contracts";

import { deriveSetFields } from "./grid.ts";

/**
 * #72's second runtime gap — per-metric deviation, the thing the set row
 * paints yellow.
 *
 * The comparison is against an **interval**, not a scalar. That distinction
 * is the whole reason this lives here rather than in the React row: an
 * actual that lands *inside* a prescribed range is the prescription being
 * met, not a miss, and the prototype's `number | [number, number]` target
 * could not say so — it resolved every range to its top and then called
 * anything else a deviation, so 7 reps against "5–8" read as "−1 rep".
 *
 * The signed size of the miss is measured from the **nearest violated
 * bound**, which is the only number the user can act on: under 5 on a "5–8"
 * range by one rep is `-1`, over 8 by two is `+2`.
 */

export type MetricDeviation =
  | { readonly status: "unprescribed" }
  | { readonly status: "on-target" }
  | { readonly status: "under"; readonly by: number }
  | { readonly status: "over"; readonly by: number };

/**
 * Compares one logged actual against its prescribed interval.
 *
 * An absent interval, or an entirely open one (`{}` — "report effort, no
 * target"), prescribes nothing to miss: both are `"unprescribed"`, and the
 * row shows the value with no yellow. A one-sided bound is only violable on
 * the side it states — "8+" cannot be exceeded, "<=8 RPE" cannot be
 * undershot.
 */
export function metricDeviation(
  interval: PrescribedTargetInterval | undefined,
  actual: number | undefined,
): MetricDeviation {
  if (interval === undefined || actual === undefined) {
    return { status: "unprescribed" };
  }
  const { min, max } = interval;
  if (min === undefined && max === undefined) {
    return { status: "unprescribed" };
  }
  if (min !== undefined && actual < min) {
    return { status: "under", by: round(min - actual) };
  }
  if (max !== undefined && actual > max) {
    return { status: "over", by: round(actual - max) };
  }
  return { status: "on-target" };
}

/** `-1` / `+2` / `0` — the row's label, sign carrying the direction of the miss. */
export function deviationDelta(deviation: MetricDeviation): number {
  switch (deviation.status) {
    case "under":
      return -deviation.by;
    case "over":
      return deviation.by;
    case "on-target":
    case "unprescribed":
      return 0;
  }
}

/** True only for a real miss — what decides whether the metric is painted. */
export function isDeviated(deviation: MetricDeviation): boolean {
  return deviation.status === "under" || deviation.status === "over";
}

/**
 * Every tracked metric of a Set, in `deriveSetFields` order, with its
 * verdict — so the row walks one list rather than deriving the fields once
 * and the deviations again somewhere else.
 */
export function setDeviations(
  target: PrescribedMetricMap,
  actual: ActualMetricMap | undefined,
): ReadonlyArray<{ readonly metric: MetricName; readonly deviation: MetricDeviation }> {
  return deriveSetFields(target).map((metric) => ({
    metric,
    deviation: metricDeviation(target[metric], actual?.[metric]),
  }));
}

/** True when any tracked metric missed — the row-level "this set deviated". */
export function hasDeviation(
  target: PrescribedMetricMap,
  actual: ActualMetricMap | undefined,
): boolean {
  return setDeviations(target, actual).some(({ deviation }) => isDeviated(deviation));
}

/** Loads are prescribed in 2.5 kg steps; float subtraction must not surface as 2.4999999999999996. */
const round = (value: number): number => Math.round(value * 1000) / 1000;
