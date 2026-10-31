import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput } from "@repcoach/contracts";
import { ZERO_TOKEN_USAGE } from "@repcoach/contracts";

import { DeliberationAgent } from "../agents/deliberationAgent.ts";
import { DeliberationRunner } from "./deliberationRunner.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { DeliberationSweepAgent } from "../agents/deliberationSweepAgent.ts";
import { UnwiredIntakeSessionAgent } from "../agents/intakeSessionAgent.ts";
import { CannedIntakeSweepAgent } from "../agents/intakeSweepAgent.ts";
import { makeCannedQuotaService } from "../agents/quotaService.ts";
import { SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "../store.ts";

/**
 * ADVERSARIAL Deferral queue coverage (ADR 0011 §8, 2B slice 7 — issue #32):
 * probes the edges of the quota-aware deferral mechanism through Seam 2
 * (`DeliberationRunner` → `Store`), using a controlled `QuotaService` that
 * can be set to low or flipped to available.
 */

const observationDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary,
  rationale: "rationale",
  citations: [],
  reasoning_only_points: [],
  surface: true,
});

const makeDeferralRunnerLayer = () => {
  const state: {
    output: DeliberationRunOutput;
    calls: Array<{ readonly prompt: string; readonly model: string | undefined }>;
  } = {
    output: { decisions: [], observation_directives: [] },
    calls: [],
  };

  const AgentCapture = Layer.succeed(DeliberationAgent)({
    run: (assembledPrompt, model) => {
      state.calls.push({ prompt: assembledPrompt, model });
      return Effect.succeed({
        output: state.output,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0,
      });
    },
  });

  const SweepPassThrough = Layer.succeed(DeliberationSweepAgent)({
    run: (draft) => Effect.succeed({ output: draft, usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
  });

  const { setLow, setAvailable, layer: quotaLayer } = makeCannedQuotaService();

  const layer = DeliberationRunner.layer.pipe(
    Layer.provide(AgentCapture),
    Layer.provide(SweepPassThrough),
    // Intake ports the review cadences never touch — provided so the runner layer builds.
    Layer.provide(UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(quotaLayer),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  );

  return { state, setLow, setAvailable, layer };
};

describe("DeliberationRunner deferral queue — adversarial (issue #32)", () => {
  it("a run with quota available fires immediately and commits normally", async () => {
    const { state, layer } = makeDeferralRunnerLayer();
    state.output = {
      decisions: [observationDraft("normal run")],
      observation_directives: [],
    };

    const result = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      return yield* runner.runNow;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(state.calls).toHaveLength(1);
    expect(result.decisionIds).toHaveLength(1);
    expect(result.feedEntryIds).toHaveLength(1);
  });

  it("a run started while quota is LOW defers (does not run), then FIRES when quota frees up", async () => {
    const { state, setLow, setAvailable, layer } = makeDeferralRunnerLayer();
    state.output = {
      decisions: [observationDraft("deferred run that fires on recovery")],
      observation_directives: [],
    };

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;

      // Quota is low: the deliberator must NOT be called yet.
      yield* setLow;
      const runFiber = yield* Effect.forkScoped(runner.runNow);

      // Give the forked run a chance to enqueue + await its Deferred.
      yield* Effect.sleep("5 millis");
      const callsWhileLow = state.calls.length;
      const stateWhileLow = yield* SubscriptionRef.get(runner.runState);

      // Quota frees up — the low→available signal must drain the queue and fire
      // the held run to completion.
      yield* setAvailable;
      const result = yield* Fiber.join(runFiber);

      return { callsWhileLow, stateWhileLow, result };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // While low: deferred, never ran the deliberator.
    expect(outcome.callsWhileLow).toBe(0);
    expect(outcome.stateWhileLow.status).toBe("queued");
    expect(outcome.stateWhileLow.queuedCount).toBeGreaterThanOrEqual(1);

    // After recovery: fired exactly once and committed.
    expect(state.calls).toHaveLength(1);
    expect(outcome.result.decisionIds).toHaveLength(1);
    expect(outcome.result.feedEntryIds).toHaveLength(1);
  });

  it("drainQueue does NOT fire a queued run while quota is still low (the sweep is never skipped to save budget)", async () => {
    const { state, setLow, setAvailable, layer } = makeDeferralRunnerLayer();
    state.output = {
      decisions: [observationDraft("should stay deferred while low")],
      observation_directives: [],
    };

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;

      yield* setLow;
      const runFiber = yield* Effect.forkScoped(runner.runNow);
      yield* Effect.sleep("5 millis");

      // Still low — even if a drain is attempted, nothing may run.
      const callsStillLow = state.calls.length;

      // Now free quota and let it fire so the test can complete cleanly.
      yield* setAvailable;
      yield* Fiber.join(runFiber);
      return { callsStillLow };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome.callsStillLow).toBe(0);
    // It DID fire after recovery.
    expect(state.calls).toHaveLength(1);
  });

  it("reconciles runState to queued/idle by remaining queue depth when quota drops MID-drain, not just on the empty-poll branch (issue #38 item 1)", async () => {
    // Two runs queued while low. When quota frees, `drainQueue` pops and
    // executes the FIRST — its deliberator call flips quota back to low
    // (simulating quota dropping mid-drain, after some queued runs already
    // fired) before `drainQueue` recurses onto the second entry. That
    // recursion must see quota is low again and reconcile `runState` to
    // "queued" with the true remaining depth (1), rather than leaving the
    // stale "running" status `executeRun` set for the first entry.
    const state: {
      output: DeliberationRunOutput;
      calls: Array<{ readonly prompt: string; readonly model: string | undefined }>;
    } = {
      output: { decisions: [observationDraft("mid-drain reconciliation")], observation_directives: [] },
      calls: [],
    };

    const { setLow, setAvailable, layer: quotaLayer } = makeCannedQuotaService();

    const AgentCaptureThenDropQuota = Layer.succeed(DeliberationAgent)({
      run: (assembledPrompt, model) =>
        Effect.gen(function* () {
          state.calls.push({ prompt: assembledPrompt, model });
          if (state.calls.length === 1) {
            // Simulate quota dropping again while the FIRST queued run's
            // agent call is still in flight, before `drainQueue` recurses.
            yield* setLow;
          }
          return { output: state.output, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, costUsd: 0 };
        }),
    });

    const SweepPassThrough = Layer.succeed(DeliberationSweepAgent)({
      run: (draft) => Effect.succeed({ output: draft, usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
    });

    const layer = DeliberationRunner.layer.pipe(
      Layer.provide(AgentCaptureThenDropQuota),
      Layer.provide(SweepPassThrough),
      Layer.provide(UnwiredIntakeSessionAgent),
      Layer.provide(CannedIntakeSweepAgent),
      Layer.provide(NoopDeliberationSnapshotForTest),
      Layer.provide(SeedInputsProviderLive),
      Layer.provide(quotaLayer),
      Layer.provide(Store.layer),
      Layer.provideMerge(Store.layer),
    );

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;

      yield* setLow;
      const fiber1 = yield* Effect.forkScoped(runner.runNow);
      const fiber2 = yield* Effect.forkScoped(runner.runSessionReview({ sessionIdsConsidered: [] }));
      yield* Effect.sleep("5 millis");

      const queuedCountBefore = (yield* SubscriptionRef.get(runner.runState)).queuedCount;

      // Frees quota: drainQueue pops entry 1, executes it (which flips quota
      // low again from inside the agent call above), then recurses onto
      // entry 2 while quota now reads low.
      yield* setAvailable;
      yield* Effect.sleep("5 millis");

      const stateMidDrain = yield* SubscriptionRef.get(runner.runState);
      const callsMidDrain = state.calls.length;

      // Free quota again and let the second entry drain so the test exits cleanly.
      yield* setAvailable;
      const result1 = yield* Fiber.join(fiber1);
      const result2 = yield* Fiber.join(fiber2);

      return { queuedCountBefore, stateMidDrain, callsMidDrain, result1, result2 };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome.queuedCountBefore).toBe(2);

    // Exactly one run fired before the mid-drain snapshot (the second is
    // still held back by the reconciled low quota).
    expect(outcome.callsMidDrain).toBe(1);
    // THE FIX: status is reconciled to "queued" (not left at "running"), and
    // queuedCount reflects the true remaining depth (1), not stale/zeroed.
    expect(outcome.stateMidDrain.status).toBe("queued");
    expect(outcome.stateMidDrain.queuedCount).toBe(1);

    // Both eventually complete once quota is freed a second time.
    expect(state.calls).toHaveLength(2);
    expect(outcome.result1.decisionIds).toHaveLength(1);
    expect(outcome.result2.decisionIds).toHaveLength(1);
  });
});