import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type {
  CommitDeliberationOutputInput,
  DeliberationRunOutput,
  IntakeDraftPlan,
} from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/**
 * Black-box rung-1 coverage for the **Intake marker** (issue #70, ADR 0014 §6),
 * run against BOTH `Store` layers through one shared assertion body so the
 * in-memory and SQLite layers cannot drift on this seam. Mirrors
 * `commitDeliberationOutput.revisionRun.test.ts`, which is the direct precedent:
 * a runner-supplied marker whose *meaning* the store enforces, because the
 * store is the trust boundary over an untrusted agent output (ADR 0011 §3).
 *
 * What is under test is deliberately not "did the runner behave" but "can a
 * caller reach past the marker" — the three §6 rules, each asserted from the
 * public `Store` surface only.
 */

const intakeWindow = {
  cadence: "intake" as const,
  ran_at: "2026-07-26T12:00:00.000Z",
  session_ids_considered: [],
  evidence_roster_version: "roster-v1",
};

const reviewWindow = { ...intakeWindow, cadence: "session-review" as const };

const draftPlan: IntakeDraftPlan = {
  planModel: "linear-progression",
  headline: "Upper / lower, four days a week",
  sessions: [
    {
      label: "Upper A",
      entries: [
        {
          exerciseId: "exercise-bench-press" as never,
          exerciseName: "Bench Press",
          sets: [{ setType: "working", target: { reps: { min: 6, max: 10 } }, restSec: 120 }],
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

const observationDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary,
  rationale: "Noticed while drafting.",
  citations: [],
  reasoning_only_points: [],
  surface: true, // asks to be surfaced — an Intake commit must refuse
});

/** Commits the one Intake Proposal and returns its id. */
const commitIntake = (
  store: Store["Service"],
  summary: string,
  directives: DeliberationRunOutput["observation_directives"] = [],
) =>
  Effect.gen(function* () {
    const committed = yield* store.commitDeliberationOutput({
      runOutput: { decisions: [proposalDraft(summary)], observation_directives: directives },
      dataWindow: intakeWindow,
      intakeRun: { draftPlan },
    });
    return committed.decisionIds[0] as string;
  });

/**
 * Accepting is the ordinary path (ADR 0008) — Intake has no accept of its own,
 * which is the point. A not-found or already-resolved failure would be a defect
 * in these tests: the ids come from the commit that just ran.
 */
const accept = (store: Store["Service"], proposalId: string) =>
  store.resolveProposal({ proposalId: proposalId as never, decision: "accepted" }).pipe(Effect.orDie);

const runIntakeMarkerSuite = (withStore: <A>(effect: Effect.Effect<A, never, Store>) => Promise<A>) => {
  it("carries the drafted Plan as structured data on the Proposal, not as a string in a prose field", async () => {
    const proposal = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitIntake(store, "Your first training plan.");
        // Read it back through the surface the card renders from, once it is no
        // longer the live artifact.
        yield* accept(store, id);
        const proposals = yield* store.getProposals;
        return proposals.find((p) => p.id === (id as never));
      }),
    );

    expect(proposal?.draftPlan).toEqual(draftPlan);
  });

  it("withholds the Intake Proposal from the pending-Proposal surface while it is undecided, and releases it once resolved", async () => {
    const [whilePending, afterAccept] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitIntake(store, "Your first training plan.");

        const pendingSurface = yield* store.getProposals;
        const hiddenWhilePending = pendingSurface.every((p) => (p.id as string) !== id);

        yield* accept(store, id);
        const afterSurface = yield* store.getProposals;
        const visibleAfter = afterSurface.some((p) => (p.id as string) === id);

        return [hiddenWhilePending, visibleAfter] as const;
      }),
    );

    // ADR 0014 §6 — never pending on Today: it is decided in place inside the
    // takeover, so offering it there would ask the user to decide twice.
    expect(whilePending).toBe(true);
    // §7 — but it must stay readable afterwards, beside the plan it qualifies.
    expect(afterAccept).toBe(true);
  });

  it("keeps the Intake Proposal out of the Coaching feed while undecided — never in the Coach badge", async () => {
    const [duringIntake, afterAccept] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const feedBefore = (yield* store.getCoachingFeed).length;
        const id = yield* commitIntake(store, "Your first training plan.");
        const feedDuring = (yield* store.getCoachingFeed).length;
        yield* accept(store, id);
        const feedAfter = (yield* store.getCoachingFeed).length;
        return [feedDuring - feedBefore, feedAfter - feedBefore] as const;
      }),
    );

    expect(duringIntake).toBe(0);
    expect(afterAccept).toBe(1);
  });

  it("resolves the hidden Intake Proposal by id — hiding it from a surface must not make it unacceptable", async () => {
    const resolved = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = yield* commitIntake(store, "Your first training plan.");
        return yield* accept(store, id);
      }),
    );

    expect(resolved.proposal.status).toBe("accepted");
  });

  it("commits at most ONE Proposal per Intake, whatever the agent emitted", async () => {
    const proposalCount = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const committed = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [
              proposalDraft("Your first training plan."),
              proposalDraft("...and a second one, somehow."),
            ],
            observation_directives: [],
          },
          dataWindow: intakeWindow,
          intakeRun: { draftPlan },
        });
        return committed.decisionIds.length;
      }),
    );

    // "One Decision, written once" (ADR 0014 §2) is what keeps the store
    // contract trivial, so the store holds the bar itself.
    expect(proposalCount).toBe(1);
  });

  it("refuses to surface an Observation an Intake commit happened to include", async () => {
    const [feedDelta, observationStatus] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const feedBefore = (yield* store.getCoachingFeed).length;
        const committed = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [observationDraft("Noticed something in passing.")],
            observation_directives: [],
          },
          dataWindow: intakeWindow,
          intakeRun: { draftPlan },
        });
        const feedAfter = (yield* store.getCoachingFeed).length;
        const decisions = yield* store.listDecisionsForTest;
        const observation = decisions.find((d) => d.id === (committed.decisionIds[0] as string));
        return [feedAfter - feedBefore, observation?.status] as const;
      }),
    );

    // Kept in the log as evidence, forced unsurfaced — a cold-start user has no
    // feed to read yet, and manufacturing an unread item for them is noise.
    expect(feedDelta).toBe(0);
    expect(observationStatus).toBe("open");
  });

  it("supersedes only a still-pending Intake Proposal when re-converging", async () => {
    const [firstStatus, secondIsPendingHead] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const firstId = yield* commitIntake(store, "First draft of your plan.");

        // The user reopened the exchange, took another turn, and converged
        // again — the second sweep's output replaces the first.
        const secondId = yield* commitIntake(store, "Second draft of your plan.", [
          { id: firstId as never, action: "supersede" },
        ]);

        const decisions = yield* store.listDecisionsForTest;
        const first = decisions.find((d) => d.id === firstId);
        const second = decisions.find((d) => d.id === secondId);
        return [first?.status, second?.status === "pending"] as const;
      }),
    );

    expect(firstStatus).toBe("superseded");
    expect(secondIsPendingHead).toBe(true);
  });

  it("cannot supersede a Proposal that is not an Intake Proposal — every other id is a no-op", async () => {
    const reviewProposalStatus = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        // An ordinary pending Proposal from a review cadence.
        const committed = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [proposalDraft("An unrelated pending Proposal.")],
            observation_directives: [],
          },
          dataWindow: reviewWindow,
        });
        const unrelatedId = committed.decisionIds[0] as string;

        yield* commitIntake(store, "Your first training plan.", [
          { id: unrelatedId as never, action: "supersede" },
        ]);

        const decisions = yield* store.listDecisionsForTest;
        return decisions.find((d) => d.id === unrelatedId)?.status;
      }),
    );

    // The agent supplies the judgment, the marker supplies the subject — a
    // reasoning slip must not be able to kill an unrelated pending row.
    expect(reviewProposalStatus).toBe("pending");
  });

  it("cannot supersede an already-accepted Intake Proposal", async () => {
    const status = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const acceptedId = yield* commitIntake(store, "Your first training plan.");
        yield* accept(store, acceptedId);

        yield* commitIntake(store, "A later Intake, somehow.", [
          { id: acceptedId as never, action: "supersede" },
        ]);

        const decisions = yield* store.listDecisionsForTest;
        return decisions.find((d) => d.id === acceptedId)?.status;
      }),
    );

    expect(status).toBe("accepted");
  });

  it("discards escalate/close under the Intake marker — at cold start there are no priors to act on", async () => {
    const observationStatus = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        // A pre-existing open Observation from a review cadence.
        const committed = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [observationDraft("An open prior Observation.")],
            observation_directives: [],
          },
          dataWindow: reviewWindow,
        });
        const observationId = committed.decisionIds[0] as string;

        yield* commitIntake(store, "Your first training plan.", [
          { id: observationId as never, action: "close" },
        ]);

        const decisions = yield* store.listDecisionsForTest;
        return decisions.find((d) => d.id === observationId)?.status;
      }),
    );

    expect(observationStatus).toBe("open");
  });

  it("leaves the marker null on an ordinary review run — no drafted Plan, nothing hidden", async () => {
    const [record, visibleOnSurface] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const committed = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [proposalDraft("An ordinary Proposal.")],
            observation_directives: [],
          },
          dataWindow: reviewWindow,
        });
        const id = committed.decisionIds[0] as string;
        const decisions = yield* store.listDecisionsForTest;
        const proposals = yield* store.getProposals;
        return [decisions.find((d) => d.id === id), proposals.some((p) => (p.id as string) === id)] as const;
      }),
    );

    expect(record?.intakePlanJson).toBeNull();
    expect(visibleOnSurface).toBe(true);
  });
};

const intakeRunInputIsTyped: CommitDeliberationOutputInput = {
  runOutput: { decisions: [proposalDraft("A plan.")], observation_directives: [] },
  dataWindow: intakeWindow,
  intakeRun: { draftPlan },
};
void intakeRunInputIsTyped;

describe("Intake marker (ADR 0014 §6) — in-memory Store", () => {
  const withStore = <A>(effect: Effect.Effect<A, never, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runIntakeMarkerSuite(withStore);
});

describe("Intake marker (ADR 0014 §6) — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string => path.join(os.tmpdir(), `repcoach-intake-marker-${randomUUID()}.sqlite`);

  const cleanupDbFile = (dbPath: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };

  const withStore = <A>(effect: Effect.Effect<A, never, Store>): Promise<A> => {
    const dbPath = tempDbPath();
    return effect
      .pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise)
      .finally(() => cleanupDbFile(dbPath));
  };

  runIntakeMarkerSuite(withStore);
});
