import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput, TokenUsage } from "@repcoach/contracts";
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
 * ADVERSARIAL — deferral queue ORDERING, no-clobber, flapping quota, empty-queue
 * recovery, and per-run token-usage attribution (ADR 0011 §8, issue #32).
 *
 * Hostile edges the happy-path deferral tests skip: several queued runs of
 * DIFFERENT cadences flushing on one recovery; a run that must fire with its
 * OWN cadence + session-id provenance (never re-derived from shared state); a
 * rapidly flapping quota that must not double-fire or drop a run; a recovery
 * signal against an empty queue; and token usage that must reflect the run that
 * produced it rather than a stale prior run.
 */

const observationDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary,
  rationale: "rationale",
  citations: [],
  reasoning_only_points: [],
  surface: true,
});

const makeRunnerLayer = (opts?: {
  readonly usageForCall?: (callIndex: number) => TokenUsage;
}) => {
  const state: {
    output: DeliberationRunOutput;
    calls: Array<{ readonly prompt: string; readonly model: string | undefined }>;
  } = {
    output: { decisions: [observationDraft("run")], observation_directives: [] },
    calls: [],
  };

  const AgentCapture = Layer.succeed(DeliberationAgent)({
    run: (assembledPrompt, model) => {
      const callIndex = state.calls.length;
      state.calls.push({ prompt: assembledPrompt, model });
      const usage = opts?.usageForCall?.(callIndex) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      return Effect.succeed({ output: state.output, usage, costUsd: 0 });
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

const cadenceOf = (dataWindowJson: string | null): string | undefined => {
  if (dataWindowJson === null) return undefined;
  return (JSON.parse(dataWindowJson) as { readonly cadence?: string }).cadence;
};

describe("DeliberationRunner deferral — ordering / clobber / flapping (issue #32)", () => {
  it("three queued runs of DIFFERENT cadences all fire on one recovery, each with its OWN cadence + session ids (no clobber)", async () => {
    const { state, setLow, setAvailable, layer } = makeRunnerLayer();

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;

      yield* setLow;
      const f1 = yield* Effect.forkScoped(runner.runNow); // on-demand, []
      const f2 = yield* Effect.forkScoped(
        runner.runSessionReview({ sessionIdsConsidered: ["s1", "s2"] }),
      );
      const f3 = yield* Effect.forkScoped(runner.runCycleReview); // cycle-review, []

      // Let all three enqueue and await their Deferreds.
      yield* Effect.sleep("15 millis");
      const callsWhileLow = state.calls.length;
      const stateWhileLow = yield* SubscriptionRef.get(runner.runState);

      yield* setAvailable;
      const r1 = yield* Fiber.join(f1);
      const r2 = yield* Fiber.join(f2);
      const r3 = yield* Fiber.join(f3);

      const decisions = yield* store.listDecisionsForTest;
      return { callsWhileLow, stateWhileLow, r1, r2, r3, decisions };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // Nothing ran while low; all three were queued.
    expect(outcome.callsWhileLow).toBe(0);
    expect(outcome.stateWhileLow.queuedCount).toBe(3);

    // All three fired exactly once each — no lost or duplicated run.
    expect(state.calls).toHaveLength(3);

    // Each fiber got its OWN committed result (a single decision), no clobber.
    expect(outcome.r1.decisionIds).toHaveLength(1);
    expect(outcome.r2.decisionIds).toHaveLength(1);
    expect(outcome.r3.decisionIds).toHaveLength(1);

    // Restrict to the decisions THIS test committed (the store is seeded with a
    // pre-existing decision), keyed by the ids the three runs returned.
    const committedIds = new Set<string>([
      ...outcome.r1.decisionIds.map(String),
      ...outcome.r2.decisionIds.map(String),
      ...outcome.r3.decisionIds.map(String),
    ]);
    const committed = outcome.decisions.filter((d) => committedIds.has(String(d.id)));
    expect(committed).toHaveLength(3);

    // Each cadence is represented exactly once across the committed decisions.
    const cadences = committed.map((d) => cadenceOf(d.dataWindowJson)).sort();
    expect(cadences).toEqual(["cycle-review", "on-demand", "session-review"]);

    // The session-review run carried its OWN session-id provenance, not clobbered.
    const sessionReviewDecision = committed.find(
      (d) => cadenceOf(d.dataWindowJson) === "session-review",
    );
    const sessionIds = JSON.parse(sessionReviewDecision?.dataWindowJson ?? "{}").session_ids_considered as
      | ReadonlyArray<string>
      | undefined;
    expect(sessionIds).toEqual(["s1", "s2"]);
  });

  it("a rapidly flapping quota (available→low→available) fires a single queued run exactly once — no double-commit, no lost run", async () => {
    const { state, setLow, setAvailable, layer } = makeRunnerLayer();

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;

      yield* setLow;
      const f = yield* Effect.forkScoped(runner.runNow);
      yield* Effect.sleep("10 millis");

      // Flap: recover, drop, recover again in quick succession.
      yield* setAvailable;
      yield* setLow;
      yield* setAvailable;

      const result = yield* Fiber.join(f);
      const decisions = yield* store.listDecisionsForTest;
      return { result, decisions };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // The queued run executed exactly ONCE despite the flapping — no double-fire
    // (which would show as a second agent call) and no lost run (which would
    // hang the joined fiber). One execution ⇒ one committed decision id.
    expect(state.calls).toHaveLength(1);
    expect(outcome.result.decisionIds).toHaveLength(1);
    // Exactly one of this run's committed ids is present in the store.
    const runIds = new Set<string>(outcome.result.decisionIds.map(String));
    const committed = outcome.decisions.filter((d) => runIds.has(String(d.id)));
    expect(committed).toHaveLength(1);
  });

  it("a quotaAvailable recovery signal against an EMPTY queue is a harmless no-op (no crash, no phantom run)", async () => {
    const { state, setAvailable, layer } = makeRunnerLayer();

    const finalState = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;

      // No run was ever queued; a recovery signal must not synthesize a run.
      yield* setAvailable;
      yield* Effect.sleep("10 millis");

      return yield* SubscriptionRef.get(runner.runState);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(state.calls).toHaveLength(0);
    expect(finalState.queuedCount).toBe(0);
  });

  it("token usage reflects the run that produced it — a deferred run that later fires carries ITS OWN usage, not the prior run's", async () => {
    // Call 0 (immediate run) uses {100,10}; call 1 (the deferred run) uses {200,20}.
    const { setLow, setAvailable, layer } = makeRunnerLayer({
      usageForCall: (i) => (i === 0 ? { input: 100, output: 10, cacheRead: 0, cacheCreation: 0 } : { input: 200, output: 20, cacheRead: 0, cacheCreation: 0 }),
    });

    const usage = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;

      // Immediate run — sets tokenUsage to {100,10}.
      yield* runner.runNow;
      const afterFirst = yield* SubscriptionRef.get(runner.runState);

      // Defer a second run; it must overwrite tokenUsage with ITS own {200,20}.
      yield* setLow;
      const f = yield* Effect.forkScoped(runner.runCycleReview);
      yield* Effect.sleep("10 millis");
      yield* setAvailable;
      yield* Fiber.join(f);
      const afterDeferred = yield* SubscriptionRef.get(runner.runState);

      return { afterFirst: afterFirst.tokenUsage, afterDeferred: afterDeferred.tokenUsage };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(usage.afterFirst).toEqual({ input: 100, output: 10, cacheRead: 0, cacheCreation: 0 });
    // Not stale: the deferred run's usage replaced the prior run's.
    expect(usage.afterDeferred).toEqual({ input: 200, output: 20, cacheRead: 0, cacheCreation: 0 });
  });
});
