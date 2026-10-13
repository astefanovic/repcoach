import { describe, expect, it } from "vitest";

import type { IntakeDraftPlan, PlanId } from "@repcoach/contracts";

import { materializeDraftPlan } from "./materialize.ts";
import type { PlanAuthoringContext } from "./operations.ts";

/**
 * Unit coverage for the pure half of #75 — turning an accepted Intake draft
 * into a real Plan. The store-level round trip (both layers, `getPlan` /
 * `subscribePlan` / `startSession`) lives in
 * `packages/persistence/src/acceptedIntakePlan.test.ts`; what is under test
 * here is the shape: replacement, minted ids, one straight Block per session,
 * and authoring a catalog entry for an exerciseId the catalog doesn't have.
 */

const context: PlanAuthoringContext = {
  exercises: [
    { id: "exercise-bench-press", name: "Bench Press", trackedMetrics: ["reps", "load"] },
    { id: "exercise-plank", name: "Plank", trackedMetrics: ["duration"] },
  ],
};

const draft: IntakeDraftPlan = {
  planModel: "upper-lower",
  headline: "Upper / lower, four days a week",
  sessions: [
    {
      label: "Upper A",
      entries: [
        {
          exerciseId: "exercise-bench-press" as never,
          exerciseName: "Bench Press",
          sets: [
            { setType: "working", target: { reps: { min: 6, max: 10 }, load: { min: 60 } }, restSec: 120 },
            { setType: "working", target: { reps: { max: 8 }, rpe: {} } },
          ],
        },
        {
          exerciseId: "exercise-plank" as never,
          exerciseName: "Plank",
          sets: [{ setType: "working", target: { duration: { min: 30, max: 45 } } }],
        },
      ],
    },
    {
      label: "Lower A",
      entries: [
        {
          exerciseId: "exercise-plank" as never,
          exerciseName: "Plank",
          sets: [{ setType: "working", target: { duration: { min: 60, max: 60 } } }],
        },
      ],
    },
  ],
};

const sequentialIds = (): (() => string) => {
  let n = 0;
  return () => `id-${++n}`;
};

const materialize = (input: IntakeDraftPlan = draft, ctx: PlanAuthoringContext = context) =>
  materializeDraftPlan(input, {
    planId: "plan-1" as PlanId as never,
    context: ctx,
    newId: sequentialIds(),
  });

describe("materializeDraftPlan (#75)", () => {
  it("replaces the Plan's contents with the drafted sessions, keeping the Plan row's id", () => {
    const result = materialize();

    expect(result.plan.id).toBe("plan-1");
    // The Plan model is the draft's — accepting a plan accepts the model it was
    // drafted under, not the seeded one.
    expect(result.plan.planModel).toBe("upper-lower");
    expect(result.plan.sessions.map((session) => session.name)).toEqual(["Upper A", "Lower A"]);
  });

  it("wraps each drafted session's entries in exactly one straight Block (ADR 0001)", () => {
    const result = materialize();

    const [upper] = result.plan.sessions;
    expect(upper?.blocks).toHaveLength(1);
    expect(upper?.blocks[0]?.format).toBe("straight");
    expect(upper?.blocks[0]?.entries.map((entry) => entry.exerciseId)).toEqual([
      "exercise-bench-press",
      "exercise-plank",
    ]);
  });

  it("mints a distinct id for every Session, Block, Entry and Set — the draft carries none", () => {
    const result = materialize();

    const ids = result.plan.sessions.flatMap((session) => [
      session.id as string,
      ...session.blocks.flatMap((block) => [
        block.id as string,
        ...block.entries.flatMap((entry) => [
          entry.id as string,
          ...entry.sets.map((set) => set.id as string),
        ]),
      ]),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("id-"))).toBe(true);
  });

  it("copies prescribed targets verbatim — intervals, one-sided bounds and an open rpe", () => {
    const result = materialize();

    const sets = result.plan.sessions[0]?.blocks[0]?.entries[0]?.sets;
    // ADR 0014 §5 — the sweep governs the justification, never the
    // prescription. Nothing between the draft and the database may rewrite it.
    expect(sets?.map((set) => set.target)).toEqual([
      { reps: { min: 6, max: 10 }, load: { min: 60 } },
      { reps: { max: 8 }, rpe: {} },
    ]);
    expect(sets?.[0]?.restSec).toBe(120);
    expect(sets?.[1]?.restSec).toBeUndefined();
  });

  it("takes trackedMetrics from the catalog, which is canonical for the logging field layout", () => {
    const result = materialize();

    const entries = result.plan.sessions[0]?.blocks[0]?.entries;
    expect(entries?.[0]?.trackedMetrics).toEqual(["reps", "load"]);
    expect(entries?.[1]?.trackedMetrics).toEqual(["duration"]);
  });

  it("reports no new catalog entries when every drafted exerciseId is already in the catalog", () => {
    const result = materialize();
    expect(result.newCatalogEntries).toEqual([]);
  });

  it("authors a new catalog entry (from the draft's own name/trackedMetrics) for an exerciseId the catalog lacks — an empty catalog included", () => {
    const result = materialize(draft, { exercises: [] });

    // Every drafted exercise is new against an empty catalog, de-duplicated by id.
    expect(result.newCatalogEntries).toEqual([
      { id: "exercise-bench-press", name: "Bench Press" },
      { id: "exercise-plank", name: "Plank" },
    ]);
    // And the Plan still materializes — Intake naming a new Exercise is not a
    // refused Accept, it's the coach authoring one.
    expect(result.plan.sessions.map((session) => session.name)).toEqual(["Upper A", "Lower A"]);
  });

  it("a newly-authored exerciseId's trackedMetrics still flows through this same materialization (the draft is the only source for it)", () => {
    const oneOffDraft: IntakeDraftPlan = {
      ...draft,
      sessions: [
        {
          label: "Upper A",
          entries: [
            {
              exerciseId: "exercise-leg-press" as never,
              exerciseName: "Leg Press",
              trackedMetrics: ["reps", "load"],
              sets: [{ setType: "working", target: { reps: { min: 8, max: 12 }, load: { min: 40 } } }],
            },
          ],
        },
      ],
    };
    const result = materialize(oneOffDraft, { exercises: [] });

    expect(result.newCatalogEntries).toEqual([
      { id: "exercise-leg-press", name: "Leg Press", trackedMetrics: ["reps", "load"] },
    ]);
    expect(result.plan.sessions[0]?.blocks[0]?.entries[0]?.trackedMetrics).toEqual(["reps", "load"]);
  });

  it("gives an entry-less drafted session no Block rather than an empty one", () => {
    const result = materialize({ ...draft, sessions: [{ label: "Rest", entries: [] }] });

    expect(result.plan.sessions[0]?.blocks).toEqual([]);
  });
});
