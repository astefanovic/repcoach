import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { PlanOperation, ProposedCatalogExercise } from "@repcoach/contracts";
import { PlanOperationRejectedError } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { SEEDED_SESSION_ID, Store } from "./store.ts";

/**
 * Rung-1 coverage for a coach Proposal that introduces an **Exercise** (ADR
 * 0016), across BOTH `Store` layers through one shared assertion body — the
 * same discipline `acceptedProposalOperations.test.ts` runs on, and for the
 * same reason: the two layers must not be able to disagree about what
 * accepting such a Proposal means.
 *
 * The gap this closes is an asymmetry that had been open since ADR 0016.
 * Intake could always author an Exercise — `materializeDraftPlan` mints a
 * catalog row for every unknown `exerciseId` an accepted draft names. A review
 * cadence proposes OPERATIONS instead, and `addEntry` carries an `exerciseId`
 * and nothing else, so proposing a movement the catalog had never held used to
 * apply ANYWAY, into an Entry pointing at a row that did not exist: the raw id
 * rendered where the name belongs, no tracked metrics for the logging grid,
 * zero volume toward every muscle, and — because the enrichment roster reads
 * the catalog table — no path by which anything ever repaired it.
 *
 * Two halves, and both are asserted here: `addEntry` now REFUSES an id that
 * joins to nothing, and `catalog_exercises` is how a Proposal legitimately
 * declares the row it needs.
 */

const window = {
  cadence: "session-review" as const,
  ran_at: "2026-08-09T12:00:00.000Z",
  session_ids_considered: [],
  evidence_roster_version: "roster-v1",
};

const NEW_EXERCISE: ProposedCatalogExercise = {
  exercise_id: "exercise-barbell-row" as never,
  name: "Barbell Row" as never,
  tracked_metrics: ["reps", "load"],
};

/** Add the new movement to the seeded Session, then give it its sets. */
const addTheRow: ReadonlyArray<PlanOperation> = [
  {
    _tag: "addEntry",
    sessionId: SEEDED_SESSION_ID as never,
    blockId: "block-row" as never,
    entryId: "entry-row" as never,
    exerciseId: NEW_EXERCISE.exercise_id,
  },
  {
    _tag: "replaceEntrySets",
    entryId: "entry-row" as never,
    sets: [
      {
        id: "set-row-1" as never,
        setType: "working",
        target: { reps: { min: 8, max: 12 }, load: { min: 40, max: 40 } },
        restSec: 120,
      },
    ],
  },
];

const commitProposal = (
  store: Store["Service"],
  operations: ReadonlyArray<PlanOperation>,
  exercises?: ReadonlyArray<ProposedCatalogExercise>,
) =>
  Effect.gen(function* () {
    const committed = yield* store.commitDeliberationOutput({
      runOutput: {
        decisions: [
          {
            kind: "proposal",
            summary: "Add barbell rows for horizontal pulling volume.",
            rationale: "Nothing in the plan trains the upper back directly.",
            citations: [],
            reasoning_only_points: [],
            surface: true,
            plan_operations: operations,
            ...(exercises === undefined ? {} : { catalog_exercises: exercises }),
          },
        ],
        observation_directives: [],
      },
      dataWindow: window,
    });
    return committed.decisionIds[0] as string;
  });

const catalogIds = (store: Store["Service"]) =>
  store.getExerciseCatalog.pipe(Effect.map((catalog) => catalog.exercises.map((e) => e.id as string)));

const entryIds = (store: Store["Service"]) =>
  store.getPlan.pipe(
    Effect.map((plan) =>
      plan.sessions.flatMap((session) =>
        session.blocks.flatMap((block) => block.entries.map((entry) => entry.id as string)),
      ),
    ),
  );

const runSuite = (withStore: <A, E>(effect: Effect.Effect<A, E, Store>) => Promise<A>) => {
  it("creates the declared catalog row, then applies the operation that references it", async () => {
    const [ids, entries, entry] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitProposal(store, addTheRow, [NEW_EXERCISE]);
        yield* store.resolveProposal({ proposalId: id as never, decision: "accepted" }).pipe(Effect.orDie);
        const plan = yield* store.getPlan;
        const added = plan.sessions
          .flatMap((session) => session.blocks)
          .flatMap((block) => block.entries)
          .find((candidate) => (candidate.id as string) === "entry-row");
        return [yield* catalogIds(store), yield* entryIds(store), added] as const;
      }),
    );

    expect(ids).toContain("exercise-barbell-row");
    expect(entries).toContain("entry-row");
    // The Entry inherits the metrics the Proposal declared — the whole reason
    // the row has to exist before the Entry does. Without it the grid renders
    // no fields at all.
    expect(entry?.trackedMetrics).toEqual(["reps", "load"]);
    expect(entry?.sets).toHaveLength(1);
  });

  it("refuses the whole Proposal when an operation names an Exercise nobody declared", async () => {
    const [outcome, ids, entries, status] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        // Operations that reference the new id, with NO `catalog_exercises` —
        // the shape that used to apply into a dangling Entry.
        const id = yield* commitProposal(store, addTheRow);
        const result = yield* Effect.result(
          store.resolveProposal({ proposalId: id as never, decision: "accepted" }),
        );
        const decisions = yield* store.listDecisionsForTest;
        return [
          result,
          yield* catalogIds(store),
          yield* entryIds(store),
          decisions.find((d) => d.id === id)?.status,
        ] as const;
      }),
    );

    expect(Result.isFailure(outcome)).toBe(true);
    if (!Result.isFailure(outcome)) return;
    expect(outcome.failure).toBeInstanceOf(PlanOperationRejectedError);
    expect(String((outcome.failure as PlanOperationRejectedError).reason)).toContain(
      "exercise-barbell-row",
    );
    // Loud and total, rather than a silently orphaned Entry: no row, no Entry,
    // and the Proposal still pending so it can be revised rather than lost.
    expect(ids).not.toContain("exercise-barbell-row");
    expect(entries).not.toContain("entry-row");
    expect(status).toBe("pending");
  });

  it("writes no catalog row when the Proposal is rejected", async () => {
    const ids = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitProposal(store, addTheRow, [NEW_EXERCISE]);
        yield* store.resolveProposal({ proposalId: id as never, decision: "rejected" }).pipe(Effect.orDie);
        return yield* catalogIds(store);
      }),
    );

    // A catalog row is permanent — renameable, never deleted, because past
    // Logged Sessions reference it. Creating one when the run committed would
    // leave a row behind every Proposal the user turns down, forever.
    expect(ids).not.toContain("exercise-barbell-row");
  });

  it("leaves a row that already exists alone rather than overwriting its name", async () => {
    const name = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createExercise({
          exerciseId: NEW_EXERCISE.exercise_id,
          name: "Pendlay Row" as never,
        });
        const id = yield* commitProposal(store, addTheRow, [NEW_EXERCISE]);
        yield* store.resolveProposal({ proposalId: id as never, decision: "accepted" }).pipe(Effect.orDie);
        const catalog = yield* store.getExerciseCatalog;
        return catalog.exercises.find((e) => (e.id as string) === "exercise-barbell-row")?.name;
      }),
    );

    // Idempotent on the id, exactly as `createExercise` is: the standing row
    // may carry a name the user has since fixed, and a Proposal drafted before
    // that fix does not get to undo it.
    expect(name).toBe("Pendlay Row");
  });

  it("surfaces the declared rows back on the Proposal, so the card can render them", async () => {
    const declared = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitProposal(store, addTheRow, [NEW_EXERCISE]);
        const proposals = yield* store.getProposals;
        return proposals.find((p) => (p.id as string) === id)?.catalogExercises;
      }),
    );

    expect(declared).toEqual([NEW_EXERCISE]);
  });

  it("drops declared rows on a Decision that carries no operations to reference them", async () => {
    const declared = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const committed = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [
              {
                kind: "observation",
                summary: "Upper-back volume is thin.",
                rationale: "Worth watching.",
                citations: [],
                reasoning_only_points: [],
                surface: false,
                catalog_exercises: [NEW_EXERCISE],
              },
            ],
            observation_directives: [],
          },
          dataWindow: window,
        });
        const decisions = yield* store.listDecisionsForTest;
        return decisions.find((d) => d.id === committed.decisionIds[0])?.catalogExercisesJson;
      }),
    );

    // An Observation applies nothing, so there is no Accept that would ever
    // create these rows — storing them would be an orphan waiting to happen.
    expect(declared).toBeNull();
  });
};

describe("A Proposal that introduces an Exercise (ADR 0016) — in-memory Store", () => {
  const withStore = <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runSuite(withStore);
});

describe("A Proposal that introduces an Exercise (ADR 0016) — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-proposed-catalog-${randomUUID()}.sqlite`);

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
