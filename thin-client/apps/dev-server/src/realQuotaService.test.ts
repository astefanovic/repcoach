import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput } from "@repcoach/contracts";
import { ZERO_TOKEN_USAGE } from "@repcoach/contracts";

import { DeliberationAgent } from "./deliberationAgent.ts";
import { DeliberationRunner } from "./deliberationRunner.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { DeliberationSweepAgent } from "./deliberationSweepAgent.ts";
import { UnwiredIntakeSessionAgent } from "./intakeSessionAgent.ts";
import { CannedIntakeSweepAgent } from "./intakeSweepAgent.ts";
import { QuotaService } from "./quotaService.ts";
import {
  DEFAULT_RUN_HEADROOM_PERCENT,
  isQuotaLowForReading,
  makeQuotaServiceLayer,
  QuotaReadFailedError,
  type QuotaReading,
} from "./realQuotaService.ts";
import { SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "./store.ts";

/**
 * The real `QuotaService` (issue #88) minus its one untestable edge: the live
 * Agent SDK reader needs a subscription session, so everything below drives the
 * same service through a reader the test owns. What is proven here is the part
 * ADR 0011 §8 actually specifies — when a run defers, when it fires, and that a
 * run can never buy a deliberator it cannot also afford a sweep for.
 */

const reading = (over: Partial<QuotaReading> = {}): QuotaReading => ({
  rateLimitsAvailable: true,
  fiveHourUtilization: 0,
  sevenDayUtilization: 0,
  ...over,
});

describe("isQuotaLowForReading", () => {
  it("is not low with an empty window", () => {
    expect(isQuotaLowForReading(reading())).toBe(false);
  });

  it("reserves headroom for BOTH the deliberator and its sweep (ADR 0011 §8)", () => {
    // The sweep is never skipped to save budget, and nothing re-checks quota
    // between the two sessions — so the last sliver of a window must not be
    // spendable on a deliberator alone.
    expect(isQuotaLowForReading(reading({ fiveHourUtilization: 99 }))).toBe(true);
    expect(isQuotaLowForReading(reading({ fiveHourUtilization: 100 - DEFAULT_RUN_HEADROOM_PERCENT }))).toBe(
      false,
    );
    expect(
      isQuotaLowForReading(reading({ fiveHourUtilization: 100 - DEFAULT_RUN_HEADROOM_PERCENT + 1 })),
    ).toBe(true);
  });

  it("takes the busier of the rolling and weekly windows (ADR 0005)", () => {
    expect(isQuotaLowForReading(reading({ fiveHourUtilization: 5, sevenDayUtilization: 97 }))).toBe(true);
    expect(isQuotaLowForReading(reading({ fiveHourUtilization: 97, sevenDayUtilization: 5 }))).toBe(true);
  });

  it("honours a custom headroom", () => {
    expect(isQuotaLowForReading(reading({ fiveHourUtilization: 60 }), 50)).toBe(true);
    expect(isQuotaLowForReading(reading({ fiveHourUtilization: 40 }), 50)).toBe(false);
  });

  it("is never low when plan rate limits do not apply", () => {
    // API key / Bedrock / Vertex: there is no subscription window to defer
    // against, and inventing one would queue every run forever.
    expect(
      isQuotaLowForReading(
        reading({ rateLimitsAvailable: false, fiveHourUtilization: undefined, sevenDayUtilization: undefined }),
      ),
    ).toBe(false);
  });

  it("is never low when no window reported a number", () => {
    expect(
      isQuotaLowForReading(reading({ fiveHourUtilization: undefined, sevenDayUtilization: undefined })),
    ).toBe(false);
  });
});

/** A reader the test drives, plus a call counter so polling itself is observable. */
const makeFakeReader = () => {
  const state = Effect.runSync(
    Ref.make<{ next: Effect.Effect<QuotaReading, QuotaReadFailedError>; calls: number }>({
      next: Effect.succeed(reading()),
      calls: 0,
    }),
  );

  const read: Effect.Effect<QuotaReading, QuotaReadFailedError> = Effect.gen(function* () {
    const current = yield* Ref.updateAndGet(state, (s) => ({ ...s, calls: s.calls + 1 }));
    return yield* current.next;
  });

  return {
    read,
    calls: Ref.get(state).pipe(Effect.map((s) => s.calls)),
    setReading: (next: QuotaReading) => Ref.update(state, (s) => ({ ...s, next: Effect.succeed(next) })),
    setFailing: Ref.update(state, (s) => ({
      ...s,
      next: Effect.fail(new QuotaReadFailedError({ detail: "probe blew up" })),
    })),
  };
};

const starved = reading({ fiveHourUtilization: 99 });

describe("makeQuotaServiceLayer", () => {
  it("reads immediately rather than waiting out a poll interval", async () => {
    const reader = makeFakeReader();
    await Effect.runPromise(reader.setReading(starved));

    // The read is deliberately off the construction path (a live probe spawns
    // an Agent SDK session, and the server's boot must not wait on it) — but it
    // is fired at once, not on the first tick of a 60s interval.
    const isLow = await Effect.gen(function* () {
      const quota = yield* QuotaService;
      yield* Effect.sleep("20 millis");
      return yield* quota.isQuotaLow;
    }).pipe(
      Effect.provide(makeQuotaServiceLayer({ read: reader.read, pollIntervalMillis: 10_000 })),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(isLow).toBe(true);
  });

  it("emits on the low→available edge and nowhere else", async () => {
    const reader = makeFakeReader();
    await Effect.runPromise(reader.setReading(starved));

    const edges = await Effect.gen(function* () {
      const quota = yield* QuotaService;
      yield* Effect.sleep("20 millis"); // let the first (backgrounded) read land
      expect(yield* quota.isQuotaLow).toBe(true);

      const seen = yield* Ref.make(0);
      yield* Effect.forkScoped(Stream.runForEach(quota.quotaAvailable, () => Ref.update(seen, (n) => n + 1)));
      yield* Effect.sleep("10 millis");

      // Still low: polling must not manufacture a wake-up.
      yield* Effect.sleep("30 millis");
      expect(yield* Ref.get(seen)).toBe(0);

      yield* reader.setReading(reading());
      yield* Effect.sleep("40 millis");
      expect(yield* quota.isQuotaLow).toBe(false);
      const afterRecovery = yield* Ref.get(seen);

      // Available→available ticks are not edges either.
      yield* Effect.sleep("40 millis");
      return { afterRecovery, afterMore: yield* Ref.get(seen) };
    }).pipe(
      Effect.provide(makeQuotaServiceLayer({ read: reader.read, pollIntervalMillis: 10 })),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(edges.afterRecovery).toBe(1);
    expect(edges.afterMore).toBe(1);
  });

  it("keeps the last known state when a read fails", async () => {
    const reader = makeFakeReader();
    await Effect.runPromise(reader.setReading(starved));

    const states = await Effect.gen(function* () {
      const quota = yield* QuotaService;
      yield* Effect.sleep("20 millis"); // let the first (backgrounded) read land
      const whileStarved = yield* quota.isQuotaLow;

      yield* reader.setFailing;
      yield* Effect.sleep("40 millis");

      // A failed probe is "learned nothing", not "quota recovered": a
      // fabricated recovery would spend against a limit we just failed to see.
      return { whileStarved, afterFailures: yield* quota.isQuotaLow };
    }).pipe(
      Effect.provide(makeQuotaServiceLayer({ read: reader.read, pollIntervalMillis: 10 })),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(states).toEqual({ whileStarved: true, afterFailures: true });
  });

  it("starts available so a cold server whose first read fails still runs", async () => {
    const reader = makeFakeReader();
    await Effect.runPromise(reader.setFailing);

    const isLow = await Effect.gen(function* () {
      const quota = yield* QuotaService;
      return yield* quota.isQuotaLow;
    }).pipe(
      Effect.provide(makeQuotaServiceLayer({ read: reader.read, pollIntervalMillis: 10_000 })),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(isLow).toBe(false);
  });
});

/**
 * The point of the whole issue: this service, not the canned lever, driving the
 * runner's deferral queue end to end.
 */
describe("the real quota service against the deferral queue", () => {
  const observationDraft: DeliberationRunOutput["decisions"][number] = {
    kind: "observation",
    summary: "deferred then fired",
    rationale: "rationale",
    citations: [],
    reasoning_only_points: [],
    surface: true,
  };

  it("defers a run started while quota is low, and fires it when quota frees up", async () => {
    const reader = makeFakeReader();
    await Effect.runPromise(reader.setReading(starved));

    const calls: Array<string> = [];
    const AgentCapture = Layer.succeed(DeliberationAgent)({
      run: (assembledPrompt) => {
        calls.push(assembledPrompt);
        return Effect.succeed({
          output: { decisions: [observationDraft], observation_directives: [] },
          usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          costUsd: 0,
        });
      },
    });
    const SweepPassThrough = Layer.succeed(DeliberationSweepAgent)({
      run: (draft) => Effect.succeed({ output: draft, usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
    });

    const layer = DeliberationRunner.layer.pipe(
      Layer.provide(AgentCapture),
      Layer.provide(SweepPassThrough),
      Layer.provide(UnwiredIntakeSessionAgent),
      Layer.provide(CannedIntakeSweepAgent),
      Layer.provide(NoopDeliberationSnapshotForTest),
      Layer.provide(SeedInputsProviderLive),
      Layer.provide(makeQuotaServiceLayer({ read: reader.read, pollIntervalMillis: 10 })),
      Layer.provide(Store.layer),
      Layer.provideMerge(Store.layer),
    );

    const result = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* Effect.sleep("20 millis"); // let the first (backgrounded) read land
      const fiber = yield* Effect.forkScoped(runner.runNow);
      yield* Effect.sleep("30 millis");

      // Nothing ran: the queue held it rather than spending the sliver of
      // quota that the sweep would have needed.
      expect(calls).toHaveLength(0);
      const state = yield* SubscriptionRef.get(runner.runState);
      expect(state.status).toBe("queued");
      expect(state.queuedCount).toBe(1);

      yield* reader.setReading(reading());
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(calls).toHaveLength(1);
    expect(result.decisionIds).toHaveLength(1);
  });
});
