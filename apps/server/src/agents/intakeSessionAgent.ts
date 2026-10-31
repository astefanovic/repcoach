import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type {
  DeliberationEffort,
  IntakeDraftEntry,
  IntakeDraftPlan,
  IntakeDraftSet,
  IntakeOpenQuestion,
  IntakeProvisionalCitation,
  IntakeRationaleLine,
  TokenUsage,
} from "@repcoach/contracts";

/**
 * The **interactive** deliberator port (ADR 0014 §2, issue #70) — a held-open
 * session, resumed turn to turn.
 *
 * This is a SECOND entry point alongside `DeliberationAgent.run`, not a
 * replacement for it. The one-shot form stays exactly as it was for the three
 * fire-and-forget cadences, which have no user waiting and no conversation to
 * carry: giving them a session lifecycle would be machinery for nobody. Intake
 * is the one interactive run in the app, and it needs the opposite shape.
 *
 * Why held open rather than re-seeded per turn (the shape slice 8 shipped):
 * ADR 0013 seeds a Revision run with the full Session-review context so the
 * coach can re-read the Log and settle an argument about data. At cold start
 * there is no Log, no Check-in and no prior Decision — the database is empty by
 * definition — so a re-seeded run would be re-reading nothing, expensively,
 * once per turn, while still forgetting what the user said two turns ago. The
 * session carries its own context instead, which is what makes turns cheap
 * enough that arguing with the draft is not something a user should ration.
 *
 * The port is deliberately small: open, send, close. Everything else the
 * takeover needs — ordering, event fan-out, the one Decision — belongs to the
 * runner, which is the seam #70 is tested through.
 */

/**
 * Where a live session's tool activity goes (ADR 0014 §4's activity line). The
 * ports report *what happened* — a tool name and whatever the SDK gives as its
 * subject — and the runner stamps the sequence number and fans it out.
 *
 * Ordering is deliberately NOT the port's business: `seq` is assigned at one
 * place, by the one component that also owns the sweep's verdict order, which is
 * how the wait is prevented from narrating a sequence the card then contradicts.
 * Phrasing is not the port's business either — "reading up on training
 * frequency" is client copy (§4), so a new tool never needs a server change to
 * render sanely.
 */
export interface IntakeToolEventSink {
  readonly emit: (event: { readonly tool: string; readonly subject?: string }) => Effect.Effect<void>;
}

/** A sink that drops everything — for callers with no subscriber to feed. */
export const noopIntakeToolEventSink: IntakeToolEventSink = {
  emit: () => Effect.void,
};

/**
 * One coach reply from the live session, already structured. Decoding the
 * model's output is the ADAPTER's job, not the runner's, so a malformed reply
 * fails here as `IntakeAgentError` and never reaches the runner as a
 * half-parsed shape it has to guess about.
 *
 * There is deliberately no `plan`-shaped fallback anywhere in this file: slice 8
 * substituted a fabricated one-exercise "Unknown" plan when the decode failed,
 * which handed the user a plan the coach never drafted and called it a draft.
 */
export interface IntakeAgentReply {
  readonly draftPlan: IntakeDraftPlan;
  readonly rationale: ReadonlyArray<IntakeRationaleLine>;
  readonly citations: ReadonlyArray<IntakeProvisionalCitation>;
  readonly calibrationNote: string;
  /** At most one — ADR 0014 §2 plus the #64 prototype's "one question on screen". */
  readonly openQuestion?: IntakeOpenQuestion;
  readonly usage: TokenUsage;
  /** The SDK's own `total_cost_usd` for this turn's session (issue #81) — stored on the run ledger, never rendered. */
  readonly costUsd: number;
}

/**
 * The session could not produce a usable reply — it was killed by the guard, the
 * SDK failed, or its output did not decode. One error type for all three
 * because the caller's options are identical in every case: tell the user, keep
 * what they already have, offer a retry.
 */
export class IntakeAgentError extends Schema.TaggedErrorClass<IntakeAgentError>()("IntakeAgentError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `The Intake deliberator session failed: ${this.detail}`;
  }
}

/**
 * An opaque handle to one live session. Opaque on purpose: the runner keys its
 * own session map by an id it minted, so nothing outside the adapter can reach
 * the underlying SDK session, and the adapter is free to hold a process, a
 * generator or nothing at all behind this.
 */
export interface IntakeSessionHandle {
  readonly sessionKey: string;
}

export class IntakeSessionAgent extends Context.Service<
  IntakeSessionAgent,
  {
    /**
     * Opens a session on the Intake seed and returns its FIRST reply — the cold
     * draft. Seeding and drafting are one round trip because they are one act
     * from the user's side: they submitted a form, and the next thing that
     * exists is a plan.
     */
    readonly open: (params: {
      readonly seed: string;
      readonly model?: string;
      /** Per-cadence reasoning effort for the Intake cadence (issue #81) — the other half of `model`. */
      readonly effort?: DeliberationEffort;
      readonly sink: IntakeToolEventSink;
    }) => Effect.Effect<
      { readonly handle: IntakeSessionHandle; readonly reply: IntakeAgentReply },
      IntakeAgentError
    >;
    /**
     * Sends one user turn to an ALREADY-OPEN session — resumed, never re-seeded.
     * A failure here must leave the session usable: ADR 0014 §8 makes a failed
     * turn a genuine no-op, and the draft on screen is the valuable thing.
     */
    readonly send: (params: {
      readonly handle: IntakeSessionHandle;
      readonly answer: string;
      readonly sink: IntakeToolEventSink;
    }) => Effect.Effect<IntakeAgentReply, IntakeAgentError>;
    /**
     * Tears the underlying session down. Called when the exchange converges,
     * when the client's connection drops, and on abandonment — ADR 0014 §8 has
     * no resurrection path, so this is the only lifecycle exit and it must be
     * safe to call on an already-dead handle.
     */
    readonly close: (handle: IntakeSessionHandle) => Effect.Effect<void>;
  }
>()("@repcoach/server/IntakeSessionAgent") {}

/**
 * An `IntakeSessionAgent` where every call fails, plainly.
 *
 * This is the right default for the unit rungs: a suite exercising the deferral
 * queue or the cycle-review cadence has no business holding a working Intake
 * coach, and one that failed loudly if reached is how that stays true.
 *
 * It was also, until #82, what the *dev-server* ran — see
 * `CannedIntakeSessionAgent` below for why that stopped being defensible.
 */
export const UnwiredIntakeSessionAgent: Layer.Layer<IntakeSessionAgent> = Layer.succeed(IntakeSessionAgent)({
  open: () =>
    Effect.fail(
      new IntakeAgentError({
        detail: "no Intake coach is wired on this server — Intake needs the real Agent SDK session",
      }),
    ),
  send: () =>
    Effect.fail(
      new IntakeAgentError({
        detail: "no Intake coach is wired on this server — Intake needs the real Agent SDK session",
      }),
    ),
  close: () => Effect.void,
});

/* ------------------------------------------------ the dev-server's coach --- */

/**
 * The dev-server's canned Intake coach (#82).
 *
 * **This overturns a decision that was taken on purpose, so here is the
 * argument.** `UnwiredIntakeSessionAgent` above used to be what the dev-server
 * ran, reasoning that a fixed script would have to fake the one thing this port
 * exists to provide — a session carrying the user's own words forward — and
 * that the surface's design question was already answered by the #64 prototype.
 *
 * That held right up until Intake had to be *acceptance-tested*. Rung 2 is the
 * gate before phone UAT, and with nothing wired, every path past the form was
 * unreachable from a browser: the cold draft failed, so the exchange, the
 * ledger, the sweep, the swept Proposal card and Accept had **no black-box
 * coverage at all** — the single flow a new user cannot skip was the single
 * flow nothing tested. #82 makes the call explicitly ("the flow needs the agent
 * stubbed or scripted at the server boundary — the runner's ports are already
 * injectable"), and the cost of leaving it unwired is strictly higher than the
 * cost of a script.
 *
 * The old objection is answered rather than ignored: this coach is a function
 * of the **whole transcript**, not a fixed reel. Its first revision is visibly
 * *caused* by the answer it was given — the draft loses an exercise and gains
 * another, and says which answer did it — so a runner that re-seeded per turn
 * instead of resuming would produce a different plan and the flow would fail.
 * That is the property `makeScriptedIntakeSessionAgent`'s signature was built
 * to expose, borrowed here rather than reinvented.
 *
 * What it does NOT fake: it never claims trust. Its citations are provisional
 * by construction (`IntakeProvisionalCitation` carries no `trust` field), and
 * the badges the user eventually reads come from `CannedIntakeSweepAgent`
 * ruling on them. The three URLs below are chosen to drive all three of that
 * sweep's outcomes — a corpus hit, a blog post that gets **removed** with its
 * reason, and one that survives as retrieved-unverified — so the swept card has
 * a real disclosure to make rather than a vacuous one.
 *
 * It is wired only through `makeDeliberationLevers`, i.e. only into the
 * dev-server. Production runs `RealIntakeSessionAgent`; the unit rungs keep
 * `UnwiredIntakeSessionAgent`, so a suite that reaches Intake by accident still
 * fails loudly.
 */

const CALIBRATION_NOTE =
  "The first few weeks are calibration: I am guessing your starting loads and " +
  "watching what you actually lift. Once there are three or four logged " +
  "sessions I can start proposing changes from your own numbers rather than " +
  "from population averages.";

/** Drives `CannedIntakeSweepAgent`'s corpus branch — survives as `corpus-verified`. */
const CORPUS_URL = "https://example.com/corpus/frequency-meta-analysis";
/** Drives its `removed` branch — the disclosure the swept card has to make. */
const BLOG_URL = "https://example.com/blog/lifting-twice-a-week";
/** Drives its fall-through — survives, badged `retrieved-unverified`. */
const RETRIEVED_URL = "https://example.com/retrieved/progression-primer";

const CANNED_CITATIONS: ReadonlyArray<IntakeProvisionalCitation> = [
  {
    id: "intake-c1",
    claim: "Training a muscle twice a week beats once for hypertrophy at matched volume.",
    source_url: CORPUS_URL,
  },
  {
    id: "intake-c2",
    claim: "Two full-body days a week is enough for a beginner to grow.",
    source_url: BLOG_URL,
  },
  {
    id: "intake-c3",
    claim: "Adding load once the top of the rep range is reached is the simplest workable progression.",
    source_url: RETRIEVED_URL,
  },
];

const set = (target: IntakeDraftSet["target"], restSec: number): IntakeDraftSet => ({
  setType: "working",
  target,
  restSec,
});

const REPS_5_AT_100 = set({ reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } }, 180);
const REPS_8_10_AT_60 = set({ reps: { min: 8, max: 10 }, load: { min: 60, max: 60 } }, 90);
const REPS_10_AT_80 = set({ reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } }, 90);
const PLANK_30_45 = set({ duration: { min: 30, max: 45 } }, 60);

/**
 * `ExerciseId` is branded, and these four are the `exercise_catalog` seed's own
 * ids (`@repcoach/persistence`'s `exerciseCatalogSeed.ts`) — the same widening
 * the in-memory `Store` seed does for the same reason. Drafting an exercise the
 * catalog does not hold would fail at materialization, so these being the seed's
 * ids is load-bearing rather than illustrative.
 */
const catalogId = (id: string) => id as never;

const BACK_SQUAT: IntakeDraftEntry = {
  exerciseId: catalogId("exercise-back-squat"),
  exerciseName: "Back Squat",
  trackedMetrics: ["reps", "load"],
  sets: [REPS_5_AT_100, REPS_5_AT_100, REPS_5_AT_100],
};
const LEG_PRESS: IntakeDraftEntry = {
  exerciseId: catalogId("exercise-leg-press"),
  exerciseName: "Leg Press",
  trackedMetrics: ["reps", "load"],
  sets: [REPS_10_AT_80, REPS_10_AT_80, REPS_10_AT_80],
};
const BENCH_PRESS: IntakeDraftEntry = {
  exerciseId: catalogId("exercise-bench-press"),
  exerciseName: "Bench Press",
  trackedMetrics: ["reps", "load"],
  sets: [REPS_8_10_AT_60, REPS_8_10_AT_60, REPS_8_10_AT_60],
};
const PLANK: IntakeDraftEntry = {
  exerciseId: catalogId("exercise-plank"),
  exerciseName: "Plank",
  trackedMetrics: ["duration"],
  sets: [PLANK_30_45, PLANK_30_45],
};

const planWith = (lowerBody: IntakeDraftEntry, headline: string): IntakeDraftPlan => ({
  planModel: "manual",
  headline,
  sessions: [
    { label: "Lower A", entries: [lowerBody, PLANK] },
    { label: "Upper A", entries: [BENCH_PRESS, PLANK] },
  ],
});

const COLD_HEADLINE = "Upper / lower, four days a week";
/**
 * The revised headline names the answer that caused it. That is not decoration:
 * it is what makes "the coach still knows what you told it" observable from a
 * browser, which is the only reason a scripted coach is defensible here at all.
 */
const REVISED_HEADLINE = "Upper / lower, four days a week — squatting swapped out";

const RATIONALE_COLD: ReadonlyArray<IntakeRationaleLine> = [
  { text: "Four days lets every muscle be trained twice a week.", citationId: "intake-c1" },
  { text: "Two days would also work, but leaves less room to add volume later.", citationId: "intake-c2" },
  { text: "Every target is hand-entered and moves when you beat the top of the range.", citationId: "intake-c3" },
];

const RATIONALE_REVISED: ReadonlyArray<IntakeRationaleLine> = [
  { text: "Four days lets every muscle be trained twice a week.", citationId: "intake-c1" },
  { text: "Leg press instead of back squat keeps the quads loaded off your spine.", citationId: "intake-c3" },
  { text: "Two days would also work, but leaves less room to add volume later.", citationId: "intake-c2" },
];

const OPEN_QUESTION: IntakeOpenQuestion = {
  id: "q-injuries",
  question: "Anything you need me to work around?",
  options: ["Nothing — all good", "Bad lower back", "Cranky shoulder"],
};

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/**
 * The canned coach's reply for a given transcript.
 *
 * `transcript[0]` is the seed; everything after it is a user answer in order.
 * The cold draft carries the one open question ADR 0014 §2 allows; once the
 * user has answered anything at all the coach has what it needs and asks
 * nothing further, so the exchange converges after a single turn. That keeps
 * the acceptance flow short without faking convergence — the question is gone
 * because it was answered.
 */
const cannedIntakeReply = (transcript: ReadonlyArray<string>): IntakeAgentReply => {
  const answers = transcript.slice(1);
  if (answers.length === 0) {
    return {
      draftPlan: planWith(BACK_SQUAT, COLD_HEADLINE),
      rationale: RATIONALE_COLD,
      citations: CANNED_CITATIONS,
      calibrationNote: CALIBRATION_NOTE,
      openQuestion: OPEN_QUESTION,
      // The cold draft is the expensive one; #64 settled that a turn's cost
      // must read as visibly a fraction of it, so these are not both zero.
      usage: { input: 4200, output: 900, cacheRead: 0, cacheCreation: 0 },
      costUsd: 0,
    };
  }
  return {
    draftPlan: planWith(LEG_PRESS, REVISED_HEADLINE),
    rationale: RATIONALE_REVISED,
    citations: CANNED_CITATIONS,
    calibrationNote: CALIBRATION_NOTE,
    usage: { input: 380, output: 120, cacheRead: 0, cacheCreation: 0 },
    costUsd: 0,
  };
};

/**
 * A SCRIPTED `IntakeSessionAgent` for tests: the caller supplies `respond`,
 * which is handed the session's **whole transcript so far** — the seed, then
 * every user answer in order.
 *
 * That signature is the point. A held-open session and a re-seeded one are
 * indistinguishable from the outside unless the test can tell whether the coach
 * still knows what it was told on turn 1, so the scripted agent makes the
 * transcript the thing a reply is a function of: a runner that re-seeded would
 * hand `respond` a one-entry transcript every time, and the assertion on turn 3
 * would fail. No test needs to count calls into the port to prove this.
 */
export const makeScriptedIntakeSessionAgent = (options: {
  readonly respond: (transcript: ReadonlyArray<string>) => IntakeAgentReply | IntakeAgentError;
  /** Tool events the adapter reports for each reply, in order. */
  readonly toolEvents?: ReadonlyArray<{ readonly tool: string; readonly subject?: string }>;
}): {
  readonly layer: Layer.Layer<IntakeSessionAgent>;
  /** Live session keys — lets a test assert a dropped connection really tore the session down. */
  readonly openSessionKeys: Effect.Effect<ReadonlyArray<string>>;
} => {
  const transcripts = Effect.runSync(Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map()));
  let nextKey = 0;

  const emitEvents = (sink: IntakeToolEventSink): Effect.Effect<void> =>
    Effect.forEach(options.toolEvents ?? [], (event) => sink.emit(event), { discard: true });

  const replyFor = (transcript: ReadonlyArray<string>): Effect.Effect<IntakeAgentReply, IntakeAgentError> => {
    const outcome = options.respond(transcript);
    return outcome instanceof IntakeAgentError ? Effect.fail(outcome) : Effect.succeed(outcome);
  };

  const layer = Layer.succeed(IntakeSessionAgent)({
    open: ({ seed, sink }) =>
      Effect.gen(function* () {
        const sessionKey = `scripted-intake-${(nextKey += 1)}`;
        const transcript: ReadonlyArray<string> = [seed];
        yield* Ref.update(transcripts, (map) => new Map(map).set(sessionKey, transcript));
        yield* emitEvents(sink);
        const reply = yield* replyFor(transcript);
        return { handle: { sessionKey }, reply };
      }),

    send: ({ handle, answer, sink }) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(transcripts);
        const existing = map.get(handle.sessionKey);
        if (existing === undefined) {
          // The runner is supposed to have checked this already; a scripted
          // agent that lied about it would hide a real bug.
          return yield* Effect.fail(
            new IntakeAgentError({ detail: `no live scripted session for ${handle.sessionKey}` }),
          );
        }
        const transcript: ReadonlyArray<string> = [...existing, answer];
        yield* Ref.update(transcripts, (m) => new Map(m).set(handle.sessionKey, transcript));
        yield* emitEvents(sink);
        // A failed turn must not cost the user their session, so the transcript
        // above is recorded before the reply can fail — the answer WAS sent.
        return yield* replyFor(transcript);
      }),

    close: (handle) =>
      Ref.update(transcripts, (map) => {
        const next = new Map(map);
        next.delete(handle.sessionKey);
        return next;
      }),
  });

  return {
    layer,
    openSessionKeys: Ref.get(transcripts).pipe(Effect.map((map) => Array.from(map.keys()))),
  };
};

/**
 * The dev-server's Intake coach — `cannedIntakeReply` over the scripted
 * adapter. Declared here rather than beside its data because it is built from
 * `makeScriptedIntakeSessionAgent`, and a `const` cannot be read before the
 * `const` it calls.
 *
 * The tool events are the sink the *cold* wait cannot subscribe to (the session
 * id does not exist until the draft has returned — #70's own suite records
 * this), so they are emitted for completeness rather than for the surface to
 * render. The activity line the user actually sees belongs to the sweep, and
 * `CannedIntakeSweepAgent` emits that one per citation.
 */
export const CannedIntakeSessionAgent: Layer.Layer<IntakeSessionAgent> =
  makeScriptedIntakeSessionAgent({
    respond: cannedIntakeReply,
    toolEvents: [
      { tool: "read_evidence_roster" },
      { tool: "search_corpus", subject: "training frequency" },
      { tool: "draft_plan" },
    ],
  }).layer;
