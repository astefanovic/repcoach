import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/**
 * `QuotaService` — an injectable service that checks whether the subscription
 * quota (ADR 0005 rolling/weekly rate limits) is low enough that a Deliberation
 * run should defer rather than run immediately. The real implementation
 * (`realQuotaService.ts`, issue #88) polls the Agent SDK's plan rate limits;
 * the canned version below is a test-controllable stand-in.
 *
 * The deferral plan (ADR 0011 §8): when quota is low, a run **queues and fires
 * when quota frees up** — late costs nothing. The adversarial sweep is NEVER
 * skipped to save budget; a run that can't afford its sweep defers.
 */
export class QuotaService extends Context.Service<
  QuotaService,
  {
    /** Returns `true` when quota is low — a run should defer rather than run now. */
    readonly isQuotaLow: Effect.Effect<boolean>;
    /**
     * A stream that emits a signal (void) when quota becomes available again
     * after being low. Used by the deferral queue to wake up and fire queued
     * runs. The stream NEVER emits when quota is already available — it only
     * fires on the low→available transition.
     */
    readonly quotaAvailable: Stream.Stream<void>;
  }
>()("@repcoach/server/QuotaService") {}

/**
 * The canned `QuotaService` for tests: a controllable stand-in that starts
 * with `isQuotaLow = false` (quota always available — runs never defer) but
 * provides a `setLow`/`setAvailable` lever so Seam-2 tests can prove the
 * deferral mechanism.
 */
export const makeCannedQuotaService = (): {
  readonly setLow: Effect.Effect<void>;
  readonly setAvailable: Effect.Effect<void>;
  readonly layer: Layer.Layer<QuotaService>;
} => {
  const state = Effect.runSync(Ref.make<{ isLow: boolean }>({ isLow: false }));
  const signalQueue = Effect.runSync(Queue.unbounded<void>());

  const setLow: Effect.Effect<void> = Ref.update(state, (s) => ({ ...s, isLow: true }));
  const setAvailable: Effect.Effect<void> = Effect.gen(function* () {
    yield* Queue.offer(signalQueue, void 0);
    yield* Ref.update(state, (s) => ({ ...s, isLow: false }));
  });

  const isQuotaLow = Ref.get(state).pipe(Effect.map((s) => s.isLow));

  const quotaAvailable: Stream.Stream<void> = Stream.fromQueue(signalQueue);

  const layer: Layer.Layer<QuotaService> = Layer.succeed(QuotaService)({
    isQuotaLow,
    quotaAvailable,
  });

  return { setLow, setAvailable, layer };
};

/**
 * A default `QuotaService` layer that always reports quota as available (never
 * defers). It is the default for the **unit rungs** — a suite that is not
 * exercising the deferral queue has no business having one — and the fallback
 * inside `makeCannedDeliberationRunnerLayer`.
 *
 * It is NOT what production runs on: `makeRealDeliberationRunnerLayer` provides
 * `QuotaServiceLive` (`realQuotaService.ts`), and the dev-server provides the
 * canned stand-in above so the `/__test__` levers can drive the queue. Nothing
 * user-facing is wired to this layer — which was exactly the bug issue #88
 * fixed: while production held it, no run could ever defer.
 */
export const QuotaServiceAlwaysAvailable: Layer.Layer<QuotaService> = Layer.succeed(QuotaService)({
  isQuotaLow: Effect.succeed(false),
  quotaAvailable: Stream.never,
});