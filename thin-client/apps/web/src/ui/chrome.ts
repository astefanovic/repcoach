import { Units } from "@repcoach/client-runtime";
import type { CatalogExercise, MetricName } from "@repcoach/contracts";

/**
 * The chrome's own vocabulary (#42), lifted out of the prototype's fixture
 * file so that nothing on screen imports fixtures any more (#72).
 *
 * `StripState` is the whole of it: one line, always present, neutral by
 * default, yellow on exception, red on a hard failure, and green only as a
 * temporal flash. `runtime/statusStrip.ts` produces it from the live supervisor
 * and outbox; the shell renders it.
 *
 * **The never-red rule, amended (issue #111).** #42 capped the strip at
 * caution, and the reasoning still holds for everything it was aimed at: being
 * offline mid-gym is expected, not a failure, and a strip that shouts at an
 * expected state teaches the user to stop reading it. What that rule had no
 * case for is a state where the app is not degraded but **broken** — a client
 * whose bundle cannot decode what its server sends, or a coach that failed to
 * think. Those were indistinguishable from "offline" at a glance, and the cost
 * of that was an Intake failing five times in a row, in yellow, while the user
 * paid for every attempt.
 *
 * So `error` exists and is spent only there. Yellow keeps its meaning — this is
 * expected and it will resolve — and red now means: this will not resolve on
 * its own, and continuing costs you something.
 */
export type StripState =
  | { readonly tone: "neutral"; readonly text: string }
  | { readonly tone: "caution"; readonly text: string }
  | { readonly tone: "error"; readonly text: string }
  | { readonly tone: "flash"; readonly text: string };

/** `2:00` — a countdown, or a prescribed rest, said the way a clock says it. */
export function mmss(totalSec: number): string {
  const whole = Math.max(0, Math.round(totalSec));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** `3 sets` / `1 set` — pluralisation, which every surface needs and none should restate. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Per-metric **presentation**: the unit that follows the number, the width
 * that keeps a column of set rows reading as a column, and the increment a
 * stepper moves by.
 *
 * One table, shared by the surface that runs a prescription and the one that
 * authors it — a load that steps by 2.5 kg while logging and by 1 kg while
 * editing would be the same bug in two places.
 *
 * Presentation only, deliberately. *Which* metrics appear is a catalog fact
 * (`deriveSetFields`); how a prescribed one reads is `formatGhostText`.
 * Neither is restated here.
 */
export const METRIC_UI: Record<
  MetricName,
  { readonly unit: string; readonly width: string; readonly step: number }
> = {
  reps: { unit: "reps", width: "w-[4.5rem]", step: 1 },
  load: { unit: "kg", width: "w-[5rem]", step: 2.5 },
  duration: { unit: "sec", width: "w-[5rem]", step: 5 },
  distance: { unit: "m", width: "w-[5rem]", step: 5 },
  rpe: { unit: "rpe", width: "w-[4.5rem]", step: 0.5 },
  tempo: { unit: "tempo", width: "w-[5rem]", step: 1 },
};

/**
 * `METRIC_UI` with the load row in the device's display unit (kg / lb). A
 * load's unit and stepper size are the only presentation that changes with
 * the setting; the stored value never does (`Units` in client-runtime).
 */
export function metricUi(
  metric: MetricName,
  weightUnit: Units.WeightUnit,
): { readonly unit: string; readonly width: string; readonly step: number } {
  const spec = METRIC_UI[metric];
  if (metric !== "load") return spec;
  return { ...spec, unit: weightUnit, step: Units.loadStep(weightUnit) };
}

/**
 * An Exercise's display name.
 *
 * The catalog is the authority — a name is coach-authored data (CONTEXT
 * `Exercise catalog`), not something a client derives. De-slugging the id is
 * a **fallback for a catalog that has not loaded or does not carry the row**,
 * and it is a fallback rather than the rule precisely because a fabricated
 * name is indistinguishable on screen from a real one.
 */
export function exerciseName(
  catalog: ReadonlyArray<CatalogExercise>,
  exerciseId: string,
): string {
  const known = catalog.find((exercise) => exercise.id === exerciseId);
  if (known !== undefined) return known.name;
  return exerciseId
    .replace(/^exercise-/, "")
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
