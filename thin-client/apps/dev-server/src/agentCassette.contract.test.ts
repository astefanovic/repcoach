import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput, IntakeDraftPlan } from "@repcoach/contracts";

import { makeReplayTransport, readCassetteDirectory, type AgentCassette } from "./agentCassette.ts";
import { DEFAULT_CASSETTE_DIR } from "./agentMode.ts";
import { agentPromptFingerprint } from "./agentPromptFingerprint.ts";
import type { AgentSessionStage } from "./agentTransport.ts";
import { DeliberationAgent } from "./deliberationAgent.ts";
import { DeliberationSweepAgent } from "./deliberationSweepAgent.ts";
import { IntakeSessionAgent, noopIntakeToolEventSink } from "./intakeSessionAgent.ts";
import { IntakeSweepAgent } from "./intakeSweepAgent.ts";
import { RealDeliberationAgent } from "./realDeliberationAgent.ts";
import { RealDeliberationSweepAgent } from "./realDeliberationSweepAgent.ts";
import { RealIntakeSessionAgent } from "./realIntakeSessionAgent.ts";
import { RealIntakeSweepAgent } from "./realIntakeSweepAgent.ts";

/**
 * **The committed cassettes still decode through the real adapters** (issue
 * #95) — the rung-1 half of "a change to the output contract or the prompts
 * that breaks real decoding is caught below human UAT".
 *
 * This is the cheapest possible form of that guarantee and the broadest. Every
 * cassette goes through the SAME adapter production runs: `extractJsonPayload`
 * strips the fence, `dropNullValues` absorbs the `null`-for-absent idiom,
 * `defaultEmptyDecisionLists` fills the two unambiguous lists and `surface`,
 * and then the contract's own Schema decode rules on the result. Tighten a
 * contract, rename a wire field, or remove one of those absorbers, and this
 * file goes red on every commit — no browser, no quota, no journey needed.
 *
 * It covers all four stages, including the two (deliberator and sweep) that no
 * agent-backed e2e flow drives yet. That asymmetry is the point of testing it
 * here: an e2e journey per stage would be the expensive way to learn the same
 * fact.
 */

const cassettes = readCassetteDirectory(DEFAULT_CASSETTE_DIR);

const forStage = (stage: AgentSessionStage): ReadonlyArray<AgentCassette> =>
  cassettes.filter((cassette) => cassette.stage === stage);

/** A replay transport holding exactly the cassettes for one stage. */
const replayFor = (stage: AgentSessionStage) =>
  makeReplayTransport({ cassettes: forStage(stage) }).transport;

const EMPTY_DRAFT = { decisions: [], observation_directives: [] } as unknown as DeliberationRunOutput;

describe("the committed cassettes (issue #95)", () => {
  it("covers every agent stage, so no stage is silently unrecorded", () => {
    expect(new Set(cassettes.map((c) => c.stage))).toEqual(
      new Set(["deliberator", "sweep", "intake-session", "intake-sweep"]),
    );
  });

  it("was recorded against the prompts this build sends", () => {
    // The staleness signal, asserted directly rather than only as a side effect
    // of replay: a prompt change lands here as "restamp or re-record", naming
    // the file, instead of as a decode failure three layers away.
    for (const cassette of cassettes) {
      expect(
        { stage: cassette.stage, fingerprint: cassette.promptFingerprint },
        `a cassette for "${cassette.stage}" was recorded against a different prompt — re-record it, or restamp with \`pnpm --filter @repcoach/dev-server cassettes:restamp\` if the change cannot have invalidated the reply`,
      ).toEqual({ stage: cassette.stage, fingerprint: agentPromptFingerprint(cassette.stage) });
    }
  });

  it("states its provenance, so a hand-seeded reply is never mistaken for a recorded one", () => {
    for (const cassette of cassettes) {
      expect(cassette.provenance).not.toBe("unknown");
      expect(cassette.provenance.length).toBeGreaterThan(0);
    }
  });
});

describe("replaying a cassette through the real adapter", () => {
  it("decodes the deliberator's draft — including the omitted lists and `surface`", async () => {
    const output = await Effect.gen(function* () {
      const agent = yield* DeliberationAgent;
      return yield* agent.run("(seed)", undefined, undefined);
    }).pipe(
      Effect.provide(RealDeliberationAgent(undefined, replayFor("deliberator"))),
      Effect.scoped,
      Effect.runPromise,
    );

    const decision = output.output.decisions[0];
    expect(decision).toBeDefined();
    // The two shapes #93 recorded, both absorbed rather than fatal: the fixture
    // omits `reasoning_only_points` and `surface` entirely, and a Proposal
    // always surfaces (ADR 0011 §6).
    expect(decision?.reasoning_only_points).toEqual([]);
    expect(decision?.surface).toBe(true);
    // And the working the run actually did is NOT defaulted away.
    expect(decision?.rule).toBeDefined();
    expect(decision?.measurements?.length).toBeGreaterThan(0);
    expect(decision?.plan_operations?.length).toBeGreaterThan(0);
  });

  it("decodes the adversarial sweep's final output", async () => {
    const output = await Effect.gen(function* () {
      const agent = yield* DeliberationSweepAgent;
      return yield* agent.run(EMPTY_DRAFT, [], undefined, undefined);
    }).pipe(
      Effect.provide(RealDeliberationSweepAgent(undefined, replayFor("sweep"))),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(output.output.decisions.length).toBeGreaterThan(0);
    // The sweep governs the justification, never the prescription: the
    // operations it echoed back are still on the committed output.
    expect(output.output.decisions[0]?.plan_operations?.length).toBeGreaterThan(0);
  });

  it("decodes every turn of the held-open Intake session, fence and null-for-absent included", async () => {
    const { first, second } = await Effect.gen(function* () {
      const agent = yield* IntakeSessionAgent;
      const opened = yield* agent.open({ seed: "(intake seed)", sink: noopIntakeToolEventSink });
      const next = yield* agent.send({
        handle: opened.handle,
        answer: "Bad lower back",
        sink: noopIntakeToolEventSink,
      });
      yield* agent.close(opened.handle);
      return { first: opened.reply, second: next };
    }).pipe(
      Effect.provide(RealIntakeSessionAgent(undefined, replayFor("intake-session"))),
      Effect.scoped,
      Effect.runPromise,
    );

    // Turn 1 carries the one open question ADR 0014 §2 allows, and its third
    // rationale line spelled "no citation" as `null` — the deviation that once
    // killed a whole drafted Plan.
    expect(first.openQuestion).toBeDefined();
    expect(first.rationale[2]?.citationId).toBeUndefined();
    // Three, because the re-recorded fixture drafted a 3-day full body plan.
    // The count is the fixture's, not a contract rule — what is asserted is
    // that a whole draft Plan survives the decode, however many days it has.
    expect(first.draftPlan.sessions.length).toBe(3);

    // Turn 2 arrived inside a markdown fence, and dropped its open question the
    // same `null` way. The plan is the same object, revised.
    expect(second.openQuestion).toBeUndefined();
    expect(second.draftPlan.headline).not.toBe(first.draftPlan.headline);
  });

  it("decodes the Intake sweep and derives trust from its verdicts alone", async () => {
    const draftPlan = { planModel: "upper-lower", headline: "h", sessions: [] } as IntakeDraftPlan;
    const citations = [
      { id: "ic1", claim: "c1", source_url: "https://example.com/1" },
      { id: "ic2", claim: "c2", source_url: "https://example.com/2" },
      { id: "ic3", claim: "c3", source_url: "https://example.com/3" },
    ];

    const result = await Effect.gen(function* () {
      const agent = yield* IntakeSweepAgent;
      return yield* agent.run({
        draftPlan,
        rationale: [],
        citations,
        evidenceRoster: [],
        sink: noopIntakeToolEventSink,
      });
    }).pipe(
      Effect.provide(RealIntakeSweepAgent(undefined, replayFor("intake-sweep"))),
      Effect.scoped,
      Effect.runPromise,
    );

    // Three verdicts, one of each outcome — a removal that states its reason,
    // and two survivors badged from the verdict rather than from a second field
    // the model could contradict itself on.
    expect(result.verdicts.map((v) => v.outcome)).toEqual([
      "corpus-verified",
      "removed",
      "retrieved-unverified",
    ]);
    expect(result.verdicts[1]?.why).toBeDefined();
    expect(result.citations.map((c) => c.id)).toEqual(["ic1", "ic3"]);
    expect(result.citations.map((c) => c.trust)).toEqual(["corpus-verified", "retrieved-unverified"]);
    // The struck line survives, uncited — degrade to uncited, never fabricate.
    expect(result.rationale.length).toBe(3);
    expect(result.rationale[2]?.citationId).toBeUndefined();
  });
});
