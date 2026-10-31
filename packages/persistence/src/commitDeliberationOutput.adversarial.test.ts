import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type {
  CommitDeliberationOutputInput,
  DeliberationRunOutput,
  DecisionDirective,
} from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { Store, type DecisionRecord } from "./store.ts";

/**
 * ADVERSARIAL black-box coverage for `Store.commitDeliberationOutput` (issue
 * #26, ADR 0011 §3/§5/§6) — written from the SPEC, not the implementation,
 * to probe edges the implementer's own `commitDeliberationOutput.test.ts`
 * doesn't reach: verbatim JSON round-tripping (including empty arrays),
 * directive/decision interplay WITHIN a single call, directives against
 * non-Observation rows, ordering, and layer parity.
 *
 * FORBIDDEN from reading the method bodies under test — assertions come
 * from the issue spec + ADR 0011 §5/§6, `packages/contracts/src/deliberation.ts`,
 * and the `Store`/`DecisionRecord` type shapes only.
 */

const dataWindow = {
  cadence: "on-demand" as const,
  ran_at: "2026-07-18T12:00:00.000Z",
  session_ids_considered: ["session-a", "session-b"],
  evidence_roster_version: "roster-v1",
};

const otherDataWindow = {
  cadence: "cycle-review" as const,
  ran_at: "2026-08-01T09:30:00.000Z",
  window_from: "2026-07-01T00:00:00.000Z",
  window_to: "2026-08-01T00:00:00.000Z",
  session_ids_considered: ["session-x", "session-y", "session-z"],
  evidence_roster_version: "roster-v2",
};

const observationDraft = (
  surface: boolean,
  overrides: Partial<DeliberationRunOutput["decisions"][number]> = {},
): DeliberationRunOutput["decisions"][number] => ({
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
  ...overrides,
});

const proposalDraft = (
  overrides: Partial<DeliberationRunOutput["decisions"][number]> = {},
): DeliberationRunOutput["decisions"][number] => ({
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
  surface: false,
  ...overrides,
});

type WithStore = <A>(effect: Effect.Effect<A, never, Store>) => Promise<A>;

const runAdversarialSuite = (withStore: WithStore) => {
  it("empty decisions + empty directives is a true no-op: no crash, empty result arrays, no row created", async () => {
    const [result, beforeCount, afterCount] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const before = yield* store.listDecisionsForTest;
        const result = yield* store.commitDeliberationOutput({
          runOutput: { decisions: [], observation_directives: [] },
          dataWindow,
        });
        const after = yield* store.listDecisionsForTest;
        return [result, before.length, after.length] as const;
      }),
    );

    expect(result.decisionIds).toHaveLength(0);
    expect(result.feedEntryIds).toHaveLength(0);
    expect(afterCount).toBe(beforeCount);
  });

  it("stores an EMPTY citations array verbatim as [] (not null, not omitted)", async () => {
    const created = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commitResult = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [observationDraft(true, { citations: [] })],
            observation_directives: [],
          },
          dataWindow,
        });
        const decisions = yield* store.listDecisionsForTest;
        return decisions.filter((d) => commitResult.decisionIds.includes(d.id as never));
      }),
    );

    expect(created).toHaveLength(1);
    const stored = created[0];
    expect(stored?.citationsJson).not.toBeNull();
    expect(JSON.parse(stored?.citationsJson ?? "null")).toEqual([]);
  });

  it("stores citations_json fields verbatim in snake_case (claim/source_url/trust) and reasoning_only_points verbatim", async () => {
    const draft = proposalDraft({
      citations: [
        { claim: "Claim A", source_url: "https://example.com/a", trust: "corpus-verified" },
        { claim: "Claim B", source_url: "https://example.com/b", trust: "retrieved-unverified" },
      ],
      reasoning_only_points: ["Point one.", "Point two."],
    });

    const created = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commitResult = yield* store.commitDeliberationOutput({
          runOutput: { decisions: [draft], observation_directives: [] },
          dataWindow,
        });
        const decisions = yield* store.listDecisionsForTest;
        return decisions.filter((d) => commitResult.decisionIds.includes(d.id as never));
      }),
    );

    const stored = created[0];
    const citations = JSON.parse(stored?.citationsJson ?? "[]") as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(citations).toEqual(draft.citations);
    // Field names are snake_case on the wire per the agent contract.
    expect(Object.keys(citations[0] ?? {}).sort()).toEqual(["claim", "source_url", "trust"]);
  });

  it("stores data_window_json verbatim including optional window_from/window_to when present", async () => {
    const created = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commitResult = yield* store.commitDeliberationOutput({
          runOutput: { decisions: [proposalDraft()], observation_directives: [] },
          dataWindow: otherDataWindow,
        });
        const decisions = yield* store.listDecisionsForTest;
        return decisions.filter((d) => commitResult.decisionIds.includes(d.id as never));
      }),
    );

    const stored = created[0];
    const storedWindow = JSON.parse(stored?.dataWindowJson ?? "{}");
    expect(storedWindow).toEqual(otherDataWindow);
  });

  it("a directive referencing a PROPOSAL id (not an Observation) does not flip the proposal's status", async () => {
    const [proposalBefore, proposalAfter] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const firstResult = yield* store.commitDeliberationOutput({
          runOutput: { decisions: [proposalDraft()], observation_directives: [] },
          dataWindow,
        });
        const proposalId = firstResult.decisionIds[0];
        if (proposalId === undefined) {
          return yield* Effect.die(new Error("expected a proposal id"));
        }

        const before = yield* store.listDecisionsForTest;
        const proposalBefore = before.find((d) => d.id === proposalId);

        // Directive references a Proposal id, which the spec (ADR 0011 §5)
        // defines directives as acting only against Observation ids.
        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [],
            observation_directives: [{ id: proposalId as never, action: "close" }],
          },
          dataWindow,
        });

        const after = yield* store.listDecisionsForTest;
        const proposalAfter = after.find((d) => d.id === proposalId);
        return [proposalBefore, proposalAfter] as const;
      }),
    );

    // The Proposal's status must remain 'pending' — a directive is only a
    // valid operation against an existing Observation per the spec.
    expect(proposalAfter?.status).toBe(proposalBefore?.status);
    expect(proposalAfter?.status).toBe("pending");
  });

  it("a directive on an unknown id changes neither decision rows nor feed rows (full no-op, not just decision count)", async () => {
    const [beforeDecisions, afterDecisions, beforeFeed, afterFeed] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        // Seed some real state first so the no-op is checked against a non-empty store.
        yield* store.commitDeliberationOutput({
          runOutput: { decisions: [observationDraft(true), proposalDraft()], observation_directives: [] },
          dataWindow,
        });

        const beforeDecisions = yield* store.listDecisionsForTest;
        const beforeFeed = yield* store.getCoachingFeed;

        const result = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [],
            observation_directives: [{ id: "does-not-exist-at-all" as never, action: "escalate" }],
          },
          dataWindow,
        });

        const afterDecisions = yield* store.listDecisionsForTest;
        const afterFeed = yield* store.getCoachingFeed;
        return [beforeDecisions, afterDecisions, beforeFeed, afterFeed, result] as const;
      }),
    );

    expect(afterDecisions).toEqual(beforeDecisions);
    expect(afterFeed).toEqual(beforeFeed);
  });

  it("a directive can reference an Observation id CREATED IN THE SAME CALL (accumulation: new Proposal + escalate a prior-run Observation together)", async () => {
    const [priorObservationId, secondResult, afterDecisions] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        // First run: an open Observation from a prior run.
        const firstResult = yield* store.commitDeliberationOutput({
          runOutput: { decisions: [observationDraft(true)], observation_directives: [] },
          dataWindow,
        });
        const priorObservationId = firstResult.decisionIds[0];
        if (priorObservationId === undefined) {
          return yield* Effect.die(new Error("expected an observation id from first run"));
        }

        // Second run: emits a NEW Proposal (the escalation) AND a directive
        // against the OLD Observation id in the SAME commit call — the
        // realistic escalation shape per ADR 0011 §5.
        const secondResult = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [proposalDraft({ summary: "Escalated: increase squat working load." })],
            observation_directives: [{ id: priorObservationId as never, action: "escalate" }],
          },
          dataWindow,
        });

        const afterDecisions = yield* store.listDecisionsForTest;
        return [priorObservationId, secondResult, afterDecisions] as const;
      }),
    );

    expect(secondResult.decisionIds).toHaveLength(1); // only the new Proposal
    const newProposal = afterDecisions.find((d) => secondResult.decisionIds.includes(d.id as never));
    expect(newProposal?.status).toBe("pending");

    const escalatedObservation = afterDecisions.find((d) => d.id === priorObservationId);
    expect(escalatedObservation?.status).toBe("escalated");
  });

  it("multiple decisions + multiple directives in ONE call all apply correctly together", async () => {
    const [seedIds, result, afterDecisions, afterFeed] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const seedResult = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [observationDraft(true), observationDraft(true), observationDraft(false)],
            observation_directives: [],
          },
          dataWindow,
        });
        const seedIds = seedResult.decisionIds as ReadonlyArray<string>;
        const [obsA, obsB, obsC] = seedIds;
        if (obsA === undefined || obsB === undefined || obsC === undefined) {
          return yield* Effect.die(new Error("expected three seeded observation ids"));
        }

        const result = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [proposalDraft(), observationDraft(true)],
            observation_directives: [
              { id: obsA as never, action: "escalate" },
              { id: obsB as never, action: "close" },
              // obsC left untouched
            ],
          },
          dataWindow,
        });

        const afterDecisions = yield* store.listDecisionsForTest;
        const afterFeed = yield* store.getCoachingFeed;
        return [seedIds, result, afterDecisions, afterFeed] as const;
      }),
    );

    expect(result.decisionIds).toHaveLength(2); // proposal + new observation
    expect(result.feedEntryIds).toHaveLength(2); // proposal always + surfaced observation

    const [obsA, obsB, obsC] = seedIds;
    const byId = new Map(afterDecisions.map((d) => [d.id, d] as const));
    expect(byId.get(obsA as string)?.status).toBe("escalated");
    expect(byId.get(obsB as string)?.status).toBe("expired");
    expect(byId.get(obsC as string)?.status).toBe("open"); // untouched

    const newProposal = afterDecisions.find(
      (d) => result.decisionIds.includes(d.id as never) && d.kind === "proposal",
    );
    expect(newProposal?.status).toBe("pending");
  });

  it("runner-assigned ids stay unique across MANY decisions submitted in one call", async () => {
    const decisionIds = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const manyDecisions: DeliberationRunOutput["decisions"] = Array.from({ length: 25 }, (_, i) =>
          i % 2 === 0 ? observationDraft(i % 4 === 0) : proposalDraft({ summary: `Proposal #${i}` }),
        );
        const result = yield* store.commitDeliberationOutput({
          runOutput: { decisions: manyDecisions, observation_directives: [] },
          dataWindow,
        });
        return result.decisionIds as ReadonlyArray<string>;
      }),
    );

    expect(decisionIds).toHaveLength(25);
    expect(new Set(decisionIds).size).toBe(25);
  });

  it("feed entries preserve the decisions[] submission order (stable ordering, not e.g. reversed/hash-order)", async () => {
    const [result, feedEntries] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const orderedDrafts = [
          proposalDraft({ summary: "First proposal in the array." }),
          observationDraft(true, { summary: "Second, a surfaced observation." }),
          proposalDraft({ summary: "Third proposal in the array." }),
        ];
        const commitResult = yield* store.commitDeliberationOutput({
          runOutput: { decisions: orderedDrafts, observation_directives: [] },
          dataWindow,
        });
        const feed = yield* store.getCoachingFeed;
        const feedEntries = feed.filter((entry) => commitResult.feedEntryIds.includes(entry.id));
        return [commitResult, feedEntries] as const;
      }),
    );

    expect(result.feedEntryIds).toHaveLength(3);
    // feedEntryIds itself should be returned in submission order.
    const summaries = result.feedEntryIds
      .map((id) => feedEntries.find((e) => e.id === id)?.summary)
      .filter((s): s is string => s !== undefined);
    expect(summaries).toEqual([
      "First proposal in the array.",
      "Second, a surfaced observation.",
      "Third proposal in the array.",
    ]);
  });

  it("an Observation's feed entry summary matches the decision summary and carries no proposalId even after later escalation", async () => {
    const [observationId, feedEntryBefore, feedEntryAfter] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const firstResult = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [observationDraft(true, { summary: "Distinctive observation summary." })],
            observation_directives: [],
          },
          dataWindow,
        });
        const observationId = firstResult.decisionIds[0];
        if (observationId === undefined) {
          return yield* Effect.die(new Error("expected an observation id"));
        }
        const feedBefore = yield* store.getCoachingFeed;
        const feedEntryBefore = feedBefore.find((e) => firstResult.feedEntryIds.includes(e.id));

        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [],
            observation_directives: [{ id: observationId as never, action: "escalate" }],
          },
          dataWindow,
        });

        const feedAfter = yield* store.getCoachingFeed;
        const feedEntryAfter = feedAfter.find((e) => e.id === feedEntryBefore?.id);
        return [observationId, feedEntryBefore, feedEntryAfter] as const;
      }),
    );

    expect(feedEntryBefore?.summary).toBe("Distinctive observation summary.");
    expect(feedEntryBefore?.proposalId).toBeUndefined();
    // Escalating the Observation must not retroactively rewrite or delete its feed entry.
    expect(feedEntryAfter).toBeDefined();
    expect(feedEntryAfter?.summary).toBe(feedEntryBefore?.summary);
    expect(feedEntryAfter?.proposalId).toBeUndefined();
    expect(observationId).toBeDefined();
  });

  it("close (not escalate) also leaves rationale/citations/data_window/summary/createdAt byte-identical", async () => {
    const [before, after] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const firstResult = yield* store.commitDeliberationOutput({
          runOutput: { decisions: [observationDraft(true)], observation_directives: [] },
          dataWindow,
        });
        const id = firstResult.decisionIds[0];
        if (id === undefined) {
          return yield* Effect.die(new Error("expected observation id"));
        }
        const beforeAll = yield* store.listDecisionsForTest;
        const before = beforeAll.find((d) => d.id === id);

        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [],
            observation_directives: [{ id: id as never, action: "close" }],
          },
          dataWindow,
        });

        const afterAll = yield* store.listDecisionsForTest;
        const after = afterAll.find((d) => d.id === id);
        return [before, after] as const;
      }),
    );

    expect(after?.status).toBe("expired");
    expect(after?.status).not.toBe(before?.status);
    const { status: _beforeStatus, ...beforeRest } = before as DecisionRecord;
    const { status: _afterStatus, ...afterRest } = after as DecisionRecord;
    expect(afterRest).toEqual(beforeRest);
  });
};

describe("Store.commitDeliberationOutput — ADVERSARIAL — in-memory Store", () => {
  const withStore: WithStore = (effect) =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runAdversarialSuite(withStore);
});

describe("Store.commitDeliberationOutput — ADVERSARIAL — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-commit-deliberation-output-adversarial-${randomUUID()}.sqlite`);

  const cleanupDbFile = (dbPath: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };

  const withStore: WithStore = (effect) => {
    const dbPath = tempDbPath();
    return effect
      .pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise)
      .finally(() => cleanupDbFile(dbPath));
  };

  runAdversarialSuite(withStore);
});

describe("Store.commitDeliberationOutput — LAYER PARITY (in-memory vs SqlStore)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-commit-deliberation-output-parity-${randomUUID()}.sqlite`);

  const cleanupDbFile = (dbPath: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };

  const canned: CommitDeliberationOutputInput = {
    runOutput: {
      decisions: [observationDraft(false), observationDraft(true), proposalDraft()],
      observation_directives: [] as ReadonlyArray<DecisionDirective> as DecisionDirective[],
    },
    dataWindow,
  };

  it("produces equivalent observable shape on both layers for the same canned run-output", async () => {
    const memory = await Effect.gen(function* () {
      const store = yield* Store;
      const result = yield* store.commitDeliberationOutput(canned);
      const decisions = yield* store.listDecisionsForTest;
      const feed = yield* store.getCoachingFeed;
      const created = decisions.filter((d) => result.decisionIds.includes(d.id as never));
      const createdFeed = feed.filter((e) => result.feedEntryIds.includes(e.id));
      return {
        decisionCount: result.decisionIds.length,
        feedCount: result.feedEntryIds.length,
        kinds: created.map((d) => d.kind).sort(),
        statuses: created.map((d) => d.status).sort(),
        feedKinds: createdFeed.map((e) => e.kind).sort(),
      };
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    const dbPath = tempDbPath();
    const sql = await Effect.gen(function* () {
      const store = yield* Store;
      const result = yield* store.commitDeliberationOutput(canned);
      const decisions = yield* store.listDecisionsForTest;
      const feed = yield* store.getCoachingFeed;
      const created = decisions.filter((d) => result.decisionIds.includes(d.id as never));
      const createdFeed = feed.filter((e) => result.feedEntryIds.includes(e.id));
      return {
        decisionCount: result.decisionIds.length,
        feedCount: result.feedEntryIds.length,
        kinds: created.map((d) => d.kind).sort(),
        statuses: created.map((d) => d.status).sort(),
        feedKinds: createdFeed.map((e) => e.kind).sort(),
      };
    })
      .pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise)
      .finally(() => cleanupDbFile(dbPath));

    expect(sql).toEqual(memory);
  });
});
