import type {
  MetricName,
  PrescribedMetricMap,
  PrescribedSet,
  PrescribedTargetInterval,
  SetId,
  SetType,
} from "@repcoach/contracts";

/**
 * Set **runs** — the Plan editor's authoring unit (#45): `4 × 5–8 reps @
 * 80 kg` is one statement with a count, not four rows.
 *
 * Runs are **derived, never stored**. A Prescribed Session holds an ordered
 * list of Sets, exactly like a Logged Session, because CONTEXT's `Session`
 * requires the same node types on both sides so prescribed-vs-actual is a
 * row-for-row alignment rather than a join. Storing groups would break that
 * alignment. So the editor coalesces consecutive Sets into runs on the way
 * in and expands runs back into Sets on the way out.
 *
 * Note the name: `logging/grid.ts` already exports `SetGroup`, meaning a
 * working Set plus its trailing drop/rest-pause/myo continuations. That is a
 * *different* concept — this one deliberately does not reuse the name.
 */

/** Every metric a prescribed target may carry, in a fixed order so comparisons and formatting are stable. */
const METRIC_ORDER: ReadonlyArray<MetricName> = [
  "reps",
  "load",
  "duration",
  "distance",
  "rpe",
  "tempo",
] as const;

/**
 * A run of consecutive identical Sets within one Entry. `setIds` are the
 * Sets it was coalesced from — carried so that re-expanding a run the user
 * only changed the *count* of reuses the existing Set ids instead of
 * churning them.
 */
export interface SetRun {
  readonly count: number;
  readonly setType: SetType;
  readonly target: PrescribedMetricMap;
  /** Prescription-only rest (CONTEXT `Set`) — absent means no rest timer. */
  readonly restSec?: number;
  readonly setIds: ReadonlyArray<SetId>;
}

const sameInterval = (
  a: PrescribedTargetInterval | undefined,
  b: PrescribedTargetInterval | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return a.min === b.min && a.max === b.max;
};

/** Two target maps are the same when every metric agrees — including which metrics are absent entirely. */
export function sameTarget(a: PrescribedMetricMap, b: PrescribedMetricMap): boolean {
  return METRIC_ORDER.every((metric) => sameInterval(a[metric], b[metric]));
}

/** A Set belongs to a run when its set type, rest and every target bound match the run's. */
const joinsRun = (run: SetRun, set: PrescribedSet): boolean =>
  run.setType === set.setType && run.restSec === set.restSec && sameTarget(run.target, set.target);

/**
 * Coalesces an Entry's ordered Sets into the runs the editor presents.
 * Adjacency is required: two identical runs separated by a different Set
 * stay two runs, because the Set order *is* the prescription (a ramp, a top
 * set and its backoff). Conversely two adjacent runs that become identical —
 * because the user edited one of them to match the other — merge into one,
 * which is the whole point of deriving rather than storing them.
 */
export function coalesceSetRuns(sets: ReadonlyArray<PrescribedSet>): ReadonlyArray<SetRun> {
  const runs: Array<SetRun> = [];
  for (const set of sets) {
    const previous = runs[runs.length - 1];
    if (previous !== undefined && joinsRun(previous, set)) {
      runs[runs.length - 1] = {
        ...previous,
        count: previous.count + 1,
        setIds: [...previous.setIds, set.id],
      };
      continue;
    }
    runs.push({
      count: 1,
      setType: set.setType,
      target: set.target,
      ...(set.restSec === undefined ? {} : { restSec: set.restSec }),
      setIds: [set.id],
    });
  }
  return runs;
}

/**
 * Expands runs back into the ordered Set list `replaceEntrySets` writes.
 * Existing `setIds` are reused positionally — shrinking a run drops the
 * trailing ids, growing it mints only the Sets that are genuinely new — so a
 * count edit does not renumber the Sets that did not change. `makeSetId` is
 * called exactly once per genuinely-new Set.
 */
export function expandSetRuns(
  runs: ReadonlyArray<SetRun>,
  makeSetId: () => SetId,
): ReadonlyArray<PrescribedSet> {
  const sets: Array<PrescribedSet> = [];
  for (const run of runs) {
    for (let index = 0; index < run.count; index++) {
      sets.push({
        id: run.setIds[index] ?? makeSetId(),
        setType: run.setType,
        target: run.target,
        ...(run.restSec === undefined ? {} : { restSec: run.restSec }),
      });
    }
  }
  return sets;
}

/**
 * The Entry-level "rest default for this exercise" control (ui-surfaces.md →
 * Plan): rest lives on the Set and nowhere else (CONTEXT `Set`), so the
 * affordance writes `restSec` across every Set of the Entry. `undefined`
 * clears it — "no rest at all", which is what suppresses the rest timer
 * during logging.
 */
export function withRestAcrossRuns(
  runs: ReadonlyArray<SetRun>,
  restSec: number | undefined,
): ReadonlyArray<SetRun> {
  return runs.map((run) => {
    const { restSec: _dropped, ...rest } = run;
    return restSec === undefined ? rest : { ...rest, restSec };
  });
}

/**
 * A run missing a target for a metric the exercise records cannot be run as
 * written — the same yellow the logging grid uses for a missed prescription
 * (`logging/deviation.ts`'s `isDeviated`). `metrics` is the catalog's
 * declared metrics for the Entry's exercise, not `deriveSetFields(run.target)`
 * — the whole point is to catch a metric the catalog expects but the run's
 * target is silent on.
 */
export function isRunIncomplete(run: SetRun, metrics: ReadonlyArray<MetricName>): boolean {
  return metrics.some((metric) => run.target[metric] === undefined);
}

/**
 * The Entry-level rest default's three-state summary (ui-surfaces.md →
 * Plan): "tracked" only when every run agrees on a defined `restSec`,
 * "not-tracked" when every run agrees on no rest at all, and "varies" when
 * the runs disagree — the header is a summary, not a source of truth, and
 * must say so honestly rather than pick one run's value to show.
 */
export type RunsRestSummary =
  | { readonly kind: "tracked"; readonly restSec: number }
  | { readonly kind: "not-tracked" }
  | { readonly kind: "varies" };

export function summarizeRunsRest(runs: ReadonlyArray<SetRun>): RunsRestSummary {
  const restSec = runs[0]?.restSec;
  if (!runs.every((run) => run.restSec === restSec)) {
    return { kind: "varies" };
  }
  return restSec === undefined ? { kind: "not-tracked" } : { kind: "tracked", restSec };
}
