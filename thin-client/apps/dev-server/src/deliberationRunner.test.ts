import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput } from "@repcoach/contracts";
import { ZERO_TOKEN_USAGE } from "@repcoach/contracts";

import { DeliberationAgent } from "./deliberationAgent.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { DeliberationRunner, makeCannedDeliberationRunnerLayer } from "./deliberationRunner.ts";
import { DeliberationSweepAgent } from "./deliberationSweepAgent.ts";
import { UnwiredIntakeSessionAgent } from "./intakeSessionAgent.ts";
import { CannedIntakeSweepAgent } from "./intakeSweepAgent.ts";
import { QuotaServiceAlwaysAvailable } from "./quotaService.ts";
import { SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "./store.ts";

/**
 * Seam 2 black-box coverage (issue #26 — 2B slice 1 walking skeleton; sweep
 * wiring coverage added issue #28 — 2B slice 3): `DeliberationRunner.runNow`
 * wired to the canned `DeliberationAgent` (deliberator) + canned
 * `DeliberationSweepAgent` (adversarial sweep), over the in-memory `Store`,
 * asserting the STORE reflects the SWEPT output — never reaching into
 * runner internals. This is the "tapping run now produces a real decision
 * row + matching coaching_feed_entry, visible via the existing subscribe
 * path" acceptance criterion, minus the RPC transport itself (covered
 * separately by `rpcHandlers.test.ts`'s `deliberation.runNow` case).
 *
 * `provideMerge` (not `provide`) so `Store` stays in the resulting
 * environment for assertions below, mirroring `rpcHandlers.test.ts`.
 */
const TestLayer = makeCannedDeliberationRunnerLayer(Store.layer).pipe(Layer.provideMerge(Store.layer));

/**
 * Builds a `DeliberationRunner` test layer with FULLY CONTROLLED deliberator
 * + sweep stand-ins (rather than the fixed `CannedDeliberationAgent`/
 * `CannedDeliberationSweepAgent`), so tests can prove exactly which of the
 * two agents' output actually lands in the store.
 */
const makeControlledRunnerLayer = (options: {
  readonly draft: DeliberationRunOutput;
  readonly sweep: (draft: DeliberationRunOutput) => DeliberationRunOutput;
}) => {
  const DeliberationAgentTest = Layer.succeed(DeliberationAgent)({
    run: (_assembledPrompt) =>
      Effect.succeed({
        output: options.draft,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0,
      }),
  });
  const DeliberationSweepAgentTest = Layer.succeed(DeliberationSweepAgent)({
    run: (draft) => Effect.succeed({ output: options.sweep(draft), usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
  });

  return DeliberationRunner.layer.pipe(
    Layer.provide(DeliberationAgentTest),
    Layer.provide(DeliberationSweepAgentTest),
    // Intake ports the review cadences never touch — provided so the runner layer builds.
    Layer.provide(UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(QuotaServiceAlwaysAvailable),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  );
};

const DRAFT_MARKER_OUTPUT: DeliberationRunOutput = {
  decisions: [
    {
      kind: "proposal",
      summary: "DRAFT-MARKER: never expected to reach the store",
      rationale: "This is the deliberator's unswept draft — the runner must never commit it directly.",
      citations: [
        { claim: "fabricated claim", source_url: "https://example.com/fabricated", trust: "corpus-verified" },
      ],
      reasoning_only_points: [],
      surface: true,
    },
  ],
  observation_directives: [],
};

describe("DeliberationRunner: sweep is a second, one-way stage (issue #28)", () => {
  it("commits the SWEEP's output, not the deliberator's draft, when they differ", async () => {
    let sweepWasCalledWithDraft: DeliberationRunOutput | undefined;

    const swept: DeliberationRunOutput = {
      decisions: [
        {
          kind: "observation",
          summary: "SWEEP-MARKER: the sweep's rewritten output",
          rationale: "The sweep rewrote the draft proposal down to an observation and stripped its citation.",
          citations: [],
          reasoning_only_points: ["fabricated claim"],
          surface: true,
        },
      ],
      observation_directives: [],
    };

    const TestLayer = makeControlledRunnerLayer({
      draft: DRAFT_MARKER_OUTPUT,
      sweep: (draft) => {
        sweepWasCalledWithDraft = draft;
        return swept;
      },
    });

    const [decisions] = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* runner.runNow;
      const decisions = yield* store.listDecisionsForTest;
      return [decisions] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    // The sweep WAS invoked, and with the deliberator's actual draft.
    expect(sweepWasCalledWithDraft).toEqual(DRAFT_MARKER_OUTPUT);

    // The store has the SWEEP's summary/kind, never the draft's.
    expect(decisions.some((d) => d.summary.startsWith("SWEEP-MARKER"))).toBe(true);
    expect(decisions.some((d) => d.summary.startsWith("DRAFT-MARKER"))).toBe(false);
    const committed = decisions.find((d) => d.summary.startsWith("SWEEP-MARKER"));
    expect(committed?.kind).toBe("observation"); // sweep rewrote proposal -> observation
    expect(JSON.parse(committed?.citationsJson ?? "[]")).toHaveLength(0); // sweep stripped the citation
  });

  it("the sweep is always invoked — structurally cannot be skipped", async () => {
    let sweepInvocationCount = 0;

    const TestLayer = makeControlledRunnerLayer({
      draft: DRAFT_MARKER_OUTPUT,
      sweep: (draft) => {
        sweepInvocationCount += 1;
        return draft;
      },
    });

    await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* runner.runNow;
      yield* runner.runNow;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(sweepInvocationCount).toBe(2); // once per runNow call, never skipped
  });

  it("a downgraded trust level from the sweep lands as committed via commitDeliberationOutput", async () => {
    const draft: DeliberationRunOutput = {
      decisions: [
        {
          kind: "observation",
          summary: "Trust downgrade case",
          rationale: "rationale",
          citations: [{ claim: "claim", source_url: "https://example.com/source", trust: "corpus-verified" }],
          reasoning_only_points: [],
          surface: true,
        },
      ],
      observation_directives: [],
    };

    const TestLayer = makeControlledRunnerLayer({
      draft,
      sweep: (d) => ({
        ...d,
        decisions: d.decisions.map((decision) => ({
          ...decision,
          citations: decision.citations.map((c) => ({ ...c, trust: "retrieved-unverified" as const })),
        })),
      }),
    });

    const [decisions] = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* runner.runNow;
      const decisions = yield* store.listDecisionsForTest;
      return [decisions] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const committed = decisions.find((d) => d.summary === "Trust downgrade case");
    expect(committed).toBeDefined();
    const citations = JSON.parse(committed?.citationsJson ?? "[]") as ReadonlyArray<{ trust: string }>;
    expect(citations).toHaveLength(1);
    expect(citations[0]?.trust).toBe("retrieved-unverified");
  });
});

describe("DeliberationRunner + canned DeliberationAgent (Seam 2)", () => {
  it("runNow commits the canned agent's output: a surfaced Observation and a Proposal both land in the store", async () => {
    const [result, decisions, feed, proposals] = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;

      const result = yield* runner.runNow;
      const decisions = yield* store.listDecisionsForTest;
      const feed = yield* store.getCoachingFeed;
      const proposals = yield* store.getProposals;
      return [result, decisions, feed, proposals] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    // The canned output (deliberationAgent.ts) is one Observation
    // (surface:true) and one Proposal — both must have landed as decision
    // rows AND both must have a coaching_feed_entry (Observations only
    // surface when `surface:true`; this canned Observation is).
    expect(result.decisionIds).toHaveLength(2);
    expect(result.feedEntryIds).toHaveLength(2);

    const decisionIds = result.decisionIds as ReadonlyArray<string>;
    const committed = decisions.filter((d) => decisionIds.includes(d.id));
    expect(committed).toHaveLength(2);

    const observation = committed.find((d) => d.kind === "observation");
    const proposal = committed.find((d) => d.kind === "proposal");
    expect(observation).toBeDefined();
    expect(proposal).toBeDefined();
    expect(observation?.status).toBe("open");
    expect(observation?.origin).toBe("coach-proposal");
    expect(proposal?.status).toBe("pending");
    expect(proposal?.origin).toBe("coach-proposal");

    const committedFeedEntries = feed.filter((entry) => result.feedEntryIds.includes(entry.id));
    expect(committedFeedEntries).toHaveLength(2);
    expect(committedFeedEntries.some((entry) => entry.kind === "observation")).toBe(true);
    expect(committedFeedEntries.some((entry) => entry.kind === "proposal")).toBe(true);

    // The Proposal is visible via getProposals — the same path
    // subscribeProposals (and thus the phone's Coaching feed) reads.
    const committedProposal = proposals.find((p) => p.id === proposal?.id);
    expect(committedProposal).toBeDefined();
    expect(committedProposal?.status).toBe("pending");
  });

  it("runNow is callable more than once and accumulates further decision/feed rows each time", async () => {
    const [firstResult, secondResult, decisions] = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;

      const firstResult = yield* runner.runNow;
      const secondResult = yield* runner.runNow;
      const decisions = yield* store.listDecisionsForTest;
      return [firstResult, secondResult, decisions] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const allIds = new Set<string>([...firstResult.decisionIds, ...secondResult.decisionIds]);
    expect(allIds.size).toBe(4); // two runs x two decisions each, all distinct ids
    expect(decisions.filter((d) => allIds.has(d.id))).toHaveLength(4);
  });
});

describe("the run ledger (ADR 0011 §8 amendment, issue #81) — the regression test for bug 2", () => {
  it("one on-demand run writes exactly one deliberator row and one sweep row, sharing a run id", async () => {
    const spend = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* runner.runNow;
      return yield* store.getSpendSummary;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(spend.perCadence).toEqual([{ cadence: "on-demand", runCount: 1, usage: expect.any(Object) }]);
    expect(spend.recentRuns).toHaveLength(1);
    const run = spend.recentRuns[0];
    expect(run?.stages.map((s) => s.stage).sort()).toEqual(["deliberator", "sweep"]);
  });

  it("the sweep's usage is recorded even when it comes back zero — the bug this fixes was that it was never recorded at all", async () => {
    const spend = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* runner.runNow;
      return yield* store.getSpendSummary;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const sweepStage = spend.recentRuns[0]?.stages.find((s) => s.stage === "sweep");
    // Present at all is the assertion — before this fix, the sweep contributed
    // NO row, so this stage would be entirely absent from the list.
    expect(sweepStage).toBeDefined();
  });

  it("two runNow calls produce two DISTINCT run ids on the ledger, each with its own pair of rows", async () => {
    const spend = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* runner.runNow;
      yield* runner.runNow;
      return yield* store.getSpendSummary;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(spend.perCadence).toEqual([{ cadence: "on-demand", runCount: 2, usage: expect.any(Object) }]);
    const runIds = new Set(spend.recentRuns.map((r) => r.runId));
    expect(runIds.size).toBe(2);
  });
});
