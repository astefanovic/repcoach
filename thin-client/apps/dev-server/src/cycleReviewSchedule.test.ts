import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput } from "@repcoach/contracts";
import { ZERO_TOKEN_USAGE } from "@repcoach/contracts";

import { makeCycleReviewScheduleLayer, runDueCycleReview } from "./cycleReviewSchedule.ts";
import { DeliberationAgent } from "./deliberationAgent.ts";
import { DeliberationRunner } from "./deliberationRunner.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { DeliberationSweepAgent } from "./deliberationSweepAgent.ts";
import { UnwiredIntakeSessionAgent } from "./intakeSessionAgent.ts";
import { CannedIntakeSweepAgent } from "./intakeSweepAgent.ts";
import { makeCannedQuotaService, QuotaServiceAlwaysAvailable, type QuotaService } from "./quotaService.ts";
import { SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "./store.ts";

/**
 * The monthly Cycle-review schedule (ADR 0011 §4, issue #91): the server fires
 * a Cycle review on a cadence with nobody initiating it.
 *
 * Exercised through the REAL `DeliberationRunner` (capturing deliberator +
 * pass-through sweep, the wiring the other runner suites use) over the real
 * in-memory `Store`, so what these assert is what a scheduled fire actually
 * does — a real run, through the sweep, committing real rows with the
 * cycle-review framing and the cycle-review model. A stubbed runner would only
 * prove the scheduler calls a function.
 *
 * The claim/persistence half — restart survival, missed windows, one claim per
 * window — lives with the storage that owns it
 * (`packages/persistence/src/cycleReviewSchedule.test.ts`).
 */

const SCHEDULED_SUMMARY = "scheduled cycle observation";

/** A short interval so a test can step past a "month" without waiting one. */
const INTERVAL = 60_000;

const observationDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary,
  rationale: "rationale",
  citations: [],
  reasoning_only_points: [],
  surface: true,
});

/**
 * The runner as the schedule meets it, with the deliberator CAPTURING the
 * prompt + model per call. `provideMerge` of the same `Store.layer` reference
 * exposes the one store the runner writes to — the schedule ticks against that
 * same instance.
 */
const makeScheduledRunnerLayer = (quotaService?: Layer.Layer<QuotaService>) => {
  const state: { calls: Array<{ readonly prompt: string; readonly model: string | undefined }> } = {
    calls: [],
  };
  const AgentCapture = Layer.succeed(DeliberationAgent)({
    run: (assembledPrompt, model) => {
      state.calls.push({ prompt: assembledPrompt, model });
      return Effect.succeed({
        output: { decisions: [observationDraft(SCHEDULED_SUMMARY)], observation_directives: [] },
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0,
      });
    },
  });
  const Sweep = Layer.succeed(DeliberationSweepAgent)({
    run: (draft) => Effect.succeed({ output: draft, usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
  });

  const layer = DeliberationRunner.layer.pipe(
    Layer.provide(AgentCapture),
    Layer.provide(Sweep),
    // Intake ports the review cadences never touch — provided so the layer builds.
    Layer.provide(UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(quotaService ?? QuotaServiceAlwaysAvailable),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  );
  return { state, layer };
};

/**
 * Starts the schedule's clock far enough in the past that the very next claim
 * finds a due window — i.e. the state a server boots into a month later.
 */
const makeWindowDue = Effect.gen(function* () {
  const store = yield* Store;
  yield* store.claimDueCycleReview({
    now: new Date(Date.now() - 2 * INTERVAL).toISOString(),
    intervalMillis: INTERVAL,
  });
});

const scheduledDecisions = Effect.gen(function* () {
  const store = yield* Store;
  const decisions = yield* store.listDecisionsForTest;
  return decisions.filter((d) => d.summary === SCHEDULED_SUMMARY);
});

describe("the monthly Cycle-review schedule (ADR 0011 §4, issue #91)", () => {
  it("fires a Cycle review with NO user action once the window is due, and commits its rows", async () => {
    const { state, layer } = makeScheduledRunnerLayer();

    const result = await Effect.gen(function* () {
      yield* makeWindowDue;
      // Nobody calls `runCycleReview` — the tick does.
      const tick = yield* runDueCycleReview({ intervalMillis: INTERVAL });
      return { tick, committed: yield* scheduledDecisions };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(result.tick.ran).toBe(true);
    expect(result.committed).toHaveLength(1);
    expect(state.calls).toHaveLength(1);
  });

  it("uses the CYCLE-REVIEW framing and the cycle-review-configured model, exactly as the on-demand path does", async () => {
    const { state, layer } = makeScheduledRunnerLayer();

    const calls = await Effect.gen(function* () {
      const store = yield* Store;
      yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-strong" });
      yield* store.setCadenceModel({ cadence: "session-review", model: "model-cheap" });
      yield* makeWindowDue;

      yield* runDueCycleReview({ intervalMillis: INTERVAL });
      // The on-demand path, for comparison: a scheduled run must BE that run,
      // not a second, drifting copy of "how a Cycle review is run".
      const runner = yield* DeliberationRunner;
      yield* runner.runCycleReview;
      return state.calls;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(calls).toHaveLength(2);
    const [scheduled, onDemand] = calls;
    // The cycle-review model, not the session-review one.
    expect(scheduled?.model).toBe("model-strong");
    expect(scheduled?.model).toBe(onDemand?.model);
    // The cycle-review framing, identical to the on-demand path's. (The two
    // prompts are not byte-identical — the pointer digest moves once the first
    // run has committed — but the framing they are built around is the same.)
    expect(scheduled?.prompt).toContain("Cycle review — weigh the longer history");
    expect(onDemand?.prompt).toContain("Cycle review — weigh the longer history");
  });

  it("does NOT fire when no window is due — a tick is a claim attempt, not a run", async () => {
    const { state, layer } = makeScheduledRunnerLayer();

    const ticks = await Effect.gen(function* () {
      // A fresh schedule: the first tick starts the clock and claims nothing,
      // so standing a server up does not immediately spend quota.
      const first = yield* runDueCycleReview({ intervalMillis: INTERVAL });
      const second = yield* runDueCycleReview({ intervalMillis: INTERVAL });
      return [first.ran, second.ran];
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(ticks).toEqual([false, false]);
    expect(state.calls).toHaveLength(0);
  });

  it("cannot double-fire from ONE due window — the later ticks find nothing to claim", async () => {
    const { state, layer } = makeScheduledRunnerLayer();

    const result = await Effect.gen(function* () {
      yield* makeWindowDue;
      const ran = [
        (yield* runDueCycleReview({ intervalMillis: INTERVAL })).ran,
        (yield* runDueCycleReview({ intervalMillis: INTERVAL })).ran,
        (yield* runDueCycleReview({ intervalMillis: INTERVAL })).ran,
      ];
      return { ran, committed: yield* scheduledDecisions };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(result.ran).toEqual([true, false, false]);
    // Exactly ONE Cycle review, and exactly one Decision, off one due window.
    expect(result.committed).toHaveLength(1);
    expect(state.calls).toHaveLength(1);
  });

  it("the schedule LAYER polls in the background and fires the due window with nobody asking", async () => {
    const { layer } = makeScheduledRunnerLayer();

    const committed = await Effect.gen(function* () {
      yield* makeWindowDue;

      // Building the schedule layer is the ONLY act here — no run method is
      // ever called. The first tick is immediate (a restart after a missed
      // window must not wait out a poll interval), so a short settle suffices.
      return yield* Effect.provide(
        Effect.sleep(300).pipe(Effect.andThen(scheduledDecisions)),
        makeCycleReviewScheduleLayer({ intervalMillis: INTERVAL, pollIntervalMillis: 20 }),
      );
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(committed).toHaveLength(1);
  });

  it("a scheduled run landing while quota is LOW queues, then fires when quota frees up", async () => {
    const quota = makeCannedQuotaService();
    const { state, layer } = makeScheduledRunnerLayer(quota.layer);

    const result = await Effect.gen(function* () {
      yield* makeWindowDue;
      yield* quota.setLow;

      // The tick blocks on the queued run (ADR 0011 §8: late costs nothing),
      // so it is forked and observed rather than awaited.
      const tick = yield* Effect.forkScoped(runDueCycleReview({ intervalMillis: INTERVAL }));
      yield* Effect.sleep(100);
      const whileLow = { calls: state.calls.length, committed: yield* scheduledDecisions };

      yield* quota.setAvailable;
      yield* Fiber.await(tick);
      return { whileLow, afterRecovery: yield* scheduledDecisions };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // Queued, not run: no deliberator call and nothing committed while low.
    expect(result.whileLow.calls).toBe(0);
    expect(result.whileLow.committed).toHaveLength(0);
    // ...and it fires once quota recovers — exactly one run, never dropped.
    expect(result.afterRecovery).toHaveLength(1);
    expect(state.calls).toHaveLength(1);
  });
});
