import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { CommitDeliberationOutputInput, DeliberationRunOutput } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/**
 * Black-box rung-1 coverage for `Store.commitDeliberationOutput` (ADR 0011
 * §3/§6, issue #26 — 2B slice 1 walking skeleton), run against BOTH `Store`
 * layers — the in-memory `Store.layer` (mirroring `rpcHandlers.test.ts`) and
 * the real SQLite `SqlStore` (mirroring `sqlStore.test.ts`) — via one shared
 * assertion body, so the two layers can't silently drift on this seam.
 *
 * Deliberately tests ONLY the public `Store` surface
 * (`commitDeliberationOutput` / `listDecisionsForTest` / `getCoachingFeed` /
 * `getProposals`), never internals — a black-box seam test per the issue's
 * testing bar.
 */

const dataWindow = {
  cadence: "on-demand" as const,
  ran_at: "2026-07-18T12:00:00.000Z",
  session_ids_considered: ["session-a", "session-b"],
  evidence_roster_version: "roster-v1",
};

const observationDraft = (surface: boolean): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary: "Bench press working load has held flat for 3 sessions.",
  rationale: "Three consecutive sessions landed the same load at the same reps.",
  citations: [
    {
      claim: "A 3+ session load plateau is an early stall signal.",
      source_url: "https://example.com/research/plateau",
      trust: "retrieved-unverified",
    },
  ],
  reasoning_only_points: [],
  surface,
});

const proposalDraft = (): DeliberationRunOutput["decisions"][number] => ({
  kind: "proposal",
  summary: "Add a fourth back squat working set next session.",
  rationale: "Squat load has progressed cleanly with reps at the top of range for 3 sessions.",
  citations: [
    {
      claim: "Adding volume before increasing load is lower-risk when reps-in-reserve stays high.",
      source_url: "https://example.com/research/volume-first",
      trust: "corpus-verified",
    },
  ],
  reasoning_only_points: ["Restraint favors one small change at a time."],
  // `surface` is only meaningful for Observations — a Proposal always gets
  // a feed entry regardless of this flag (asserted below).
  surface: false,
});

const firstCommitInput: CommitDeliberationOutputInput = {
  runOutput: {
    decisions: [
      observationDraft(false), // never surfaced
      observationDraft(true), // surfaced
      proposalDraft(), // always surfaced, despite surface:false
    ],
    observation_directives: [],
  },
  dataWindow,
};

/**
 * The shared assertion body, run against both `Store` layers below.
 * `withStore` provides a FRESH store instance per call (a fresh in-memory
 * layer build, or a fresh temp-file `SqlStore`), matching how
 * `rpcHandlers.test.ts`/`sqlStore.test.ts` isolate each test.
 */
const runSeam1Suite = (withStore: <A>(effect: Effect.Effect<A, never, Store>) => Promise<A>) => {
  it("inserts a decision row per draft: runner-assigned id/createdAt, origin='coach-proposal', status by kind", async () => {
    const [result, created] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commitResult = yield* store.commitDeliberationOutput(firstCommitInput);
        const decisionIds = commitResult.decisionIds as ReadonlyArray<string>;
        const decisions = yield* store.listDecisionsForTest;
        const created = decisions.filter((d) => decisionIds.includes(d.id));
        return [commitResult, created] as const;
      }),
    );

    expect(result.decisionIds).toHaveLength(3);
    expect(new Set(result.decisionIds).size).toBe(3); // distinct runner-assigned ids
    expect(created).toHaveLength(3);

    for (const decision of created) {
      expect(decision.origin).toBe("coach-proposal");
      expect(decision.createdAt.length).toBeGreaterThan(0);
      expect(decision.status).toBe(decision.kind === "observation" ? "open" : "pending");
    }

    expect(created.filter((d) => d.kind === "observation")).toHaveLength(2);
    expect(created.filter((d) => d.kind === "proposal")).toHaveLength(1);
  });

  it("stores citations/data_window from the output verbatim (value-snapshot, ADR 0003)", async () => {
    const created = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commitResult = yield* store.commitDeliberationOutput(firstCommitInput);
        const decisionIds = commitResult.decisionIds as ReadonlyArray<string>;
        const decisions = yield* store.listDecisionsForTest;
        return decisions.filter((d) => decisionIds.includes(d.id));
      }),
    );

    for (const decision of created) {
      expect(decision.citationsJson).not.toBeNull();
      const citations = JSON.parse(decision.citationsJson ?? "[]") as ReadonlyArray<{ readonly claim: string }>;
      expect(citations.length).toBeGreaterThan(0);

      expect(decision.dataWindowJson).not.toBeNull();
      const storedWindow = JSON.parse(decision.dataWindowJson ?? "{}") as { readonly ran_at: string };
      expect(storedWindow.ran_at).toBe(dataWindow.ran_at);
    }
  });

  it("writes a coaching_feed_entry for every Proposal, and for Observations only when surface:true", async () => {
    const [result, newFeedEntries] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commitResult = yield* store.commitDeliberationOutput(firstCommitInput);
        const feed = yield* store.getCoachingFeed;
        const newFeedEntries = feed.filter((entry) => commitResult.feedEntryIds.includes(entry.id));
        return [commitResult, newFeedEntries] as const;
      }),
    );

    // 2 new feed entries: the surfaced Observation + the Proposal (the
    // surface:false Observation gets none).
    expect(result.feedEntryIds).toHaveLength(2);
    expect(newFeedEntries).toHaveLength(2);

    const feedProposalEntry = newFeedEntries.find((entry) => entry.kind === "proposal");
    const feedObservationEntry = newFeedEntries.find((entry) => entry.kind === "observation");
    expect(feedProposalEntry).toBeDefined();
    expect(feedObservationEntry).toBeDefined();
    // The Proposal's feed entry points back at its decision id.
    expect(feedProposalEntry?.proposalId).toBeDefined();
    // An Observation's feed entry never carries a proposalId.
    expect(feedObservationEntry?.proposalId).toBeUndefined();
  });

  it("a committed Proposal is visible via getProposals with origin/status set by the runner", async () => {
    const [result, proposals] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commitResult = yield* store.commitDeliberationOutput(firstCommitInput);
        const proposals = yield* store.getProposals;
        return [commitResult, proposals] as const;
      }),
    );

    const decisionIds = result.decisionIds as ReadonlyArray<string>;
    const committedProposal = proposals.find((p) => decisionIds.includes(p.id));
    expect(committedProposal).toBeDefined();
    expect(committedProposal?.origin).toBe("coach-proposal");
    expect(committedProposal?.status).toBe("pending");
  });

  it("observation_directives flip ONLY status on existing rows: escalate -> escalated, close -> expired; rationale/citations/data_window untouched", async () => {
    const [beforeById, afterById, observationIds] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const firstResult = yield* store.commitDeliberationOutput(firstCommitInput);
        const beforeDecisions = yield* store.listDecisionsForTest;
        const beforeById = new Map(beforeDecisions.map((d) => [d.id, d] as const));

        const observationIds = firstResult.decisionIds.filter(
          (id) => beforeById.get(id)?.kind === "observation",
        );
        const [toClose, toEscalate] = observationIds;
        if (toClose === undefined || toEscalate === undefined) {
          return yield* Effect.die(new Error("expected two observation ids from the first commit"));
        }

        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [],
            observation_directives: [
              { id: toClose as never, action: "close" },
              { id: toEscalate as never, action: "escalate" },
            ],
          },
          dataWindow,
        });

        const afterDecisions = yield* store.listDecisionsForTest;
        const afterById = new Map(afterDecisions.map((d) => [d.id, d] as const));
        return [beforeById, afterById, [toClose, toEscalate]] as const;
      }),
    );

    const [closeId, escalateId] = observationIds;

    const closedBefore = beforeById.get(closeId);
    const closedAfter = afterById.get(closeId);
    const escalatedBefore = beforeById.get(escalateId);
    const escalatedAfter = afterById.get(escalateId);

    expect(closedAfter?.status).toBe("expired");
    expect(escalatedAfter?.status).toBe("escalated");

    // Immutability: only `status` moved.
    expect(closedAfter?.rationale).toBe(closedBefore?.rationale);
    expect(closedAfter?.citationsJson).toBe(closedBefore?.citationsJson);
    expect(closedAfter?.dataWindowJson).toBe(closedBefore?.dataWindowJson);
    expect(closedAfter?.summary).toBe(closedBefore?.summary);
    expect(closedAfter?.createdAt).toBe(closedBefore?.createdAt);

    expect(escalatedAfter?.rationale).toBe(escalatedBefore?.rationale);
    expect(escalatedAfter?.citationsJson).toBe(escalatedBefore?.citationsJson);
    expect(escalatedAfter?.dataWindowJson).toBe(escalatedBefore?.dataWindowJson);
    expect(escalatedAfter?.summary).toBe(escalatedBefore?.summary);
    expect(escalatedAfter?.createdAt).toBe(escalatedBefore?.createdAt);
  });

  it("a directive referencing an unknown decision id is a no-op — no error, no row count change", async () => {
    const [beforeCount, afterCount] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const before = yield* store.listDecisionsForTest;
        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [],
            observation_directives: [{ id: "does-not-exist" as never, action: "close" }],
          },
          dataWindow,
        });
        const after = yield* store.listDecisionsForTest;
        return [before.length, after.length] as const;
      }),
    );

    expect(afterCount).toBe(beforeCount);
  });
};

describe("Store.commitDeliberationOutput — in-memory Store", () => {
  const withStore = <A>(effect: Effect.Effect<A, never, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runSeam1Suite(withStore);
});

describe("Store.commitDeliberationOutput — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-commit-deliberation-output-${randomUUID()}.sqlite`);

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

  runSeam1Suite(withStore);
});
