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
 * Black-box rung-1 coverage for **Revision runs** — what happens when the
 * user Revises a Proposal (issue #60, ADR 0013) — run against BOTH `Store`
 * layers through one shared assertion body, so the in-memory and SQLite
 * layers cannot drift on this seam.
 *
 * The subject under test is the store's role as the **trust boundary over an
 * untrusted agent output** (ADR 0011 §3): the agent supplies judgment, the
 * runner supplies the subject, and everything off-subject is refused here
 * rather than upstream. Only the public `Store` surface is touched.
 */

const reviseWindow = {
  cadence: "revision-run" as const,
  ran_at: "2026-07-26T12:00:00.000Z",
  session_ids_considered: ["session-a"],
  evidence_roster_version: "roster-v1",
};

const reviewWindow = { ...reviseWindow, cadence: "session-review" as const };

const answerDraft = (summary = "Five days is what the trend supports; here is the data."): DeliberationRunOutput["decisions"][number] => ({
  kind: "answer",
  summary,
  rationale: "Your last four sessions cleared the top of the rep range on every working set.",
  citations: [
    {
      claim: "Progressive overload requires a rising stimulus over time.",
      source_url: "https://example.com/research/overload",
      trust: "corpus-verified",
    },
  ],
  reasoning_only_points: [],
  // `surface` is meaningless for an Answer — asserted below that it is
  // ignored, so a `true` here must still produce no feed entry.
  surface: true,
});

const proposalDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "proposal",
  summary,
  rationale: "Revised to respect the stated three-day ceiling.",
  citations: [],
  reasoning_only_points: [],
  surface: false,
});

const observationDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary,
  rationale: "Noticed while digging through the Log to answer the question.",
  citations: [],
  reasoning_only_points: [],
  surface: true, // asks to be surfaced — a Revision run must refuse
});

/** Commits a pending Proposal via a normal review run and returns its id. */
const seedPendingProposal = (store: Store["Service"], summary: string) =>
  Effect.gen(function* () {
    const committed = yield* store.commitDeliberationOutput({
      runOutput: { decisions: [proposalDraft(summary)], observation_directives: [] },
      dataWindow: reviewWindow,
    });
    return committed.decisionIds[0] as string;
  });

const runRevisionRunSuite = (withStore: <A>(effect: Effect.Effect<A, never, Store>) => Promise<A>) => {
  it("an Answer is born terminal, joins the target's lineage, and never reaches the feed", async () => {
    const [answer, feedCount] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const targetId = yield* seedPendingProposal(store, "Train five days a week.");
        const feedBefore = (yield* store.getCoachingFeed).length;

        const committed = yield* store.commitDeliberationOutput({
          runOutput: { decisions: [answerDraft()], observation_directives: [] },
          dataWindow: reviseWindow,
          reviseTargetProposalId: targetId as never,
        });

        const decisions = yield* store.listDecisionsForTest;
        const answer = decisions.find((d) => d.id === (committed.decisionIds[0] as string));
        const feedAfter = (yield* store.getCoachingFeed).length;
        return [{ ...answer, targetId }, feedAfter - feedBefore] as const;
      }),
    );

    expect(answer.kind).toBe("answer");
    // Nothing to accept, no accumulation to sit in (ADR 0013 §2).
    expect(answer.status).toBe("answered");
    expect(answer.inResponseToId).toBe(answer.targetId);
    // `surface: true` on the draft must not buy an Answer a feed entry.
    expect(feedCount).toBe(0);
  });

  it("a revision supersedes the target, becomes the new pending head, and carries the lineage link", async () => {
    const [target, revision] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const targetId = yield* seedPendingProposal(store, "Train five days a week.");

        const committed = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [answerDraft(), proposalDraft("Train three days a week instead.")],
            observation_directives: [{ id: targetId as never, action: "supersede" }],
          },
          dataWindow: reviseWindow,
          reviseTargetProposalId: targetId as never,
        });

        const decisions = yield* store.listDecisionsForTest;
        const ids = committed.decisionIds as ReadonlyArray<string>;
        return [
          decisions.find((d) => d.id === targetId),
          decisions.find((d) => ids.includes(d.id) && d.kind === "proposal"),
        ] as const;
      }),
    );

    expect(target?.status).toBe("superseded");
    expect(revision?.status).toBe("pending");
    expect(revision?.inResponseToId).toBe(target?.id);
  });

  it("supersede naming ANY id other than the run's target is a no-op — a slip cannot reach past its subject", async () => {
    const [target, bystander] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const targetId = yield* seedPendingProposal(store, "The Proposal under discussion.");
        const bystanderId = yield* seedPendingProposal(store, "An unrelated pending Proposal.");

        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [answerDraft()],
            // The agent half-remembers an id from its `sqlite3` dig.
            observation_directives: [{ id: bystanderId as never, action: "supersede" }],
          },
          dataWindow: reviseWindow,
          reviseTargetProposalId: targetId as never,
        });

        const decisions = yield* store.listDecisionsForTest;
        return [
          decisions.find((d) => d.id === targetId),
          decisions.find((d) => d.id === bystanderId),
        ] as const;
      }),
    );

    expect(bystander?.status).toBe("pending"); // untouched
    expect(target?.status).toBe("pending"); // and the real target was not superseded either
  });

  it("supersede from a run with NO target is a no-op — a review cadence cannot retire a Proposal", async () => {
    const target = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const targetId = yield* seedPendingProposal(store, "A pending Proposal.");

        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [],
            observation_directives: [{ id: targetId as never, action: "supersede" }],
          },
          dataWindow: reviewWindow, // no reviseTargetProposalId
        });

        const decisions = yield* store.listDecisionsForTest;
        return decisions.find((d) => d.id === targetId);
      }),
    );

    expect(target?.status).toBe("pending");
  });

  it("supersede on an already-RESOLVED target is a no-op — an accepted Decision cannot be retired behind the Plan's back", async () => {
    const target = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const targetId = yield* seedPendingProposal(store, "A Proposal the user accepts mid-flight.");
        // Typed failures here would be a broken fixture, not the case under
        // test — die rather than widen the suite's error channel.
        yield* store
          .resolveProposal({ proposalId: targetId as never, decision: "accepted" })
          .pipe(Effect.orDie);

        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [answerDraft()],
            observation_directives: [{ id: targetId as never, action: "supersede" }],
          },
          dataWindow: reviseWindow,
          reviseTargetProposalId: targetId as never,
        });

        const decisions = yield* store.listDecisionsForTest;
        return decisions.find((d) => d.id === targetId);
      }),
    );

    // The Plan already mutated on acceptance; flipping this to `superseded`
    // would desync the Plan from its own audit trail.
    expect(target?.status).toBe("accepted");
  });

  it("scopes emissions: only the FIRST revised Proposal survives, and Observations are kept but never surfaced", async () => {
    const [proposalCount, observations, feedDelta] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const targetId = yield* seedPendingProposal(store, "The Proposal under discussion.");
        const feedBefore = (yield* store.getCoachingFeed).length;

        const committed = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [
              answerDraft(),
              proposalDraft("The revision."),
              proposalDraft("An unrelated Plan change the dig turned up."),
              observationDraft("Bench volume has drifted low."),
            ],
            observation_directives: [{ id: targetId as never, action: "supersede" }],
          },
          dataWindow: reviseWindow,
          reviseTargetProposalId: targetId as never,
        });

        const ids = committed.decisionIds as ReadonlyArray<string>;
        const decisions = yield* store.listDecisionsForTest;
        const created = decisions.filter((d) => ids.includes(d.id));
        const feedAfter = (yield* store.getCoachingFeed).length;
        return [
          created.filter((d) => d.kind === "proposal").length,
          created.filter((d) => d.kind === "observation"),
          feedAfter - feedBefore,
        ] as const;
      }),
    );

    // Answering a question must not change the subject.
    expect(proposalCount).toBe(1);
    // The dig is not wasted — it becomes evidence for future runs...
    expect(observations).toHaveLength(1);
    expect(observations[0]?.status).toBe("open");
    // ...but asking a question produces no unread feed items beyond the
    // revision itself (1 = the surviving Proposal, 0 for Answer/Observation).
    expect(feedDelta).toBe(1);
  });

  it("discards escalate/close in a Revision run — Observation accumulation belongs to the surveying cadences", async () => {
    const observation = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const seeded = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [observationDraft("A prior open Observation.")],
            observation_directives: [],
          },
          dataWindow: reviewWindow,
        });
        const observationId = seeded.decisionIds[0] as string;
        const targetId = yield* seedPendingProposal(store, "The Proposal under discussion.");

        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [answerDraft()],
            observation_directives: [{ id: observationId as never, action: "escalate" }],
          },
          dataWindow: reviseWindow,
          reviseTargetProposalId: targetId as never,
        });

        const decisions = yield* store.listDecisionsForTest;
        return decisions.find((d) => d.id === observationId);
      }),
    );

    expect(observation?.status).toBe("open");
  });

  it("leaves lineage null on an ordinary review run — an unprompted Decision has no subject", async () => {
    const created = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const committed = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [proposalDraft("An unprompted Proposal."), observationDraft("An unprompted Observation.")],
            observation_directives: [],
          },
          dataWindow: reviewWindow,
        });
        const ids = committed.decisionIds as ReadonlyArray<string>;
        const decisions = yield* store.listDecisionsForTest;
        return decisions.filter((d) => ids.includes(d.id));
      }),
    );

    expect(created).toHaveLength(2);
    for (const decision of created) {
      expect(decision.inResponseToId).toBeNull();
    }
  });
};

const revisionRunInputIsTyped: CommitDeliberationOutputInput = {
  runOutput: { decisions: [answerDraft()], observation_directives: [] },
  dataWindow: reviseWindow,
  reviseTargetProposalId: "some-decision-id" as never,
};
void revisionRunInputIsTyped;

describe("Revision run (ADR 0013) — in-memory Store", () => {
  const withStore = <A>(effect: Effect.Effect<A, never, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runRevisionRunSuite(withStore);
});

describe("Revision run (ADR 0013) — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-revision-run-${randomUUID()}.sqlite`);

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

  runRevisionRunSuite(withStore);
});
