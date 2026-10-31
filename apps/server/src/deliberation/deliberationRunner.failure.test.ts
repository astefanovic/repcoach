import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput } from "@repcoach/contracts";

import { DeliberationRunKilledError, DeliberationRunOutputParseError } from "../agents/agentSdkSession.ts";
import { DeliberationAgent } from "../agents/deliberationAgent.ts";
import { DeliberationRunner } from "./deliberationRunner.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { DeliberationSweepAgent } from "../agents/deliberationSweepAgent.ts";
import { UnwiredIntakeSessionAgent } from "../agents/intakeSessionAgent.ts";
import { CannedIntakeSweepAgent } from "../agents/intakeSweepAgent.ts";
import { makeCannedQuotaService, QuotaServiceAlwaysAvailable } from "../agents/quotaService.ts";
import { SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "../store.ts";

/**
 * Issue #90: a killed session, an unparseable output, or a session that
 * could not start no longer vanish silently — they end in a "failed" run
 * state carrying a human-readable reason, reachable via the same
 * `runState` subscription a successful run's status already rides.
 *
 * Issue #94 moved WHERE that starts: the real deliberator/sweep now fail TYPED
 * (`DeliberationRunFailure` on the port), and the runner converts it to the
 * same defect at the one boundary that owns `runState` (`dieOnRunFailure`).
 * Most of these tests drive the defect path directly through `Effect.die(...)`
 * stand-ins because that is what reaches the runner's recording; the last one
 * drives a typed failure end to end, the shape the real adapters now produce.
 */

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } as const;

const observationDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary,
  rationale: "rationale",
  citations: [],
  reasoning_only_points: [],
  surface: true,
});

/**
 * Builds a `DeliberationRunner` test layer whose deliberator dies with the
 * given defect on its Nth call (1-indexed) and succeeds with a trivial
 * Observation on every other call — the same shape `realDeliberationAgent.ts`
 * produces (dies via `Effect.orDie`, never a typed failure).
 */
const makeFailingRunnerLayer = (options: {
  readonly dieOnCall: number;
  readonly defect: unknown;
  readonly quota?: "always-available" | "canned";
}) => {
  let callCount = 0;
  const AgentTest = Layer.succeed(DeliberationAgent)({
    run: (_assembledPrompt, _model) => {
      callCount += 1;
      if (callCount === options.dieOnCall) return Effect.die(options.defect);
      return Effect.succeed({ output: { decisions: [observationDraft(`run ${callCount}`)], observation_directives: [] }, usage: ZERO_USAGE, costUsd: 0 });
    },
  });
  const SweepPassThrough = Layer.succeed(DeliberationSweepAgent)({
    run: (draft) => Effect.succeed({ output: draft, usage: ZERO_USAGE, costUsd: 0 }),
  });

  const quota = options.quota === "canned" ? makeCannedQuotaService() : undefined;

  const layer = DeliberationRunner.layer.pipe(
    Layer.provide(AgentTest),
    Layer.provide(SweepPassThrough),
    // Intake ports the review cadences never touch — provided so the runner layer builds.
    Layer.provide(UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(quota?.layer ?? QuotaServiceAlwaysAvailable),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  );

  return { getCallCount: () => callCount, setLow: quota?.setLow, setAvailable: quota?.setAvailable, layer };
};

/** Builds a variant whose SWEEP (not the deliberator) dies on its Nth call. */
const makeSweepFailingRunnerLayer = (options: { readonly dieOnCall: number; readonly defect: unknown }) => {
  let callCount = 0;
  const AgentPassThrough = Layer.succeed(DeliberationAgent)({
    run: (_assembledPrompt) =>
      Effect.succeed({
        output: { decisions: [observationDraft("draft")], observation_directives: [] },
        usage: ZERO_USAGE,
        costUsd: 0,
      }),
  });
  const SweepTest = Layer.succeed(DeliberationSweepAgent)({
    run: (draft) => {
      callCount += 1;
      if (callCount === options.dieOnCall) return Effect.die(options.defect);
      return Effect.succeed({ output: draft, usage: ZERO_USAGE, costUsd: 0 });
    },
  });

  const layer = DeliberationRunner.layer.pipe(
    Layer.provide(AgentPassThrough),
    Layer.provide(SweepTest),
    Layer.provide(UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(QuotaServiceAlwaysAvailable),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  );

  return { layer };
};

describe("DeliberationRunner: a failed run is surfaced, not silent (issue #90)", () => {
  it("a run killed on the turn cap ends in a failed run state naming the turn cap", async () => {
    const { layer } = makeFailingRunnerLayer({
      dieOnCall: 1,
      defect: new DeliberationRunKilledError({ reason: "max-turns", detail: "run hit the 40-turn cap" }),
    });

    const { runOutcome, state, decisionsBefore, decisionsAfter } = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      // The in-memory Store ships seed fixture decisions (`SEEDED_OBSERVATION_ID`
      // et al.) — "no partial rows" means the count doesn't MOVE, not that it's
      // zero.
      const decisionsBefore = yield* store.listDecisionsForTest;
      const runOutcome = yield* Effect.exit(runner.runNow);
      const state = yield* SubscriptionRef.get(runner.runState);
      const decisionsAfter = yield* store.listDecisionsForTest;
      return { runOutcome, state, decisionsBefore, decisionsAfter };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // The RPC-facing call still dies (unchanged, loud behaviour) — but the
    // run state is what the client actually watches.
    expect(Exit.isFailure(runOutcome)).toBe(true);
    expect(state.status).toBe("failed");
    expect(state.failureReason).toContain("max-turns");
    expect(state.failureReason).toContain("turn cap");

    // No partial rows: the runner's only write never ran.
    expect(decisionsAfter).toHaveLength(decisionsBefore.length);
  });

  it("a run killed on the wall clock ends in a failed run state naming the wall clock", async () => {
    const { layer } = makeFailingRunnerLayer({
      dieOnCall: 1,
      defect: new DeliberationRunKilledError({
        reason: "wall-clock",
        detail: "run exceeded 600000ms wall-clock budget",
      }),
    });

    const state = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* Effect.exit(runner.runNow);
      return yield* SubscriptionRef.get(runner.runState);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(state.status).toBe("failed");
    expect(state.failureReason).toContain("wall-clock");
  });

  it("a session that could not start ends in a failed run state naming that it could not start", async () => {
    const { layer } = makeFailingRunnerLayer({
      dieOnCall: 1,
      defect: new DeliberationRunKilledError({
        reason: "could-not-start",
        detail: "session could not start: OAuth token expired",
      }),
    });

    const state = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* Effect.exit(runner.runNow);
      return yield* SubscriptionRef.get(runner.runState);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(state.status).toBe("failed");
    expect(state.failureReason).toContain("could-not-start");
  });

  it("unparseable deliberator output ends in a failed run state naming the parse failure", async () => {
    const { layer } = makeFailingRunnerLayer({
      dieOnCall: 1,
      defect: new DeliberationRunOutputParseError({ detail: "not valid JSON: Unexpected token" }),
    });

    const state = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* Effect.exit(runner.runNow);
      return yield* SubscriptionRef.get(runner.runState);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(state.status).toBe("failed");
    expect(state.failureReason).toContain("failed to parse against the contract");
  });

  it("unparseable SWEEP output also ends in a failed run state, not a silent commit of the unverified draft", async () => {
    const { layer } = makeSweepFailingRunnerLayer({
      dieOnCall: 1,
      defect: new DeliberationRunOutputParseError({ detail: "sweep output not valid JSON" }),
    });

    const { state, decisionsBefore, decisionsAfter } = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const decisionsBefore = yield* store.listDecisionsForTest;
      yield* Effect.exit(runner.runNow);
      const state = yield* SubscriptionRef.get(runner.runState);
      const decisionsAfter = yield* store.listDecisionsForTest;
      return { state, decisionsBefore, decisionsAfter };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(state.status).toBe("failed");
    expect(state.failureReason).toContain("failed to parse against the contract");
    expect(decisionsAfter).toHaveLength(decisionsBefore.length);
  });

  it("an output that survived neither the extraction nor the repair turn fails typed, naming which way (issue #94)", async () => {
    // What the real deliberator now produces: a TYPED failure on the port,
    // carrying the reason, rather than a defect thrown past it. The user-facing
    // result is unchanged — a failed run state with a readable reason.
    const AgentTypedFailure = Layer.succeed(DeliberationAgent)({
      run: () =>
        Effect.fail(
          new DeliberationRunOutputParseError({
            reason: "contract",
            detail: "deliberation run output failed contract decode | the one repair turn did not fix it",
          }),
        ),
    });
    const SweepPassThrough = Layer.succeed(DeliberationSweepAgent)({
      run: (draft) => Effect.succeed({ output: draft, usage: ZERO_USAGE, costUsd: 0 }),
    });
    const layer = DeliberationRunner.layer.pipe(
      Layer.provide(AgentTypedFailure),
      Layer.provide(SweepPassThrough),
      Layer.provide(UnwiredIntakeSessionAgent),
      Layer.provide(CannedIntakeSweepAgent),
      Layer.provide(NoopDeliberationSnapshotForTest),
      Layer.provide(SeedInputsProviderLive),
      Layer.provide(QuotaServiceAlwaysAvailable),
      Layer.provide(Store.layer),
      Layer.provideMerge(Store.layer),
    );

    const { state, decisionsBefore, decisionsAfter } = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const decisionsBefore = yield* store.listDecisionsForTest;
      yield* Effect.exit(runner.runNow);
      const state = yield* SubscriptionRef.get(runner.runState);
      const decisionsAfter = yield* store.listDecisionsForTest;
      return { state, decisionsBefore, decisionsAfter };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(state.status).toBe("failed");
    expect(state.failureReason).toContain("contract");
    expect(state.failureReason).toContain("the one repair turn did not fix it");
    expect(decisionsAfter).toHaveLength(decisionsBefore.length);
  });

  it("does not wedge the runner: the next cadence run starts and completes normally", async () => {
    const { layer } = makeFailingRunnerLayer({
      dieOnCall: 1, // only the FIRST call dies; the second succeeds
      defect: new DeliberationRunKilledError({ reason: "max-turns", detail: "run hit the 40-turn cap" }),
    });

    const { firstState, secondOutcome, secondState } = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* Effect.exit(runner.runNow);
      const firstState = yield* SubscriptionRef.get(runner.runState);

      const secondOutcome = yield* Effect.exit(runner.runNow);
      const secondState = yield* SubscriptionRef.get(runner.runState);

      return { firstState, secondOutcome, secondState };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(firstState.status).toBe("failed");

    // The second run was not blocked by the first's failure, and its
    // success clears the stale failure state.
    expect(Exit.isSuccess(secondOutcome)).toBe(true);
    expect(secondState.status).toBe("idle");
    expect(secondState.failureReason).toBeUndefined();
  });

  it("a failed DEFERRED run does not wedge the deferral queue: later queued runs still fire", async () => {
    const { layer, setLow, setAvailable } = makeFailingRunnerLayer({
      dieOnCall: 1, // the FIRST queued run (on-demand) dies; the SECOND (session-review) succeeds
      defect: new DeliberationRunKilledError({ reason: "max-turns", detail: "run hit the 40-turn cap" }),
      quota: "canned",
    });
    if (setLow === undefined || setAvailable === undefined) throw new Error("canned quota service required");

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;

      yield* setLow;
      const failingFiber = yield* Effect.forkScoped(runner.runNow);
      const succeedingFiber = yield* Effect.forkScoped(
        runner.runSessionReview({ sessionIdsConsidered: [] }),
      );
      // Give both forked calls a chance to enqueue before quota recovers.
      yield* Effect.sleep("5 millis");

      yield* setAvailable;

      const failingOutcome = yield* Effect.exit(Fiber.join(failingFiber));
      const succeedingOutcome = yield* Effect.exit(Fiber.join(succeedingFiber));
      // `drainQueue` resolves each entry's `Deferred` BEFORE its own recursive
      // call settles `runState` back to idle — the two fibers above can
      // observe their result a beat before that reconciliation lands, so give
      // it a moment rather than asserting on an inherently racy read.
      yield* Effect.sleep("5 millis");
      const finalState = yield* SubscriptionRef.get(runner.runState);

      return { failingOutcome, succeedingOutcome, finalState };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // The failed run's awaiting caller is interrupted rather than left
    // hanging forever.
    expect(Exit.isFailure(outcome.failingOutcome)).toBe(true);

    // Crucially: the SECOND queued run was not stranded behind the first's
    // failure — the deferral daemon kept draining.
    expect(Exit.isSuccess(outcome.succeedingOutcome)).toBe(true);
    if (Exit.isSuccess(outcome.succeedingOutcome)) {
      expect(outcome.succeedingOutcome.value.decisionIds).toHaveLength(1);
    }

    // The runner settled back to idle after the queue fully drained, not
    // stuck at "failed" or "running" forever.
    expect(outcome.finalState.status).toBe("idle");
  });
});
