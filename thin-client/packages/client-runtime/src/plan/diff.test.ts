import { describe, expect, it } from "vitest";

import type { PlanOperation, PlanSnapshot } from "@repcoach/contracts";

import { diffPlans } from "./diff.ts";
import { applyPlanOperations, type PlanAuthoringContext } from "./operations.ts";

/**
 * The two halves of what a Proposal card promises (#86): the fold that decides
 * what accepting a Proposal does (`applyPlanOperations`), and the diff that
 * shows it (`diffPlans`). Asserted through the public functions only.
 */

const context: PlanAuthoringContext = {
  exercises: [
    { id: "exercise-back-squat", name: "Back Squat", trackedMetrics: ["reps", "load"] },
    { id: "exercise-bench-press", name: "Bench Press", trackedMetrics: ["reps", "load"] },
  ],
};

const plan = (json: unknown): PlanSnapshot => json as PlanSnapshot;

const basePlan = (): PlanSnapshot =>
  plan({
    id: "plan-1",
    planModel: "manual",
    sessions: [
      {
        id: "session-a",
        name: "Push",
        blocks: [
          {
            id: "block-1",
            format: "straight",
            entries: [
              {
                id: "entry-1",
                exerciseId: "exercise-back-squat",
                sets: [
                  {
                    id: "set-1",
                    setType: "working",
                    target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } },
                    restSec: 120,
                  },
                  {
                    id: "set-2",
                    setType: "working",
                    target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } },
                    restSec: 120,
                  },
                ],
              },
            ],
          },
          {
            id: "block-2",
            format: "straight",
            entries: [{ id: "entry-2", exerciseId: "exercise-bench-press", sets: [] }],
          },
        ],
      },
    ],
  });

const raiseSquatLoad: PlanOperation = {
  _tag: "replaceEntrySets",
  entryId: "entry-1" as never,
  sets: [
    {
      id: "set-1" as never,
      setType: "working",
      target: { reps: { min: 5, max: 5 }, load: { min: 102.5, max: 102.5 } },
      restSec: 120,
    },
    {
      id: "set-2" as never,
      setType: "working",
      target: { reps: { min: 5, max: 5 }, load: { min: 102.5, max: 102.5 } },
      restSec: 120,
    },
  ],
};

const applied = (operations: ReadonlyArray<PlanOperation>): PlanSnapshot => {
  const result = applyPlanOperations(basePlan(), operations, context);
  if (!result.ok) throw new Error(`expected the sequence to apply: ${result.reason}`);
  return result.plan;
};

describe("applyPlanOperations — the all-or-nothing fold (#86)", () => {
  it("folds each operation onto the previous one's result, so a sequence can build on itself", () => {
    const result = applyPlanOperations(
      basePlan(),
      [
        { _tag: "createSession", sessionId: "session-b" as never, name: "Pull" },
        {
          _tag: "addEntry",
          sessionId: "session-b" as never,
          blockId: "block-new" as never,
          entryId: "entry-new" as never,
          exerciseId: "exercise-bench-press" as never,
        },
      ],
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The second operation named a Session that did not exist until the first
    // one ran — which is only possible because the fold is sequential.
    expect(result.plan.sessions.map((session) => session.name)).toEqual(["Push", "Pull"]);
    expect(result.summaries).toHaveLength(2);
  });

  it("reports WHICH operation failed, and returns no Plan at all", () => {
    const result = applyPlanOperations(
      basePlan(),
      [raiseSquatLoad, { _tag: "removeEntry", entryId: "entry-nope" as never }],
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.index).toBe(1);
    expect(result.operation).toBe("removeEntry");
    expect(result.code).toBe("not-found");
    // There is deliberately no partial `plan` on the failure branch — the
    // caller cannot accidentally write half a Proposal.
    expect("plan" in result).toBe(false);
  });

  it("is a no-op on an empty sequence", () => {
    const result = applyPlanOperations(basePlan(), [], context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toEqual(basePlan());
    expect(result.summaries).toEqual([]);
  });
});

describe("diffPlans — what the Proposal card shows (#86)", () => {
  it("reads a changed prescription as before → after, named by exercise", () => {
    const lines = diffPlans(basePlan(), applied([raiseSquatLoad]), context);

    expect(lines).toEqual([
      {
        kind: "changed",
        subject: "Push · Back Squat",
        before: "2 × 5 reps @ 100 kg",
        after: "2 × 5 reps @ 102.5 kg",
      },
    ]);
  });

  it("reads a swapped exercise as the old name → the new one, and nothing else when the Sets stay", () => {
    const lines = diffPlans(
      basePlan(),
      applied([{ _tag: "setEntryExercise", entryId: "entry-2" as never, exerciseId: "exercise-back-squat" as never }]),
      context,
    );
    expect(lines).toEqual([{ kind: "changed", subject: "Push", before: "Bench Press", after: "Back Squat" }]);
  });

  it("says nothing at all when the operations change nothing", () => {
    expect(diffPlans(basePlan(), basePlan(), context)).toEqual([]);
  });

  it("reports an added Entry as added, and a removed one as removed", () => {
    const added = diffPlans(
      basePlan(),
      applied([
        {
          _tag: "addEntry",
          sessionId: "session-a" as never,
          blockId: "block-1" as never,
          entryId: "entry-new" as never,
          exerciseId: "exercise-bench-press" as never,
        },
      ]),
      context,
    );
    expect(added).toEqual([
      { kind: "added", subject: "Push · Bench Press", after: "no sets" },
    ]);

    const removed = diffPlans(
      basePlan(),
      applied([{ _tag: "removeEntry", entryId: "entry-1" as never }]),
      context,
    );
    expect(removed).toEqual([
      { kind: "removed", subject: "Push · Back Squat", before: "2 × 5 reps @ 100 kg" },
    ]);
  });

  it("reports a deleted Session once, not once per Entry underneath it", () => {
    const lines = diffPlans(
      basePlan(),
      applied([{ _tag: "deleteSession", sessionId: "session-a" as never }]),
      context,
    );

    expect(lines).toEqual([
      { kind: "removed", subject: "Push", before: "removed, with everything under it" },
    ]);
  });
});
