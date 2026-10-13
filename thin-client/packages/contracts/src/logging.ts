import * as Schema from "effect/Schema";

import { CommandId, EntryId, ExerciseId, IsoDateTime, LoggedSessionId, SessionId, SetId } from "./baseSchemas.ts";
import { ActualMetricMap, PrescribedMetricMap, SetType } from "./metrics.ts";

/**
 * `logSetActual` — pure actual-capture (ADR 0006). This is **never** a
 * Change: it records what happened, keyed by a client-generated
 * `commandId` so the server can apply it exactly-once no matter how many
 * times the outbox (Task 4) replays it after a reconnect.
 *
 * `loggedSessionId` (Step 2A, task 2A.2) attaches the actual to the real
 * Logged Session copy created by `startSession` — `sessionId` (the
 * *prescribed* SessionId) is kept alongside it for backward-compat display
 * purposes, but `loggedSessionId` is the authoritative attachment point.
 */
export const LogSetActualInput = Schema.Struct({
  commandId: CommandId,
  loggedSessionId: LoggedSessionId,
  sessionId: SessionId,
  entryId: EntryId,
  setId: SetId,
  setType: SetType,
  actual: ActualMetricMap,
});
export type LogSetActualInput = typeof LogSetActualInput.Type;

/**
 * Result of applying (or re-applying) a `logSetActual` command. A replayed
 * `commandId` returns the *same* result rather than erroring or double
 * applying — this is the contract-level half of the idempotency guarantee
 * Task 2's server implements.
 */
export const LogSetActualResult = Schema.Struct({
  commandId: CommandId,
  loggedSessionId: LoggedSessionId,
  sessionId: SessionId,
  entryId: EntryId,
  setId: SetId,
  setType: SetType,
  actual: ActualMetricMap,
  appliedAt: IsoDateTime,
  /**
   * The retraction discriminator (ADR 0019, issue #83). Always `false` here —
   * a genuine `logSetActual` row is never a tombstone. Present so `actuals`
   * (`loggedSession.ts`) can carry logs and retractions in one ordered array
   * and the client fold can tell which is which without a second lookup.
   */
  retraction: Schema.Literal(false),
});
export type LogSetActualResult = typeof LogSetActualResult.Type;

export class LogSetActualRejectedError extends Schema.TaggedErrorClass<LogSetActualRejectedError>()(
  "LogSetActualRejectedError",
  {
    commandId: CommandId,
    sessionId: SessionId,
    entryId: EntryId,
    setId: SetId,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `logSetActual rejected for commandId ${this.commandId}: ${this.reason}`;
  }
}

/**
 * `unlogSetActual` — a retraction (ADR 0019, issue #83): "this Set was not
 * performed after all", appended as its own row rather than deleting or
 * mutating the `logSetActual` row it retracts. No metric map — a retraction
 * carries no measurement of what happened, because nothing did. Idempotent
 * by client-minted `commandId`, exactly like `logSetActual`: a retraction
 * claims its own `commandId` permanently, which is what keeps a replayed
 * *original* `logSetActual` from resurrecting the Set (see the ADR's replay
 * argument — this is why a delete was rejected in favor of a tombstone).
 */
export const UnlogSetActualInput = Schema.Struct({
  commandId: CommandId,
  loggedSessionId: LoggedSessionId,
  entryId: EntryId,
  setId: SetId,
});
export type UnlogSetActualInput = typeof UnlogSetActualInput.Type;

/**
 * Result of applying (or re-applying) an `unlogSetActual` command. Shaped to
 * slot into `LoggedSession.actuals` alongside `LogSetActualResult` — the
 * client fold treats `actuals` as one ordered stream and the last row per
 * `setId` wins, so a retraction's result carries the same identity fields
 * (`entryId`/`setId`) and the same `retraction` discriminator, just pinned
 * to `true` instead of `false`.
 */
export const UnlogSetActualResult = Schema.Struct({
  commandId: CommandId,
  loggedSessionId: LoggedSessionId,
  entryId: EntryId,
  setId: SetId,
  appliedAt: IsoDateTime,
  retraction: Schema.Literal(true),
});
export type UnlogSetActualResult = typeof UnlogSetActualResult.Type;

/**
 * `swapEntryExercise` — recording that an Entry's Sets were actually
 * performed against a different Exercise than the prescribed one (ADR 0019,
 * CONTEXT `Swap`). A **pure actual-side annotation**, exactly like
 * `logSetActual`: it never overwrites the Logged Session's frozen
 * `entry.exerciseId` (ADR 0006/0007's copy-on-instantiate guarantee), so the
 * prescribed exercise stays legible forever. `entryId`/`exerciseId` are
 * carried **by value**, with no lookup against the prescribed tree — the
 * same discipline ADR 0017 established for `logSetActual`.
 *
 * Idempotent by client-minted `commandId`, identically to `logSetActual`: a
 * replayed `commandId` returns the row the first attempt wrote.
 */
export const SwapEntryExerciseInput = Schema.Struct({
  commandId: CommandId,
  loggedSessionId: LoggedSessionId,
  entryId: EntryId,
  exerciseId: ExerciseId,
});
export type SwapEntryExerciseInput = typeof SwapEntryExerciseInput.Type;

export const SwapEntryExerciseResult = Schema.Struct({
  commandId: CommandId,
  loggedSessionId: LoggedSessionId,
  entryId: EntryId,
  exerciseId: ExerciseId,
  swappedAt: IsoDateTime,
});
export type SwapEntryExerciseResult = typeof SwapEntryExerciseResult.Type;

/**
 * A swap is offered only while an Entry has zero logged Sets (ADR 0019, the
 * cheapest defensible answer to "what happens to already-logged Sets").
 * `Logging.canSwapEntry` is the client-side half of this guard — this is the
 * server-side half, for the race an offline outbox replay can create: a
 * queued swap and a queued `logSetActual` for the same Entry can reorder
 * relative to what the user's taps suggested happened.
 */
export class EntryAlreadyLoggedError extends Schema.TaggedErrorClass<EntryAlreadyLoggedError>()(
  "EntryAlreadyLoggedError",
  {
    commandId: CommandId,
    loggedSessionId: LoggedSessionId,
    entryId: EntryId,
  },
) {
  override get message(): string {
    return `Entry ${this.entryId} already has a logged Set and cannot be swapped`;
  }
}

/**
 * `lastActualForExercise` — the tier-2 seed source (issue #149). Answers
 * exactly one question: **the most recent actual the user logged for each
 * metric, the last time this Exercise was performed**, across *finished*
 * Logged Sessions.
 *
 * Deliberately narrow — this is not a history query and must not grow into
 * one:
 *
 * - **No dates, one session.** Just "what did you last do": one value per
 *   metric for the seed, and that same last session Set by Set (`sets`, UAT)
 *   so each row in Logging can suggest its own counterpart rather than the
 *   plan's range. Never a second session, never a trend.
 * - **Swap-aware (ADR 0019).** Keyed on the exercise an Entry was actually
 *   *performed* against — the recorded swap when there is one, the frozen
 *   prescribed `exerciseId` otherwise — never the prescribed copy blindly, so
 *   a squat load never seeds onto a leg press.
 * - **Finished sessions only.** An in-flight session's own earlier Sets are
 *   tier 1's job (`seedFromPreviousSet`, client-side, offline); this is the
 *   across-session read tier 1's doc always named and never had.
 * - **Catalog-bounded.** Only metrics the Exercise's catalog row tracks are
 *   returned (`trackedMetrics`, CONTEXT `Exercise catalog`).
 *
 * No error channel, exactly like `listSessions` / `getDailySetCounts`: an
 * Exercise never performed before is not a failure, it is `perMetric: {}`.
 */
export const LastActualForExerciseInput = Schema.Struct({
  exerciseId: ExerciseId,
});
export type LastActualForExerciseInput = typeof LastActualForExerciseInput.Type;

export const LastActualForExerciseResult = Schema.Struct({
  exerciseId: ExerciseId,
  /**
   * Most recent logged value per metric, folded to net state (a Set logged
   * then retracted does not count) and constrained to the Exercise's tracked
   * metrics. Empty when the Exercise has never been performed to completion.
   */
  perMetric: ActualMetricMap,
  /**
   * The last finished session that performed this Exercise, Set by Set in
   * the order the Sets sat on the Entry (UAT): what Logging suggests for
   * each row. Net state and catalog-bounded like `perMetric`; empty when the
   * Exercise has never been performed.
   */
  sets: Schema.Array(
    Schema.Struct({
      setType: SetType,
      actual: ActualMetricMap,
      /**
       * What the Set was prescribed that day (the frozen snapshot's target);
       * absent for a Set the snapshot never held. Logging shows the plan's
       * number instead of last time's for any metric whose prescription has
       * moved since — an accepted Proposal, chiefly.
       */
      target: Schema.optionalKey(PrescribedMetricMap),
    }),
  ),
  /**
   * The best estimated one-rep max (`estimateOneRepMax`) of any non-warmup
   * Set ever performed on this Exercise across finished sessions — the bar a
   * Set logged now must clear for Logging to mark it a PR. Absent when no
   * finished Set had both a load and 1–12 reps.
   */
  bestE1rm: Schema.optionalKey(Schema.Number),
});
export type LastActualForExerciseResult = typeof LastActualForExerciseResult.Type;

/**
 * Net-state fold (ADR 0019, issue #83) — the single definition of "which Sets
 * on this stream are still logged". `rows` is one ordered stream of logs and
 * retractions in application order; the last row per `setId` wins, and a
 * retraction in that position drops the Set. `log -> un-log -> log` and
 * `log -> log -> un-log` differ only by this fold.
 *
 * This is the shared primitive both halves of the swap guard must agree on.
 * `Logging.canSwapEntry` runs over the client's already-folded actuals;
 * `foldServerActuals` (web client) is built on this; and the server's
 * `swapEntryExercise` guard must ask the identical question rather than
 * counting raw `logged_set_actual` rows — a retraction is a row in that table
 * too (migration `021`), so a naive `COUNT(*)` refuses a swap forever after a
 * Set was logged then un-logged. The in-memory Store calls this directly; the
 * SqlStore expresses it in SQL and is pinned to this function by test.
 */
export function foldNetActuals<T extends { readonly setId: SetId; readonly retraction: boolean }>(
  rows: Iterable<T>,
): ReadonlyMap<SetId, T> {
  const net = new Map<SetId, T>();
  for (const row of rows) {
    if (row.retraction) net.delete(row.setId);
    else net.set(row.setId, row);
  }
  return net;
}
