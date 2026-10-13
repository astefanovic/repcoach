import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput, IntakeDraftPlan, PlanSnapshot } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { SEEDED_SESSION_ID, Store } from "./store.ts";

/**
 * Rung-1 coverage for #75 — **Accept materializes the drafted Plan**, run
 * against BOTH `Store` layers through one shared assertion body so the
 * in-memory and SQLite layers cannot drift on the seam, exactly as
 * `commitDeliberationOutput.intakeRun.test.ts` does.
 *
 * ADR 0014 §6: Accept "brings the Plan into existence and exits the takeover
 * to a populated Today". Everything here is asserted from the public `Store`
 * surface — `getPlan`, `subscribePlan`, `startSession` — because that is what
 * Today and "Start workout" actually read.
 */

const intakeWindow = {
  cadence: "intake" as const,
  ran_at: "2026-07-26T12:00:00.000Z",
  session_ids_considered: [],
  evidence_roster_version: "roster-v1",
};

const reviewWindow = { ...intakeWindow, cadence: "session-review" as const };

const draftPlan: IntakeDraftPlan = {
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
            // Deliberately awkward targets: a closed interval, a one-sided
            // lower bound, and an open `rpe` (ADR 0014 §5 — the sweep governs
            // the justification, never the prescription; nothing between the
            // draft and the database may rewrite these).
            { setType: "working", target: { reps: { min: 6, max: 10 }, load: { min: 60 } }, restSec: 120 },
            { setType: "working", target: { reps: { max: 8 }, rpe: {} } },
          ],
        },
      ],
    },
    {
      label: "Lower A",
      entries: [
        {
          exerciseId: "exercise-back-squat" as never,
          exerciseName: "Back Squat",
          sets: [{ setType: "working", target: { reps: { min: 5, max: 5 }, load: { min: 80, max: 90 } } }],
        },
      ],
    },
  ],
};

const draftPlanWithNewExercise: IntakeDraftPlan = {
  ...draftPlan,
  sessions: [
    {
      label: "Upper A",
      entries: [
        {
          exerciseId: "exercise-cable-crossover" as never,
          exerciseName: "Cable Crossover",
          trackedMetrics: ["reps", "load"],
          sets: [{ setType: "working", target: { reps: { min: 8, max: 12 } } }],
        },
      ],
    },
  ],
};

const proposalDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "proposal",
  summary,
  rationale: "Four days lets each muscle be trained twice a week.",
  citations: [],
  reasoning_only_points: [],
  surface: false,
});

/** Commits one Intake Proposal carrying `plan` and returns its id. */
const commitIntake = (store: Store["Service"], plan: IntakeDraftPlan = draftPlan) =>
  Effect.gen(function* () {
    const committed = yield* store.commitDeliberationOutput({
      runOutput: { decisions: [proposalDraft("Your first training plan.")], observation_directives: [] },
      dataWindow: intakeWindow,
      intakeRun: { draftPlan: plan },
    });
    return committed.decisionIds[0] as string;
  });

/** Commits an ordinary review-cadence Proposal — no drafted Plan — and returns its id. */
const commitReviewProposal = (store: Store["Service"]) =>
  Effect.gen(function* () {
    const committed = yield* store.commitDeliberationOutput({
      runOutput: { decisions: [proposalDraft("Add 2.5kg to the squat.")], observation_directives: [] },
      dataWindow: reviewWindow,
    });
    return committed.decisionIds[0] as string;
  });

const resolve = (store: Store["Service"], proposalId: string, decision: "accepted" | "rejected") =>
  store.resolveProposal({ proposalId: proposalId as never, decision });

/** Every prescribed target in the Plan, in tree order — the round-trip assertion's subject. */
const targetsOf = (plan: PlanSnapshot) =>
  plan.sessions.flatMap((session) =>
    session.blocks.flatMap((block) => block.entries.flatMap((entry) => entry.sets.map((set) => set.target))),
  );

const runAcceptedIntakePlanSuite = (
  withStore: <A, E>(effect: Effect.Effect<A, E, Store>) => Promise<A>,
) => {
  it("replaces the Plan with the drafted sessions — the seeded demo Plan is gone", async () => {
    const plan = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitIntake(store);
        yield* resolve(store, id, "accepted").pipe(Effect.orDie);
        return yield* store.getPlan;
      }),
    );

    expect(plan.sessions.map((session) => session.name)).toEqual(["Upper A", "Lower A"]);
    // User story 4 — never an ambiguity about which Plan is the user's.
    expect(plan.sessions.some((session) => (session.id as string) === SEEDED_SESSION_ID)).toBe(false);
    // Accepting a plan accepts the model it was drafted under.
    expect(plan.planModel).toBe("upper-lower");
    // Each drafted session's entries become one straight Block (ADR 0001).
    expect(plan.sessions.map((session) => session.blocks.map((block) => block.format))).toEqual([
      ["straight"],
      ["straight"],
    ]);
  });

  it("emits the accepted Plan on subscribePlan, so Today renders it", async () => {
    const plan = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitIntake(store);
        yield* resolve(store, id, "accepted").pipe(Effect.orDie);
        return yield* Stream.runHead(store.subscribePlan).pipe(Effect.map(Option.getOrThrow));
      }),
    );

    expect(plan.sessions.map((session) => session.name)).toEqual(["Upper A", "Lower A"]);
  });

  it("keeps the prescribed targets intact through the round trip — intervals, one-sided bounds, an open rpe", async () => {
    const targets = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitIntake(store);
        yield* resolve(store, id, "accepted").pipe(Effect.orDie);
        return targetsOf(yield* store.getPlan);
      }),
    );

    // The prescription the sweep was forbidden to touch must not be quietly
    // rewritten by the store instead (user story 3).
    expect(targets).toEqual([
      { reps: { min: 6, max: 10 }, load: { min: 60 } },
      { reps: { max: 8 }, rpe: {} },
      { reps: { min: 5, max: 5 }, load: { min: 80, max: 90 } },
    ]);
  });

  it("instantiates a Logged Session from a materialized session — accepting means something beyond a screen changing", async () => {
    const [loggedSession, sessionName] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitIntake(store);
        yield* resolve(store, id, "accepted").pipe(Effect.orDie);
        const plan = yield* store.getPlan;
        const first = plan.sessions[0]!;
        const started = yield* store.startSession(first.id).pipe(Effect.orDie);
        const logged = yield* store.getLoggedSession(started.loggedSessionId);
        return [logged, first.name] as const;
      }),
    );

    // Copy-on-instantiate (ADR 0006/0007) — the snapshot is the accepted plan.
    expect(loggedSession._tag).toBe("Some");
    if (loggedSession._tag !== "Some") return;
    expect(loggedSession.value.session.name).toBe(sessionName);
    expect(loggedSession.value.session.blocks[0]?.entries[0]?.exerciseId).toBe("exercise-bench-press");
  });

  it("leaves an in-flight Logged Session intact — replacing the Plan cannot reach a frozen copy", async () => {
    const [snapshotBefore, snapshotAfter] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const started = yield* store
          .startSession(SEEDED_SESSION_ID as never)
          .pipe(Effect.orDie);
        const before = yield* store.getLoggedSession(started.loggedSessionId);
        const id = yield* commitIntake(store);
        yield* resolve(store, id, "accepted").pipe(Effect.orDie);
        const after = yield* store.getLoggedSession(started.loggedSessionId);
        return [before, after] as const;
      }),
    );

    // Copy-on-instantiate (ADR 0006/0007): materialization mints all-new ids
    // and deletes every prior Prescribed Session, but a workout already
    // underway logs against its own frozen snapshot.
    expect(Option.isSome(snapshotAfter)).toBe(true);
    expect(snapshotAfter).toEqual(snapshotBefore);
  });

  it("leaves the Plan untouched when a Proposal carrying a drafted Plan is rejected (ADR 0008)", async () => {
    const [before, after, status] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const planBefore = yield* store.getPlan;
        const id = yield* commitIntake(store);
        const resolved = yield* resolve(store, id, "rejected").pipe(Effect.orDie);
        return [planBefore, yield* store.getPlan, resolved.proposal.status] as const;
      }),
    );

    expect(after).toEqual(before);
    expect(status).toBe("rejected");
  });

  it("mutates NOTHING for a Proposal that carries no Change — the stand-in bump is gone (#86)", async () => {
    const [before, after, status] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const planBefore = yield* store.getPlan;
        const id = yield* commitReviewProposal(store);
        const resolved = yield* resolve(store, id, "accepted").pipe(Effect.orDie);
        return [planBefore, yield* store.getPlan, resolved.proposal.status] as const;
      }),
    );

    // The Proposal above carries neither a drafted Plan nor `plan_operations`,
    // so it proposes no Plan change — an Observation-shaped finding. Before
    // #86 accepting it applied a fixed +2.5 kg to EVERY prescribed Set in the
    // Plan, which is the mutation this test now exists to prove is gone. The
    // targets are spelled out rather than recomputed, so a stand-in creeping
    // back fails here instead of being mirrored by the test's own arithmetic.
    expect(status).toBe("accepted");
    expect(after.sessions.map((session) => session.id)).toEqual(before.sessions.map((session) => session.id));
    expect(targetsOf(after)).toEqual([
      { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } },
      { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } },
      { reps: { min: 8, max: 10 }, load: { min: 60, max: 60 } },
      { duration: { min: 30, max: 45 } },
      { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
      { load: { max: 60 } },
    ]);
  });

  it("authors a new catalog Exercise when the draft names one the catalog does not have yet — accept still succeeds", async () => {
    const [outcome, catalog, plan] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitIntake(store, draftPlanWithNewExercise);
        const resolved = yield* Effect.result(resolve(store, id, "accepted"));
        const catalogAfter = yield* store.getExerciseCatalog;
        const planAfter = yield* store.getPlan;
        return [resolved, catalogAfter, planAfter] as const;
      }),
    );

    // Accept succeeds — an Exercise Intake invents is the coach authoring a
    // new catalog row (CONTEXT `Exercise catalog`), not a refused Accept.
    expect(Result.isSuccess(outcome)).toBe(true);
    expect(catalog.exercises.map((exercise) => exercise.id)).toContain("exercise-cable-crossover");
    const newExercise = catalog.exercises.find((exercise) => exercise.id === "exercise-cable-crossover");
    expect(newExercise?.name).toBe("Cable Crossover");
    expect(newExercise?.trackedMetrics).toEqual(["reps", "load"]);
    expect(plan.sessions[0]?.blocks[0]?.entries[0]?.exerciseId).toBe("exercise-cable-crossover");
  });
};

describe("Accept materializes the drafted Plan (#75) — in-memory Store", () => {
  const withStore = <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runAcceptedIntakePlanSuite(withStore);
});

describe("Accept materializes the drafted Plan (#75) — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string => path.join(os.tmpdir(), `repcoach-accept-intake-${randomUUID()}.sqlite`);

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

  runAcceptedIntakePlanSuite(withStore);
});
