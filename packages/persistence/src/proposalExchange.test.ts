import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/**
 * Black-box rung-1 coverage for the **Revise contract + persistence seam**
 * (issue #66 slice 1, ADR 0013): the Revise prose is durable and readable
 * (§1/§9), `getProposalExchange` walks a lineage chain oldest-first (§9), an
 * answer-only turn leaves the original Proposal as the chain head (§2), and
 * `getDecision` round-trips a full Decision (§6's Revision-run seed needs).
 *
 * Run against BOTH `Store` layers through one shared assertion body, so the
 * in-memory and SQLite layers cannot drift on this seam (mirrors
 * `commitDeliberationOutput.revisionRun.test.ts`). Only the public `Store`
 * surface is touched.
 */

const reviewWindow = {
  cadence: "session-review" as const,
  ran_at: "2026-07-26T12:00:00.000Z",
  session_ids_considered: ["session-a"],
  evidence_roster_version: "roster-v1",
};

const reviseWindow = { ...reviewWindow, cadence: "revision-run" as const };

const answerDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
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
  surface: false,
});

const proposalDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "proposal",
  summary,
  rationale: "Revised to respect the stated ceiling.",
  citations: [],
  reasoning_only_points: [],
  surface: false,
});

const seedPendingProposal = (store: Store["Service"], summary: string) =>
  Effect.gen(function* () {
    const committed = yield* store.commitDeliberationOutput({
      runOutput: { decisions: [proposalDraft(summary)], observation_directives: [] },
      dataWindow: reviewWindow,
    });
    return committed.decisionIds[0] as string;
  });

/** Picks out the `kind: 'proposal'` id among a commit's `decisionIds` (a run also commits an Answer). */
const findCommittedProposalId = (store: Store["Service"], decisionIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    for (const id of decisionIds) {
      const decision = yield* store.getDecision(id);
      if (Option.isSome(decision) && decision.value.kind === "proposal") {
        return id;
      }
    }
    return yield* Effect.die(new Error("no proposal id found among decisionIds"));
  });

const runSuite = (withStore: <A>(effect: Effect.Effect<A, never, Store>) => Promise<A>) => {
  it("the Revise prose is persisted on the Answer row and readable back", async () => {
    const answer = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const targetId = yield* seedPendingProposal(store, "Train five days a week.");

        const committed = yield* store.commitDeliberationOutput({
          runOutput: { decisions: [answerDraft("Here is why five days.")], observation_directives: [] },
          dataWindow: reviseWindow,
          reviseTargetProposalId: targetId as never,
          revisionProse: "why 5 days?" as never,
        });

        const decision = yield* store.getDecision(committed.decisionIds[0] as string);
        return decision;
      }),
    );

    expect(Option.isSome(answer)).toBe(true);
    expect(Option.getOrThrow(answer).revisionProse).toBe("why 5 days?");
  });

  // Regression (#66): the walk used to read the user's prose off the ANSWER
  // row, so a run that emitted only a revised Proposal — no Answer — dropped
  // the user's own words off the card entirely. ADR 0013 §9 makes rendering
  // that prose a trust obligation, and §2's "an Answer, always" is a promise
  // made by the agent, not something the read model may rely on.
  it("renders the Revise prose even when the run emitted no Answer at all", async () => {
    const exchange = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const targetId = yield* seedPendingProposal(store, "Train five days a week.");

        const committed = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [proposalDraft("Three days instead of five.")],
            observation_directives: [{ id: targetId as never, action: "supersede" as const }],
          },
          dataWindow: reviseWindow,
          reviseTargetProposalId: targetId as never,
          revisionProse: "not 5 days, I can never train more than 3" as never,
        });

        const headId = yield* findCommittedProposalId(store, committed.decisionIds);
        return yield* store.getProposalExchange(headId);
      }),
    );

    const entries = Option.getOrThrow(exchange).entries;
    const revise = entries.filter((entry) => entry.kind === "revise");
    expect(revise).toHaveLength(1);
    expect(revise[0]).toMatchObject({ text: "not 5 days, I can never train more than 3" });
    // One turn, one prose entry — the run stamps it on every row it commits.
    expect(entries.filter((entry) => entry.kind === "superseded-proposal")).toHaveLength(1);
  });

  it("getDecision round-trips a full Decision — summary, rationale, citations, data window", async () => {
    const decision = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const targetId = yield* seedPendingProposal(store, "Train five days a week.");
        return yield* store.getDecision(targetId);
      }),
    );

    expect(Option.isSome(decision)).toBe(true);
    const row = Option.getOrThrow(decision);
    expect(row.kind).toBe("proposal");
    expect(row.summary).toBe("Train five days a week.");
    expect(row.rationale).toBe("Revised to respect the stated ceiling.");
    expect(row.dataWindowJson).not.toBeNull();
  });

  it("getDecision returns None for an unknown id", async () => {
    const decision = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.getDecision("no-such-id");
      }),
    );

    expect(Option.isNone(decision)).toBe(true);
  });

  it("walks a two-turn chain oldest-first: revise, answer, superseded-proposal per turn", async () => {
    const exchange = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const p0 = yield* seedPendingProposal(store, "Train five days a week.");

        const turn0 = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [answerDraft("Five days fits the trend."), proposalDraft("Train three days a week.")],
            observation_directives: [{ id: p0 as never, action: "supersede" }],
          },
          dataWindow: reviseWindow,
          reviseTargetProposalId: p0 as never,
          revisionProse: "not 5 days, I can't train more than 3" as never,
        });
        const p1 = yield* findCommittedProposalId(store, turn0.decisionIds as ReadonlyArray<string>);

        const turn1 = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [answerDraft("Three it is."), proposalDraft("Train three days, upper/lower split.")],
            observation_directives: [{ id: p1 as never, action: "supersede" }],
          },
          dataWindow: reviseWindow,
          reviseTargetProposalId: p1 as never,
          revisionProse: "make it upper/lower" as never,
        });
        const p2 = yield* findCommittedProposalId(store, turn1.decisionIds as ReadonlyArray<string>);

        return yield* store.getProposalExchange(p2);
      }),
    );

    expect(Option.isSome(exchange)).toBe(true);
    const kinds = Option.getOrThrow(exchange).entries.map((e) => e.kind);
    expect(kinds).toEqual([
      "revise",
      "answer",
      "superseded-proposal",
      "revise",
      "answer",
      "superseded-proposal",
    ]);
    const texts = Option.getOrThrow(exchange).entries.filter((e) => e.kind === "revise").map((e) => e.text);
    expect(texts).toEqual(["not 5 days, I can't train more than 3", "make it upper/lower"]);
  });

  it("an Answer with no revision keeps the original Proposal as the chain head", async () => {
    const exchange = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const p0 = yield* seedPendingProposal(store, "Train five days a week.");

        yield* store.commitDeliberationOutput({
          runOutput: { decisions: [answerDraft("Five days is what the trend supports.")], observation_directives: [] },
          dataWindow: reviseWindow,
          reviseTargetProposalId: p0 as never,
          revisionProse: "why 5 days?" as never,
        });

        return [yield* store.getProposalExchange(p0), yield* store.getProposals] as const;
      }),
    );

    const [ex, proposals] = exchange;
    expect(Option.isSome(ex)).toBe(true);
    const entries = Option.getOrThrow(ex).entries;
    expect(entries.map((e) => e.kind)).toEqual(["revise", "answer"]);
    // The original stays pending and is still the head — no supersede.
    expect(proposals.some((p) => p.status === "pending")).toBe(true);
  });

  it("getProposalExchange returns None for a non-Proposal or unknown id", async () => {
    const [forObservation, forUnknown] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const seeded = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [
              {
                kind: "observation",
                summary: "An Observation, not a Proposal.",
                rationale: "n/a",
                citations: [],
                reasoning_only_points: [],
                surface: true,
              },
            ],
            observation_directives: [],
          },
          dataWindow: reviewWindow,
        });
        const observationId = seeded.decisionIds[0] as string;
        return [
          yield* store.getProposalExchange(observationId),
          yield* store.getProposalExchange("no-such-id"),
        ] as const;
      }),
    );

    expect(Option.isNone(forObservation)).toBe(true);
    expect(Option.isNone(forUnknown)).toBe(true);
  });
};

describe("Proposal exchange + Revise prose (ADR 0013, issue #66 slice 1) — in-memory Store", () => {
  const withStore = <A>(effect: Effect.Effect<A, never, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runSuite(withStore);
});

describe("Proposal exchange + Revise prose (ADR 0013, issue #66 slice 1) — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string => path.join(os.tmpdir(), `repcoach-proposal-exchange-${randomUUID()}.sqlite`);

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

  runSuite(withStore);
});
