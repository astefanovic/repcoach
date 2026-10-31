import { describe, expect, it } from "vitest";

import type { EntryId, PlanSnapshot, PrescribedSession, SetId } from "@repcoach/contracts";

import type { EntryNote, EntrySwap, LoggedSetActual } from "../runtime/useLoggedSession.ts";
import { editableNote, planSwapCandidates, setRowLabels, withAddedEntries, withUnplannedSets } from "./Logging.tsx";

/**
 * Rung 1 for #129 item 2: a Set confirmed as a drop/rest-pause/myo-cluster
 * must reconstruct with that same `setType` after a reload, not silently
 * downgrade to a working set — the exact failure mode the ticket names, and
 * the same omission ADR 0017 already found and fixed for `entryId`.
 */
describe("withUnplannedSets orphan reconstruction (#129 item 2, ADR 0017)", () => {
  const session: PrescribedSession = {
    id: "session-1" as never,
    blocks: [
      {
        id: "block-1" as never,
        format: "straight",
        entries: [
          {
            id: "entry-1" as never,
            exerciseId: "exercise-1" as never,
            sets: [
              {
                id: "set-1" as never,
                setType: "working",
                target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
                restSec: 90,
              },
            ],
          },
        ],
      },
    ],
  };

  const orphan = (setType: LoggedSetActual["setType"]): ReadonlyMap<SetId, LoggedSetActual> =>
    new Map([
      [
        "set-orphan" as SetId,
        {
          actual: { reps: 8, load: 60 },
          entryId: "entry-1" as never,
          setType,
          pending: false,
          appliedAt: "2026-08-19T00:00:00.000Z",
        },
      ],
    ]);

  it("reconstructs a drop orphan as a drop, not a working set", () => {
    const result = withUnplannedSets(session, new Map(), orphan("drop"));
    const sets = result.blocks[0]!.entries[0]!.sets;
    expect(sets).toHaveLength(2);
    expect(sets[1]!.setType).toBe("drop");
  });

  it("reconstructs a rest-pause orphan as a rest-pause", () => {
    const result = withUnplannedSets(session, new Map(), orphan("rest-pause"));
    expect(result.blocks[0]!.entries[0]!.sets[1]!.setType).toBe("rest-pause");
  });

  it("reconstructs a myo-cluster orphan as a myo-cluster", () => {
    const result = withUnplannedSets(session, new Map(), orphan("myo-cluster"));
    expect(result.blocks[0]!.entries[0]!.sets[1]!.setType).toBe("myo-cluster");
  });

  it("still reconstructs a plain working-set orphan as another straight set", () => {
    const result = withUnplannedSets(session, new Map(), orphan("working"));
    expect(result.blocks[0]!.entries[0]!.sets[1]!.setType).toBe("working");
  });
});

/**
 * Rung 1 for the UAT note change: the note item edits the Entry's note
 * instead of adding a second one, so something has to answer "which note is
 * *the* note".
 */
describe("editableNote (UAT: the note item edits rather than appends)", () => {
  const note = (id: string, text: string, recordedAt: string): EntryNote => ({
    id,
    entryId: "entry-1" as never,
    text,
    recordedAt,
    pending: false,
  });

  it("has nothing to edit on an Entry with no notes — which is what makes the item read 'Add a note'", () => {
    expect(editableNote([])).toBeUndefined();
  });

  it("edits the note when there is exactly one", () => {
    const only = note("note-1", "left elbow twinged", "2026-08-25T08:00:00.000Z");
    expect(editableNote([only])).toBe(only);
  });

  /**
   * An Entry can still be carrying several: every note written while the item
   * appended is still on the record, and none is deleted retroactively. The
   * latest is the only choice that keeps the item's meaning stable across
   * that boundary — editing the OLDEST would silently rewrite history the
   * user had moved on from.
   *
   * The list arrives sorted oldest-first (`notesByEntry` sorts on
   * `recordedAt`), so "latest" is "last".
   */
  it("edits the most recent note on an Entry that accumulated several", () => {
    const older = note("note-1", "left elbow twinged", "2026-08-25T08:00:00.000Z");
    const newer = note("note-2", "elbow fine after the warmup", "2026-08-25T08:20:00.000Z");
    expect(editableNote([older, newer])).toBe(newer);
  });
});

/**
 * Rung 1 for the UAT remove change: the remove sheet names Sets by the label
 * the Entry shows, so the numbering has to come from one place. Two
 * independent numberings would be a way to remove the wrong Set.
 */
describe("setRowLabels (UAT: the remove sheet names Sets the way the Entry does)", () => {
  const set = (id: string, setType: LoggedSetActual["setType"]) => ({
    id: id as never,
    setType,
    target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
    restSec: 90,
  });

  it("numbers working sets from 1, marks warmups W, and marks continuations ↳", () => {
    const labels = setRowLabels([
      set("warm-1", "warmup"),
      set("work-1", "working"),
      set("drop-1", "drop"),
      set("work-2", "working"),
    ]);
    expect(labels.get("warm-1")).toBe("W");
    expect(labels.get("work-1")).toBe("1");
    expect(labels.get("drop-1")).toBe("↳");
    expect(labels.get("work-2")).toBe("2");
  });

  /**
   * A continuation does not consume a number — the drop set under working set
   * 1 must not push the next working set to 3. This is the assertion that
   * would catch the numbering drifting apart from the rendered rows.
   */
  it("does not let a continuation advance the working-set count", () => {
    const withDrop = setRowLabels([set("work-1", "working"), set("drop-1", "drop"), set("work-2", "working")]);
    const withoutDrop = setRowLabels([set("work-1", "working"), set("work-2", "working")]);
    expect(withDrop.get("work-2")).toBe(withoutDrop.get("work-2"));
  });
});

/**
 * UAT: an exercise added to a workout already in progress. It is an Entry
 * the frozen prescription does not hold, recorded as a swap naming its
 * exercise (ADR 0019's annotation on an Entry id the snapshot never minted),
 * so it has to be rebuilt from `swaps` on every render — including after a
 * reload, which is the case that matters.
 */
describe("withAddedEntries (UAT — add an exercise mid-workout)", () => {
  const session: PrescribedSession = {
    id: "session-1" as never,
    blocks: [
      {
        id: "block-1" as never,
        format: "straight",
        entries: [
          {
            id: "entry-1" as never,
            exerciseId: "exercise-squat" as never,
            sets: [{ id: "set-1" as never, setType: "working", target: { reps: {} }, restSec: 120 }],
          },
        ],
      },
    ],
  };
  const swaps = (entries: ReadonlyArray<readonly [string, string]>): ReadonlyMap<never, EntrySwap> =>
    new Map(entries.map(([entryId, exerciseId]) => [entryId as never, { exerciseId: exerciseId as never, pending: false }]));
  const catalog = [
    { id: "exercise-curl" as never, name: "Curl", trackedMetrics: ["reps", "load"] as const },
  ];

  it("leaves a session with no added exercise untouched", () => {
    const result = withAddedEntries(session, swaps([["entry-1", "exercise-press"]]), catalog);
    expect(result.session).toBe(session);
    expect(result.added.size).toBe(0);
  });

  it("appends a swap on an Entry the prescription does not hold as its own Entry, after the plan's", () => {
    const result = withAddedEntries(session, swaps([["entry-added", "exercise-curl"]]), catalog);
    expect(result.session.blocks).toHaveLength(2);
    const added = result.session.blocks[1]!.entries[0]!;
    expect(added.id).toBe("entry-added");
    expect(added.exerciseId).toBe("exercise-curl");
    expect(added.sets.map((set) => set.target)).toEqual([
      { reps: {}, load: {} },
      { reps: {}, load: {} },
      { reps: {}, load: {} },
    ]);
    // The rest the session already uses, so the timer still runs.
    expect(added.sets[0]!.restSec).toBe(120);
    expect([...result.added]).toEqual(["entry-added"]);
  });

  it("rebuilds the same Set ids every time, so actuals logged before a reload land on their rows", () => {
    const once = withAddedEntries(session, swaps([["entry-added", "exercise-curl"]]), catalog);
    const again = withAddedEntries(session, swaps([["entry-added", "exercise-curl"]]), catalog);
    expect(again.session.blocks[1]!.entries[0]!.sets.map((set) => set.id)).toEqual(
      once.session.blocks[1]!.entries[0]!.sets.map((set) => set.id),
    );
  });
});

/**
 * After a workout, each swap is offered as a Plan edit — but only where the
 * Plan still prescribes what the workout was frozen with, so the prompt never
 * offers to undo an edit made since, nor to "swap" an exercise already there.
 */
describe("planSwapCandidates", () => {
  const entry = (id: string, exerciseId: string) => ({ id, exerciseId, sets: [] });
  const session = {
    id: "session-1",
    blocks: [
      { id: "block-1", format: "straight", entries: [entry("entry-1", "exercise-curl"), entry("entry-2", "exercise-press")] },
    ],
  } as unknown as PrescribedSession;
  const planWith = (entries: ReadonlyArray<ReturnType<typeof entry>>): PlanSnapshot =>
    ({
      id: "plan-1",
      planModel: "manual",
      sessions: [{ id: "session-1", blocks: [{ id: "block-1", format: "straight", entries }] }],
    }) as unknown as PlanSnapshot;
  const swaps = (pairs: ReadonlyArray<[string, string]>): ReadonlyMap<EntryId, EntrySwap> =>
    new Map(pairs.map(([entryId, exerciseId]) => [entryId as EntryId, { exerciseId: exerciseId as never, pending: false }]));

  it("offers a swapped Entry the Plan still prescribes as it was frozen", () => {
    const plan = planWith([entry("entry-1", "exercise-curl"), entry("entry-2", "exercise-press")]);
    expect(planSwapCandidates(session, swaps([["entry-1", "exercise-leg-curl"]]), plan)).toEqual([
      { entryId: "entry-1", fromExerciseId: "exercise-curl", toExerciseId: "exercise-leg-curl" },
    ]);
  });

  it("skips an exercise added mid-workout — it has no prescribed side to replace", () => {
    const plan = planWith([entry("entry-1", "exercise-curl")]);
    expect(planSwapCandidates(session, swaps([["entry-new", "exercise-row"]]), plan)).toEqual([]);
  });

  it("skips an Entry the Plan no longer holds, or has changed since the workout started", () => {
    expect(
      planSwapCandidates(session, swaps([["entry-1", "exercise-leg-curl"]]), planWith([entry("entry-2", "exercise-press")])),
    ).toEqual([]);
    expect(
      planSwapCandidates(session, swaps([["entry-1", "exercise-leg-curl"]]), planWith([entry("entry-1", "exercise-row")])),
    ).toEqual([]);
  });

  it("skips a swap back to the prescribed exercise", () => {
    const plan = planWith([entry("entry-1", "exercise-curl")]);
    expect(planSwapCandidates(session, swaps([["entry-1", "exercise-curl"]]), plan)).toEqual([]);
  });

  it("offers nothing without a Plan to edit", () => {
    expect(planSwapCandidates(session, swaps([["entry-1", "exercise-leg-curl"]]), undefined)).toEqual([]);
  });
});
