import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "vitest";

import {
  ZERO_TOKEN_USAGE,
  type CatalogEnrichment,
  type DeliberationRunOutput,
  type ExerciseId,
} from "@repcoach/contracts";

import { sanitizeCatalogEnrichments } from "./agents/agentSdkSession.ts";
import { DeliberationAgent } from "./agents/deliberationAgent.ts";
import { DeliberationRunner } from "./deliberation/deliberationRunner.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberation/deliberationSnapshot.ts";
import { DeliberationSweepAgent } from "./agents/deliberationSweepAgent.ts";
import { UnwiredIntakeSessionAgent } from "./agents/intakeSessionAgent.ts";
import { CannedIntakeSweepAgent } from "./agents/intakeSweepAgent.ts";
import { QuotaServiceAlwaysAvailable } from "./agents/quotaService.ts";
import { SeedInputsProvider, SeedInputsProviderLive, assembleSeed } from "./deliberation/seedContext.ts";
import { Store } from "./store.ts";

/**
 * Silent catalog enrichment (#104, ADR 0016) at the two seams above the
 * store: what the SEED offers the coach, and what the RUNNER does with what
 * comes back.
 *
 * Black-box on both. The seed is asserted as a string containing the roster
 * (never by reading `renderEnrichmentSection`'s body), and the runner is
 * asserted through the `Store` — the catalog rows it wrote, and the Decision
 * log it did not touch.
 */

const id = (value: string): ExerciseId => value as ExerciseId;

const ZERCHER = id("exercise-zercher-squat");

const emptyOutput: DeliberationRunOutput = { decisions: [], observation_directives: [] };

const withEnrichments = (enrichments: ReadonlyArray<CatalogEnrichment>): DeliberationRunOutput => ({
  ...emptyOutput,
  catalog_enrichments: enrichments,
});

/**
 * A runner wired to a deliberator returning `draft`, and a sweep that models
 * the REAL one: it echoes the decisions and drops `catalog_enrichments`
 * entirely, because the sweep is never told the field exists (it verifies
 * citations, and an enrichment carries none). A runner that read enrichments
 * off the sweep's output rather than the draft's would silently write nothing
 * here, which is exactly the regression worth catching.
 */
const makeRunnerLayer = (draft: DeliberationRunOutput) => {
  const DeliberationAgentTest = Layer.succeed(DeliberationAgent)({
    run: () => Effect.succeed({ output: draft, usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
  });
  const CitationOnlySweep = Layer.succeed(DeliberationSweepAgent)({
    run: (drafted) =>
      Effect.succeed({
        output: { decisions: drafted.decisions, observation_directives: drafted.observation_directives },
        usage: ZERO_TOKEN_USAGE,
        costUsd: 0,
      }),
  });

  return DeliberationRunner.layer.pipe(
    Layer.provide(DeliberationAgentTest),
    Layer.provide(CitationOnlySweep),
    Layer.provide(UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(QuotaServiceAlwaysAvailable),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  );
};

const runWith = <A, E>(
  draft: DeliberationRunOutput,
  effect: Effect.Effect<A, E, DeliberationRunner | Store>,
): Promise<A> =>
  effect.pipe(Effect.provide(makeRunnerLayer(draft)), Effect.scoped, Effect.runPromise);

const SeedLayer = SeedInputsProviderLive.pipe(Layer.provideMerge(Store.layer));

const buildSeed = <A, E>(effect: Effect.Effect<A, E, SeedInputsProvider | Store>): Promise<A> =>
  effect.pipe(Effect.provide(SeedLayer), Effect.scoped, Effect.runPromise);

describe("the Session-review seed carries the un-enriched roster (#104)", () => {
  it("names every un-enriched row, by id and by the user's own name", async () => {
    const seed = await buildSeed(
      Effect.gen(function* () {
        const store = yield* Store;
        const provider = yield* SeedInputsProvider;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        const inputs = yield* provider.buildSeedInputs({
          cadence: "session-review",
          snapshotDbPath: "/tmp/fake-snapshot.sqlite",
        });
        return assembleSeed(inputs);
      }),
    );

    expect(seed).toContain(ZERCHER);
    expect(seed).toContain("Zercher Squat");
    // The field it must add to its output is named, since nothing else in the
    // output-format instruction mentions it.
    expect(seed).toContain("catalog_enrichments");
  });

  it("offers only the un-enriched rows — a filled-in row is not in the roster", async () => {
    const { seed, enrichedName } = await buildSeed(
      Effect.gen(function* () {
        const store = yield* Store;
        const provider = yield* SeedInputsProvider;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        yield* store.createExercise({ exerciseId: id("exercise-jefferson"), name: "Jefferson Curl" });
        yield* store.enrichExercises({
          enrichments: [
            {
              exercise_id: id("exercise-jefferson"),
              tracked_metrics: ["reps", "load"],
              muscles: ["spinal erectors", "hamstrings"],
              movement_pattern: "hinge",
            },
          ],
        });
        const inputs = yield* provider.buildSeedInputs({
          cadence: "session-review",
          snapshotDbPath: "/tmp/fake-snapshot.sqlite",
        });
        return { seed: assembleSeed(inputs), enrichedName: "exercise-jefferson" };
      }),
    );

    expect(seed).toContain(ZERCHER);
    expect(seed).not.toContain(enrichedName);
  });

  it("says nothing at all about enrichment when there is nothing outstanding", async () => {
    const seed = await buildSeed(
      Effect.gen(function* () {
        const store = yield* Store;
        const provider = yield* SeedInputsProvider;
        // Fill in every row the seed store ships with, so the roster is empty.
        const roster = yield* store.listUnenrichedExercises;
        yield* store.enrichExercises({
          enrichments: roster.map((row) => ({
            exercise_id: row.id,
            tracked_metrics: ["reps" as const, "load" as const],
            muscles: ["quadriceps"],
            movement_pattern: "squat",
          })),
        });
        const inputs = yield* provider.buildSeedInputs({
          cadence: "session-review",
          snapshotDbPath: "/tmp/fake-snapshot.sqlite",
        });
        return assembleSeed(inputs);
      }),
    );

    expect(seed).not.toContain("catalog_enrichments");
    expect(seed).not.toContain("awaiting metadata");
    // Still the review it always was.
    expect(seed).toContain("## Standing constraints");
    expect(seed).toContain("## Data dictionary (table -> columns)");
  });

  it("offers the roster on Session review and on no other cadence", async () => {
    const seeds = await buildSeed(
      Effect.gen(function* () {
        const store = yield* Store;
        const provider = yield* SeedInputsProvider;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        const forCadence = (cadence: "session-review" | "cycle-review" | "on-demand" | "revision-run") =>
          provider
            .buildSeedInputs({ cadence, snapshotDbPath: "/tmp/fake-snapshot.sqlite" })
            .pipe(Effect.map(assembleSeed));
        return {
          sessionReview: yield* forCadence("session-review"),
          cycleReview: yield* forCadence("cycle-review"),
          onDemand: yield* forCadence("on-demand"),
          revision: yield* forCadence("revision-run"),
        };
      }),
    );

    expect(seeds.sessionReview).toContain(ZERCHER);
    expect(seeds.cycleReview).not.toContain("catalog_enrichments");
    expect(seeds.onDemand).not.toContain("catalog_enrichments");
    expect(seeds.revision).not.toContain("catalog_enrichments");
  });
});

describe("the runner writes the enrichment, and writes nothing else (#104)", () => {
  it("fills in the row from the DELIBERATOR's draft, which the sweep never carried", async () => {
    const draft = withEnrichments([
      {
        exercise_id: ZERCHER,
        tracked_metrics: ["reps", "load"],
        muscles: ["quadriceps", "upper back"],
        movement_pattern: "squat",
      },
    ]);

    const { metadata, roster } = await runWith(
      draft,
      Effect.gen(function* () {
        const store = yield* Store;
        const runner = yield* DeliberationRunner;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        yield* runner.runSessionReview({ sessionIdsConsidered: [] });
        return {
          metadata: yield* store.getExerciseEnrichmentForTest(ZERCHER),
          roster: yield* store.listUnenrichedExercises,
        };
      }),
    );

    const enriched = Option.getOrThrow(metadata);
    expect(enriched.trackedMetrics).toEqual(["reps", "load"]);
    expect(enriched.muscles).toEqual(["quadriceps", "upper back"]);
    expect(enriched.movementPattern).toBe("squat");
    expect(roster.map((row) => row.id)).not.toContain(ZERCHER);
  });

  it("surfaces nothing: no Decision row, and nothing on the Coaching feed", async () => {
    const draft = withEnrichments([
      { exercise_id: ZERCHER, tracked_metrics: ["reps", "load"], muscles: ["quadriceps"] },
    ]);

    const { decisionsBefore, decisionsAfter, feed } = await runWith(
      draft,
      Effect.gen(function* () {
        const store = yield* Store;
        const runner = yield* DeliberationRunner;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        const decisionsBefore = yield* store.listDecisionsForTest;
        const result = yield* runner.runSessionReview({ sessionIdsConsidered: [] });
        return {
          decisionsBefore,
          decisionsAfter: yield* store.listDecisionsForTest,
          feed: result.feedEntryIds,
        };
      }),
    );

    // The run emitted no decisions of its own, so an enrichment that had
    // quietly become one would be the only new row.
    expect(decisionsAfter.map((decision) => decision.id)).toEqual(
      decisionsBefore.map((decision) => decision.id),
    );
    expect(feed).toEqual([]);
  });

  it("leaves the row name-only and usable when the run returns no enrichment at all", async () => {
    const { metadata, catalogName } = await runWith(
      emptyOutput,
      Effect.gen(function* () {
        const store = yield* Store;
        const runner = yield* DeliberationRunner;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        yield* runner.runSessionReview({ sessionIdsConsidered: [] });
        const catalog = yield* store.getExerciseCatalog;
        return {
          metadata: yield* store.getExerciseEnrichmentForTest(ZERCHER),
          catalogName: catalog.exercises.find((exercise) => exercise.id === ZERCHER)?.name,
        };
      }),
    );

    const enriched = Option.getOrThrow(metadata);
    expect(enriched.trackedMetrics).toEqual([]);
    expect(enriched.muscles).toBeUndefined();
    // Still in the picker, still addable to a Plan.
    expect(catalogName).toBe("Zercher Squat");
  });

  it("does not write catalog metadata on a cadence that was never offered the roster", async () => {
    const draft = withEnrichments([
      { exercise_id: ZERCHER, tracked_metrics: ["reps", "load"], muscles: ["quadriceps"] },
    ]);

    const metadata = await runWith(
      draft,
      Effect.gen(function* () {
        const store = yield* Store;
        const runner = yield* DeliberationRunner;
        yield* store.createExercise({ exerciseId: ZERCHER, name: "Zercher Squat" });
        yield* runner.runCycleReview;
        return yield* store.getExerciseEnrichmentForTest(ZERCHER);
      }),
    );

    expect(Option.getOrThrow(metadata).trackedMetrics).toEqual([]);
  });

  it("commits the review even when the enrichment write fails", async () => {
    const draft: DeliberationRunOutput = {
      decisions: [
        {
          kind: "observation",
          summary: "Bench press has held flat for three sessions.",
          rationale: "The finding this review exists for — it must survive a failed metadata write.",
          citations: [],
          reasoning_only_points: [],
          surface: true,
        },
      ],
      observation_directives: [],
      catalog_enrichments: [{ exercise_id: ZERCHER, muscles: ["quadriceps"] }],
    };

    // A store whose ONLY difference is that enrichment dies — the failure
    // mode the acceptance criterion names ("does not fail the review").
    const FailingEnrichStore = Layer.effect(Store)(
      Effect.gen(function* () {
        const store = yield* Store;
        return Store.of({
          ...store,
          enrichExercises: () => Effect.die(new Error("catalog write exploded")),
        });
      }),
    ).pipe(Layer.provide(Store.layer));

    const DeliberationAgentTest = Layer.succeed(DeliberationAgent)({
      run: () => Effect.succeed({ output: draft, usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
    });
    const EchoSweep = Layer.succeed(DeliberationSweepAgent)({
      run: (drafted) =>
        Effect.succeed({
          output: { decisions: drafted.decisions, observation_directives: drafted.observation_directives },
          usage: ZERO_TOKEN_USAGE,
          costUsd: 0,
        }),
    });

    const layer = DeliberationRunner.layer.pipe(
      Layer.provide(DeliberationAgentTest),
      Layer.provide(EchoSweep),
      Layer.provide(UnwiredIntakeSessionAgent),
      Layer.provide(CannedIntakeSweepAgent),
      Layer.provide(NoopDeliberationSnapshotForTest),
      Layer.provide(SeedInputsProviderLive),
      Layer.provide(QuotaServiceAlwaysAvailable),
      Layer.provide(FailingEnrichStore),
      Layer.provideMerge(FailingEnrichStore),
    );

    const { result, runStatus } = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const result = yield* runner.runSessionReview({ sessionIdsConsidered: [] });
      const state = yield* SubscriptionRef.get(runner.runState);
      return { result, runStatus: state.status };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(result.decisionIds).toHaveLength(1);
    expect(runStatus).not.toBe("failed");
  });
});

describe("a malformed enrichment cannot cost the review (#104)", () => {
  it("drops entries the store could never write, and keeps the rest of the output", () => {
    const parsed = sanitizeCatalogEnrichments({
      decisions: [],
      observation_directives: [],
      catalog_enrichments: [
        // No id: nothing to write against.
        { muscles: ["quadriceps"] },
        // A metric this app does not track, alongside two that it does.
        { exercise_id: "exercise-zercher-squat", tracked_metrics: ["reps", "sets", "load"] },
        "not an object",
      ],
    }) as { readonly catalog_enrichments: ReadonlyArray<Record<string, unknown>> };

    expect(parsed.catalog_enrichments).toHaveLength(1);
    expect(parsed.catalog_enrichments[0]).toEqual({
      exercise_id: "exercise-zercher-squat",
      tracked_metrics: ["reps", "load"],
    });
  });

  it("leaves the field absent when the run never emitted one", () => {
    const parsed = sanitizeCatalogEnrichments({ decisions: [], observation_directives: [] });
    expect(parsed).not.toHaveProperty("catalog_enrichments");
  });
});
