import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { QuotaService } from "./quotaService.ts";

/**
 * The REAL `QuotaService` (issue #88): the signal that makes ADR 0011 §8's
 * degradation ladder actually load-bearing. The queue, the run states and the
 * client's `coach queued` strip were all built against
 * `QuotaServiceAlwaysAvailable`, which reports quota available forever — so
 * until this file existed, no production run ever deferred and the whole ladder
 * was unreachable code.
 *
 * Three pieces, deliberately separated so only the last one needs a live
 * subscription to exercise:
 *
 * 1. `QuotaReading` — the raw plan rate-limit windows (ADR 0005's "rolling +
 *    weekly"), normalised away from the SDK's experimental shape.
 * 2. `isQuotaLowForReading` — the pure judgment, headroom included. Unit-tested.
 * 3. `makeQuotaServiceLayer` — the polling shell that turns readings into
 *    `isQuotaLow` + the low→available edge the deferral queue wakes on.
 *    Unit-tested against a fake reader.
 *
 * `readAgentSdkQuota` (the live reader) is the one untestable edge: it needs a
 * real Agent SDK session under the owner's OAuth, so like the real deliberator
 * and sweep it is verified in UAT rather than by an automated rung.
 */

export class QuotaReadFailedError extends Schema.TaggedErrorClass<QuotaReadFailedError>()(
  "QuotaReadFailedError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Could not read subscription quota: ${this.detail}`;
  }
}

/**
 * One observation of the subscription's plan limits.
 *
 * `rateLimitsAvailable` is false for API-key / Bedrock / Vertex sessions, where
 * plan limits simply do not apply — there is nothing to defer against, and this
 * service says so rather than inventing a limit (see `isQuotaLowForReading`).
 *
 * Utilizations are percentages of the window consumed, 0–100, and either may be
 * absent: the SDK reports a window only when it knows about it.
 */
export interface QuotaReading {
  readonly rateLimitsAvailable: boolean;
  /** ADR 0005's *rolling* limit — the SDK's `five_hour` window. */
  readonly fiveHourUtilization: number | undefined;
  /** ADR 0005's *weekly* limit — the SDK's `seven_day` window. */
  readonly sevenDayUtilization: number | undefined;
}

/**
 * How much of a window a run must be able to see free before it is allowed to
 * start — expressed as a percentage of that window, and covering **both stages
 * of the run** (ADR 0011 §8: "the adversarial sweep is never skipped to save
 * budget — a run that can't afford its sweep defers").
 *
 * That last clause is the reason this is a headroom and not a "is the window
 * exhausted?" check. A run is two independent Agent SDK sessions, the sweep
 * strictly after the deliberator, and nothing re-checks quota between them —
 * so the only place the sweep's budget can be reserved is *before* the
 * deliberator starts. Starting a run at 99% would buy a deliberator and then
 * discover there was nothing left for the editor that is supposed to have final
 * authority over it, committing an unswept draft or losing the work entirely.
 *
 * 10% is a deliberate over-reservation at personal scale: two sessions cost
 * nowhere near that on a Max plan, and deferring a proactive run slightly early
 * costs nothing (late is free — that is the ADR's whole premise), while
 * starting one slightly late costs a run.
 */
export const DEFAULT_RUN_HEADROOM_PERCENT = 10;

/**
 * The pure judgment: is quota low enough that a run should defer?
 *
 * Both windows are checked and the busier one wins — a weekly limit at 95% is
 * just as blocking as a rolling one, and ADR 0005 names both.
 */
export const isQuotaLowForReading = (
  reading: QuotaReading,
  headroomPercent: number = DEFAULT_RUN_HEADROOM_PERCENT,
): boolean => {
  // Plan limits do not apply to this session (API key / Bedrock / Vertex, or a
  // profile without the scope). There is no quota to be low: deferring here
  // would queue every run forever against a limit that does not exist.
  if (!reading.rateLimitsAvailable) return false;

  const utilizations = [reading.fiveHourUtilization, reading.sevenDayUtilization].filter(
    (value): value is number => value !== undefined,
  );
  // Rate limits are "available" but no window reported a number — same posture
  // as above: never invent a limit, never block on ignorance.
  if (utilizations.length === 0) return false;

  return Math.max(...utilizations) > 100 - headroomPercent;
};

export interface QuotaServiceLayerOptions {
  /** One observation. Failures are tolerated — see `makeQuotaServiceLayer`. */
  readonly read: Effect.Effect<QuotaReading, QuotaReadFailedError>;
  /**
   * How often to re-read. The low→available edge is what fires deferred runs,
   * so this is also the worst-case lag between quota recovering and the queue
   * draining. A rolling window resets on the hour scale; a minute of lag on a
   * run whose entire premise is "late costs nothing" is not worth polling
   * harder for.
   */
  readonly pollIntervalMillis?: number;
  readonly headroomPercent?: number;
}

export const DEFAULT_QUOTA_POLL_INTERVAL_MILLIS = 60_000;

/**
 * Turns a reader into the `QuotaService` the runner consumes: a current
 * `isQuotaLow` answer plus a stream that emits **only on the low→available
 * edge**, which is precisely the runner's wake-up condition.
 *
 * Two failure postures worth stating, because both are choices:
 *
 * - **A failed read changes nothing.** The last known state is kept rather than
 *   assumed either way. Assuming "available" would spend against a limit we
 *   just failed to see; assuming "low" would wedge every run behind a transient
 *   SDK hiccup with no edge to recover on (the recovery edge only fires from a
 *   *successful* read, so a fabricated "low" could never be undone).
 * - **The initial state is available.** The first read is fired immediately but
 *   off the boot path, so there is always a window — and after a failed first
 *   read a whole poll interval — where the answer is "available" without a
 *   reading behind it. A cold server whose very first read fails runs rather
 *   than queues. Optimism is the safe direction here: a run
 *   that should have deferred just gets rejected by the API and fails, while a
 *   run that should have fired but queued sits invisible until the next poll.
 */
export const makeQuotaServiceLayer = (
  options: QuotaServiceLayerOptions,
): Layer.Layer<QuotaService> =>
  Layer.effect(QuotaService)(
    Effect.gen(function* () {
      const headroom = options.headroomPercent ?? DEFAULT_RUN_HEADROOM_PERCENT;
      const interval = options.pollIntervalMillis ?? DEFAULT_QUOTA_POLL_INTERVAL_MILLIS;

      const isLowRef = yield* Ref.make(false);
      // A hub rather than a queue: the runner's drain daemon is the only
      // subscriber today, but an edge is a broadcast, and a second consumer
      // silently stealing the runner's wake-up would be a miserable bug.
      const availableHub = yield* PubSub.unbounded<void>();

      const observe = (reading: QuotaReading): Effect.Effect<void> =>
        Effect.gen(function* () {
          const nowLow = isQuotaLowForReading(reading, headroom);
          const wasLow = yield* Ref.getAndSet(isLowRef, nowLow);
          // ONLY the edge. Publishing while quota was already available would
          // make the runner drain on a timer, which is not what "fires when
          // quota frees up" means and would mask a stuck queue.
          if (wasLow && !nowLow) yield* PubSub.publish(availableHub, void 0);
        });

      const pollOnce: Effect.Effect<void> = options.read.pipe(
        Effect.flatMap(observe),
        Effect.catchTag("QuotaReadFailedError", (error) =>
          Effect.logWarning(`[quota] ${error.message} — keeping the last known quota state`),
        ),
      );

      // The first read happens IMMEDIATELY but in the BACKGROUND. Both halves
      // of that matter: immediately, so a server started into an already-starved
      // window learns it in seconds rather than a poll interval; in the
      // background, because layer construction is the server's boot path and a
      // live probe spawns an Agent SDK session — blocking `/rpc` from listening
      // on a quota check would trade a proactive nicety for the app itself.
      yield* Effect.forkScoped(
        Effect.forever(pollOnce.pipe(Effect.andThen(Effect.sleep(interval)))),
      );

      return {
        isQuotaLow: Ref.get(isLowRef),
        quotaAvailable: Stream.fromPubSub(availableHub),
      };
    }),
  );

/** Wall-clock cap on one usage probe — a hung probe must not stall the poll loop. */
const QUOTA_PROBE_TIMEOUT_MILLIS = 30_000;

/**
 * Reads the plan's rate-limit windows out of a live Agent SDK session.
 *
 * The SDK exposes them through the structured `/usage` control request, which
 * (per the SDK's own docs) is only answerable in **streaming-input mode** — so
 * this opens a session whose prompt is an async iterable that yields nothing
 * and resolves on abort. The session initialises, answers the control request
 * and is torn down: **no model turn is ever taken**, which is what makes it
 * sane to run on a timer against the very quota it is measuring.
 *
 * The API is flagged experimental by the SDK and may change under us; a shape
 * change surfaces here as a `QuotaReadFailedError`, which the poll loop treats
 * as "learned nothing this tick" rather than as a reason to stop running.
 */
export const readAgentSdkQuota: Effect.Effect<QuotaReading, QuotaReadFailedError> =
  Effect.tryPromise({
    try: async (): Promise<QuotaReading> => {
      const abortController = new AbortController();
      const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
        // Holds the session open with zero user messages, and lets go the
        // instant we abort — a generator parked on a promise that never
        // settles would leak one pending continuation per poll.
        await new Promise<void>((resolve) => {
          if (abortController.signal.aborted) return resolve();
          abortController.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })();

      const session = query({ prompt, options: { abortController, maxTurns: 1 } });

      // The message stream is drained in the background: control-request
      // responses ride the same transport, and an unconsumed stream is not a
      // contract the SDK makes. Nothing here reads the messages — errors after
      // teardown are the expected shape of an aborted session.
      const drained = (async () => {
        try {
          for await (const _message of session as AsyncIterable<SDKMessage>) {
            // intentionally empty — see above
          }
        } catch {
          // aborted teardown, not a read failure
        }
      })();

      try {
        const usage = await Promise.race([
          session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
          new Promise<never>((_resolve, reject) => {
            setTimeout(
              () => reject(new Error(`usage probe exceeded ${QUOTA_PROBE_TIMEOUT_MILLIS}ms`)),
              QUOTA_PROBE_TIMEOUT_MILLIS,
            ).unref?.();
          }),
        ]);

        const windows = usage.rate_limits;
        return {
          rateLimitsAvailable: usage.rate_limits_available,
          fiveHourUtilization: windows?.five_hour?.utilization ?? undefined,
          sevenDayUtilization: windows?.seven_day?.utilization ?? undefined,
        };
      } finally {
        abortController.abort();
        session.close();
        await drained;
      }
    },
    catch: (cause) => new QuotaReadFailedError({ detail: String(cause) }),
  });

/**
 * The production `QuotaService`: the live Agent SDK reader on the default poll
 * interval. This is what `makeRealDeliberationRunnerLayer` provides — the
 * dev-server keeps its test-controllable stand-in (`makeCannedQuotaService`,
 * driven by the `/__test__` levers).
 */
export const QuotaServiceLive = (
  options?: Omit<QuotaServiceLayerOptions, "read">,
): Layer.Layer<QuotaService> =>
  makeQuotaServiceLayer({ read: readAgentSdkQuota, ...(options ?? {}) });
