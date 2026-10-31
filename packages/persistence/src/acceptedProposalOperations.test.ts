import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { PlanOperation, PlanSnapshot } from "@repcoach/contracts";
import { PlanOperationRejectedError } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/**
 * Rung-1 coverage for #86 — **a coach Proposal carries the Plan Change it
 * proposes**, run against BOTH `Store` layers through one shared assertion
 * body, exactly as `acceptedIntakePlan.test.ts` does. The two layers must not
 * be able to disagree about what accepting a Proposal means.
 *
 * The thing under test is the join, not the applier: `applyPlanOperation`'s own
 * structural rules are covered by `planAuthoring.test.ts`. What matters here is
 * that the operations the Proposal carries are the operations Accept applies —
 * that a Proposal saying "add a fourth working set" adds a set and does nothing
 * else, where the deleted stand-in raised every load in the Plan instead.
 */

const window = {
  cadence: "session-review" as const,
  ran_at: "2026-08-04T12:00:00.000Z",
  session_ids_considered: [],
  evidence_roster_version: "roster-v1",
};

/** The seeded Plan's back-squat Entry, and the two Sets it already carries. */
const SQUAT_ENTRY = "entry-1";

/** "Add a fourth working set" — the issue's own example, as one whole-value operation. */
const addASquatSet: PlanOperation = {
  _tag: "replaceEntrySets",
  entryId: SQUAT_ENTRY as never,
  sets: [
    { id: "set-1" as never, setType: "working", target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } }, restSec: 120 },
    { id: "set-2" as never, setType: "working", target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } }, restSec: 120 },
    { id: "set-new" as never, setType: "working", target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } }, restSec: 120 },
  ],
};

const commitProposal = (store: Store["Service"], operations: ReadonlyArray<PlanOperation> | undefined) =>
  Effect.gen(function* () {
    const committed = yield* store.commitDeliberationOutput({
      runOutput: {
        decisions: [
          {
            kind: "proposal",
            summary: "Add a fourth back squat working set.",
            rationale: "Volume has stalled at three sets.",
            citations: [],
            reasoning_only_points: [],
            surface: true,
            ...(operations === undefined ? {} : { plan_operations: operations }),
          },
        ],
        observation_directives: [],
      },
      dataWindow: window,
    });
    return committed.decisionIds[0] as string;
  });

const accept = (store: Store["Service"], proposalId: string) =>
  store.resolveProposal({ proposalId: proposalId as never, decision: "accepted" });

const squatSets = (plan: PlanSnapshot) =>
  plan.sessions
    .flatMap((session) => session.blocks)
    .flatMap((block) => block.entries)
    .find((entry) => (entry.id as string) === SQUAT_ENTRY)?.sets ?? [];

/** Every prescribed target in the Plan, in tree order. */
const targetsOf = (plan: PlanSnapshot) =>
  plan.sessions.flatMap((session) =>
    session.blocks.flatMap((block) => block.entries.flatMap((entry) => entry.sets.map((set) => set.target))),
  );

const runSuite = (withStore: <A, E>(effect: Effect.Effect<A, E, Store>) => Promise<A>) => {
  it("applies exactly the operations the Proposal carries, and nothing else", async () => {
    const [before, after] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const planBefore = yield* store.getPlan;
        const id = yield* commitProposal(store, [addASquatSet]);
        yield* accept(store, id).pipe(Effect.orDie);
        return [planBefore, yield* store.getPlan] as const;
      }),
    );

    // The set was added...
    expect(squatSets(before)).toHaveLength(2);
    expect(squatSets(after)).toHaveLength(3);
    // ...and every OTHER target in the Plan is untouched. This is the whole
    // point of #86: the deleted stand-in would have raised all six of these.
    expect(targetsOf(after).slice(3)).toEqual(targetsOf(before).slice(2));
  });

  it("carries a Proposal through to a `coach-proposal` Change, born `applied` (ADR 0008)", async () => {
    const [proposalStatus, change] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitProposal(store, [addASquatSet]);
        const resolved = yield* accept(store, id).pipe(Effect.orDie);
        const decisions = yield* store.listDecisionsForTest;
        return [
          resolved.proposal.status,
          decisions.find((d) => d.kind === "change" && d.origin === "coach-proposal"),
        ] as const;
      }),
    );

    expect(proposalStatus).toBe("accepted");
    // The Proposal row carries the DECISION; this row carries the EFFECT —
    // the same shape a user-direct edit writes, so the Plan's history reads
    // the same whoever authored the change.
    expect(change?.status).toBe("applied");
    expect(change?.planOperationsJson).not.toBeNull();
  });

  it("leaves the Proposal pending and the Plan untouched when an operation does not validate", async () => {
    const [outcome, unchanged, status] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const planBefore = yield* store.getPlan;
        const id = yield* commitProposal(store, [
          // The first operation is fine; the second names an Entry that is not
          // in the Plan. All-or-nothing means the first one must not land.
          addASquatSet,
          { _tag: "removeEntry", entryId: "entry-that-never-existed" as never },
        ]);
        const result = yield* Effect.result(accept(store, id));
        const planAfter = yield* store.getPlan;
        const decisions = yield* store.listDecisionsForTest;
        return [
          result,
          JSON.stringify(planAfter) === JSON.stringify(planBefore),
          decisions.find((d) => d.id === id)?.status,
        ] as const;
      }),
    );

    expect(Result.isFailure(outcome)).toBe(true);
    if (!Result.isFailure(outcome)) return;
    expect(outcome.failure).toBeInstanceOf(PlanOperationRejectedError);
    // Nothing half-applied: the first operation's set is NOT in the Plan.
    expect(unchanged).toBe(true);
    // Still pending, so it can be revised or dismissed rather than lost.
    expect(status).toBe("pending");
  });

  it("resolves a Proposal that proposes no Plan change with no mutation at all", async () => {
    const [unchanged, status] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const planBefore = yield* store.getPlan;
        const id = yield* commitProposal(store, undefined);
        const resolved = yield* accept(store, id).pipe(Effect.orDie);
        const planAfter = yield* store.getPlan;
        return [JSON.stringify(planAfter) === JSON.stringify(planBefore), resolved.proposal.status] as const;
      }),
    );

    expect(unchanged).toBe(true);
    expect(status).toBe("accepted");
  });

  it("does not mutate the Plan when the Proposal is dismissed", async () => {
    const unchanged = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const planBefore = yield* store.getPlan;
        const id = yield* commitProposal(store, [addASquatSet]);
        yield* store.resolveProposal({ proposalId: id as never, decision: "rejected" }).pipe(Effect.orDie);
        return JSON.stringify(yield* store.getPlan) === JSON.stringify(planBefore);
      }),
    );

    expect(unchanged).toBe(true);
  });

  it("surfaces the operations back on the Proposal, so the card can diff them", async () => {
    const operations = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitProposal(store, [addASquatSet]);
        const proposals = yield* store.getProposals;
        return proposals.find((p) => (p.id as string) === id)?.planOperations;
      }),
    );

    expect(operations).toEqual([addASquatSet]);
  });
};

describe("Accepting a Proposal applies the Change it carries (#86) — in-memory Store", () => {
  const withStore = <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runSuite(withStore);
});

describe("Accepting a Proposal applies the Change it carries (#86) — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-proposal-ops-${randomUUID()}.sqlite`);

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

  runSuite(withStore);
});
