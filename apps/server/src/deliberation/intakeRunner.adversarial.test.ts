import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import type {
  IntakeDraftPlan,
  IntakeOpenQuestion,
  IntakeProvisionalCitation,
  IntakeRationaleLine,
  StartIntakeInput,
  TokenUsage,
} from "@repcoach/contracts";
import {
  IntakeQuotaExhaustedError,
  IntakeSessionNotFoundError,
  IntakeSweepRejectedError,
  IntakeTurnFailedError,
} from "@repcoach/contracts";

import { CannedDeliberationAgent } from "../agents/deliberationAgent.ts";
import { DeliberationRunner } from "./deliberationRunner.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { CannedDeliberationSweepAgent } from "../agents/deliberationSweepAgent.ts";
import {
  IntakeAgentError,
  IntakeSessionAgent,
  makeScriptedIntakeSessionAgent,
  type IntakeAgentReply,
} from "../agents/intakeSessionAgent.ts";
import { CannedIntakeSweepAgent, IntakeSweepAgent } from "../agents/intakeSweepAgent.ts";
import { makeCannedQuotaService, QuotaService, QuotaServiceAlwaysAvailable } from "../agents/quotaService.ts";
import { SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "../store.ts";

/**
 * ADVERSARIAL coverage for the Intake runner capability (ADR 0014, issue #70).
 *
 * Every test here drives `DeliberationRunner`'s public methods and asserts on
 * what a USER could observe: the turns returned, the events emitted, the rows in
 * a real store, the typed errors. Nothing asserts on prompt strings, on how many
 * times a port was called, or on the runner's private session map — a test that
 * did would pass for a reimplementation that behaved differently.
 *
 * The single strongest assertion in the file is a row count: an exchange of N
 * turns leaves the decision table empty until converge, and holding exactly one
 * row after.
 */

const startInput: StartIntakeInput = {
  goal: "get stronger without getting fat",
  daysPerWeek: 4,
  equipment: ["Dumbbells", "Barbell + rack"],
  lifts: "squat 100, bench 70",
};

const planFor = (headline: string, sessionCount = 4): IntakeDraftPlan => ({
  planModel: "linear-progression",
  headline,
  sessions: Array.from({ length: sessionCount }, (_, i) => ({
    label: `Session ${i + 1}`,
    entries: [
      {
        exerciseId: "exercise-back-squat" as never,
        exerciseName: "Back Squat",
        trackedMetrics: ["reps", "load"] as const,
        sets: [
          {
            setType: "working" as const,
            target: { reps: { min: 5, max: 8 }, load: { min: 85, max: 85 } },
            restSec: 180,
          },
        ],
      },
    ],
  })),
});

/** A source the canned sweep's corpus holds. */
const CORPUS_CITATION: IntakeProvisionalCitation = {
  id: "c1",
  claim: "Two sessions per muscle per week beats one at matched weekly volume.",
  source_url: "https://example.com/corpus/frequency-meta-analysis",
};

/** A source the canned sweep removes — it traces to a blog post citing itself. */
const FOLKLORE_CITATION: IntakeProvisionalCitation = {
  id: "c2",
  claim: "Hip thrusts load the hip extensors with a fraction of the spinal shear of an RDL.",
  source_url: "https://example.com/blog/biomechanics-post",
};

const CALIBRATION_NOTE =
  "This first block is more template than coaching — I have your equipment and three numbers and nothing " +
  "about how you recover. Log about four weeks and the rep ranges start coming off your own e1RM curve.";

const replyWith = (options: {
  readonly headline: string;
  readonly rationale?: ReadonlyArray<IntakeRationaleLine>;
  readonly citations?: ReadonlyArray<IntakeProvisionalCitation>;
  readonly openQuestion?: IntakeOpenQuestion;
  readonly usage?: TokenUsage;
}): IntakeAgentReply => ({
  draftPlan: planFor(options.headline),
  rationale: options.rationale ?? [
    { text: "Four days lets each muscle be trained twice a week.", citationId: "c1" },
  ],
  citations: options.citations ?? [CORPUS_CITATION],
  calibrationNote: CALIBRATION_NOTE,
  ...(options.openQuestion === undefined ? {} : { openQuestion: options.openQuestion }),
  usage: options.usage ?? { input: 1000, output: 200, cacheRead: 0, cacheCreation: 0 },
  costUsd: 0,
});

interface Harness {
  readonly layer: Layer.Layer<DeliberationRunner | Store>;
}

const makeHarness = (options: {
  readonly sessionAgent: Layer.Layer<IntakeSessionAgent>;
  readonly sweepAgent?: Layer.Layer<IntakeSweepAgent>;
  readonly quota?: Layer.Layer<QuotaService>;
}): Harness => ({
  layer: DeliberationRunner.layer.pipe(
    Layer.provide(CannedDeliberationAgent),
    Layer.provide(CannedDeliberationSweepAgent),
    Layer.provide(options.sessionAgent),
    Layer.provide(options.sweepAgent ?? CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(options.quota ?? QuotaServiceAlwaysAvailable),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  ),
});

/** A coach that always drafts the same thing, ignoring the exchange. */
const staticCoach = (reply: IntakeAgentReply) =>
  makeScriptedIntakeSessionAgent({ respond: () => reply });

describe("Intake: the held-open exchange (ADR 0014 §2)", () => {
  it("carries context across turns — turn 3 still reflects a constraint given on turn 1", async () => {
    // The coach's reply is a function of the WHOLE transcript. A runner that
    // re-seeded per turn (the shape slice 8 shipped) would hand the coach a
    // one-entry transcript each time and could not produce this headline.
    const scripted = makeScriptedIntakeSessionAgent({
      respond: (transcript) => {
        const heardAboutBack = transcript.some((entry) => entry.includes("bad lower back"));
        return replyWith({
          headline: heardAboutBack
            ? "Upper / lower, four days — low spinal load"
            : "Upper / lower, four days a week",
        });
      },
    });
    const { layer } = makeHarness({ sessionAgent: scripted.layer });

    const third = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      yield* runner.turnIntake({ intakeSessionId, answer: "I have a bad lower back" });
      yield* runner.turnIntake({ intakeSessionId, answer: "Adjustable bench" });
      return yield* runner.turnIntake({ intakeSessionId, answer: "Both, honestly" });
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(third.turn.draftPlan.headline).toContain("low spinal load");
  });

  it("numbers the draft, so four revisions read as one plan changed rather than four messages", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
    });

    const revisions = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const start = yield* runner.startIntake(startInput);
      const second = yield* runner.turnIntake({ intakeSessionId: start.intakeSessionId, answer: "No bench" });
      const third = yield* runner.turnIntake({ intakeSessionId: start.intakeSessionId, answer: "Mostly size" });
      return [start.turn.revision, second.turn.revision, third.turn.revision] as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(revisions).toEqual([1, 2, 3]);
  });

  it("carries the coach's open question and its closed-set options through to the caller", async () => {
    const question: IntakeOpenQuestion = {
      id: "q1",
      question: "Dumbbells and a rack — is there a bench, and does it incline?",
      options: ["Adjustable bench", "Flat bench only", "No bench"],
    };
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week", openQuestion: question })).layer,
    });

    const turn = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const start = yield* runner.startIntake(startInput);
      return start.turn;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(turn.openQuestion).toEqual(question);
  });

  it("treats a tapped chip and a typed sentence as the same turn", async () => {
    // The coach echoes what it was told, so two runs that differ only in whether
    // the text came from a chip or the keyboard must be indistinguishable.
    const echoing = () =>
      makeScriptedIntakeSessionAgent({
        respond: (transcript) => replyWith({ headline: `heard: ${transcript[transcript.length - 1]}` }),
      });

    const answerOnce = (answer: string) => {
      const { layer } = makeHarness({ sessionAgent: echoing().layer });
      return Effect.gen(function* () {
        const runner = yield* DeliberationRunner;
        const { intakeSessionId } = yield* runner.startIntake(startInput);
        const turn = yield* runner.turnIntake({ intakeSessionId, answer });
        return turn.turn.draftPlan.headline;
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
    };

    const [fromChip, fromKeyboard] = await Promise.all([
      answerOnce("Adjustable bench"),
      answerOnce("Adjustable bench"),
    ]);

    expect(fromChip).toBe(fromKeyboard);
  });

  it("attaches the calibration note to every turn, never to a moment before the form", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
    });

    const notes = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const start = yield* runner.startIntake(startInput);
      const next = yield* runner.turnIntake({ intakeSessionId: start.intakeSessionId, answer: "No bench" });
      return [start.turn.calibrationNote, next.turn.calibrationNote] as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(notes[0]).toBe(CALIBRATION_NOTE);
    expect(notes[1]).toBe(CALIBRATION_NOTE);
  });

  it("reports each turn's own spend, not a running total the client would double-count", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(
        replyWith({ headline: "Upper / lower, four days a week", usage: { input: 400, output: 90, cacheRead: 0, cacheCreation: 0 } }),
      ).layer,
    });

    const usages = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const start = yield* runner.startIntake(startInput);
      const next = yield* runner.turnIntake({ intakeSessionId: start.intakeSessionId, answer: "No bench" });
      return [start.turn.usage, next.turn.usage] as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(usages[0]).toEqual({ input: 400, output: 90, cacheRead: 0, cacheCreation: 0 });
    expect(usages[1]).toEqual({ input: 400, output: 90, cacheRead: 0, cacheCreation: 0 });
  });
});

describe("Intake: nothing is written before convergence (ADR 0014 §2)", () => {
  it("writes no Decision across a multi-turn exchange, then exactly one on converge", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
    });

    const counts = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;

      const before = (yield* store.listDecisionsForTest).length;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      yield* runner.turnIntake({ intakeSessionId, answer: "No bench" });
      yield* runner.turnIntake({ intakeSessionId, answer: "Mostly size" });
      yield* runner.turnIntake({ intakeSessionId, answer: "Bad lower back" });
      const duringExchange = (yield* store.listDecisionsForTest).length;

      yield* runner.convergeIntake({ intakeSessionId });
      const afterConverge = (yield* store.listDecisionsForTest).length;

      return { before, duringExchange, afterConverge } as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(counts.duringExchange).toBe(counts.before);
    expect(counts.afterConverge).toBe(counts.before + 1);
  });

  it("the run ledger records one row per stage — cold draft, each turn, and the convergence sweep (issue #81)", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
    });

    const spend = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;

      const { intakeSessionId } = yield* runner.startIntake(startInput);
      yield* runner.turnIntake({ intakeSessionId, answer: "No bench" });
      yield* runner.turnIntake({ intakeSessionId, answer: "Mostly size" });
      yield* runner.convergeIntake({ intakeSessionId });

      return yield* store.getSpendSummary;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(spend.perCadence).toEqual([{ cadence: "intake", runCount: 1, usage: expect.any(Object) }]);
    expect(spend.recentRuns).toHaveLength(1);
    const stages = spend.recentRuns[0]?.stages.map((s) => s.stage).sort();
    // Two turns collapse into ONE "intake-turn" stage entry (summed), per the
    // ledger's stage grain — see `summarizeRunLedger`.
    expect(stages).toEqual(["intake-draft", "intake-turn", "sweep"]);
  });

  it("writes nothing after a FAILED turn either — a failed turn is a genuine no-op", async () => {
    let calls = 0;
    const failsSecondTurn = makeScriptedIntakeSessionAgent({
      respond: () => {
        calls += 1;
        return calls === 2
          ? new IntakeAgentError({ detail: "the model returned prose, not a turn" })
          : replyWith({ headline: "Upper / lower, four days a week" });
      },
    });
    const { layer } = makeHarness({ sessionAgent: failsSecondTurn.layer });

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;

      const before = (yield* store.listDecisionsForTest).length;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      const failed = yield* Effect.result(runner.turnIntake({ intakeSessionId, answer: "No bench" }));
      const after = (yield* store.listDecisionsForTest).length;
      // The draft the user was reading must still be there, and the session must
      // still be usable — the valuable thing survives the failure.
      const recovered = yield* runner.turnIntake({ intakeSessionId, answer: "No bench, then" });
      return { before, after, failed, recovered: recovered.turn.revision } as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome.after).toBe(outcome.before);
    expect(Result.isFailure(outcome.failed)).toBe(true);
    const failure = Result.isFailure(outcome.failed) ? outcome.failed.failure : undefined;
    expect(failure).toBeInstanceOf(IntakeTurnFailedError);
    // Revision 2, because the failed turn produced no draft to count.
    expect(outcome.recovered).toBe(2);
  });

  it("a cold draft that cannot be read fails typed and leaves NO session behind — no fallback stub plan", async () => {
    const brokenColdDraft = makeScriptedIntakeSessionAgent({
      respond: () => new IntakeAgentError({ detail: "reply was not valid JSON" }),
    });
    const { layer } = makeHarness({ sessionAgent: brokenColdDraft.layer });

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const failed = yield* Effect.result(runner.startIntake(startInput));
      const rows = (yield* store.listDecisionsForTest).length;
      return { failed, rows } as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(Result.isFailure(outcome.failed)).toBe(true);
    const failure = Result.isFailure(outcome.failed) ? outcome.failed.failure : undefined;
    // Slice 8 substituted a fabricated one-exercise "Unknown" plan here and
    // called it a draft. The user is told instead, and keeps their form.
    expect(failure).toBeInstanceOf(IntakeTurnFailedError);
  });

  it("an abandoned Intake leaves zero rows and needs no cleanup", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
    });

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;

      const before = (yield* store.listDecisionsForTest).length;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      yield* runner.turnIntake({ intakeSessionId, answer: "No bench" });
      yield* runner.abandonIntake({ intakeSessionId });
      const after = (yield* store.listDecisionsForTest).length;

      // The session is gone: a later turn against that id is a typed not-found.
      const afterwards = yield* Effect.result(
        runner.turnIntake({ intakeSessionId, answer: "actually, wait" }),
      );
      return { before, after, afterwards } as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome.after).toBe(outcome.before);
    expect(Result.isFailure(outcome.afterwards)).toBe(true);
    const failure = Result.isFailure(outcome.afterwards) ? outcome.afterwards.failure : undefined;
    expect(failure).toBeInstanceOf(IntakeSessionNotFoundError);
  });

  it("a turn or converge against an unknown session id is a typed not-found, never a fresh session", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
    });

    const failures = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const turn = yield* Effect.result(
        runner.turnIntake({ intakeSessionId: "no-such-session", answer: "hi" }),
      );
      const converge = yield* Effect.result(
        runner.convergeIntake({ intakeSessionId: "no-such-session" }),
      );
      return [
        Result.isFailure(turn) ? turn.failure : undefined,
        Result.isFailure(converge) ? converge.failure : undefined,
      ] as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(failures[0]).toBeInstanceOf(IntakeSessionNotFoundError);
    expect(failures[1]).toBeInstanceOf(IntakeSessionNotFoundError);
  });
});

describe("Intake: convergence and the single sweep (ADR 0014 §5)", () => {
  it("commits the SWEEP's justification, never the deliberator's draft", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(
        replyWith({
          headline: "Upper / lower, four days a week",
          rationale: [
            { text: "Twice-weekly frequency beats once.", citationId: "c1" },
            { text: "Hip thrusts spare the lower back.", citationId: "c2" },
          ],
          citations: [CORPUS_CITATION, FOLKLORE_CITATION],
        }),
      ).layer,
    });

    const converged = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      const result = yield* runner.convergeIntake({ intakeSessionId });
      const decisions = yield* store.listDecisionsForTest;
      const committed = decisions.find((d) => d.id === (result.proposalId as string));
      return { result, committed } as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // The folklore citation was removed by the sweep, so it is neither returned
    // nor committed — the user is shown what was verified, not what was drafted.
    expect(converged.result.citations.map((c) => c.id)).toEqual(["c1"]);
    const committedCitations = JSON.parse(converged.committed?.citationsJson ?? "[]") as ReadonlyArray<{
      readonly source_url: string;
    }>;
    expect(committedCitations.map((c) => c.source_url)).toEqual([CORPUS_CITATION.source_url]);
  });

  it("discloses every verdict, held sources included, so 'all sources held' is legible as a fact", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(
        replyWith({
          headline: "Upper / lower, four days a week",
          rationale: [
            { text: "Twice-weekly frequency beats once.", citationId: "c1" },
            { text: "Hip thrusts spare the lower back.", citationId: "c2" },
          ],
          citations: [CORPUS_CITATION, FOLKLORE_CITATION],
        }),
      ).layer,
    });

    const disclosure = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      const result = yield* runner.convergeIntake({ intakeSessionId });
      return result.disclosure;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(disclosure.verdicts).toHaveLength(2);
    expect(disclosure.verdicts[0]?.outcome).toBe("corpus-verified");
    expect(disclosure.verdicts[1]?.outcome).toBe("removed");
    // A removal without a reason is not a disclosure.
    expect(disclosure.verdicts[1]?.why).toBeDefined();
  });

  it("scopes the disclosure to the citations THAT plan carried — converging early cannot report unseen sources", async () => {
    // The coach accumulates a second citation only from turn 2 onwards. A user
    // who taps straight through to review must never be told a source they never
    // saw was removed.
    const growing = makeScriptedIntakeSessionAgent({
      respond: (transcript) =>
        replyWith({
          headline: "Upper / lower, four days a week",
          citations: transcript.length > 1 ? [CORPUS_CITATION, FOLKLORE_CITATION] : [CORPUS_CITATION],
        }),
    });
    const { layer } = makeHarness({ sessionAgent: growing.layer });

    const disclosure = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      // Converge straight off the cold draft — legitimate, and the case that
      // caught this in the prototype.
      const result = yield* runner.convergeIntake({ intakeSessionId });
      return result.disclosure;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(disclosure.verdicts.map((v) => v.citationId)).toEqual(["c1"]);
  });

  it("leaves the prescription untouched — the sweep governs the justification only", async () => {
    const drafted = planFor("Upper / lower, four days a week");
    const { layer } = makeHarness({
      sessionAgent: staticCoach(
        replyWith({
          headline: "Upper / lower, four days a week",
          rationale: [{ text: "Hip thrusts spare the lower back.", citationId: "c2" }],
          citations: [FOLKLORE_CITATION],
        }),
      ).layer,
    });

    const result = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      return yield* runner.convergeIntake({ intakeSessionId });
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(result.draftPlan).toEqual(drafted);
  });

  it("still commits a plan the sweep gutted — thinner rationale, and the user can accept it", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(
        replyWith({
          headline: "Upper / lower, four days a week",
          rationale: [{ text: "Hip thrusts spare the lower back.", citationId: "c2" }],
          citations: [FOLKLORE_CITATION],
        }),
      ).layer,
    });

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      const result = yield* runner.convergeIntake({ intakeSessionId });
      // Accept it the ordinary way — there is no Intake accept path.
      const resolved = yield* store.resolveProposal({
        proposalId: result.proposalId as never,
        decision: "accepted",
      });
      return { result, resolved } as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // Every source struck out, yet a real, acceptable Proposal exists: ADR 0014
    // §8 calls this the machinery working, not an error. This is also #38 item 2
    // — the old zero-citation downgrade to an Observation made it unacceptable.
    expect(outcome.result.citations).toHaveLength(0);
    expect(outcome.result.disclosure.verdicts.every((v) => v.outcome === "removed")).toBe(true);
    expect(outcome.resolved.proposal.status).toBe("accepted");
    // The rationale line survives, uncited, rather than vanishing.
    expect(outcome.result.rationale).toHaveLength(1);
    expect(outcome.result.rationale[0]?.citationId).toBeUndefined();
  });

  it("carries the calibration note into the committed Decision, where it stays readable", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
    });

    const rationale = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      const result = yield* runner.convergeIntake({ intakeSessionId });
      const decisions = yield* store.listDecisionsForTest;
      return decisions.find((d) => d.id === (result.proposalId as string))?.rationale ?? "";
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(rationale).toContain("more template than coaching");
  });

  it("carries the drafted Plan onto the Proposal as structured data, not a JSON blob in prose", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
    });

    const proposal = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      const result = yield* runner.convergeIntake({ intakeSessionId });
      yield* store.resolveProposal({ proposalId: result.proposalId as never, decision: "accepted" });
      const proposals = yield* store.getProposals;
      return proposals.find((p) => (p.id as string) === (result.proposalId as string));
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(proposal?.draftPlan).toEqual(planFor("Upper / lower, four days a week"));
  });

  it("keeps the Intake Proposal off the pending-Proposal surface until it is accepted", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
    });

    const [hiddenWhilePending, feedDelta] = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const feedBefore = (yield* store.getCoachingFeed).length;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      const result = yield* runner.convergeIntake({ intakeSessionId });
      const proposals = yield* store.getProposals;
      const feedAfter = (yield* store.getCoachingFeed).length;
      return [
        proposals.every((p) => (p.id as string) !== (result.proposalId as string)),
        feedAfter - feedBefore,
      ] as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(hiddenWhilePending).toBe(true);
    expect(feedDelta).toBe(0);
  });

  it("re-converging after reopening the exchange supersedes only the prior Intake Proposal", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
    });

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;

      const rowsBefore = (yield* store.listDecisionsForTest).length;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      const first = yield* runner.convergeIntake({ intakeSessionId });

      // The user noticed a problem on the final card and reopened the exchange.
      yield* runner.turnIntake({ intakeSessionId, answer: "actually, drop the RDLs" });
      const second = yield* runner.convergeIntake({ intakeSessionId });

      const decisions = yield* store.listDecisionsForTest;
      return {
        firstStatus: decisions.find((d) => d.id === (first.proposalId as string))?.status,
        secondStatus: decisions.find((d) => d.id === (second.proposalId as string))?.status,
        added: decisions.length - rowsBefore,
      } as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome.firstStatus).toBe("superseded");
    expect(outcome.secondStatus).toBe("pending");
    expect(outcome.added).toBe(2);
  });

  it("offers no Proposal when the sweep could not run, and keeps the session alive to retry", async () => {
    const sweepThatCannotRun = Layer.succeed(IntakeSweepAgent)({
      run: () => Effect.fail(new IntakeAgentError({ detail: "the sweep session was killed" })),
    });
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
      sweepAgent: sweepThatCannotRun,
    });

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const before = (yield* store.listDecisionsForTest).length;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      const first = yield* Effect.result(runner.convergeIntake({ intakeSessionId }));
      const after = (yield* store.listDecisionsForTest).length;
      // The session survives, so a retry hits the sweep again rather than
      // "session not found" — the user does not lose four turns of work.
      const second = yield* Effect.result(runner.convergeIntake({ intakeSessionId }));
      // And they can keep tweaking instead of retrying, if they prefer.
      const stillUsable = yield* runner.turnIntake({ intakeSessionId, answer: "drop the RDLs" });
      return { before, after, first, second, stillUsable } as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // An unverified plan cannot be accepted, so nothing is committed (§8).
    expect(outcome.after).toBe(outcome.before);
    for (const result of [outcome.first, outcome.second]) {
      expect(Result.isFailure(result)).toBe(true);
      const failure = Result.isFailure(result) ? result.failure : undefined;
      expect(failure).toBeInstanceOf(IntakeSweepRejectedError);
      expect(failure).not.toBeInstanceOf(IntakeSessionNotFoundError);
    }
    expect(outcome.stillUsable.turn.revision).toBe(2);
  });

  it("hands the Intake sweep the SAME Evidence-base roster the Intake seed carried (issue #92)", async () => {
    let sweepSawRosterLength: number | undefined;
    const rosterCapturingSweep = Layer.succeed(IntakeSweepAgent)({
      run: ({ rationale, citations, evidenceRoster, sink }) =>
        Effect.gen(function* () {
          sweepSawRosterLength = evidenceRoster.length;
          yield* sink.emit({ tool: "collect_claims", subject: `${citations.length}` });
          return {
            rationale,
            citations: citations.map((c) => ({ ...c, trust: "retrieved-unverified" as const })),
            verdicts: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            costUsd: 0,
          };
        }),
    });
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
      sweepAgent: rosterCapturingSweep,
    });

    await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      yield* runner.convergeIntake({ intakeSessionId });
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // `Store.layer` runs the real migrations, which seat the vetted evidence
    // corpus (#87) — a non-empty roster here is evidence the Intake sweep
    // received the seed's actual roster, not an empty stand-in.
    expect(sweepSawRosterLength).toBeGreaterThan(0);
  });
});

describe("Intake: the activity line (ADR 0014 §4)", () => {
  it("delivers discrete ordered tool events to a subscriber", async () => {
    const scripted = makeScriptedIntakeSessionAgent({
      respond: () => replyWith({ headline: "Upper / lower, four days a week" }),
      toolEvents: [
        { tool: "WebSearch", subject: "training frequency 4 days" },
        { tool: "WebFetch", subject: "https://example.com/corpus/frequency-meta-analysis" },
      ],
    });
    const { layer } = makeHarness({ sessionAgent: scripted.layer });

    const events = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const { intakeSessionId } = yield* runner.startIntake(startInput);

      // Subscribe, then take a turn: the events of THAT turn are what a watching
      // client sees. (The cold draft's events precede any possible subscriber,
      // which is correct — events are live-only and replay nothing.)
      const collected = yield* Ref.make<ReadonlyArray<string>>([]);
      const fiber = yield* Effect.forkChild(
        runner
          .intakeEvents({ intakeSessionId })
          .pipe(
            Stream.take(2),
            Stream.runForEach((event) =>
              Ref.update(collected, (all) => [...all, `${event.seq}:${event.tool}`]),
            ),
          ),
      );
      // Give the subscription a chance to attach before producing events.
      yield* Effect.yieldNow;
      yield* runner.turnIntake({ intakeSessionId, answer: "No bench" });
      yield* Fiber.join(fiber);
      return yield* Ref.get(collected);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(events).toHaveLength(2);
    // Monotonic and in the order the coach did the work — ordinals are the
    // client's to derive, ordering is the runner's to guarantee.
    expect(events[0]).toMatch(/:WebSearch$/);
    expect(events[1]).toMatch(/:WebFetch$/);
    const seqs = events.map((entry) => Number(entry.split(":")[0]));
    expect(seqs[1] as number).toBeGreaterThan(seqs[0] as number);
  });

  it("emits one sweep event per citation, in the same order as the disclosure it returns", async () => {
    const { layer } = makeHarness({
      sessionAgent: staticCoach(
        replyWith({
          headline: "Upper / lower, four days a week",
          citations: [CORPUS_CITATION, FOLKLORE_CITATION],
        }),
      ).layer,
    });

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const { intakeSessionId } = yield* runner.startIntake(startInput);

      const fiber = yield* Effect.forkChild(
        runner.intakeEvents({ intakeSessionId }).pipe(Stream.take(4), Stream.runCollect),
      );
      yield* Effect.yieldNow;
      const result = yield* runner.convergeIntake({ intakeSessionId });
      const events = yield* Fiber.join(fiber);
      return { result, events } as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    const verifySubjects = outcome.events
      .filter((event) => event.tool === "verify_citation")
      .map((event) => event.subject);
    // The wait narrates the same list, in the same order, as the card that
    // follows it — so "checking source 2 of 2" can never contradict the card.
    expect(verifySubjects).toEqual(outcome.result.disclosure.verdicts.map((v) => v.source_url));
  });

  it("stops narrating once the session is gone, rather than failing a live subscriber", async () => {
    const scripted = makeScriptedIntakeSessionAgent({
      respond: () => replyWith({ headline: "Upper / lower, four days a week" }),
    });
    const { layer } = makeHarness({ sessionAgent: scripted.layer });

    const completed = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      const fiber = yield* Effect.forkChild(
        runner.intakeEvents({ intakeSessionId }).pipe(Stream.runCollect),
      );
      yield* Effect.yieldNow;
      // The tab closed.
      yield* runner.abandonIntake({ intakeSessionId });
      yield* Fiber.join(fiber);
      return true;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(completed).toBe(true);
  });

  it("tears the underlying coach session down when the client's subscription ends", async () => {
    const scripted = makeScriptedIntakeSessionAgent({
      respond: () => replyWith({ headline: "Upper / lower, four days a week" }),
    });
    const { layer } = makeHarness({ sessionAgent: scripted.layer });

    const liveAfterDrop = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      // Whatever owns the connection is responsible for calling this when it
      // drops; `rpcHandlers` wires it to the events subscription's lifetime.
      yield* runner.abandonIntake({ intakeSessionId });
      return yield* scripted.openSessionKeys;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // No SDK session left holding subscription spend for a conversation nobody
    // can continue (ADR 0014 §8).
    expect(liveAfterDrop).toHaveLength(0);
  });
});

describe("Intake: quota fails loudly (ADR 0014 §4)", () => {
  it("fails typed and immediately when quota is low, rather than enqueueing", async () => {
    const quota = makeCannedQuotaService();
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
      quota: quota.layer,
    });

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* quota.setLow;
      // Immediately, not after awaiting a queue slot — a timeout would hang here
      // if Intake had been enqueued.
      return yield* Effect.result(runner.startIntake(startInput));
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(Result.isFailure(outcome)).toBe(true);
    const failure = Result.isFailure(outcome) ? outcome.failure : undefined;
    expect(failure).toBeInstanceOf(IntakeQuotaExhaustedError);
  });

  it("fails a turn and a converge on low quota too, without touching the store", async () => {
    const quota = makeCannedQuotaService();
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
      quota: quota.layer,
    });

    const outcome = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const { intakeSessionId } = yield* runner.startIntake(startInput);
      const before = (yield* store.listDecisionsForTest).length;

      yield* quota.setLow;
      const turn = yield* Effect.result(runner.turnIntake({ intakeSessionId, answer: "No bench" }));
      const converge = yield* Effect.result(runner.convergeIntake({ intakeSessionId }));
      const after = (yield* store.listDecisionsForTest).length;

      return {
        turnFailure: Result.isFailure(turn) ? turn.failure : undefined,
        convergeFailure: Result.isFailure(converge) ? converge.failure : undefined,
        before,
        after,
      } as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(outcome.turnFailure).toBeInstanceOf(IntakeQuotaExhaustedError);
    expect(outcome.convergeFailure).toBeInstanceOf(IntakeQuotaExhaustedError);
    expect(outcome.after).toBe(outcome.before);
  });

  it("recovers with no ceremony once quota frees up — nothing was queued to drain", async () => {
    const quota = makeCannedQuotaService();
    const { layer } = makeHarness({
      sessionAgent: staticCoach(replyWith({ headline: "Upper / lower, four days a week" })).layer,
      quota: quota.layer,
    });

    const revision = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* quota.setLow;
      yield* Effect.result(runner.startIntake(startInput));
      yield* quota.setAvailable;
      // The user tapped Retry.
      const start = yield* runner.startIntake(startInput);
      return start.turn.revision;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(revision).toBe(1);
  });
});
