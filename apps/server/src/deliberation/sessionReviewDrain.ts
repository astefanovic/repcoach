import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DeliberationRunner } from "./deliberationRunner.ts";

/**
 * The Session-review drain schedule (issue #132) — the half that makes a lost
 * review *recoverable* rather than merely *detectable*.
 *
 * `finishWorkout` already nudges the drain the moment a workout ends, so in the
 * happy path this schedule does nothing. It exists for the three ways that
 * nudge can fail to produce a review, all of which happened:
 *
 * - **The run failed.** The session stays `pending`; the next tick retries it.
 *   Before this existed, a failed run was terminal — `finishWorkout`'s
 *   `transitioned` guard made every retry a silent no-op, and three sessions
 *   went unreviewed for ten days with no path to recovery.
 * - **The run was deferred on low quota and the server restarted.** The
 *   runner's `deferralQueue` is in-memory (`Queue.unbounded`), so a restart
 *   dropped the queued review with the session already `finished`. The row
 *   outlives the queue.
 * - **The server was never up to receive the nudge**, or died between the
 *   status flip and the fork.
 *
 * **Why a poll over a retry-on-failure.** Same argument migration `011` makes
 * for the Cycle-review schedule: a home server reboots, and in-process retry
 * state does not survive a reboot. Deriving the work list from durable rows on
 * every tick means the recovery path is identical whether the previous attempt
 * failed a second ago or the process was killed mid-run — there is only one
 * mechanism to get right.
 *
 * **Why it cannot double-review.** Three guards, and each covers a different
 * race. The loop AWAITS `reviewPendingSessions` before sleeping, so a slow
 * backlog cannot have a second tick started underneath it. The runner's
 * in-memory claim set stops a tick and a concurrent `finishWorkout` nudge from
 * both taking the same session. And `markSessionReviewed` runs only after a
 * committed run, so the row leaves `pending` exactly once.
 *
 * **Why the first tick is immediate.** It is the recovery path: a server
 * starting up with stranded sessions in the DB should review them now, not a
 * poll interval from now. This is what will pick up the three sessions already
 * sitting in the live database once migration `017` backfills them to
 * `pending`.
 *
 * **Production only.** `makeProductionServer` wires this; `makeDevServer` does
 * not, so the dev server — and every suite that boots it — never starts firing
 * background runs. Tests drive `reviewPendingSessions` (or `runSessionReviewDrainTick`
 * below) directly instead of racing a wall clock, exactly as the Cycle-review
 * suite drives `runDueCycleReview`.
 */

/**
 * How often the backlog is CHECKED — not how often a review fires. A review
 * normally starts from `finishWorkout`'s nudge within milliseconds; this
 * interval only bounds how long a *failed or dropped* review waits before it is
 * retried. Fifteen minutes keeps a stranded session's recovery well inside the
 * same day without polling a table that is almost always empty.
 */
export const DEFAULT_SESSION_REVIEW_POLL_INTERVAL_MILLIS = 15 * 60 * 1000;

export interface SessionReviewDrainConfig {
  /** How often the pending-review backlog is checked. Defaults to `DEFAULT_SESSION_REVIEW_POLL_INTERVAL_MILLIS`. */
  readonly pollIntervalMillis?: number;
}

/**
 * One tick: review everything currently owed, sequentially. Exported so a test
 * can drive the drain a tick at a time rather than racing the poll loop —
 * mirrors `runDueCycleReview`'s reason for being exported.
 *
 * Failures are swallowed per session inside `reviewPendingSessions`; this catch
 * is the outer belt that keeps the poll loop alive if the drain itself dies
 * (a store read failing, say) rather than silently ending the schedule.
 */
export const runSessionReviewDrainTick = (): Effect.Effect<
  { readonly reviewed: number },
  never,
  DeliberationRunner
> =>
  Effect.gen(function* () {
    const runner = yield* DeliberationRunner;
    return yield* runner.reviewPendingSessions.pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`[session-review] drain tick failed: ${Cause.pretty(cause)}`).pipe(
          Effect.as({ reviewed: 0 }),
        ),
      ),
    );
  });

/**
 * The drain as a Layer: a background fiber in the layer's own scope (it must
 * outlive any one request and die with the server), ticking immediately and
 * then every poll interval.
 *
 * Backgrounded because layer construction is the server's boot path — a
 * Deliberation run takes minutes, and blocking `/rpc` from listening while the
 * coach works through a backlog would trade the app for the recovery.
 */
export const makeSessionReviewDrainLayer = (
  config?: SessionReviewDrainConfig,
): Layer.Layer<never, never, DeliberationRunner> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pollInterval = config?.pollIntervalMillis ?? DEFAULT_SESSION_REVIEW_POLL_INTERVAL_MILLIS;
      yield* Effect.forkScoped(
        Effect.forever(runSessionReviewDrainTick().pipe(Effect.andThen(Effect.sleep(pollInterval)))),
      );
    }),
  );
