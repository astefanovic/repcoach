import type {
  IntakeDraftEntry,
  IntakeDraftPlan,
  IntakeDraftSession,
  IntakeDraftSet,
  PrescribedMetricMap,
  SetType,
} from "@repcoach/contracts";

import { formatSetRun } from "../plan/format.ts";
import type { WeightUnit } from "../units/weight.ts";
import { sameTarget } from "../plan/runs.ts";

/**
 * Reading a drafted Plan as lines (#74). The prototype hand-wrote the hero's
 * session bodies as prose strings; the real `IntakeDraftPlan` carries
 * `PrescribedMetricMap` targets over the six tracked metrics, so turning a
 * plank or a loaded carry into a sentence is now a derivation — and it uses
 * `plan/format.ts`'s vocabulary unchanged, so the drafted plan, the Plan view
 * and the logging grid never disagree about what "8+" or "<=8 RPE" means.
 */

/** A run of consecutive identical drafted Sets — the same coalescing the Plan editor does, minus Set ids (a draft has none). */
interface DraftSetRun {
  readonly count: number;
  readonly setType: SetType;
  readonly target: PrescribedMetricMap;
  readonly restSec?: number;
}

function coalesceDraftSets(sets: ReadonlyArray<IntakeDraftSet>): ReadonlyArray<DraftSetRun> {
  const runs: Array<DraftSetRun> = [];
  for (const set of sets) {
    const previous = runs[runs.length - 1];
    if (
      previous !== undefined &&
      previous.setType === set.setType &&
      previous.restSec === set.restSec &&
      sameTarget(previous.target, set.target)
    ) {
      runs[runs.length - 1] = { ...previous, count: previous.count + 1 };
      continue;
    }
    runs.push({
      count: 1,
      setType: set.setType,
      target: set.target,
      ...(set.restSec === undefined ? {} : { restSec: set.restSec }),
    });
  }
  return runs;
}

/**
 * A drafted Entry's Sets, without the exercise name: `1 × 4–6 reps, 3 × 6–10
 * reps`. An Entry with no Sets at all is *stated* rather than rendered blank —
 * a draft the coach left empty is a thing the user must be able to see and
 * argue with.
 */
export function formatDraftSets(entry: IntakeDraftEntry, weightUnit: WeightUnit = "kg"): string {
  const runs = coalesceDraftSets(entry.sets);
  if (runs.length === 0) {
    return "no sets drafted";
  }
  return runs
    .map((run) =>
      formatSetRun({ count: run.count, setType: run.setType, target: run.target, setIds: [] }, weightUnit),
    )
    .join(", ");
}

/** One drafted Entry as a line: `DB bench 1 × 4–6 reps, 3 × 6–10 reps`. */
export function formatDraftEntry(entry: IntakeDraftEntry, weightUnit: WeightUnit = "kg"): string {
  return `${entry.exerciseName} ${formatDraftSets(entry, weightUnit)}`;
}

/** A drafted Session's body: its Entries, in order, separated the way the hero reads them. */
export function formatDraftSession(session: IntakeDraftSession, weightUnit: WeightUnit = "kg"): string {
  if (session.entries.length === 0) {
    return "no exercises drafted";
  }
  return session.entries.map((entry) => formatDraftEntry(entry, weightUnit)).join(" · ");
}

/** The hero's session rows, ready to render. */
export interface DraftSessionLine {
  readonly label: string;
  readonly body: string;
}

export function draftSessionLines(
  plan: IntakeDraftPlan,
  weightUnit: WeightUnit = "kg",
): ReadonlyArray<DraftSessionLine> {
  return plan.sessions.map((session) => ({
    label: session.label,
    body: formatDraftSession(session, weightUnit),
  }));
}
