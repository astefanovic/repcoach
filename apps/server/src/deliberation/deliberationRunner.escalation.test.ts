import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput } from "@repcoach/contracts";
import { ZERO_TOKEN_USAGE } from "@repcoach/contracts";

import { DeliberationAgent } from "../agents/deliberationAgent.ts";
import { DeliberationRunner } from "./deliberationRunner.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { DeliberationSweepAgent } from "../agents/deliberationSweepAgent.ts";
import { UnwiredIntakeSessionAgent } from "../agents/intakeSessionAgent.ts";
import { CannedIntakeSweepAgent } from "../agents/intakeSweepAgent.ts";
import { QuotaServiceAlwaysAvailable } from "../agents/quotaService.ts";
import { SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "../store.ts";

/**
 * Escalation / anti-twitchy accumulation coverage (ADR 0011 §5, issue #30 —
 * 2B slice 5), all through Seam 2 (`DeliberationRunner` → `Store`), never
 * reaching into runner internals:
 *
 * - a single off day lands as an OPEN Observation and leaves the Plan alone;
 * - a confirmed trend escalates the supporting OPEN Observations into ONE
 *   Proposal and flips them to `escalated`;
 * - a stale/contradicted Observation is closed (`expired`) by a later run;
 * - an acute/safety finding surfaces as a Proposal with no accumulated trend.
 *
 * The runner injects the open Observations into the seed as priors
 * (`SeedInputsProviderLive`), so the CANNED agent below reads their ids back
 * out of the assembled prompt to prove the round-trip — the same id the
 * runner assigned is what the agent names in an `escalate`/`close` directive.
 * The sweep is identity here (its own rewrite behaviour is covered in
 * `deliberationRunner.test.ts`); this suite is about the directive flow.
 */

/**
 * A `DeliberationRunner` test layer whose deliberator returns a MUTABLE,
 * test-controlled output (settable AFTER the runner is built, so a test can
 * commit seed Observations first, learn their runner-assigned ids, then point
 * the agent's directives at them) and captures the last assembled prompt (to
 * assert the priors were injected). Sweep is identity. One shared `Store`
 * instance — `Layer.provide`/`provideMerge` of the same `Store.layer`
 * reference memoize to a single build, exactly as `deliberationRunner.test.ts`
 * relies on.
 */
const makeEscalationRunnerLayer = () => {
  const state: { output: DeliberationRunOutput; lastPrompt: string | undefined } = {
    output: { decisions: [], observation_directives: [] },
    lastPrompt: undefined,
  };
  const AgentTest = Layer.succeed(DeliberationAgent)({
    run: (assembledPrompt) => {
      state.lastPrompt = assembledPrompt;
      return Effect.succeed({
        output: state.output,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0,
      });
    },
  });
  const SweepIdentity = Layer.succeed(DeliberationSweepAgent)({
    run: (draft) => Effect.succeed({ output: draft, usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
  });
  const layer = DeliberationRunner.layer.pipe(
    Layer.provide(AgentTest),
    Layer.provide(SweepIdentity),
    // Intake ports the review cadences never touch — provided so the runner layer builds.
    Layer.provide(UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(QuotaServiceAlwaysAvailable),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  );
  return { state, layer };
};

const observationDraft = (summary: string, rationale: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary,
  rationale,
  citations: [],
  reasoning_only_points: [],
  surface: true,
});

const proposalDraft = (summary: string, rationale: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "proposal",
  summary,
  rationale,
  citations: [
    { claim: "supporting claim", source_url: "https://example.com/evidence", trust: "retrieved-unverified" },
  ],
  reasoning_only_points: [],
  surface: false,
});

describe("DeliberationRunner escalation (ADR 0011 §5, issue #30)", () => {
  it("records a single off day as an OPEN Observation and does not change the Plan", async () => {
    const { state, layer } = makeEscalationRunnerLayer();
    state.output = {
      decisions: [observationDraft("One sandbagged squat day", "Loads dropped for a single session; likely fatigue.")],
      observation_directives: [],
    };

    const { planBefore, planAfter, decisions, result } = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const planBefore = yield* store.getPlan;
      const result = yield* runner.runNow;
      const planAfter = yield* store.getPlan;
      const decisions = yield* store.listDecisionsForTest;
      return { planBefore, planAfter, decisions, result };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    const committed = decisions.find((d) => (result.decisionIds as ReadonlyArray<string>).includes(d.id));
    expect(committed?.kind).toBe("observation");
    expect(committed?.status).toBe("open"); // born open — not yet a Change
    // The Plan is untouched: an Observation notices without acting.
    expect(JSON.stringify(planAfter)).toEqual(JSON.stringify(planBefore));
  });

  it("escalates supporting OPEN Observations into ONE Proposal and flips them to `escalated`", async () => {
    const { state, layer } = makeEscalationRunnerLayer();

    const outcome = await Effect.gen(function* () {
      const store = yield* Store;
      const runner = yield* DeliberationRunner;

      // Two open Observations accumulate across prior runs.
      const seeded = yield* store.commitDeliberationOutput({
        runOutput: {
          decisions: [
            observationDraft("Bench load flat session 1-2", "Same load, top-of-range reps."),
            observationDraft("Bench load flat session 3", "Still flat, no reported difficulty."),
          ],
          observation_directives: [],
        },
        dataWindow: {
          cadence: "session-review",
          ran_at: new Date().toISOString(),
          session_ids_considered: [],
          evidence_roster_version: "seed-1",
        },
      });
      const [obsA, obsB] = seeded.decisionIds as ReadonlyArray<string>;
      const proposalsBefore = yield* store.getProposals;

      // A later run judges the trend real: ONE Proposal + escalate directives
      // referencing both supporting Observation ids.
      state.output = {
        decisions: [proposalDraft("Bump bench working load 2.5kg", "Three-session plateau clears the trend bar.")],
        observation_directives: [
          { id: obsA as never, action: "escalate" },
          { id: obsB as never, action: "escalate" },
        ],
      };
      const result = yield* runner.runNow;
      const decisions = yield* store.listDecisionsForTest;
      const proposalsAfter = yield* store.getProposals;
      return { obsA, obsB, result, decisions, proposalsBefore, proposalsAfter, prompt: state.lastPrompt };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // The runner injected the two open Observations into the seed as priors —
    // the ids the agent referenced were the ones it read back out.
    expect(outcome.prompt).toContain(outcome.obsA);
    expect(outcome.prompt).toContain(outcome.obsB);

    // Both supporting Observations flipped to `escalated` (status only).
    const flippedA = outcome.decisions.find((d) => d.id === outcome.obsA);
    const flippedB = outcome.decisions.find((d) => d.id === outcome.obsB);
    expect(flippedA?.status).toBe("escalated");
    expect(flippedB?.status).toBe("escalated");

    // Exactly ONE new Proposal, and it is the run's emitted one.
    const newProposals = outcome.proposalsAfter.filter(
      (p) => !outcome.proposalsBefore.some((b) => b.id === p.id),
    );
    expect(newProposals).toHaveLength(1);
    expect(newProposals[0]?.status).toBe("pending");
    expect((outcome.result.decisionIds as ReadonlyArray<string>)).toContain(newProposals[0]?.id);
  });

  it("closes a stale/contradicted Observation (`expired`) on a later run", async () => {
    const { state, layer } = makeEscalationRunnerLayer();

    const { obsId, decisions } = await Effect.gen(function* () {
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      const seeded = yield* store.commitDeliberationOutput({
        runOutput: {
          decisions: [observationDraft("Possible grip weakness", "One session hinted at grip failure.")],
          observation_directives: [],
        },
        dataWindow: {
          cadence: "session-review",
          ran_at: new Date().toISOString(),
          session_ids_considered: [],
          evidence_roster_version: "seed-1",
        },
      });
      const [obsId] = seeded.decisionIds as ReadonlyArray<string>;
      // Fresh data contradicted it — close it, no new Decision.
      state.output = { decisions: [], observation_directives: [{ id: obsId as never, action: "close" }] };
      yield* runner.runNow;
      const decisions = yield* store.listDecisionsForTest;
      return { obsId, decisions };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(decisions.find((d) => d.id === obsId)?.status).toBe("expired");
  });

  it("surfaces an acute/safety finding as a Proposal WITHOUT an accumulated trend", async () => {
    const { state, layer } = makeEscalationRunnerLayer();
    state.output = {
      decisions: [
        proposalDraft(
          "Deload immediately — sharp lower-back pain reported",
          "Acute safety finding: pain on deadlift warrants an immediate change, no trend needed.",
        ),
      ],
      observation_directives: [],
    };

    const { result, decisions, proposalsBefore, proposalsAfter } = await Effect.gen(function* () {
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      const proposalsBefore = yield* store.getProposals;
      const result = yield* runner.runNow;
      const decisions = yield* store.listDecisionsForTest;
      const proposalsAfter = yield* store.getProposals;
      return { result, decisions, proposalsBefore, proposalsAfter };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    const newProposals = proposalsAfter.filter((p) => !proposalsBefore.some((b) => b.id === p.id));
    expect(newProposals).toHaveLength(1);
    expect(newProposals[0]?.status).toBe("pending");
    // No directives, no accumulated Observations required for this path.
    const committed = decisions.find((d) => (result.decisionIds as ReadonlyArray<string>).includes(d.id));
    expect(committed?.kind).toBe("proposal");
  });

  // Seam 2 acceptance: a run emitting an `escalate` directive flips the
  // referenced Observation AND creates the linked Proposal, using the injected
  // (canned) agent — the single-Observation core of the escalation flow.
  it("Seam 2: an escalate directive flips the referenced Observation and creates the linked Proposal", async () => {
    const { state, layer } = makeEscalationRunnerLayer();

    const { obsId, decisions, result } = await Effect.gen(function* () {
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      const seeded = yield* store.commitDeliberationOutput({
        runOutput: {
          decisions: [observationDraft("Overhead press stalled", "Two sessions at the same load.")],
          observation_directives: [],
        },
        dataWindow: {
          cadence: "on-demand",
          ran_at: new Date().toISOString(),
          session_ids_considered: [],
          evidence_roster_version: "seed-1",
        },
      });
      const [obsId] = seeded.decisionIds as ReadonlyArray<string>;
      state.output = {
        decisions: [proposalDraft("Switch overhead press to a 5x5 wave", "The stall now warrants a Change.")],
        observation_directives: [{ id: obsId as never, action: "escalate" }],
      };
      const result = yield* runner.runNow;
      const decisions = yield* store.listDecisionsForTest;
      return { obsId, decisions, result };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // The referenced Observation flipped...
    expect(decisions.find((d) => d.id === obsId)?.status).toBe("escalated");
    // ...and the linked Proposal was created pending in the SAME run.
    const proposal = decisions.find((d) => (result.decisionIds as ReadonlyArray<string>).includes(d.id));
    expect(proposal?.kind).toBe("proposal");
    expect(proposal?.status).toBe("pending");
  });
});
