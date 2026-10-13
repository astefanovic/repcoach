import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput, Proposal } from "@repcoach/contracts";
import { ProposalAlreadyResolvedError, ProposalNotFoundError, RevisionAlreadyInFlightError, ZERO_TOKEN_USAGE } from "@repcoach/contracts";

import { DeliberationAgent } from "./deliberationAgent.ts";
import { DeliberationRunner } from "./deliberationRunner.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { DeliberationSweepAgent } from "./deliberationSweepAgent.ts";
import { UnwiredIntakeSessionAgent } from "./intakeSessionAgent.ts";
import { CannedIntakeSweepAgent } from "./intakeSweepAgent.ts";
import { makeCannedQuotaService } from "./quotaService.ts";
import { SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "./store.ts";

/**
 * Black-box Revise coverage (ADR 0013, issue #66 slice 2) — the runner
 * methods (`reviseProposal`/`cancelRevision`/`revisionStates`) wired against a
 * REAL `Store` layer with canned deliberator/sweep stand-ins, in the style of
 * `deliberationRunner.deferral.adversarial.test.ts` and `deliberationRunner.
 * test.ts`. Asserts through the public store surface (`listDecisionsForTest`,
 * `getProposals`) — never into runner internals.
 */

const PENDING_PROPOSAL: Proposal = {
  id: "prop-1" as never,
  origin: "coach-proposal",
  status: "pending",
  summary: "ORIGINAL: 5-day upper/lower split",
  rationale: "ORIGINAL-RATIONALE: volume trend supports 5 days",
  createdAt: "2026-07-01T00:00:00.000Z",
};

const answerOnlyOutput = (summary: string, rationale: string): DeliberationRunOutput => ({
  decisions: [
    {
      kind: "answer",
      summary,
      rationale,
      citations: [],
      reasoning_only_points: [],
      surface: true,
    },
  ],
  observation_directives: [],
});

const answerPlusRevisionOutput = (proposalIdToSupersede: string): DeliberationRunOutput => ({
  decisions: [
    {
      kind: "answer",
      summary: "ANSWER: you're right, adjusting",
      rationale: "ANSWER-RATIONALE: the objection holds",
      citations: [],
      reasoning_only_points: [],
      surface: true,
    },
    {
      kind: "proposal",
      summary: "REVISED: 3-day full-body split",
      rationale: "REVISED-RATIONALE: honoring the stated constraint",
      citations: [],
      reasoning_only_points: [],
      surface: true,
    },
  ],
  observation_directives: [{ id: proposalIdToSupersede as never, action: "supersede" }],
});

/**
 * Builds a `DeliberationRunner` test layer with a controllable
 * `DeliberationAgent` (capturing every prompt/model it was called with) and a
 * pass-through sweep, over a REAL `Store` layer, plus a controllable
 * `QuotaService` so tests can exercise both the queued and running
 * cancellation paths.
 */
const makeReviseRunnerLayer = () => {
  const state: {
    output: DeliberationRunOutput;
    calls: Array<{ readonly prompt: string; readonly model: string | undefined }>;
    gate: Deferred.Deferred<void, never> | undefined;
  } = {
    output: answerOnlyOutput("default answer", "default rationale"),
    calls: [],
    gate: undefined,
  };

  const AgentCapture = Layer.succeed(DeliberationAgent)({
    run: (assembledPrompt, model) =>
      Effect.gen(function* () {
        state.calls.push({ prompt: assembledPrompt, model });
        if (state.gate !== undefined) {
          yield* Deferred.await(state.gate);
        }
        return { output: state.output, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, costUsd: 0 };
      }),
  });

  const SweepPassThrough = Layer.succeed(DeliberationSweepAgent)({
    run: (draft) => Effect.succeed({ output: draft, usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
  });

  const { setLow, setAvailable, layer: quotaLayer } = makeCannedQuotaService();

  const layer = DeliberationRunner.layer.pipe(
    Layer.provide(AgentCapture),
    Layer.provide(SweepPassThrough),
    // Intake ports Revise never touches — provided so the runner layer builds.
    Layer.provide(UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(quotaLayer),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  );

  return { state, setLow, setAvailable, layer };
};

/** Polls `revisionStates` until `proposalId` is absent (idle) or the budget runs out. */
const waitUntilIdle = (proposalId: string): Effect.Effect<void, never, DeliberationRunner> =>
  Effect.gen(function* () {
    const runner = yield* DeliberationRunner;
    for (let i = 0; i < 400; i++) {
      const states = yield* SubscriptionRef.get(runner.revisionStates);
      if (!states.has(proposalId)) return;
      yield* Effect.sleep("5 millis");
    }
  });

/** Polls `revisionStates` until `proposalId` reaches `status`, or the budget runs out. */
const waitUntilStatus = (
  proposalId: string,
  status: "queued" | "running",
): Effect.Effect<void, never, DeliberationRunner> =>
  Effect.gen(function* () {
    const runner = yield* DeliberationRunner;
    for (let i = 0; i < 400; i++) {
      const states = yield* SubscriptionRef.get(runner.revisionStates);
      if (states.get(proposalId) === status) return;
      yield* Effect.sleep("5 millis");
    }
  });

describe("DeliberationRunner.reviseProposal / cancelRevision (ADR 0013, issue #66 slice 2)", () => {
  it("commits one Answer plus a revised Proposal, stamped with revision-run provenance and the lineage/supersede link", async () => {
    const { state, layer } = makeReviseRunnerLayer();
    state.output = answerPlusRevisionOutput(PENDING_PROPOSAL.id);

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* store.pushProposalForTest(PENDING_PROPOSAL);

      yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "not 5 days, max 3" });
      yield* waitUntilIdle(PENDING_PROPOSAL.id);

      const decisions = yield* store.listDecisionsForTest;
      const proposals = yield* store.getProposals;
      return { decisions, proposals };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // Filtered by `inResponseToId === PENDING_PROPOSAL.id`, not just `kind`,
    // because the real `Store` layer seeds its own demo Proposals — matching
    // on lineage rather than "any proposal row" is what actually proves THIS
    // run produced the revised one.
    const answer = outcome.decisions.find(
      (d) => d.kind === "answer" && d.inResponseToId === PENDING_PROPOSAL.id,
    );
    const revised = outcome.decisions.find(
      (d) => d.kind === "proposal" && d.inResponseToId === PENDING_PROPOSAL.id,
    );
    const original = outcome.decisions.find((d) => d.id === PENDING_PROPOSAL.id);

    expect(answer).toBeDefined();
    expect(answer?.status).toBe("answered");
    expect(answer?.inResponseToId).toBe(PENDING_PROPOSAL.id);
    expect(answer?.revisionProse).toBe("not 5 days, max 3");
    expect(JSON.parse(answer?.dataWindowJson ?? "{}").cadence).toBe("revision-run");

    expect(revised).toBeDefined();
    expect(revised?.status).toBe("pending");
    expect(revised?.inResponseToId).toBe(PENDING_PROPOSAL.id);
    expect(revised?.revisionProse).toBe("not 5 days, max 3");
    expect(JSON.parse(revised?.dataWindowJson ?? "{}").cadence).toBe("revision-run");

    // The original is superseded (the lineage flip) and no longer pending —
    // `getProposals` surfaces every Proposal's CURRENT status, not just the
    // pending ones, so the assertion is on `status`, not presence.
    expect(original?.status).toBe("superseded");
    expect(outcome.proposals.find((p) => p.id === PENDING_PROPOSAL.id)?.status).toBe("superseded");
    expect(outcome.proposals.find((p) => p.id === revised?.id)?.status).toBe("pending");
  });

  it("resolves the model from the session-review setting — there is no revision-run selector", async () => {
    const { state, layer } = makeReviseRunnerLayer();
    state.output = answerOnlyOutput("just answering", "no revision warranted");

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* store.pushProposalForTest(PENDING_PROPOSAL);
      yield* store.setCadenceModel({ cadence: "session-review", model: "session-review-model-x" });

      yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "why 5 days?" });
      yield* waitUntilIdle(PENDING_PROPOSAL.id);

      return state.calls;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome).toHaveLength(1);
    expect(outcome[0]?.model).toBe("session-review-model-x");
  });

  it("the seed contains the target Decision in full and the prior exchange turns", async () => {
    const { state, layer } = makeReviseRunnerLayer();

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* store.pushProposalForTest(PENDING_PROPOSAL);

      // First turn: an answer only — the original Proposal stays pending, so
      // a second Revise against the SAME id has genuine prior turns to read.
      state.output = answerOnlyOutput(
        "FIRST-TURN-ANSWER-SUMMARY",
        "FIRST-TURN-ANSWER-RATIONALE",
      );
      yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "FIRST-TURN-USER-PROSE: why 5 days?" });
      yield* waitUntilIdle(PENDING_PROPOSAL.id);

      state.output = answerOnlyOutput("SECOND-TURN-ANSWER-SUMMARY", "SECOND-TURN-ANSWER-RATIONALE");
      yield* runner.reviseProposal({
        proposalId: PENDING_PROPOSAL.id,
        prose: "SECOND-TURN-USER-PROSE: still not convinced",
      });
      yield* waitUntilIdle(PENDING_PROPOSAL.id);

      return state.calls;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome).toHaveLength(2);
    const secondPrompt = outcome[1]?.prompt ?? "";
    // The target Decision in full.
    expect(secondPrompt).toContain(PENDING_PROPOSAL.summary);
    expect(secondPrompt).toContain(PENDING_PROPOSAL.rationale);
    // The prior turn: the first Revise's user prose and the coach's Answer.
    expect(secondPrompt).toContain("FIRST-TURN-USER-PROSE: why 5 days?");
    expect(secondPrompt).toContain("FIRST-TURN-ANSWER-SUMMARY");
    expect(secondPrompt).toContain("FIRST-TURN-ANSWER-RATIONALE");
  });

  it("a second concurrent Revise on the same Proposal is refused", async () => {
    const { state, setLow, layer } = makeReviseRunnerLayer();
    state.output = answerOnlyOutput("answer", "rationale");

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* store.pushProposalForTest(PENDING_PROPOSAL);

      // Keep the first Revise parked (queued) so the "in flight" window is
      // long enough to deterministically prove the refusal — the lock is
      // reserved SYNCHRONOUSLY in `reviseProposal`, before the background
      // fork even runs, so this isn't actually timing-sensitive either way.
      yield* setLow;
      yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "first" });

      const second = yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "second" }).pipe(
        Effect.flip,
      );
      return second;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome).toBeInstanceOf(RevisionAlreadyInFlightError);
  });

  it("Revise on an already-resolved Proposal is refused", async () => {
    const { layer } = makeReviseRunnerLayer();

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* store.pushProposalForTest(PENDING_PROPOSAL);
      yield* store.resolveProposal({ proposalId: PENDING_PROPOSAL.id, decision: "rejected" });

      return yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "too late" }).pipe(Effect.flip);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome).toBeInstanceOf(ProposalAlreadyResolvedError);
  });

  it("cancelRevision on a Proposal with nothing in flight is idempotent, not a failure", async () => {
    const { layer } = makeReviseRunnerLayer();

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* store.pushProposalForTest(PENDING_PROPOSAL);
      return yield* runner.cancelRevision({ proposalId: PENDING_PROPOSAL.id });
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome).toEqual({ cancelled: false });
  });

  it("cancelRevision on an unknown Proposal id fails with ProposalNotFoundError", async () => {
    const { layer } = makeReviseRunnerLayer();

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      return yield* runner.cancelRevision({ proposalId: "no-such-proposal" }).pipe(Effect.flip);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome).toBeInstanceOf(ProposalNotFoundError);
  });

  it("cancel-while-queued writes NO rows at all, and re-allows a later Revise on the same Proposal", async () => {
    const { state, setLow, setAvailable, layer } = makeReviseRunnerLayer();
    state.output = answerOnlyOutput("should never land", "should never land");

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* store.pushProposalForTest(PENDING_PROPOSAL);

      const before = (yield* store.listDecisionsForTest).length;

      yield* setLow;
      yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "will be cancelled" });
      yield* waitUntilStatus(PENDING_PROPOSAL.id, "queued");

      const cancelResult = yield* runner.cancelRevision({ proposalId: PENDING_PROPOSAL.id });

      // Card unlocks immediately (before quota even recovers).
      const statesAfterCancel = yield* SubscriptionRef.get(runner.revisionStates);

      // Quota frees up — the (cancelled) queued entry must be DROPPED, never
      // executed, when the daemon drains it.
      yield* setAvailable;
      yield* Effect.sleep("30 millis");

      const afterCancel = (yield* store.listDecisionsForTest).length;

      // A fresh Revise on the SAME Proposal is now accepted and actually runs.
      state.output = answerOnlyOutput("SECOND-REVISE-LANDS", "SECOND-REVISE-LANDS-RATIONALE");
      yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "second attempt" });
      yield* waitUntilIdle(PENDING_PROPOSAL.id);

      const decisionsAfterSecond = yield* store.listDecisionsForTest;

      return { before, cancelResult, statesAfterCancel, afterCancel, decisionsAfterSecond };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome.cancelResult).toEqual({ cancelled: true });
    expect(outcome.statesAfterCancel.has(PENDING_PROPOSAL.id)).toBe(false);
    // No rows at all were added by the cancelled queued run.
    expect(outcome.afterCancel).toBe(outcome.before);
    expect(outcome.decisionsAfterSecond.some((d) => d.summary === "SECOND-REVISE-LANDS")).toBe(true);
    expect(outcome.decisionsAfterSecond.some((d) => d.summary === "should never land")).toBe(false);
  });

  it("cancel-while-running writes NO rows at all — the runner commits nothing", async () => {
    const { state, layer } = makeReviseRunnerLayer();
    state.output = answerOnlyOutput("should never land either", "should never land either");
    // Blocks the agent call open until the test explicitly resolves it,
    // simulating the exact race ADR 0013 §5 calls out: the interrupt is sent
    // while the agent call is in flight, and the call is then let through to
    // "return during teardown" — the belt-and-braces re-check must still
    // stop the commit even though the fiber was already interrupted.
    const gate = Deferred.makeUnsafe<void, never>();
    state.gate = gate;

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* store.pushProposalForTest(PENDING_PROPOSAL);

      const before = (yield* store.listDecisionsForTest).length;

      yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "will be cancelled mid-run" });
      yield* waitUntilStatus(PENDING_PROPOSAL.id, "running");

      const cancelResult = yield* runner.cancelRevision({ proposalId: PENDING_PROPOSAL.id });
      const statesAfterCancel = yield* SubscriptionRef.get(runner.revisionStates);

      // Let the blocked agent call "return during teardown" — the
      // belt-and-braces flag check must catch this even though the fiber was
      // already interrupted above.
      yield* Deferred.succeed(gate, undefined);
      yield* Effect.sleep("30 millis");

      const after = (yield* store.listDecisionsForTest).length;
      return { before, cancelResult, statesAfterCancel, after };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome.cancelResult).toEqual({ cancelled: true });
    expect(outcome.statesAfterCancel.has(PENDING_PROPOSAL.id)).toBe(false);
    expect(outcome.after).toBe(outcome.before);
  });
});
