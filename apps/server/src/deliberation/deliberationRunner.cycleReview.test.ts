import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput } from "@repcoach/contracts";
import { ZERO_TOKEN_USAGE } from "@repcoach/contracts";

import { DeliberationAgent } from "../agents/deliberationAgent.ts";
import { DeliberationRunner } from "./deliberationRunner.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { DeliberationSweepAgent } from "../agents/deliberationSweepAgent.ts";
import { UnwiredIntakeSessionAgent } from "../agents/intakeSessionAgent.ts";
import { CannedIntakeSweepAgent } from "../agents/intakeSweepAgent.ts";
import { QuotaServiceAlwaysAvailable } from "../agents/quotaService.ts";
import { SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "../store.ts";

/**
 * Cycle-review cadence + per-cadence model settings coverage (ADR 0011 §4,
 * issue #31 — 2B slice 6), all through Seam 2 (`DeliberationRunner` →
 * `Store`), using a canned/capturing deliberator so the assembled prompt and
 * the model the runner passed are inspectable without a live model:
 *
 * - a monthly Cycle review runs with LONG-HISTORY framing that DIFFERS from a
 *   Session review's recent-focus framing at Seam 2 (the assembled prompt);
 * - Session review and Cycle review each run on their separately-configured
 *   model (the runner passes the per-cadence configured model to the agent);
 * - a Cycle review's output passes through the adversarial sweep before commit;
 * - "run now" can still invoke EITHER cadence on demand.
 */

/**
 * A `DeliberationRunner` test layer whose deliberator CAPTURES, per call, the
 * assembled prompt and the model the runner passed, and returns a mutable,
 * test-controlled output. The sweep is configurable so the "through the sweep"
 * leg can prove the SWEEP's output lands. One shared `Store` instance
 * (`Layer.provide` + `Layer.provideMerge` of the same reference memoize to a
 * single build), so `store.setCadenceModel` writes are visible to the runner.
 */
const makeCycleRunnerLayer = (
  sweep: (draft: DeliberationRunOutput) => DeliberationRunOutput = (draft) => draft,
) => {
  const state: {
    output: DeliberationRunOutput;
    calls: Array<{
      readonly prompt: string;
      readonly model: string | undefined;
      readonly effort: string | undefined;
    }>;
    /** What the runner handed the SWEEP — a second session, configured from the same settings row. */
    sweepCalls: Array<{ readonly model: string | undefined; readonly effort: string | undefined }>;
  } = {
    output: { decisions: [], observation_directives: [] },
    calls: [],
    sweepCalls: [],
  };
  const AgentCapture = Layer.succeed(DeliberationAgent)({
    run: (assembledPrompt, model, effort) => {
      state.calls.push({ prompt: assembledPrompt, model, effort });
      return Effect.succeed({
        output: state.output,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0,
      });
    },
  });
  const SweepConfigurable = Layer.succeed(DeliberationSweepAgent)({
    run: (draft, _evidenceRoster, model, effort) => {
      state.sweepCalls.push({ model, effort });
      return Effect.succeed({ output: sweep(draft), usage: ZERO_TOKEN_USAGE, costUsd: 0 });
    },
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

describe("DeliberationRunner cycle review (ADR 0011 §4, issue #31)", () => {
  it("a monthly Cycle review assembles LONG-HISTORY framing that differs from Session review's recent-focus framing (Seam 2)", async () => {
    const { state, layer } = makeCycleRunnerLayer();
    state.output = { decisions: [observationDraft("A cycle-level observation")], observation_directives: [] };

    const { sessionPrompt, cyclePrompt } = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* runner.runSessionReview({ sessionIdsConsidered: ["logged-1"] });
      const sessionPrompt = state.calls.at(-1)?.prompt ?? "";
      yield* runner.runCycleReview;
      const cyclePrompt = state.calls.at(-1)?.prompt ?? "";
      return { sessionPrompt, cyclePrompt };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // The two cadences produce genuinely different assembled context...
    expect(cyclePrompt).not.toEqual(sessionPrompt);
    // ...and the difference is the intended framing: Cycle = long history,
    // Session = recent focus (ADR 0011 §4).
    expect(cyclePrompt).toContain("Cycle review");
    expect(cyclePrompt.toLowerCase()).toContain("longer history");
    expect(sessionPrompt).toContain("Session review");
    expect(sessionPrompt.toLowerCase()).toContain("recent data");
    // Each carries its OWN framing, not the other's.
    expect(cyclePrompt).not.toContain("Session review — focus on the current cycle");
    expect(sessionPrompt).not.toContain("Cycle review — weigh the longer history");
  });

  it("Session review and Cycle review each run on their separately-configured model", async () => {
    const { state, layer } = makeCycleRunnerLayer();
    state.output = { decisions: [observationDraft("obs")], observation_directives: [] };

    const captured = await Effect.gen(function* () {
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      // Configure a cheap model for the frequent Session review, a stronger
      // one for the rare Cycle review (ADR 0011 §4's motivating example).
      yield* store.setCadenceModel({ cadence: "session-review", model: "model-cheap-fast" });
      yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-strong-slow" });

      yield* runner.runSessionReview({ sessionIdsConsidered: [] });
      const sessionModel = state.calls.at(-1)?.model;
      yield* runner.runCycleReview;
      const cycleModel = state.calls.at(-1)?.model;
      return { sessionModel, cycleModel };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(captured.sessionModel).toBe("model-cheap-fast");
    expect(captured.cycleModel).toBe("model-strong-slow");
  });

  it("passes the cadence's configured reasoning effort to BOTH agent stages, not just the model (issue #81)", async () => {
    // The setting was persisted and rendered before this change and then went
    // nowhere: the runner read `model` and dropped `effort` on the floor, so a
    // user who picked an effort level got a control that changed nothing.
    const { state, layer } = makeCycleRunnerLayer();
    state.output = { decisions: [observationDraft("obs")], observation_directives: [] };

    const captured = await Effect.gen(function* () {
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-strong-slow", effort: "max" });

      yield* runner.runCycleReview;
      return { deliberator: state.calls.at(-1), sweep: state.sweepCalls.at(-1) };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(captured.deliberator?.effort).toBe("max");
    // The sweep is a SECOND session and is never skipped, so it must run under
    // the same configuration — otherwise the ledger row it writes names a
    // model and effort that did not produce it.
    expect(captured.sweep).toEqual({ model: "model-strong-slow", effort: "max" });
  });

  it("leaves effort undefined when a cadence configures a model but no effort override", async () => {
    // "This model, at whatever effort it defaults to" is a real, distinct
    // state from "some effort level" — the runner must not invent one.
    const { state, layer } = makeCycleRunnerLayer();
    state.output = { decisions: [observationDraft("obs")], observation_directives: [] };

    const effort = await Effect.gen(function* () {
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-strong-slow" });
      yield* runner.runCycleReview;
      return state.calls.at(-1)?.effort;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(effort).toBeUndefined();
  });

  it("drops an effort value the SDK would not recognise rather than failing the run", async () => {
    // The Store deliberately does not re-validate `effort` (the trust boundary
    // is the contract's decode on the wire), so a row written by anything but
    // the RPC can hold a junk string. Binning a whole Deliberation run over an
    // unusable option would be the wrong trade.
    const { state, layer } = makeCycleRunnerLayer();
    state.output = { decisions: [observationDraft("obs")], observation_directives: [] };

    const captured = await Effect.gen(function* () {
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      yield* store.setCadenceModel({
        cadence: "cycle-review",
        model: "model-strong-slow",
        effort: "ludicrous" as never,
      });
      yield* runner.runCycleReview;
      return { model: state.calls.at(-1)?.model, effort: state.calls.at(-1)?.effort };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(captured.model).toBe("model-strong-slow");
    expect(captured.effort).toBeUndefined();
  });

  it("falls back to the agent's default model (undefined) when a cadence has no configured model", async () => {
    const { state, layer } = makeCycleRunnerLayer();
    state.output = { decisions: [observationDraft("obs")], observation_directives: [] };

    const model = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* runner.runCycleReview; // no setCadenceModel call first
      return state.calls.at(-1)?.model;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(model).toBeUndefined();
  });

  it("a Cycle review's output passes through the adversarial sweep before commit", async () => {
    // The sweep rewrites the draft (marker) so we can prove the STORE reflects
    // the SWEEP's output, never the deliberator's draft — for the cycle cadence.
    const swept: DeliberationRunOutput = {
      decisions: [observationDraft("SWEEP-MARKER: swept cycle output")],
      observation_directives: [],
    };
    let sweepInvocations = 0;
    const { state, layer } = makeCycleRunnerLayer((_draft) => {
      sweepInvocations += 1;
      return swept;
    });
    state.output = {
      decisions: [observationDraft("DRAFT-MARKER: unswept cycle draft")],
      observation_directives: [],
    };

    const decisions = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* runner.runCycleReview;
      return yield* store.listDecisionsForTest;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(sweepInvocations).toBe(1); // the sweep ran, exactly once, never skipped
    expect(decisions.some((d) => d.summary.startsWith("SWEEP-MARKER"))).toBe(true);
    expect(decisions.some((d) => d.summary.startsWith("DRAFT-MARKER"))).toBe(false);
  });

  it("the committed Cycle-review decisions carry cadence 'cycle-review' in their provenance envelope", async () => {
    const { state, layer } = makeCycleRunnerLayer();
    state.output = { decisions: [observationDraft("cycle obs")], observation_directives: [] };

    const decisions = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const result = yield* runner.runCycleReview;
      const all = yield* store.listDecisionsForTest;
      return all.filter((d) => (result.decisionIds as ReadonlyArray<string>).includes(d.id));
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(decisions).toHaveLength(1);
    const dataWindow = JSON.parse(decisions[0]?.dataWindowJson ?? "{}") as { readonly cadence?: string };
    expect(dataWindow.cadence).toBe("cycle-review");
  });

  it("'run now' invokes EITHER cadence on demand — on-demand, session-review, and cycle-review each commit", async () => {
    const { state, layer } = makeCycleRunnerLayer();
    state.output = { decisions: [observationDraft("obs")], observation_directives: [] };

    const cadences = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;

      yield* runner.runNow; // on-demand
      yield* runner.runSessionReview({ sessionIdsConsidered: [] });
      yield* runner.runCycleReview;

      const all = yield* store.listDecisionsForTest;
      return all
        .map((d) => JSON.parse(d.dataWindowJson ?? "{}") as { readonly cadence?: string })
        .map((w) => w.cadence)
        .filter((c): c is string => c !== undefined);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // All three cadences ran on demand and committed through the same mechanism.
    expect(cadences).toContain("on-demand");
    expect(cadences).toContain("session-review");
    expect(cadences).toContain("cycle-review");
  });
});
