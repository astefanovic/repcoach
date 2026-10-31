import { describe, expect, it } from "vitest";

import type { PlanOperation, PlanSnapshot } from "@repcoach/contracts";

import {
  applyPlanOperation,
  foldProposedExercises,
  invertPlanOperation,
  validatePlanOperation,
  type PlanAuthoringContext,
} from "./operations.ts";
import { planSessionTitle, summarizePlanSession } from "./summary.ts";

/**
 * The Plan-authoring seam (#71). Every assertion here is on **external
 * behaviour through the public seam**: the shape of the Plan after an
 * operation, the summary that operation earned, and the inverse undo would
 * send. Nothing asserts on how the tree is walked.
 */

const context: PlanAuthoringContext = {
  exercises: [
    { id: "exercise-back-squat", name: "Back Squat", trackedMetrics: ["reps", "load"] },
    { id: "exercise-bench-press", name: "Bench Press", trackedMetrics: ["reps", "load"] },
    { id: "exercise-face-pull", name: "Face Pull", trackedMetrics: ["reps", "load"] },
    { id: "exercise-plank", name: "Plank", trackedMetrics: ["duration"] },
  ],
};

const plan = (json: unknown): PlanSnapshot => json as PlanSnapshot;

/** A Plan with one Session holding two straight Blocks — squat, then bench. */
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

const emptyPlan = (): PlanSnapshot =>
  plan({ id: "plan-1", planModel: "manual", sessions: [] });

/** Applies an operation and fails the test loudly if it was rejected. */
const apply = (
  current: PlanSnapshot,
  operation: PlanOperation,
): { readonly plan: PlanSnapshot; readonly summary: string; readonly orderingContainer?: string } => {
  const result = applyPlanOperation(current, operation, context);
  if (!result.ok) {
    throw new Error(`expected ${operation._tag} to apply, got ${result.code}: ${result.reason}`);
  }
  return result;
};

const expectRejected = (current: PlanSnapshot, operation: PlanOperation, code: string): string => {
  const result = applyPlanOperation(current, operation, context);
  if (result.ok) throw new Error(`expected ${operation._tag} to be rejected`);
  expect(result.code).toBe(code);
  return result.reason;
};

const sessionOf = (snapshot: PlanSnapshot, id: string) =>
  snapshot.sessions.find((session) => session.id === id)!;

describe("Prescribed Session operations", () => {
  it("creates a Session at the end of the ordered list, from an empty Plan", () => {
    const result = apply(emptyPlan(), {
      _tag: "createSession",
      sessionId: "session-new" as never,
      name: "Legs",
    });

    expect(result.plan.sessions.map((s) => s.name)).toEqual(["Legs"]);
    expect(result.plan.sessions[0]?.blocks).toEqual([]);
    expect(result.summary).toBe('Created "Legs"');
  });

  it("renames a Session and says what it was called before", () => {
    const result = apply(basePlan(), {
      _tag: "renameSession",
      sessionId: "session-a" as never,
      name: "Push A",
    });

    expect(sessionOf(result.plan, "session-a").name).toBe("Push A");
    expect(result.summary).toBe('Renamed "Push" → "Push A"');
  });

  it("deletes a Session with everything under it", () => {
    const result = apply(basePlan(), { _tag: "deleteSession", sessionId: "session-a" as never });

    expect(result.plan.sessions).toEqual([]);
    expect(result.summary).toBe('Deleted "Push"');
  });

  it("reorders the whole Session list and names the container it reordered", () => {
    const twoSessions = apply(basePlan(), {
      _tag: "createSession",
      sessionId: "session-b" as never,
      name: "Pull",
    }).plan;

    const result = apply(twoSessions, {
      _tag: "orderSessions",
      sessionIds: ["session-b", "session-a"] as never,
    });

    expect(result.plan.sessions.map((s) => s.id)).toEqual(["session-b", "session-a"]);
    expect(result.orderingContainer).toBe("plan");
  });

  it("rejects a reorder that drops or invents a Session, changing nothing", () => {
    expectRejected(
      basePlan(),
      { _tag: "orderSessions", sessionIds: ["session-a", "session-ghost"] as never },
      "invalid",
    );
  });

  it("fails cleanly when an operation names a Session that no longer exists", () => {
    expectRejected(
      basePlan(),
      { _tag: "renameSession", sessionId: "session-gone" as never, name: "X" },
      "not-found",
    );
  });
});

describe("Entry operations", () => {
  it("adds an exercise as its own straight Block, carrying the catalog's tracked metrics", () => {
    const result = apply(basePlan(), {
      _tag: "addEntry",
      sessionId: "session-a" as never,
      blockId: "block-3" as never,
      entryId: "entry-3" as never,
      exerciseId: "exercise-plank" as never,
    });

    const blocks = sessionOf(result.plan, "session-a").blocks;
    expect(blocks.map((b) => b.id)).toEqual(["block-1", "block-2", "block-3"]);
    expect(blocks[2]?.format).toBe("straight");
    expect(blocks[2]?.entries[0]?.trackedMetrics).toEqual(["duration"]);
    expect(result.summary).toBe("Added Plank");
  });

  /**
   * `exerciseId` is the join to the catalog, and this used to fail OPEN: the
   * Entry applied, the UI rendered the raw id where the name belongs, the
   * logging grid got no metrics, and per-muscle volume counted the work as
   * zero — permanently, since the orphan is not in the catalog table and ADR
   * 0016's enrichment roster reads that table.
   *
   * Both paths that legitimately add an Exercise create the row FIRST (the
   * user's own edit via `createExercise`; a coach Proposal via
   * `foldProposedExercises`), so a refusal here can only be a mistake.
   */
  it("refuses an exerciseId that joins to no catalog row rather than dangling the Entry", () => {
    const result = applyPlanOperation(
      basePlan(),
      {
        _tag: "addEntry",
        sessionId: "session-a" as never,
        blockId: "block-3" as never,
        entryId: "entry-3" as never,
        exerciseId: "exercise-nowhere" as never,
      },
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not-found");
    expect(result.reason).toContain("exercise-nowhere");
  });

  it("joins an existing Block when the named Block is already there — how a circuit grows past two", () => {
    const grouped = apply(basePlan(), {
      _tag: "groupEntries",
      sessionId: "session-a" as never,
      blockId: "block-super" as never,
      entryIds: ["entry-1", "entry-2"] as never,
      format: "circuit",
    }).plan;

    const result = apply(grouped, {
      _tag: "addEntry",
      sessionId: "session-a" as never,
      blockId: "block-super" as never,
      entryId: "entry-3" as never,
      exerciseId: "exercise-face-pull" as never,
    });

    const blocks = sessionOf(result.plan, "session-a").blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.entries.map((e) => e.id)).toEqual(["entry-1", "entry-2", "entry-3"]);
    expect(result.summary).toBe("Added Face Pull to the circuit");
  });

  it("inserts a new Block at an explicit position", () => {
    const result = apply(basePlan(), {
      _tag: "addEntry",
      sessionId: "session-a" as never,
      blockId: "block-0" as never,
      entryId: "entry-0" as never,
      exerciseId: "exercise-face-pull" as never,
      position: 0,
    });

    expect(sessionOf(result.plan, "session-a").blocks.map((b) => b.id)).toEqual([
      "block-0",
      "block-1",
      "block-2",
    ]);
  });

  it("removes an Entry and the Block it left empty", () => {
    const result = apply(basePlan(), { _tag: "removeEntry", entryId: "entry-2" as never });

    expect(sessionOf(result.plan, "session-a").blocks.map((b) => b.id)).toEqual(["block-1"]);
    expect(result.summary).toBe("Removed Bench Press");
  });

  it("reorders Entries within one Block and names that Block as the container", () => {
    const grouped = apply(basePlan(), {
      _tag: "groupEntries",
      sessionId: "session-a" as never,
      blockId: "block-super" as never,
      entryIds: ["entry-1", "entry-2"] as never,
      format: "superset",
    }).plan;

    const result = apply(grouped, {
      _tag: "orderEntries",
      blockId: "block-super" as never,
      entryIds: ["entry-2", "entry-1"] as never,
    });

    expect(sessionOf(result.plan, "session-a").blocks[0]?.entries.map((e) => e.id)).toEqual([
      "entry-2",
      "entry-1",
    ]);
    expect(result.orderingContainer).toBe("block:block-super");
  });
});

describe("Block operations", () => {
  it("groups two adjacent Entries into a superset, where the first of them sat", () => {
    const result = apply(basePlan(), {
      _tag: "groupEntries",
      sessionId: "session-a" as never,
      blockId: "block-super" as never,
      entryIds: ["entry-1", "entry-2"] as never,
      format: "superset",
    });

    const blocks = sessionOf(result.plan, "session-a").blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.format).toBe("superset");
    expect(blocks[0]?.entries.map((e) => e.id)).toEqual(["entry-1", "entry-2"]);
    expect(result.summary).toBe("Grouped Back Squat + Bench Press into a superset");
  });

  it("refuses to group non-adjacent nodes — grouping is by adjacency, not selection", () => {
    const threeBlocks = apply(basePlan(), {
      _tag: "addEntry",
      sessionId: "session-a" as never,
      blockId: "block-3" as never,
      entryId: "entry-3" as never,
      exerciseId: "exercise-face-pull" as never,
    }).plan;

    expectRejected(
      threeBlocks,
      {
        _tag: "groupEntries",
        sessionId: "session-a" as never,
        blockId: "block-super" as never,
        entryIds: ["entry-1", "entry-3"] as never,
        format: "superset",
      },
      "invalid",
    );
  });

  it("ungroups a Block back into one straight Block per Entry, in place", () => {
    const grouped = apply(basePlan(), {
      _tag: "groupEntries",
      sessionId: "session-a" as never,
      blockId: "block-super" as never,
      entryIds: ["entry-1", "entry-2"] as never,
      format: "superset",
    }).plan;

    const result = apply(grouped, { _tag: "ungroupBlock", blockId: "block-super" as never });

    const blocks = sessionOf(result.plan, "session-a").blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.format === "straight")).toBe(true);
    expect(blocks.flatMap((b) => b.entries.map((e) => e.id))).toEqual(["entry-1", "entry-2"]);
    expect(result.summary).toBe("Ungrouped the superset");
  });

  it("collapses a superset left holding one Entry back to a plain straight Block", () => {
    const grouped = apply(basePlan(), {
      _tag: "groupEntries",
      sessionId: "session-a" as never,
      blockId: "block-super" as never,
      entryIds: ["entry-1", "entry-2"] as never,
      format: "superset",
    }).plan;

    const result = apply(grouped, { _tag: "removeEntry", entryId: "entry-2" as never });

    const blocks = sessionOf(result.plan, "session-a").blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.format).toBe("straight");
    expect(blocks[0]?.entries.map((e) => e.id)).toEqual(["entry-1"]);
  });

  it("moves an Entry into another Block at a position, collapsing the Block it left", () => {
    const grouped = apply(basePlan(), {
      _tag: "groupEntries",
      sessionId: "session-a" as never,
      blockId: "block-super" as never,
      entryIds: ["entry-1", "entry-2"] as never,
      format: "superset",
    }).plan;
    const withThird = apply(grouped, {
      _tag: "addEntry",
      sessionId: "session-a" as never,
      blockId: "block-3" as never,
      entryId: "entry-3" as never,
      exerciseId: "exercise-face-pull" as never,
    }).plan;

    const result = apply(withThird, {
      _tag: "moveEntryToBlock",
      entryId: "entry-3" as never,
      blockId: "block-super" as never,
      position: 0,
    });

    const blocks = sessionOf(result.plan, "session-a").blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.entries.map((e) => e.id)).toEqual(["entry-3", "entry-1", "entry-2"]);
    expect(result.summary).toBe("Moved Face Pull into the superset");
  });

  it("sets a circuit's target rounds", () => {
    const result = apply(basePlan(), {
      _tag: "setBlockParams",
      blockId: "block-1" as never,
      format: "circuit",
      params: { targetRounds: 3 },
    });

    const block = sessionOf(result.plan, "session-a").blocks[0]!;
    expect(block.format).toBe("circuit");
    expect(block.params?.targetRounds).toBe(3);
    expect(result.summary).toBe("Set the circuit to 3 rounds");
  });

  it("reorders a Session's Blocks — the outer unit is the node, and a Block moves as one", () => {
    const result = apply(basePlan(), {
      _tag: "orderBlocks",
      sessionId: "session-a" as never,
      blockIds: ["block-2", "block-1"] as never,
    });

    const blocks = sessionOf(result.plan, "session-a").blocks;
    expect(blocks.map((b) => b.id)).toEqual(["block-2", "block-1"]);
    expect(blocks[1]?.entries.map((e) => e.id)).toEqual(["entry-1"]);
    expect(result.orderingContainer).toBe("session:session-a");
  });

  describe("removeEntryFromBlock — issue #85", () => {
    it("takes an Entry out of a 3-wide circuit, leaving the circuit intact (the case ungroupBlock would get wrong)", () => {
      const circuit = apply(basePlan(), {
        _tag: "addEntry",
        sessionId: "session-a" as never,
        blockId: "block-3" as never,
        entryId: "entry-3" as never,
        exerciseId: "exercise-face-pull" as never,
      }).plan;
      const grouped = apply(circuit, {
        _tag: "groupEntries",
        sessionId: "session-a" as never,
        blockId: "block-circuit" as never,
        entryIds: ["entry-1", "entry-2", "entry-3"] as never,
        format: "circuit",
      }).plan;

      const result = apply(grouped, {
        _tag: "removeEntryFromBlock",
        entryId: "entry-2" as never,
        blockId: "block-new" as never,
      });

      const blocks = sessionOf(result.plan, "session-a").blocks;
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toMatchObject({
        id: "block-circuit",
        format: "circuit",
        entries: [{ id: "entry-1" }, { id: "entry-3" }],
      });
      expect(blocks[1]).toMatchObject({
        id: "block-new",
        format: "straight",
        entries: [{ id: "entry-2" }],
      });
      expect(result.summary).toBe("Took Bench Press out of the circuit");
    });

    it("takes an Entry out of a 2-wide superset, collapsing what's left back to a plain Entry", () => {
      const grouped = apply(basePlan(), {
        _tag: "groupEntries",
        sessionId: "session-a" as never,
        blockId: "block-super" as never,
        entryIds: ["entry-1", "entry-2"] as never,
        format: "superset",
      }).plan;

      const result = apply(grouped, {
        _tag: "removeEntryFromBlock",
        entryId: "entry-2" as never,
        blockId: "block-new" as never,
      });

      const blocks = sessionOf(result.plan, "session-a").blocks;
      expect(blocks).toHaveLength(2);
      expect(blocks.every((b) => b.format === "straight")).toBe(true);
      expect(blocks.flatMap((b) => b.entries.map((e) => e.id))).toEqual(["entry-1", "entry-2"]);
    });

    it("rejects taking an Entry out of a Block it is already alone in — that is a no-op, not an edit", () => {
      const reason = expectRejected(
        basePlan(),
        { _tag: "removeEntryFromBlock", entryId: "entry-1" as never, blockId: "block-new" as never },
        "invalid",
      );
      expect(reason).toMatch(/no-op/);
    });

    it("inverts into moveEntryToBlock back to the source Block and position", () => {
      const grouped = apply(basePlan(), {
        _tag: "groupEntries",
        sessionId: "session-a" as never,
        blockId: "block-super" as never,
        entryIds: ["entry-1", "entry-2"] as never,
        format: "superset",
      }).plan;
      const operation: PlanOperation = {
        _tag: "removeEntryFromBlock",
        entryId: "entry-2" as never,
        blockId: "block-new" as never,
      };

      const inverse = invertPlanOperation(grouped, operation)!;
      expect(inverse._tag).toBe("moveEntryToBlock");

      // The collapse is not perfectly reversible for a two-Entry Block on its
      // own — undo has to regroup, which `moveEntryToBlock` does by landing
      // the Entry back in the (collapsed) source Block. Check the round trip
      // rather than assume it, per #85.
      const after = apply(grouped, operation).plan;
      const restored = apply(after, inverse).plan;
      expect(
        sessionOf(restored, "session-a").blocks.flatMap((b) => b.entries.map((e) => e.id)),
      ).toEqual(["entry-1", "entry-2"]);
    });
  });
});

describe("replaceEntrySets", () => {
  const fourSets = [1, 2, 3, 4].map((n) => ({
    id: `set-n${n}`,
    setType: "working",
    target: { reps: { min: 5, max: 8 }, load: { min: 80, max: 80 } },
    restSec: 120,
  })) as never;

  it("writes an Entry's whole ordered Set list and summarises it as the run the user authored", () => {
    const result = apply(basePlan(), {
      _tag: "replaceEntrySets",
      entryId: "entry-1" as never,
      sets: fourSets,
    });

    const entry = sessionOf(result.plan, "session-a").blocks[0]!.entries[0]!;
    expect(entry.sets).toHaveLength(4);
    expect(result.summary).toBe("Set Back Squat to 4 × 5-8 reps @ 80 kg");
  });

  it("summarises a multi-run list as the sequence it is", () => {
    const result = apply(basePlan(), {
      _tag: "replaceEntrySets",
      entryId: "entry-1" as never,
      sets: [
        {
          id: "set-w",
          setType: "working",
          target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } },
        },
        { id: "set-d", setType: "drop", target: { load: { max: 60 } } },
      ] as never,
    });

    expect(result.summary).toBe("Set Back Squat to 1 × 5 reps @ 100 kg, then 1 × drop <=60 kg");
  });

  it("clears an Entry's Sets", () => {
    const result = apply(basePlan(), {
      _tag: "replaceEntrySets",
      entryId: "entry-1" as never,
      sets: [] as never,
    });

    expect(sessionOf(result.plan, "session-a").blocks[0]!.entries[0]!.sets).toEqual([]);
    expect(result.summary).toBe("Cleared Back Squat's sets");
  });

  it("is idempotent — applying the same whole-value write twice lands the same Plan", () => {
    const once = apply(basePlan(), {
      _tag: "replaceEntrySets",
      entryId: "entry-1" as never,
      sets: fourSets,
    }).plan;
    const twice = apply(once, {
      _tag: "replaceEntrySets",
      entryId: "entry-1" as never,
      sets: fourSets,
    }).plan;

    expect(twice).toEqual(once);
  });

  it("rejects a Set list carrying a duplicate id", () => {
    expectRejected(
      basePlan(),
      {
        _tag: "replaceEntrySets",
        entryId: "entry-1" as never,
        sets: [
          { id: "set-x", setType: "working", target: {} },
          { id: "set-x", setType: "working", target: {} },
        ] as never,
      },
      "invalid",
    );
  });
});

describe("setEntryExercise", () => {
  const swapSquatForPlank: PlanOperation = {
    _tag: "setEntryExercise",
    entryId: "entry-1" as never,
    exerciseId: "exercise-plank" as never,
  };

  it("points the Entry at the new exercise in place, keeping its id, position and Sets", () => {
    const before = basePlan();
    const result = apply(before, swapSquatForPlank);

    const entry = sessionOf(result.plan, "session-a").blocks[0]!.entries[0]!;
    expect(entry.id).toBe("entry-1");
    expect(entry.exerciseId).toBe("exercise-plank");
    expect(entry.sets).toEqual(sessionOf(before, "session-a").blocks[0]!.entries[0]!.sets);
    expect(entry.trackedMetrics).toEqual(["duration"]);
    expect(result.summary).toBe("Swapped Back Squat for Plank");
  });

  it("rejects an exercise the catalog does not hold", () => {
    expectRejected(
      basePlan(),
      { _tag: "setEntryExercise", entryId: "entry-1" as never, exerciseId: "exercise-nope" as never },
      "not-found",
    );
  });

  it("rejects an Entry that is not in the Plan", () => {
    expectRejected(
      basePlan(),
      { _tag: "setEntryExercise", entryId: "entry-gone" as never, exerciseId: "exercise-plank" as never },
      "not-found",
    );
  });

  it("rejects naming the exercise the Entry already has", () => {
    expectRejected(
      basePlan(),
      { _tag: "setEntryExercise", entryId: "entry-1" as never, exerciseId: "exercise-back-squat" as never },
      "invalid",
    );
  });

  it("inverts to the exercise that stood before it", () => {
    const before = basePlan();
    const inverse = invertPlanOperation(before, swapSquatForPlank)!;
    expect(inverse).toEqual({ _tag: "setEntryExercise", entryId: "entry-1", exerciseId: "exercise-back-squat" });

    const restored = apply(apply(before, swapSquatForPlank).plan, inverse).plan;
    expect(sessionOf(restored, "session-a").blocks[0]!.entries[0]!.exerciseId).toBe("exercise-back-squat");
  });
});

describe("validatePlanOperation", () => {
  it("agrees with applying — a client can fail a stale tap locally instead of after a round trip", () => {
    expect(
      validatePlanOperation(basePlan(), { _tag: "removeEntry", entryId: "entry-1" as never }, context),
    ).toEqual({ ok: true });

    const stale = validatePlanOperation(
      basePlan(),
      { _tag: "removeEntry", entryId: "entry-gone" as never },
      context,
    );
    expect(stale.ok).toBe(false);
  });
});

describe("invertPlanOperation — undo is the inverse, not a rollback path", () => {
  it("inverts a reorder into the order that stood before it", () => {
    const before = basePlan();
    const operation: PlanOperation = {
      _tag: "orderBlocks",
      sessionId: "session-a" as never,
      blockIds: ["block-2", "block-1"] as never,
    };

    const inverse = invertPlanOperation(before, operation)!;
    const after = apply(before, operation).plan;
    const restored = apply(after, inverse).plan;

    expect(restored).toEqual(before);
  });

  it("inverts a set-list write into the Sets that were there", () => {
    const before = basePlan();
    const operation: PlanOperation = {
      _tag: "replaceEntrySets",
      entryId: "entry-1" as never,
      sets: [] as never,
    };

    const restored = apply(apply(before, operation).plan, invertPlanOperation(before, operation)!)
      .plan;

    expect(restored).toEqual(before);
  });

  it("inverts adding an exercise into removing it, and grouping into ungrouping", () => {
    const before = basePlan();
    const add: PlanOperation = {
      _tag: "addEntry",
      sessionId: "session-a" as never,
      blockId: "block-3" as never,
      entryId: "entry-3" as never,
      exerciseId: "exercise-face-pull" as never,
    };
    expect(apply(apply(before, add).plan, invertPlanOperation(before, add)!).plan).toEqual(before);

    const group: PlanOperation = {
      _tag: "groupEntries",
      sessionId: "session-a" as never,
      blockId: "block-super" as never,
      entryIds: ["entry-1", "entry-2"] as never,
      format: "superset",
    };
    const ungrouped = apply(apply(before, group).plan, invertPlanOperation(before, group)!).plan;
    expect(ungrouped.sessions[0]?.blocks.flatMap((b) => b.entries.map((e) => e.id))).toEqual([
      "entry-1",
      "entry-2",
    ]);
  });

  it("inverts creating a Session into deleting it", () => {
    const create: PlanOperation = {
      _tag: "createSession",
      sessionId: "session-new" as never,
      name: "Legs",
    };
    expect(invertPlanOperation(emptyPlan(), create)).toEqual({
      _tag: "deleteSession",
      sessionId: "session-new",
    });
  });

  it("has no single-operation inverse for a deleted Session, so undo cannot pretend it is free", () => {
    expect(
      invertPlanOperation(basePlan(), { _tag: "deleteSession", sessionId: "session-a" as never }),
    ).toBeUndefined();
  });
});

describe("session summaries for the picker", () => {
  it("counts exercises and Sets, multiplying a Block's target rounds through", () => {
    const withSets = apply(basePlan(), {
      _tag: "replaceEntrySets",
      entryId: "entry-1" as never,
      sets: [
        { id: "s1", setType: "working", target: { reps: { min: 5, max: 5 } } },
        { id: "s2", setType: "working", target: { reps: { min: 5, max: 5 } } },
      ] as never,
    }).plan;
    const asCircuit = apply(withSets, {
      _tag: "setBlockParams",
      blockId: "block-1" as never,
      format: "circuit",
      params: { targetRounds: 3 },
    }).plan;

    expect(summarizePlanSession(asCircuit.sessions[0]!, 0)).toEqual({
      title: "Push",
      entryCount: 2,
      setCount: 6,
      isEmpty: false,
    });
  });

  it("marks a Session with no exercises as empty — caution, not error", () => {
    const created = apply(emptyPlan(), {
      _tag: "createSession",
      sessionId: "session-new" as never,
      name: "Legs",
    }).plan;

    expect(summarizePlanSession(created.sessions[0]!, 0).isEmpty).toBe(true);
  });

  it("falls back to a positional title for a Session authored before names existed", () => {
    const unnamed = plan({
      id: "plan-1",
      planModel: "manual",
      sessions: [{ id: "session-seed-1", blocks: [] }],
    });

    expect(planSessionTitle(unnamed.sessions[0]!, 0)).toBe("Session 1");
  });
});

/**
 * The other half of the `addEntry` guard: how a coach Proposal legitimately
 * names an Exercise the catalog does not hold yet (ADR 0016). Pure, and shared
 * by both `Store` layers so they cannot disagree about what accepting such a
 * Proposal means.
 */
describe("foldProposedExercises", () => {
  it("folds a declared row into the context its operations validate against", () => {
    const folded = foldProposedExercises(context, [
      { exercise_id: "exercise-barbell-row", name: "Barbell Row", tracked_metrics: ["reps", "load"] },
    ]);

    expect(folded.newCatalogEntries).toEqual([
      { id: "exercise-barbell-row", name: "Barbell Row", trackedMetrics: ["reps", "load"] },
    ]);
    // Folded in BEFORE validation, which is what makes the `addEntry` above
    // resolve instead of refusing — the row itself is written only once the
    // whole operation list has validated.
    const result = applyPlanOperation(
      basePlan(),
      {
        _tag: "addEntry",
        sessionId: "session-a" as never,
        blockId: "block-3" as never,
        entryId: "entry-3" as never,
        exerciseId: "exercise-barbell-row" as never,
      },
      folded.context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toBe("Added Barbell Row");
  });

  it("skips an id the catalog already holds rather than overwriting it", () => {
    const folded = foldProposedExercises(context, [
      { exercise_id: "exercise-face-pull", name: "Rear Delt Fly" },
    ]);

    // Idempotent on the id: the standing row may carry a name the user has
    // since fixed or metadata a review has since enriched, and a Proposal
    // drafted before either does not get to undo them.
    expect(folded.newCatalogEntries).toEqual([]);
    expect(folded.context.exercises).toEqual(context.exercises);
    expect(
      folded.context.exercises.find((e) => e.id === "exercise-face-pull")?.name,
    ).toBe("Face Pull");
  });

  it("is a no-op when the Proposal declares nothing", () => {
    const folded = foldProposedExercises(context, undefined);

    expect(folded.newCatalogEntries).toEqual([]);
    expect(folded.context).toBe(context);
  });
});
