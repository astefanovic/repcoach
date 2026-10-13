import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { DecisionStatus as DecisionStatusType, PlanOperation } from "@repcoach/contracts";
import { DecisionStatus } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/**
 * The `decision` status axis, pinned from BOTH ends at once.
 *
 * This exists because of a real failure: the store wrote `escalated` and
 * `expired` from 2B slice 1 (ADR 0011 §5), the wire contract's
 * `DecisionStatus` was written twelve days later without them, and nothing
 * failed until a live escalation made the *whole* Coach record undecodable —
 * one bad enum in one row killing every run on the surface. Every gate missed
 * it for the same reason: they all sampled. The unit suites asserted
 * `escalated` through `listDecisionsForTest`, which is *below* the contract;
 * the seed deliberately injects only `status='open'` priors, so rung 1 and
 * rung 2 both ran on data that structurally could not contain the bug.
 *
 * So this test enumerates instead of sampling, and closes the loop in both
 * directions:
 *
 * - **writer ⊆ contract** is a compile-time guarantee, not this test's job:
 *   `DecisionRecord.status` IS `DecisionStatus`, so a status the store learns
 *   to write without telling the contract no longer builds.
 * - **contract ⊆ writer** is what runs here. Every literal in `DecisionStatus`
 *   must be *reachable* by driving the real store, or the union has grown a
 *   member nothing can produce — the same drift, pointing the other way.
 *
 * The assertion is a set equality over one store driven through every
 * transition it has, which is why the scenarios below are written as one
 * sequence rather than nine isolated cases: the claim is about the axis as a
 * whole, not about nine statuses individually.
 */

const window = {
  cadence: "session-review" as const,
  ran_at: "2026-08-30T09:00:00.000Z",
  session_ids_considered: ["session-1"],
  evidence_roster_version: "roster-v1",
};

const reviseWindow = { ...window, cadence: "on-demand" as const };

const draft = (kind: "observation" | "proposal" | "answer", summary: string) => ({
  kind,
  summary,
  rationale: `rationale for: ${summary}`,
  citations: [],
  reasoning_only_points: [],
  surface: true,
});

/** The seeded Plan's back-squat Entry — the Change an accepted Proposal applies. */
const addASquatSet: PlanOperation = {
  _tag: "replaceEntrySets",
  entryId: "entry-1" as never,
  sets: [
    {
      id: "set-1" as never,
      setType: "working",
      target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } },
      restSec: 120,
    },
    {
      id: "set-new" as never,
      setType: "working",
      target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } },
      restSec: 120,
    },
  ],
};

/**
 * Drive one store through every transition that can set a `decision` status,
 * and hand back the distinct statuses it actually wrote.
 *
 * Each step names the status it exists to produce. A step that stops producing
 * one fails the set equality below rather than quietly shrinking coverage.
 */
const everyStatusTheStoreCanWrite = Effect.gen(function* () {
  const store = yield* Store;

  // Birth statuses (store.ts: observation → `open`, answer → `answered`,
  // proposal → `pending`). Two spare Observations for the directives to act on.
  const born = yield* store.commitDeliberationOutput({
    runOutput: {
      decisions: [
        draft("observation", "Bench has stalled."),
        draft("observation", "Squat volume drifted low."),
        draft("observation", "Row volume is steady."),
        draft("answer", "Yes — three sessions is enough to call it."),
        draft("proposal", "Hold the bench load one more week."),
      ],
      observation_directives: [],
    } as never,
    dataWindow: window,
  });
  const [toEscalate, toClose] = born.decisionIds;

  // `escalated` / `expired` — the two terminal Observation states (ADR 0011 §5).
  yield* store.commitDeliberationOutput({
    runOutput: {
      decisions: [],
      observation_directives: [
        { id: toEscalate, action: "escalate" },
        { id: toClose, action: "close" },
      ],
    } as never,
    dataWindow: window,
  });

  // `accepted` — a Proposal carrying no Plan operations, accepted.
  const plain = yield* store.commitDeliberationOutput({
    runOutput: { decisions: [draft("proposal", "Add a warm-up set.")], observation_directives: [] } as never,
    dataWindow: window,
  });
  yield* store
    .resolveProposal({ proposalId: plain.decisionIds[0] as never, decision: "accepted" })
    .pipe(Effect.orDie);

  // `rejected` — dismissing is an outcome, not a failure (ADR 0008).
  const dismissed = yield* store.commitDeliberationOutput({
    runOutput: { decisions: [draft("proposal", "Drop the third squat set.")], observation_directives: [] } as never,
    dataWindow: window,
  });
  yield* store
    .resolveProposal({ proposalId: dismissed.decisionIds[0] as never, decision: "rejected" })
    .pipe(Effect.orDie);

  // `applied` — accepting a Proposal that carries operations mints a
  // `coach-proposal` Change born `applied`, recording what it did to the Plan.
  const withOps = yield* store.commitDeliberationOutput({
    runOutput: {
      decisions: [{ ...draft("proposal", "Trim back squat to two sets."), plan_operations: [addASquatSet] }],
      observation_directives: [],
    } as never,
    dataWindow: window,
  });
  yield* store
    .resolveProposal({ proposalId: withOps.decisionIds[0] as never, decision: "accepted" })
    .pipe(Effect.orDie);

  // `superseded` — a Revision run replacing the pending Proposal it was
  // invoked against (ADR 0013 §3).
  const revised = yield* store.commitDeliberationOutput({
    runOutput: { decisions: [draft("proposal", "Bench: hold load, add a set.")], observation_directives: [] } as never,
    dataWindow: window,
  });
  const target = revised.decisionIds[0] as string;
  yield* store.commitDeliberationOutput({
    runOutput: {
      decisions: [draft("proposal", "Bench: hold load, add two sets instead.")],
      observation_directives: [{ id: target, action: "supersede" }],
    } as never,
    dataWindow: reviseWindow,
    reviseTargetProposalId: target as never,
  });

  // ...and one Proposal left alone, so `pending` is on the record too.
  const all = yield* store.listDecisionsForTest;
  return new Set(all.map((decision) => decision.status));
});

const runSuite = (withStore: <A>(effect: Effect.Effect<A, never, Store>) => Promise<A>) => {
  it("every DecisionStatus the contract declares is reachable by driving the store — no dead literals", async () => {
    const observed = await withStore(everyStatusTheStoreCanWrite);
    const declared: ReadonlyArray<DecisionStatusType> = DecisionStatus.literals;

    // Set equality, stated as two failures rather than one, so which direction
    // drifted is legible from the output alone.
    const unreachable = declared.filter((status) => !observed.has(status));
    expect(unreachable, "declared by the contract but nothing can produce them").toEqual([]);

    const undeclared = [...observed].filter(
      (status) => !declared.includes(status as DecisionStatusType),
    );
    expect(undeclared, "written by the store but absent from DecisionStatus").toEqual([]);
  });
};

describe("the decision status axis — in-memory Store", () => {
  runSuite((effect) => effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise));
});

describe("the decision status axis — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-decision-status-${randomUUID()}.sqlite`);
  const cleanupDbFile = (dbPath: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };
  runSuite((effect) => {
    const dbPath = tempDbPath();
    return effect
      .pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise)
      .finally(() => cleanupDbFile(dbPath));
  });
});
