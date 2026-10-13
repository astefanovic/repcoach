import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { ApplyUserChangeInput, PlanOperation, PlanSnapshot } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { SEEDED_SESSION_ID, Store, type DecisionRecord } from "./store.ts";

/**
 * Black-box rung-1 coverage for the Plan-authoring seam (#71), run against
 * BOTH `Store` layers through one shared assertion body so the in-memory and
 * SQLite layers cannot drift.
 *
 * Everything here goes through the public `Store` surface: apply an
 * operation, then read the Plan back and read the Decision log back. Nothing
 * asserts on rows, refs or the shape of a reducer — if the storage were
 * rewritten these tests would survive unchanged.
 */

const edit = (operation: PlanOperation, envelope: Record<string, unknown> = {}): ApplyUserChangeInput =>
  ({ operation, ...envelope }) as ApplyUserChangeInput;

const sessionOf = (plan: PlanSnapshot, id: string) =>
  plan.sessions.find((session) => session.id === id);

const planChanges = (decisions: ReadonlyArray<DecisionRecord>): ReadonlyArray<DecisionRecord> =>
  decisions.filter((decision) => decision.kind === "change" && decision.origin === "user-direct");

const runPlanAuthoringSuite = (
  withStore: <A, E>(effect: Effect.Effect<A, E, Store>) => Promise<A>,
) => {
  it("creates a Prescribed Session that shows up in the Plan, and records one applied user-direct Change", async () => {
    const { plan, changes } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const plan = yield* store.applyUserPlanChange(
          edit({ _tag: "createSession", sessionId: "session-legs" as never, name: "Legs" }),
        );
        const changes = planChanges(yield* store.listDecisionsForTest);
        return { plan, changes };
      }),
    );

    expect(sessionOf(plan, "session-legs")?.name).toBe("Legs");
    expect(sessionOf(plan, "session-legs")?.blocks).toEqual([]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.status).toBe("applied");
    expect(changes[0]?.summary).toBe('Created "Legs"');
  });

  it("adds an exercise carrying the catalog's tracked metrics, so logging renders the right fields", async () => {
    const plan = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.applyUserPlanChange(
          edit({ _tag: "createSession", sessionId: "session-legs" as never, name: "Legs" }),
        );
        return yield* store.applyUserPlanChange(
          edit({
            _tag: "addEntry",
            sessionId: "session-legs" as never,
            blockId: "block-legs-1" as never,
            entryId: "entry-legs-1" as never,
            exerciseId: "exercise-plank" as never,
          }),
        );
      }),
    );

    const entry = sessionOf(plan, "session-legs")?.blocks[0]?.entries[0];
    expect(entry?.exerciseId).toBe("exercise-plank");
    expect(entry?.trackedMetrics).toEqual(["duration"]);
  });

  it("writes an Entry's whole ordered Set list, down to the target bounds and per-Set rest", async () => {
    const plan = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.applyUserPlanChange(
          edit({
            _tag: "replaceEntrySets",
            entryId: "entry-1" as never,
            sets: [
              {
                id: "set-a",
                setType: "working",
                target: { reps: { min: 5, max: 8 }, load: { min: 82.5, max: 82.5 } },
                restSec: 150,
              },
              {
                id: "set-b",
                setType: "working",
                target: { reps: { min: 5, max: 8 }, load: { min: 82.5, max: 82.5 } },
                restSec: 150,
              },
            ],
          } as never),
        );
      }),
    );

    const entry = sessionOf(plan, SEEDED_SESSION_ID)?.blocks[0]?.entries[0];
    expect(entry?.sets.map((set) => set.id)).toEqual(["set-a", "set-b"]);
    expect(entry?.sets[0]?.target.load?.max).toBe(82.5);
    expect(entry?.sets[1]?.restSec).toBe(150);
  });

  it("swaps an Entry's exercise in place — same id and Sets, the new catalog row's metrics — as one Change", async () => {
    const { before, after, changes } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const before = yield* store.getPlan;
        yield* store.applyUserPlanChange(
          edit({ _tag: "setEntryExercise", entryId: "entry-1" as never, exerciseId: "exercise-plank" as never }),
        );
        // Read back rather than trusting the returned snapshot: this is what a reload sees.
        const after = yield* store.getPlan;
        const changes = planChanges(yield* store.listDecisionsForTest);
        return { before, after, changes };
      }),
    );

    const was = sessionOf(before, SEEDED_SESSION_ID)?.blocks[0]?.entries[0];
    const entry = sessionOf(after, SEEDED_SESSION_ID)?.blocks[0]?.entries[0];
    expect(entry?.id).toBe("entry-1");
    expect(entry?.exerciseId).toBe("exercise-plank");
    expect(entry?.trackedMetrics).toEqual(["duration"]);
    expect(entry?.sets).toEqual(was?.sets);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.summary).toMatch(/^Swapped .+ for Plank$/);
  });

  it("prescribes no rest at all when the Set list carries none — absent means no timer", async () => {
    const plan = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.applyUserPlanChange(
          edit({
            _tag: "replaceEntrySets",
            entryId: "entry-1" as never,
            sets: [{ id: "set-a", setType: "working", target: { reps: { min: 10, max: 10 } } }],
          } as never),
        );
      }),
    );

    expect(sessionOf(plan, SEEDED_SESSION_ID)?.blocks[0]?.entries[0]?.sets[0]).not.toHaveProperty(
      "restSec",
    );
  });

  it("groups adjacent exercises into a superset and collapses the Block back when one is removed", async () => {
    const { grouped, collapsed } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        // The seed's block-1 (squat) and block-2 (a superset) are not both
        // lone Entries, so author a clean Session to group in.
        yield* store.applyUserPlanChange(
          edit({ _tag: "createSession", sessionId: "session-legs" as never, name: "Legs" }),
        );
        yield* store.applyUserPlanChange(
          edit({
            _tag: "addEntry",
            sessionId: "session-legs" as never,
            blockId: "block-l1" as never,
            entryId: "entry-l1" as never,
            exerciseId: "exercise-back-squat" as never,
          }),
        );
        yield* store.applyUserPlanChange(
          edit({
            _tag: "addEntry",
            sessionId: "session-legs" as never,
            blockId: "block-l2" as never,
            entryId: "entry-l2" as never,
            exerciseId: "exercise-plank" as never,
          }),
        );
        const grouped = yield* store.applyUserPlanChange(
          edit({
            _tag: "groupEntries",
            sessionId: "session-legs" as never,
            blockId: "block-super" as never,
            entryIds: ["entry-l1", "entry-l2"] as never,
            format: "superset",
          }),
        );
        const collapsed = yield* store.applyUserPlanChange(
          edit({ _tag: "removeEntry", entryId: "entry-l2" as never }),
        );
        return { grouped, collapsed };
      }),
    );

    const groupedBlocks = sessionOf(grouped, "session-legs")!.blocks;
    expect(groupedBlocks).toHaveLength(1);
    expect(groupedBlocks[0]?.format).toBe("superset");
    expect(groupedBlocks[0]?.entries.map((entry) => entry.id)).toEqual(["entry-l1", "entry-l2"]);

    const collapsedBlocks = sessionOf(collapsed, "session-legs")!.blocks;
    expect(collapsedBlocks).toHaveLength(1);
    expect(collapsedBlocks[0]?.format).toBe("straight");
  });

  it("keeps the Plan's Session order across a reorder", async () => {
    const plan = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.applyUserPlanChange(
          edit({ _tag: "createSession", sessionId: "session-legs" as never, name: "Legs" }),
        );
        return yield* store.applyUserPlanChange(
          edit({
            _tag: "orderSessions",
            sessionIds: ["session-legs", SEEDED_SESSION_ID] as never,
          }),
        );
      }),
    );

    expect(plan.sessions.map((session) => session.id)).toEqual([
      "session-legs",
      SEEDED_SESSION_ID,
    ]);
  });

  it("leaves ONE live ordering Change after a run of reorder taps — the coach reads the net intent", async () => {
    const changes = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.applyUserPlanChange(
          edit({ _tag: "createSession", sessionId: "session-legs" as never, name: "Legs" }),
        );
        const orders: ReadonlyArray<ReadonlyArray<string>> = [
          ["session-legs", SEEDED_SESSION_ID],
          [SEEDED_SESSION_ID, "session-legs"],
          ["session-legs", SEEDED_SESSION_ID],
        ];
        for (const sessionIds of orders) {
          yield* store.applyUserPlanChange(
            edit({ _tag: "orderSessions", sessionIds: sessionIds as never }),
          );
        }
        return planChanges(yield* store.listDecisionsForTest);
      }),
    );

    const ordering = changes.filter((change) => change.summary.startsWith("Reordered"));
    expect(ordering).toHaveLength(3);
    expect(ordering.filter((change) => change.status === "applied")).toHaveLength(1);
    expect(ordering.filter((change) => change.status === "superseded")).toHaveLength(2);
    // The Change for the *creation* is a different kind of edit and must not
    // be swept up by an ordering supersession.
    expect(changes.find((change) => change.summary === 'Created "Legs"')?.status).toBe("applied");
  });

  it("supersedes the Change an undo reverses, and applies the inverse as a new Change", async () => {
    const { plan, changes } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        // The two writes adding a new Exercise to a Session takes (CONTEXT
        // `User-authored exercise`) — the row first, then the Entry that
        // references it. `addEntry` refuses an id with no catalog row.
        yield* store.createExercise({
          exerciseId: "exercise-face-pull" as never,
          name: "Face Pull" as never,
        });
        yield* store.applyUserPlanChange(
          edit({
            _tag: "addEntry",
            sessionId: SEEDED_SESSION_ID as never,
            blockId: "block-new" as never,
            entryId: "entry-new" as never,
            exerciseId: "exercise-face-pull" as never,
          }),
        );
        const added = planChanges(yield* store.listDecisionsForTest)[0]!;
        const plan = yield* store.applyUserPlanChange(
          edit(
            { _tag: "removeEntry", entryId: "entry-new" as never },
            { undoesChangeId: added.id },
          ),
        );
        return { plan, changes: planChanges(yield* store.listDecisionsForTest) };
      }),
    );

    expect(
      sessionOf(plan, SEEDED_SESSION_ID)!.blocks.flatMap((block) =>
        block.entries.map((entry) => entry.id),
      ),
    ).not.toContain("entry-new");
    expect(changes).toHaveLength(2);
    expect(changes.filter((change) => change.status === "superseded")).toHaveLength(1);
    expect(changes.filter((change) => change.status === "applied")).toHaveLength(1);
  });

  it("applies a replayed commandId exactly once — a retry cannot duplicate the user's Sets", async () => {
    const { first, second, changes } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({
          exerciseId: "exercise-face-pull" as never,
          name: "Face Pull" as never,
        });
        const command = edit(
          {
            _tag: "addEntry",
            sessionId: SEEDED_SESSION_ID as never,
            blockId: "block-new" as never,
            entryId: "entry-new" as never,
            exerciseId: "exercise-face-pull" as never,
          },
          { commandId: "plan-cmd-1" },
        );
        const first = yield* store.applyUserPlanChange(command);
        const second = yield* store.applyUserPlanChange(command);
        return { first, second, changes: planChanges(yield* store.listDecisionsForTest) };
      }),
    );

    const countEntries = (plan: PlanSnapshot): number =>
      sessionOf(plan, SEEDED_SESSION_ID)!.blocks.reduce(
        (total, block) => total + block.entries.length,
        0,
      );
    expect(countEntries(second)).toBe(countEntries(first));
    expect(changes).toHaveLength(1);
  });

  it("fails cleanly on an operation naming something that no longer exists, changing nothing", async () => {
    const { failure, planAfter, changes } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const before = yield* store.getPlan;
        const failure = yield* store
          .applyUserPlanChange(edit({ _tag: "removeEntry", entryId: "entry-ghost" as never }))
          .pipe(Effect.flip);
        const planAfter = yield* store.getPlan;
        expect(planAfter).toEqual(before);
        return { failure, planAfter, changes: planChanges(yield* store.listDecisionsForTest) };
      }),
    );

    expect(failure._tag).toBe("PlanOperationRejectedError");
    expect(planAfter.sessions).toHaveLength(1);
    expect(changes).toHaveLength(0);
  });

  it("never reaches an already-instantiated Logged Session — it is a copy taken at start", async () => {
    const snapshotSets = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
        yield* store.applyUserPlanChange(
          edit({
            _tag: "replaceEntrySets",
            entryId: "entry-1" as never,
            sets: [{ id: "set-rewritten", setType: "working", target: { reps: { min: 1, max: 1 } } }],
          } as never),
        );
        const logged = yield* store.getLoggedSession(loggedSessionId);
        return logged._tag === "Some"
          ? logged.value.session.blocks[0]?.entries[0]?.sets.map((set) => set.id)
          : undefined;
      }),
    );

    expect(snapshotSets).toEqual(["set-1", "set-2"]);
  });

  it("still accepts the original narrow Set-target edit, so nothing already built regresses", async () => {
    const plan = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.applyUserPlanChange({
          setId: "set-1" as never,
          target: { reps: { min: 5, max: 5 }, load: { min: 105, max: 105 } },
        });
      }),
    );

    expect(sessionOf(plan, SEEDED_SESSION_ID)?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max).toBe(
      105,
    );
  });
};

describe("Plan authoring (#71) — in-memory Store", () => {
  const withStore = <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runPlanAuthoringSuite(withStore);
});

describe("Plan authoring (#71) — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-plan-authoring-${randomUUID()}.sqlite`);

  const cleanupDbFile = (dbPath: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };

  const withStore = <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> => {
    const dbPath = tempDbPath();
    return effect
      .pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise)
      .finally(() => cleanupDbFile(dbPath));
  };

  runPlanAuthoringSuite(withStore);
});
