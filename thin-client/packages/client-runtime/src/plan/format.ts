import type { MetricName, PrescribedMetricMap, SetType } from "@repcoach/contracts";

import { formatGhostText } from "../logging/grid.ts";
import { intervalToDisplay, type WeightUnit } from "../units/weight.ts";
import type { SetRun } from "./runs.ts";

/**
 * Rendering a run as the sentence a person would say it in — `4 × 5–8 reps
 * @ 80 kg` (#45: the run *is* the authoring unit, and it is tapped to
 * expand). The interval vocabulary is `formatGhostText`'s, unchanged, so the
 * Plan and the logging grid never disagree about what "8+" or "<=8 RPE"
 * means.
 */

/** Order is fixed so a run always reads the same way, whatever order the metrics were authored in. */
const METRIC_ORDER: ReadonlyArray<MetricName> = [
  "reps",
  "load",
  "duration",
  "distance",
  "rpe",
  "tempo",
] as const;

/**
 * Effort and tempo carry no unit here: `formatGhostText` already spells RPE
 * into the effort forms it produces ("<=8 RPE", "report effort"), and a
 * tempo target is written as its own notation.
 */
const METRIC_UNIT: Record<MetricName, string> = {
  reps: "reps",
  load: "kg",
  duration: "sec",
  distance: "m",
  rpe: "",
  tempo: "",
};

/** Human label for a Set type; `working` is the unmarked case and reads as nothing. */
const SET_TYPE_LABEL: Record<SetType, string> = {
  working: "",
  warmup: "warmup",
  drop: "drop",
  "myo-cluster": "myo-cluster",
  "rest-pause": "rest-pause",
};

/**
 * One metric's target with its unit. A load is stored in kg and converted
 * for display when `weightUnit` is `lb` — see `units/weight.ts`.
 */
export function formatMetricTarget(
  metric: MetricName,
  target: PrescribedMetricMap,
  weightUnit: WeightUnit = "kg",
): string {
  const interval = target[metric];
  const text = formatGhostText(
    metric,
    metric === "load" && interval !== undefined ? intervalToDisplay(interval, weightUnit) : interval,
  );
  const unit = metric === "load" ? weightUnit : METRIC_UNIT[metric];
  if (text === "" || unit === "") return text;
  return `${text} ${unit}`;
}

/**
 * `4 × 5–8 reps @ 80 kg`. `@` reads as "at this load", so it only precedes a
 * load; every other metric (a carry's distance, a plank's duration) takes a
 * separating dot. A run with no prescribed metric at all reads as
 * `4 × unprescribed` rather than an empty string — the Plan view marks that
 * state as caution ("cannot be run as written", #43), so it must be sayable.
 */
export function formatSetRun(run: SetRun, weightUnit: WeightUnit = "kg"): string {
  const present = METRIC_ORDER.filter((metric) => run.target[metric] !== undefined);
  const typeLabel = SET_TYPE_LABEL[run.setType];
  const prefix = typeLabel === "" ? `${run.count} ×` : `${run.count} × ${typeLabel}`;
  if (present.length === 0) {
    return `${prefix} unprescribed`;
  }
  const body = present
    .map((metric, index) => {
      const text = formatMetricTarget(metric, run.target, weightUnit);
      if (index === 0) return text;
      return `${metric === "load" ? "@" : "·"} ${text}`;
    })
    .join(" ");
  return `${prefix} ${body}`;
}

/** `2:00` — rest is authored and read in minutes and seconds, never raw seconds. */
export function formatRest(restSec: number | undefined): string {
  if (restSec === undefined) return "no rest";
  return `${Math.floor(restSec / 60)}:${String(restSec % 60).padStart(2, "0")}`;
}
