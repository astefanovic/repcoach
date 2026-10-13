import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput } from "@repcoach/contracts";

import { DeliberationRunKilledError } from "./agentSdkSession.ts";
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
 * The runner writes the run's own row (ADR 0011 §8, the Coach run history).
 *
 * `deliberationRunRecord.test.ts` (persistence) proves the store can HOLD the
 * three outcomes. This proves the runner actually produces them, which is the
 * half that matters: ADR 0011 §3/§6 makes the runner the only thing allowed to
 * write these rows, so if it does not write them nothing else will.
 *
 * The two claims are the two states the feature exists for, and neither is
 * reachable from the Decisions a run commits:
 *
 * - **A run that commits nothing still leaves a row.** Its zero Decisions
 *   write zero `decision` rows, so before this the restraint ADR 0011 §4 asks
 *   for was indistinguishable from the coach never having run.
 * - **A run that dies leaves a row saying why.** The reason used to live only
 *   in `runStateRef`, which the next run overwrites and a restart forgets.
 *
 * Plus the rule that must not be broken to get either: a failed bookkeeping
 * write may never fail the run it is recording (ADR 0011 §6).
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

const SweepPassThrough = Layer.succeed(DeliberationSweepAgent)({
  run: (draft) => Effect.succeed({ output: draft, usage: ZERO_USAGE, costUsd: 0 }),
});

const runnerLayerWith = (agent: Layer.Layer<DeliberationAgent>) =>
  DeliberationRunner.layer.pipe(
    Layer.provide(agent),
    Layer.provide(SweepPassThrough),
    Layer.provide(UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(QuotaServiceAlwaysAvailable),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  );

/** Every run on the record that this test's runner produced — the seeded ones excluded. */
const runsAddedByTheRunner = Effect.gen(function* () {
  const store = yield* Store;
  const runs = yield* store.getDeliberationRuns;
  return runs.filter((run) => !run.runId.startsWith("run-seed-"));
});

describe("the runner writes the run's own row (ADR 0011 §8)", () => {
  it("records a run that emitted nothing — the state no Decision row can represent", async () => {
    const SilentAgent = Layer.succeed(DeliberationAgent)({
      run: () =>
        Effect.succeed({
          // The restrained run: both stages went, nothing cleared the bar.
          output: { decisions: [], observation_directives: [] },
          usage: ZERO_USAGE,
          costUsd: 0,
        }),
    });

    const runs = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const result = yield* runner.runNow;
      // The premise: this run genuinely wrote no Decision rows at all.
      expect(result.decisionIds).toEqual([]);
      return yield* runsAddedByTheRunner;
    }).pipe(Effect.provide(runnerLayerWith(SilentAgent)), Effect.scoped, Effect.runPromise);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("committed");
    expect(runs[0]?.decisions).toEqual([]);
    // And it says what it read, which is what turns "said nothing" from an
    // absence into a statement.
    expect(runs[0]?.dataWindow?.cadence).toBe("on-demand");
  });

  it("records a run that died, with the reason, after the process that held it in memory is gone", async () => {
    const DyingAgent = Layer.succeed(DeliberationAgent)({
      run: () =>
        Effect.die(
          new DeliberationRunKilledError({ reason: "max-turns", detail: "hit the turn cap (24 turns) before producing output" }),
        ),
    });

    const [exit, runs] = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const exit = yield* Effect.exit(runner.runNow);
      return [exit, yield* runsAddedByTheRunner] as const;
    }).pipe(Effect.provide(runnerLayerWith(DyingAgent)), Effect.scoped, Effect.runPromise);

    // The run still fails loudly — recording it must not swallow it.
    expect(Exit.isFailure(exit)).toBe(true);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("failed");
    expect(runs[0]?.failureReason).toBeDefined();
    expect(runs[0]?.decisions).toEqual([]);
    // Nothing part-formed was committed (ADR 0011 §6), so the run has no
    // window either — it never got as far as assembling one.
    expect(runs[0]?.dataWindow).toBeUndefined();
  });

  it("lists a run's Decisions beneath the run that produced them", async () => {
    const SpeakingAgent = Layer.succeed(DeliberationAgent)({
      run: () =>
        Effect.succeed({
          output: {
            decisions: [observationDraft("Squat load held."), observationDraft("Sleep is down.")],
            observation_directives: [],
          },
          usage: ZERO_USAGE,
          costUsd: 0,
        }),
    });

    const [committed, runs] = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const result = yield* runner.runNow;
      return [result.decisionIds, yield* runsAddedByTheRunner] as const;
    }).pipe(Effect.provide(runnerLayerWith(SpeakingAgent)), Effect.scoped, Effect.runPromise);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("committed");
    // Exactly the rows this run wrote, and no others — the tie is the run id
    // stamped at commit time, not a timestamp heuristic.
    expect([...(runs[0]?.decisions ?? [])].map((d) => d.decisionId).sort()).toEqual(
      [...committed].sort(),
    );
  });

  it("marks both stages done once the run has committed", async () => {
    const SpeakingAgent = Layer.succeed(DeliberationAgent)({
      run: () =>
        Effect.succeed({
          output: { decisions: [observationDraft("Squat load held.")], observation_directives: [] },
          usage: ZERO_USAGE,
          costUsd: 0,
        }),
    });

    const runs = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* runner.runNow;
      return yield* runsAddedByTheRunner;
    }).pipe(Effect.provide(runnerLayerWith(SpeakingAgent)), Effect.scoped, Effect.runPromise);

    expect(runs[0]?.stages).toEqual([
      { stage: "deliberator", state: "done" },
      { stage: "sweep", state: "done" },
    ]);
  });

  it("commits the run's Decisions even when every write to the run's own row fails", async () => {
    // ADR 0011 §6's rule, driven rather than asserted about: losing the record
    // OF a Decision must never cost the Decision. A store whose three run-row
    // writes all fail must still produce a committed run output.
    const SpeakingAgent = Layer.succeed(DeliberationAgent)({
      run: () =>
        Effect.succeed({
          output: { decisions: [observationDraft("Squat load held.")], observation_directives: [] },
          usage: ZERO_USAGE,
          costUsd: 0,
        }),
    });

    const BrokenRunRecordStore = Layer.effect(Store)(
      Effect.gen(function* () {
        const base = yield* Store;
        return Store.of({
          ...base,
          startDeliberationRun: () => Effect.die(new Error("run table is gone")),
          finishDeliberationRun: () => Effect.die(new Error("run table is gone")),
          discardDeliberationRun: () => Effect.die(new Error("run table is gone")),
        });
      }),
    ).pipe(Layer.provide(Store.layer));

    const result = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      return yield* runner.runNow;
    }).pipe(
      Effect.provide(
        DeliberationRunner.layer.pipe(
          Layer.provide(SpeakingAgent),
          Layer.provide(SweepPassThrough),
          Layer.provide(UnwiredIntakeSessionAgent),
          Layer.provide(CannedIntakeSweepAgent),
          Layer.provide(NoopDeliberationSnapshotForTest),
          Layer.provide(SeedInputsProviderLive),
          Layer.provide(QuotaServiceAlwaysAvailable),
          Layer.provide(BrokenRunRecordStore),
          Layer.provideMerge(BrokenRunRecordStore),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(result.decisionIds).toHaveLength(1);
  });
});
