import type { DeliberationRunRecord } from "@repcoach/contracts";

/**
 * One node on the Coach rail: a run, or a streak of runs that all failed the
 * same way.
 *
 * The Session-review drain retries a failed review every poll tick (#132), so
 * one cause that outlives a tick — an expired login is the one that happened —
 * writes a fresh "Failed" node every fifteen minutes until it is fixed. A
 * morning of that buried the reviews that did run under a column of identical
 * red lines, each one telling the user nothing the first had not.
 *
 * So a streak folds into its newest run, carrying how many attempts it stands
 * for and when the first one was. Only **consecutive** runs fold: a success in
 * between means the cause went away and came back, which is two incidents, and
 * the rail is a timeline — merging across it would put a failure above a run
 * that actually happened after it. Same cadence as well as same reason,
 * because a Cycle review failing for the same reason is a different review
 * owed, not another attempt at this one.
 */
export interface RunGroup {
  /** The newest run in the streak — the one the node shows. */
  readonly run: DeliberationRunRecord;
  /** Every run the node stands for, newest first. Length 1 for an ordinary run. */
  readonly attempts: ReadonlyArray<DeliberationRunRecord>;
}

const sameFailure = (a: DeliberationRunRecord, b: DeliberationRunRecord): boolean =>
  a.outcome === "failed" &&
  b.outcome === "failed" &&
  a.cadence === b.cadence &&
  a.failureReason === b.failureReason;

/** Folds consecutive identical failures in a newest-first run list. */
export const groupRuns = (runs: ReadonlyArray<DeliberationRunRecord>): ReadonlyArray<RunGroup> => {
  const groups: Array<{ run: DeliberationRunRecord; attempts: Array<DeliberationRunRecord> }> = [];
  for (const run of runs) {
    const last = groups.at(-1);
    if (last !== undefined && sameFailure(last.run, run)) last.attempts.push(run);
    else groups.push({ run, attempts: [run] });
  }
  return groups;
};
