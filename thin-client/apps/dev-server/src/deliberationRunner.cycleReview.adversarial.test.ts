import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput } from "@repcoach/contracts";
import { ZERO_TOKEN_USAGE } from "@repcoach/contracts";

import { DeliberationAgent } from "./deliberationAgent.ts";
import { DeliberationRunner } from "./deliberationRunner.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { DeliberationSweepAgent } from "./deliberationSweepAgent.ts";
import { UnwiredIntakeSessionAgent } from "./intakeSessionAgent.ts";
import { CannedIntakeSweepAgent } from "./intakeSweepAgent.ts";
import { QuotaServiceAlwaysAvailable } from "./quotaService.ts";
import { SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "./store.ts";

/**
 * ADVERSARIAL Cycle-review + per-cadence-model plumbing coverage (ADR 0011 §4,
 * issue #31 — 2B slice 6), through Seam 2 with a capturing deliberator. Probes
 * what the happy-path `deliberationRunner.cycleReview.test.ts` does NOT:
 *
 * - a Cycle review must NOT LEAK another cadence's model — configuring only
 *   Session review leaves Cycle review on the documented fallback (undefined),
 *   never the session model;
 * - the model is read PER RUN, not frozen when the `runCycleReview` Effect was
 *   constructed — changing the setting between two runs is observed by the
 *   second run;
 * - on-demand `runNow` honors its OWN configured model (the plumbing is not
 *   hardcoded to Session/Cycle);
 * - a Cycle review on a completely fresh/empty store (no sessions, no goal)
 *   still assembles + commits without throwing.
 */

const makeCycleRunnerLayer = (
  sweep: (draft: DeliberationRunOutput) => DeliberationRunOutput = (draft) => draft,
) => {
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
  const SweepConfigurable = Layer.succeed(DeliberationSweepAgent)({
    run: (draft) => Effect.succeed({ output: sweep(draft), usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
  });
  const layer = DeliberationRunner.layer.pipe(
    Layer.provide(AgentCapture),
    Layer.provide(SweepConfigurable),
    // Intake ports the review cadences never touch — provided so the runner layer builds.
    Layer.provide(UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(QuotaServiceAlwaysAvailable),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  );
  return { state, layer };
};

const observationDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary,
  rationale: "rationale",
  citations: [],
  reasoning_only_points: [],
  surface: true,
});

describe("DeliberationRunner cycle review — adversarial model plumbing (issue #31)", () => {
  it("a Cycle review does NOT leak the Session-review model — with only Session configured, Cycle falls back to undefined", async () => {
    const { state, layer } = makeCycleRunnerLayer();
    state.output = { decisions: [observationDraft("obs")], observation_directives: [] };

    const captured = await Effect.gen(function* () {
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      // ONLY the session cadence has a model; the cycle cadence has none.
      yield* store.setCadenceModel({ cadence: "session-review", model: "model-session-only" });

      yield* runner.runSessionReview({ sessionIdsConsidered: [] });
      const sessionModel = state.calls.at(-1)?.model;
      yield* runner.runCycleReview;
      const cycleModel = state.calls.at(-1)?.model;
      return { sessionModel, cycleModel };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(captured.sessionModel).toBe("model-session-only");
    // The cycle run must NOT inherit the session model — it falls back honestly.
    expect(captured.cycleModel).toBeUndefined();
  });

  it("the cadence model is read PER RUN, not frozen at Effect construction — a mid-life change is seen by the next run", async () => {
    const { state, layer } = makeCycleRunnerLayer();
    state.output = { decisions: [observationDraft("obs")], observation_directives: [] };

    const models = await Effect.gen(function* () {
      const store = yield* Store;
      const runner = yield* DeliberationRunner;

      yield* runner.runCycleReview; // no model configured yet
      const first = state.calls.at(-1)?.model;

      yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-first" });
      yield* runner.runCycleReview;
      const second = state.calls.at(-1)?.model;

      yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-second" });
      yield* runner.runCycleReview;
      const third = state.calls.at(-1)?.model;

      return { first, second, third };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(models.first).toBeUndefined();
    expect(models.second).toBe("model-first");
    expect(models.third).toBe("model-second"); // the overwrite is observed live
  });

  it("on-demand runNow honors its OWN configured model — the plumbing is not hardcoded to Session/Cycle", async () => {
    const { state, layer } = makeCycleRunnerLayer();
    state.output = { decisions: [observationDraft("obs")], observation_directives: [] };

    const model = await Effect.gen(function* () {
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      yield* store.setCadenceModel({ cadence: "on-demand", model: "model-ondemand" });
      yield* runner.runNow;
      return state.calls.at(-1)?.model;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(model).toBe("model-ondemand");
  });

  it("a Cycle review on a completely fresh/empty store (no sessions, no goal) still assembles + commits without throwing", async () => {
    const { state, layer } = makeCycleRunnerLayer();
    state.output = {
      decisions: [observationDraft("cycle obs on empty history")],
      observation_directives: [],
    };

    const { result, cyclePrompt } = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const result = yield* runner.runCycleReview;
      const cyclePrompt = state.calls.at(-1)?.prompt ?? "";
      return { result, cyclePrompt };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // It committed (canned decision landed) and the long-history framing is
    // still assembled even with an empty pointer digest / no goal.
    expect(result.decisionIds.length).toBeGreaterThan(0);
    expect(cyclePrompt).toContain("Cycle review");
    expect(cyclePrompt.toLowerCase()).toContain("longer history");
    // Empty-history sentinels are present, not a crash on missing data.
    expect(cyclePrompt).toContain("not yet set");
  });
});
