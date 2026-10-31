import {
  estimateOneRepMax,
  type ActualMetricMap,
  type ExerciseProgress,
  type LogSetActualResult,
  type MetricName,
  type PrescribedMetricMap,
  type PrescribedSession,
  type SetType,
  type UnlogSetActualResult,
} from "@repcoach/contracts";

/**
 * Net-state fold, local copy of `store.ts`'s `netLoggedActuals` rule (last
 * row per Set wins, a retraction drops it) — inlined here rather than
 * imported so this leaf helper carries no dependency back on the `Store`
 * module.
 *
 * `actuals` is taken to be in **ascending applied order** (both `Store`
 * layers hand it over that way — the in-memory one sorts by `appliedAt`, the
 * SQL one by `applied_at, id`). Two `logSetActual` calls in the same
 * millisecond are common, so `appliedAt` alone is not a safe tiebreaker;
 * input position is. The surviving rows come back in that same ascending
 * order, so the caller reads the *last* one as "most recent".
 */
function netLoggedRows(
  actuals: ReadonlyArray<LogSetActualResult | UnlogSetActualResult>,
): ReadonlyArray<LogSetActualResult> {
  const bySetId = new Map<string, LogSetActualResult | UnlogSetActualResult>();
  for (const actual of actuals) {
    // delete-then-set so the key moves to the end — the Map ends up in
    // order of each Set's *latest* row, not its first.
    bySetId.delete(actual.setId);
    bySetId.set(actual.setId, actual);
  }
  return Array.from(bySetId.values()).filter(
    (actual): actual is LogSetActualResult => !actual.retraction,
  );
}

/**
 * One finished Logged Session, in the shape `resolveLastActualForExercise`
 * reads — the same three disjoint sources `getLoggedSession` already returns
 * (ADR 0019): the frozen prescribed `snapshot`, the ordered
 * log/retraction stream, and the recorded swaps. Both `Store` layers build
 * this from what they already have on hand, so the resolution rule itself
 * lives in exactly one place.
 */
export interface FinishedSessionView {
  readonly loggedSessionId: string;
  /** For newest-first ordering. `finishedAt` is always set for a finished row; `startedAt` is the tiebreaker. */
  readonly finishedAt: string | undefined;
  readonly startedAt: string;
  readonly snapshot: PrescribedSession;
  readonly actuals: ReadonlyArray<LogSetActualResult | UnlogSetActualResult>;
  readonly swaps: ReadonlyArray<{
    readonly entryId: string;
    readonly exerciseId: string;
    readonly swappedAt: string;
  }>;
}

const ALL_METRICS: ReadonlyArray<MetricName> = ["reps", "load", "duration", "distance", "rpe", "tempo"];

/**
 * Tier 2 of the one-tap ✓ seed (issue #149): the most recent actual per
 * metric, the last time this Exercise was **performed** — across finished
 * Logged Sessions.
 *
 * - **Swap-aware.** An Entry's performed exercise is its most recent recorded
 *   swap's `exerciseId` (ADR 0019), or its frozen prescribed `exerciseId`
 *   when it was never swapped. A prescribed squat performed as a leg press
 *   contributes to the leg press's history, not the squat's.
 * - **Net state.** `netLoggedActuals` folds the log/retraction stream first,
 *   so a mis-tapped log-then-retract never seeds a phantom number.
 * - **Newest wins.** Sessions are walked newest-first (`finishedAt`, then
 *   `startedAt`); within a session, later-applied Sets are read first (input
 *   order, since same-millisecond logs make `appliedAt` an unsafe
 *   tiebreaker). The first value seen for a metric is kept, never overwritten.
 * - **Catalog-bounded.** When `trackedMetrics` is given, a metric outside it
 *   is dropped from the result even if some older row carried it.
 */
export function resolveLastActualForExercise(
  sessions: ReadonlyArray<FinishedSessionView>,
  exerciseId: string,
  trackedMetrics: ReadonlyArray<MetricName> | undefined,
): ActualMetricMap {
  const allowed = allowedMetrics(trackedMetrics);
  const result: Record<string, number> = {};

  for (const session of newestFirst(sessions)) {
    // `performedRows` keeps ascending applied order; reverse it so the most
    // recently performed Set is read first.
    const net = performedRows(session, exerciseId)
      .slice()
      .sort((a, b) => b.appliedIndex - a.appliedIndex);

    for (const { row } of net) {
      for (const metric of ALL_METRICS) {
        if (!allowed.has(metric)) continue;
        if (result[metric] !== undefined) continue;
        const value = row.actual[metric];
        if (value !== undefined) result[metric] = value;
      }
    }
  }

  return result as ActualMetricMap;
}

/** One Set as it was lifted, for `resolveLastSetsForExercise`. */
export interface LastSetActual {
  readonly setType: SetType;
  readonly actual: ActualMetricMap;
  /**
   * What the Set was prescribed that day, from the frozen snapshot; absent
   * for a Set the snapshot never held. Logging compares it with today's
   * prescription, so a number the plan has moved since (an accepted
   * Proposal) shows the plan's new value instead of last time's.
   */
  readonly target?: PrescribedMetricMap;
}

/**
 * What was lifted Set by Set the last time this Exercise was performed (UAT):
 * the most recent finished session with at least one net-logged Set on it,
 * in the order those Sets sat on the Entry. Each row in Logging suggests its
 * counterpart from this list instead of the plan's range.
 *
 * Entry order rather than log order, because a Set corrected after the next
 * one was logged moves to the end of the log but is still set 1. Prescribed
 * Sets come in the frozen snapshot's order; Sets the snapshot never held
 * (an unplanned Set, ADR 0017, or an exercise added mid-workout) follow,
 * in the order they were logged.
 *
 * Same swap-awareness, net state and catalog bound as
 * `resolveLastActualForExercise`. Empty when the Exercise was never
 * performed.
 */
export function resolveLastSetsForExercise(
  sessions: ReadonlyArray<FinishedSessionView>,
  exerciseId: string,
  trackedMetrics: ReadonlyArray<MetricName> | undefined,
): ReadonlyArray<LastSetActual> {
  const allowed = allowedMetrics(trackedMetrics);
  for (const session of newestFirst(sessions)) {
    const rows = performedRows(session, exerciseId);
    if (rows.length === 0) continue;
    return rows
      .slice()
      .sort(
        (a, b) =>
          a.entryRank - b.entryRank || a.setRank - b.setRank || a.appliedIndex - b.appliedIndex,
      )
      .map(({ row, target }) => ({
        setType: row.setType,
        actual: Object.fromEntries(
          Object.entries(row.actual).filter(([metric]) => allowed.has(metric as MetricName)),
        ) as ActualMetricMap,
        ...(target === undefined ? {} : { target }),
      }));
  }
  return [];
}

/**
 * The best e1RM (`estimateOneRepMax`) any non-warmup Set on `exerciseId`
 * reached across these finished sessions — the bar Logging's PR badge
 * measures a new Set against. `undefined` when no Set had a load and 1–12
 * reps. Same swap-awareness and net state as everything else here.
 */
export function resolveBestE1rm(
  sessions: ReadonlyArray<FinishedSessionView>,
  exerciseId: string,
): number | undefined {
  let best: number | undefined;
  for (const session of sessions) {
    for (const { row } of performedRows(session, exerciseId)) {
      if (row.setType === "warmup") continue;
      const e1rm = estimateOneRepMax(row.actual.load, row.actual.reps);
      if (e1rm !== undefined && (best === undefined || e1rm > best)) best = e1rm;
    }
  }
  return best;
}

/**
 * The Progress surface's read (`GetExerciseProgressResult`): per performed
 * Exercise, every finished session that performed it, oldest first, with its
 * net-logged Sets' load and reps in Entry order. An Exercise appears once it
 * has a single net-logged Set on a finished session.
 */
export function resolveExerciseProgress(
  sessions: ReadonlyArray<FinishedSessionView>,
): ReadonlyArray<ExerciseProgress> {
  const byExercise = new Map<string, Array<ExerciseProgress["sessions"][number]>>();
  for (const session of [...newestFirst(sessions)].reverse()) {
    const rows = allPerformedRows(session);
    const perExercise = new Map<string, Array<PerformedRow>>();
    for (const row of rows) {
      if (row.exerciseId === undefined) continue;
      const list = perExercise.get(row.exerciseId) ?? [];
      list.push(row);
      perExercise.set(row.exerciseId, list);
    }
    for (const [exerciseId, list] of perExercise) {
      const sets = list
        .slice()
        .sort(
          (a, b) =>
            a.entryRank - b.entryRank || a.setRank - b.setRank || a.appliedIndex - b.appliedIndex,
        )
        .map(({ row }) => ({
          setType: row.setType,
          ...(row.actual.load !== undefined ? { load: row.actual.load } : {}),
          ...(row.actual.reps !== undefined ? { reps: row.actual.reps } : {}),
        }));
      const history = byExercise.get(exerciseId) ?? [];
      history.push({
        loggedSessionId: session.loggedSessionId as never,
        performedAt: session.finishedAt ?? session.startedAt,
        sets,
      });
      byExercise.set(exerciseId, history);
    }
  }
  return Array.from(byExercise, ([exerciseId, history]) => ({
    exerciseId: exerciseId as never,
    sessions: history,
  }));
}

/**
 * The metrics a result may carry. An empty `trackedMetrics` is a catalog row
 * nobody has described yet (a user-authored name, ADR 0016, enriched later by
 * the coach), so it means "unknown", not "tracks nothing": reading it as the
 * latter dropped every number logged against a freshly added exercise.
 */
function allowedMetrics(trackedMetrics: ReadonlyArray<MetricName> | undefined): ReadonlySet<MetricName> {
  return new Set<MetricName>(
    trackedMetrics === undefined || trackedMetrics.length === 0 ? ALL_METRICS : trackedMetrics,
  );
}

function newestFirst(sessions: ReadonlyArray<FinishedSessionView>): ReadonlyArray<FinishedSessionView> {
  return [...sessions].sort((a, b) => {
    const byFinished = (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "");
    return byFinished !== 0 ? byFinished : b.startedAt.localeCompare(a.startedAt);
  });
}

interface PerformedRow {
  readonly row: LogSetActualResult;
  /** The exercise this Set was performed on — the Entry's latest swap, else its prescribed exercise. */
  readonly exerciseId: string | undefined;
  /** Position in ascending applied order — the tiebreaker `appliedAt` cannot be. */
  readonly appliedIndex: number;
  /** The Entry's position in the snapshot; an Entry the snapshot does not hold sorts last. */
  readonly entryRank: number;
  /** The Set's position in the snapshot; a Set the snapshot does not hold sorts after its Entry's prescribed Sets. */
  readonly setRank: number;
  /** The Set's prescribed target in the snapshot, when the snapshot holds it. */
  readonly target: PrescribedMetricMap | undefined;
}

/**
 * The net-logged Sets of one session that were performed on `exerciseId`.
 *
 * Which Entry a Set belongs to is read from the snapshot when the snapshot
 * holds the Set, and from the row's own `entryId` when it does not: an
 * unplanned Set (ADR 0017) and every Set of an exercise added mid-workout
 * exist only as actuals. An added exercise is an Entry the snapshot does not
 * hold whose performed exercise is recorded as a swap (ADR 0019), so the
 * swap map below already names it.
 */
function performedRows(session: FinishedSessionView, exerciseId: string): ReadonlyArray<PerformedRow> {
  return allPerformedRows(session).filter((row) => row.exerciseId === exerciseId);
}

/** Every net-logged Set of one session, each tagged with the exercise it was performed on. */
function allPerformedRows(session: FinishedSessionView): ReadonlyArray<PerformedRow> {
  // Performed exercise per Entry id: latest swap (by `swappedAt`) wins.
  const performedByEntry = new Map<string, string>();
  const entries = entriesOf(session.snapshot);
  for (const entry of entries) {
    performedByEntry.set(entry.id, entry.exerciseId);
  }
  for (const swap of [...session.swaps].sort((a, b) => a.swappedAt.localeCompare(b.swappedAt))) {
    performedByEntry.set(swap.entryId, swap.exerciseId);
  }

  const entryRank = new Map(entries.map((entry, index) => [entry.id, index]));
  const prescribedSet = new Map<
    string,
    { readonly entryId: string; readonly rank: number; readonly target: PrescribedMetricMap }
  >();
  let rank = 0;
  for (const entry of entries) {
    for (const set of entry.sets) {
      prescribedSet.set(set.id, { entryId: entry.id, rank: rank++, target: set.target });
    }
  }

  const rows: Array<PerformedRow> = [];
  netLoggedRows(session.actuals).forEach((row, appliedIndex) => {
    const prescribed = prescribedSet.get(row.setId);
    const entryId = prescribed?.entryId ?? row.entryId;
    rows.push({
      row,
      exerciseId: performedByEntry.get(entryId),
      appliedIndex,
      entryRank: entryRank.get(entryId) ?? Number.MAX_SAFE_INTEGER,
      setRank: prescribed?.rank ?? Number.MAX_SAFE_INTEGER,
      target: prescribed?.target,
    });
  });
  return rows;
}

interface EntryView {
  readonly id: string;
  readonly exerciseId: string;
  readonly sets: ReadonlyArray<{ readonly id: string; readonly target: PrescribedMetricMap }>;
}

function entriesOf(session: PrescribedSession): ReadonlyArray<EntryView> {
  return session.blocks.flatMap((block) => block.entries as ReadonlyArray<EntryView>);
}
