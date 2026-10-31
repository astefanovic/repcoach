import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS } from "@repcoach/persistence/store";

import { DeliberationRunner } from "./deliberationRunner.ts";
import { Store } from "../store.ts";

/**
 * The monthly Cycle-review schedule (ADR 0011 §4, issue #91) — the thing that
 * makes the heavier of the two proactive cadences actually fire.
 *
 * ADR 0005 makes proactivity the entire reason the coach lives on an
 * always-on home server: Session reviews fire on post-session sync, Cycle
 * reviews run on a schedule, without the owner asking. The runner capability
 * and the RPC handler both existed already; nothing on the server ever called
 * them, so the only path to a Cycle review was a manual tap that has no
 * button.
 *
 * **Why a poll over a persisted timestamp, not a timer.** A home server
 * reboots, and a monthly timer that resets on every boot is a monthly timer
 * that never fires. So this holds no schedule state of its own: every tick
 * asks the `Store` to atomically claim a due window
 * (`claimDueCycleReview`, migration `011`), and due-ness is derived from the
 * persisted "last claimed at" timestamp. A restart therefore does not reset
 * the interval, and a boot after a missed window claims it and runs the
 * review rather than skipping it.
 *
 * **Why it cannot double-fire.** Two guards, and both are needed. The claim
 * itself is one conditional UPDATE, so two ticks (or two processes) cannot
 * both win one due window. And the loop is strictly sequential — it AWAITS
 * `runCycleReview` before the next tick — so a run that takes longer than the
 * poll interval cannot have a second run started underneath it.
 *
 * **Quota.** It calls `runCycleReview` exactly as the on-demand path does, so
 * a review landing in a low-quota window queues on the runner's deferral queue
 * like any other fire-and-forget run (ADR 0011 §8), and it inherits the
 * cycle-review framing and the cycle-review-configured model for free — there
 * is no second, drifting copy of "how a Cycle review is run" here.
 *
 * **Production only.** `makeProductionServer` wires this; `makeDevServer` does
 * not, so the dev server (and every suite that boots it) never starts firing
 * background runs.
 */

/**
 * How often the schedule is CHECKED — not how often it fires. Hourly is far
 * more often than a monthly cadence needs, and deliberately so: the tick is
 * one cheap conditional UPDATE, and the cost of checking rarely is a review
 * that lands late by up to a poll interval after a reboot.
 */
export const DEFAULT_CYCLE_REVIEW_POLL_INTERVAL_MILLIS = 60 * 60 * 1000;

export interface CycleReviewScheduleConfig {
  /** The cadence. Defaults to `MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS` (ADR 0011 §4's plain month). */
  readonly intervalMillis?: number;
  /** How often due-ness is checked. Defaults to `DEFAULT_CYCLE_REVIEW_POLL_INTERVAL_MILLIS`. */
  readonly pollIntervalMillis?: number;
}

/**
 * One tick: claim a due window if there is one, and run the Cycle review if
 * this tick won the claim. Exported so a test can drive the schedule a tick at
 * a time rather than racing a wall-clock poll loop.
 */
export const runDueCycleReview = (
  config?: CycleReviewScheduleConfig,
): Effect.Effect<{ readonly ran: boolean }, never, Store | DeliberationRunner> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runner = yield* DeliberationRunner;

    const claim = yield* store.claimDueCycleReview({
      now: new Date().toISOString(),
      intervalMillis: config?.intervalMillis ?? MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS,
    });
    if (!claim.claimed) return { ran: false };

    yield* Effect.logInfo(`[cycle-review] due window claimed at ${claim.lastRunAt} — running`);
    // The claim is already committed, so a run that dies costs ONE skipped
    // month rather than a crash-loop firing a review on every boot. Catching
    // the defect here (rather than letting it kill the fiber) is what keeps
    // the schedule alive across a bad run: `runCycleReview` itself surfaces a
    // failed run to the user through `runState` (issue #90).
    yield* runner.runCycleReview.pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`[cycle-review] scheduled run failed: ${Cause.pretty(cause)}`),
      ),
    );
    return { ran: true };
  });

/**
 * The scheduler as a Layer: builds a background fiber into the layer's own
 * scope (it must outlive any one request, and die with the server), which
 * ticks immediately and then every poll interval.
 *
 * The first tick happens IMMEDIATELY, which is the half that makes a restart
 * after a missed window fire the review promptly instead of a poll interval
 * later. It runs in the BACKGROUND because layer construction is the server's
 * boot path — a Deliberation run takes minutes, and blocking `/rpc` from
 * listening on one would trade the app itself for a proactive nicety.
 */
export const makeCycleReviewScheduleLayer = (
  config?: CycleReviewScheduleConfig,
): Layer.Layer<never, never, Store | DeliberationRunner> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pollInterval = config?.pollIntervalMillis ?? DEFAULT_CYCLE_REVIEW_POLL_INTERVAL_MILLIS;
      yield* Effect.forkScoped(
        Effect.forever(runDueCycleReview(config).pipe(Effect.andThen(Effect.sleep(pollInterval)))),
      );
    }),
  );
