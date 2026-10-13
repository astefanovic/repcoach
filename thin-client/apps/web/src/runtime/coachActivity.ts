import type { DeliberationRunOutcome } from "@repcoach/contracts";

/**
 * Whether the Coach glyph carries an **activity pip** — a dot meaning "a
 * Deliberation run has happened that you have not looked at yet" (issue #150,
 * from UAT: *"notification pip for coach when a new / in-progress activity"*).
 *
 * This is a different claim from the numeric badge next to it. The badge
 * (`usePendingProposalCount`) counts **decisions you owe an answer to** and is
 * settled not to nag about anything else (#42 user story 36: a count "without
 * being nagged about observations"). The pip is the nag that story ruled out —
 * re-introduced deliberately and narrowly, because a coach whose work is
 * invisible is a coach you stop checking, which is the same argument that made
 * `/coach` a record of *runs* rather than of Decisions (ADR 0021).
 *
 * ## What lights it, and what does not
 *
 * - **A run that has SETTLED** — `committed` or `failed` — with a timestamp
 *   newer than the last time you opened `/coach`. A failed run counts: it
 *   otherwise survives only as a line of strip text that is gone the moment
 *   you look away.
 * - **A run in flight does NOT.** "Running" is the status strip's job (ADR
 *   0011 §8, `useDeliberationActivity`), and a pip plus a strip line plus the
 *   green landing flash for one event is more chrome than the event is worth.
 *   The pip is strictly about output you have not read.
 * - **New pending Proposals do NOT.** Those are what the numeric badge is for.
 *   A settled run that emitted a Proposal lights the pip *because it is a
 *   settled run*, not because of the Proposal.
 *
 * ## Reconnect replay
 *
 * The caller feeds this the run list from `useDeliberationRuns`, which
 * accumulates by `runId` and replays the full set on every reconnect. So the
 * predicate is a pure fold over current state: a replay re-emits the same runs
 * and the answer does not move, and a run that opened `running` before a dead
 * spot and closed `committed` after it flips the pip on exactly once the
 * closing emission lands. A failed subscription leaves the last run list in
 * place (same posture as the badge), so a dead spot never clears a pip that
 * should be lit or lights one that should not.
 */
export interface CoachActivityRun {
  readonly runId: string;
  readonly outcome: DeliberationRunOutcome;
  readonly startedAt: string;
  readonly finishedAt?: string | undefined;
}

/** When a run is considered to have happened, for the "newer than last seen"
 *  comparison: when it finished if it has, else when it started. */
export function runSettledAt(run: CoachActivityRun): string {
  return run.finishedAt ?? run.startedAt;
}

export interface CoachActivityInput {
  /** The accumulated-by-id run list, newest-first or not — order does not
   *  matter to the predicate. */
  readonly runs: ReadonlyArray<CoachActivityRun>;
  /**
   * ISO-8601 timestamp of the last time `/coach` was opened on this device,
   * or `undefined` if it never has been. Never-opened means every settled run
   * is unseen, which is the honest reading — there genuinely is output you
   * have not looked at.
   */
  readonly lastSeenAt: string | undefined;
}

/** ISO-8601 UTC timestamps compare lexicographically; every timestamp on a run
 *  is `new Date().toISOString()` server-side, so `>` is a real "is newer". */
export function coachHasUnseenActivity(input: CoachActivityInput): boolean {
  const seen = input.lastSeenAt ?? "";
  return input.runs.some(
    (run) => run.outcome !== "running" && runSettledAt(run) > seen,
  );
}

/**
 * The timestamp to record as "seen" when `/coach` is opened: the newest
 * settled run currently on screen, so opening the record marks exactly what
 * you could have read and a strictly newer run re-lights the pip. Falls back
 * to `now` when there are no settled runs yet, so the marker is always moving
 * forward.
 */
export function seenThrough(
  runs: ReadonlyArray<CoachActivityRun>,
  now: string,
): string {
  let newest = "";
  for (const run of runs) {
    if (run.outcome === "running") continue;
    const at = runSettledAt(run);
    if (at > newest) newest = at;
  }
  return newest > now ? newest : now;
}
