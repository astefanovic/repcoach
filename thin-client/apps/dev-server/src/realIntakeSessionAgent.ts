import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  IntakeDraftPlan,
  IntakeOpenQuestion,
  IntakeProvisionalCitation,
  IntakeRationaleLine,
  TrimmedNonEmptyString,
} from "@repcoach/contracts";

import {
  withSessionOverrides,
  DEFAULT_AGENT_SDK_SESSION_CONFIG,
  decodeAgentPayloadWithRepair,
  makeAgentPayloadShape,
  type AgentSdkSessionConfig,
  type AgentSdkSessionResult,
  type DeliberationRunKilledError,
  type HeldAgentSdkSession,
} from "./agentSdkSession.ts";
import { LiveAgentSdkTransport, type AgentSdkTransport } from "./agentTransport.ts";
import { COACH_PROSE_STYLE } from "./coachProseStyle.ts";
import {
  IntakeAgentError,
  IntakeSessionAgent,
  type IntakeAgentReply,
  type IntakeToolEventSink,
} from "./intakeSessionAgent.ts";

/**
 * The real `IntakeSessionAgent` (ADR 0014 §2): ONE Agent SDK session held open
 * across the whole Intake exchange, resumed turn to turn, rather than a fresh
 * `query()` per turn with the prior prompts re-pasted as text.
 *
 * Same tools as the one-shot deliberator, but only half its kill guard
 * (`agentSdkSession.ts`, issue #72): the turn cap bounds the conversation and
 * there is NO wall-clock budget, because a session held open across a
 * conversation runs on a human's clock — the user reading the draft is not a
 * runaway agent, and neither is a turn that spends a while retrieving. An
 * abandoned session is torn down by the event stream's finalizer (ADR 0014
 * §8), which is a truer signal than any timeout.
 */

/** Native tools only, exactly as the one-shot deliberator (ADR 0011 §2). */
const ALLOWED_TOOLS = ["Read", "Bash", "Grep", "WebSearch", "WebFetch"] as const;

export type RealIntakeSessionAgentConfig = AgentSdkSessionConfig;

export const DEFAULT_REAL_INTAKE_SESSION_AGENT_CONFIG: RealIntakeSessionAgentConfig =
  DEFAULT_AGENT_SDK_SESSION_CONFIG;

/**
 * The wire shape of one coach turn. Note what the model is asked for and what it
 * is not: it drafts the prescription and the justification, and it may ask ONE
 * question — but nothing here lets it set trust on a citation, because trust is
 * the sweep's to assign and an interim citation is provisional by construction
 * (ADR 0014 §3).
 */
const IntakeAgentTurnPayload = Schema.Struct({
  draftPlan: IntakeDraftPlan,
  rationale: Schema.Array(IntakeRationaleLine),
  citations: Schema.Array(IntakeProvisionalCitation),
  calibrationNote: TrimmedNonEmptyString,
  openQuestion: Schema.optionalKey(IntakeOpenQuestion),
});

/** Exported for the cassette fingerprint (issue #95) — see the deliberator's trailer. */
export const INTAKE_TURN_FORMAT_INSTRUCTION = `

## Required output format
Every message you send back must be ONLY a single JSON object matching this shape — no prose before or
after it, no markdown fence:

{
  "draftPlan": {
    "planModel": "...",
    "headline": "the plan in one line, e.g. 'Upper / lower, four days a week'",
    "sessions": [
      {
        "label": "...",
        "entries": [
          {
            "exerciseId": "<exercise_catalog id>",
            "exerciseName": "...",
            "trackedMetrics": ["reps", "load"],
            "sets": [
              { "setType": "working", "target": { "reps": { "min": 6, "max": 10 }, "load": { "min": 60, "max": 60 } }, "restSec": 120 }
            ]
          }
        ]
      }
    ]
  },
  "rationale": [ { "text": "...", "citationId": "c1" } ],
  "citations": [ { "id": "c1", "claim": "...", "source_url": "..." } ],
  "calibrationNote": "...",
  "openQuestion": { "id": "q1", "question": "...", "options": ["...", "..."] }
}

Rules that matter:

- A set target is an INTERVAL per metric. Equal bounds mean an exact target, differing bounds a range, one
  bound only means open-ended ("8+"), and an empty object means "report it, no target" (e.g. an open "rpe").
  Only include the metrics the exercise actually tracks — a plank has duration, not reps and load.
- "rationale" is the justification and the ONLY place a citation may attach. Never put reasoning inside the
  plan, and never put prescription inside the rationale.
- Do NOT assign a trust level to a citation. A single adversarial sweep verifies every source when the user
  reviews the plan, and it assigns trust then. Cite honestly: sources it cannot confirm are removed and their
  points degraded to reasoning-only, in public, on the card the user accepts.
- "calibrationNote" is required on every turn, in your own voice: say that this first block is more template
  than coaching because there is no performance data yet, and name specifically what changes once roughly a
  month is logged. Naming what unlocks is what turns a disclaimer into a promise.
- Intake is the ONE path that drafts a whole Plan rather than a change to one (ADR 0014 §6): there is no prior
  Plan to diff against, so you emit "draftPlan" in full and never the "plan_operations" a review-cadence
  Proposal carries (#86). Accepting materializes what is in "draftPlan" verbatim — so the plan on screen when
  the user converges is exactly the plan they get.
- "openQuestion" is optional and there is at most ONE. Ask only when the answer would actually change the
  plan, ask it about the concrete draft rather than in the abstract, and include "options" only when the
  answer is a genuinely closed set. Omit the field entirely when you have nothing worth asking.
${COACH_PROSE_STYLE}`;

/**
 * A failed Intake turn is LOUD on the server (issue #93, the same argument
 * issue #90 made for a failed Deliberation run). The user-facing failure card
 * is deliberately vague — "the draft didn't come back" is all it can honestly
 * say — so without this line, commissioning a live Intake means watching a
 * takeover fail with no server-side trace of why at all. The detail carries
 * both failure shapes: a session that could not start (OAuth, quota) and a
 * reply that did not match the contract.
 */
const logIntakeFailure =
  (phase: "open" | "turn" | "decode") =>
  (error: IntakeAgentError): Effect.Effect<void> =>
    Effect.sync(() => {
      // eslint-disable-next-line no-console
      console.error(`[repcoach-server] intake session failed (${phase}): ${error.detail}`);
    });

/**
 * The Intake turn payload's shape, read through the SAME extraction the two
 * cadence agents use (issue #94). Intake is the most exposed of the four —
 * EVERY turn must decode, so one malformed message in a long exchange used to
 * fail a conversation the user is sitting in front of.
 */
export const INTAKE_TURN_PAYLOAD_SHAPE = makeAgentPayloadShape({
  label: "intake reply",
  schema: IntakeAgentTurnPayload,
});

/**
 * Reads one coach turn, spending at most one repair turn ON THE SAME SESSION
 * when the message cannot be read (issue #94).
 *
 * Resuming the held-open session is strictly better than the one-shot agents'
 * fresh repair session: the model still has the whole exchange in front of it,
 * so "send that again as one object" costs a fraction of a turn and cannot
 * lose the draft it is re-emitting. It is also bounded twice over — one attempt
 * here, and the session's own kill guard around everything.
 */
const decodeReply = (
  result: AgentSdkSessionResult,
  repair: (instruction: string) => Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError>,
): Effect.Effect<IntakeAgentReply, IntakeAgentError> =>
  decodeAgentPayloadWithRepair({ shape: INTAKE_TURN_PAYLOAD_SHAPE, session: result, repair }).pipe(
    Effect.mapError((failure) => new IntakeAgentError({ detail: failure.detail })),
    Effect.map((decoded) => ({
      draftPlan: decoded.value.draftPlan,
      rationale: decoded.value.rationale,
      citations: decoded.value.citations,
      calibrationNote: decoded.value.calibrationNote,
      ...(decoded.value.openQuestion === undefined ? {} : { openQuestion: decoded.value.openQuestion }),
      usage: decoded.usage,
      costUsd: decoded.costUsd,
    })),
  );

/**
 * Bridges the SDK's callback-shaped tool reporting onto the runner's sink. The
 * adapter buffers nothing and phrases nothing: it forwards each call as it
 * happens, because the activity line's whole claim is that it reports real work
 * (ADR 0014 §4), and a buffered burst at the end would be a progress bar with
 * extra steps.
 */
const forwardToolCalls = (sink: IntakeToolEventSink) => (call: { readonly tool: string; readonly subject?: string }) => {
  Effect.runFork(sink.emit(call));
};

export const RealIntakeSessionAgent = (
  config: RealIntakeSessionAgentConfig = DEFAULT_REAL_INTAKE_SESSION_AGENT_CONFIG,
  /** What runs the session (issue #95) — see `agentTransport.ts`. */
  transport: AgentSdkTransport = LiveAgentSdkTransport,
): Layer.Layer<IntakeSessionAgent> =>
  Layer.effect(IntakeSessionAgent)(
    Effect.gen(function* () {
      // The live SDK sessions, keyed by the handle the runner holds. In memory
      // only, and deliberately so: ADR 0014 §8 has no persistence and no
      // resurrection, because a once-per-lifetime flow does not earn a recovery
      // subsystem it would exercise approximately once.
      const sessions = yield* Ref.make<ReadonlyMap<string, HeldAgentSdkSession>>(new Map());
      let nextKey = 0;

      return IntakeSessionAgent.of({
        open: ({ seed, model, effort, sink }) =>
          Effect.gen(function* () {
            const sessionKey = `intake-sdk-${(nextKey += 1)}`;
            const opened = yield* transport
              .openHeld({
                stage: "intake-session",
                prompt: seed + INTAKE_TURN_FORMAT_INSTRUCTION,
                config: withSessionOverrides(config, model, effort),
                allowedTools: ALLOWED_TOOLS,
                onToolCall: forwardToolCalls(sink),
              })
              .pipe(
                Effect.mapError((error) => new IntakeAgentError({ detail: error.message })),
                Effect.tapError(logIntakeFailure("open")),
              );

            const reply = yield* decodeReply(opened.first, opened.session.send).pipe(
              Effect.tapError(logIntakeFailure("decode")),
              // A cold draft that cannot be read is a dead session: there is no
              // partial plan worth keeping, and leaving the SDK session open
              // would hold subscription spend for a conversation nobody can
              // continue.
              Effect.tapError(() => opened.session.close),
            );

            yield* Ref.update(sessions, (map) => new Map(map).set(sessionKey, opened.session));
            return { handle: { sessionKey }, reply };
          }),

        send: ({ handle, answer, sink }) =>
          Effect.gen(function* () {
            const map = yield* Ref.get(sessions);
            const session = map.get(handle.sessionKey);
            if (session === undefined) {
              return yield* Effect.fail(
                new IntakeAgentError({ detail: `no live SDK session for ${handle.sessionKey}` }),
              );
            }
            // This turn's tool events reach the sink captured when the session
            // was opened — the runner hands one sink per Intake session, because
            // the activity line is a single accumulating list for the whole
            // takeover rather than one list per run. The parameter is part of
            // the port's shape (a scripted adapter has no open-time closure to
            // hold), so it is accepted and ignored here rather than dropped
            // from the interface.
            void sink;
            const result = yield* session
              .send(answer)
              .pipe(
                Effect.mapError((error) => new IntakeAgentError({ detail: error.message })),
                Effect.tapError(logIntakeFailure("turn")),
              );
            // A failed turn leaves the session alive: the draft on screen is the
            // valuable thing, and interim turns write nothing, so a no-op it is
            // (ADR 0014 §8). Issue #94 makes that stronger — a malformed reply
            // now buys one repair turn on this same session first, and even a
            // repair that fails leaves the exchange resumable rather than
            // ending it.
            return yield* decodeReply(result, session.send).pipe(Effect.tapError(logIntakeFailure("decode")));
          }),

        close: (handle) =>
          Effect.gen(function* () {
            const map = yield* Ref.get(sessions);
            const session = map.get(handle.sessionKey);
            yield* Ref.update(sessions, (m) => {
              const next = new Map(m);
              next.delete(handle.sessionKey);
              return next;
            });
            // Safe on an already-dead handle — close is the only lifecycle exit
            // and it is reached from convergence, abandonment AND a dropped
            // connection, so it must never be the thing that throws.
            if (session !== undefined) yield* session.close;
          }),
      });
    }),
  );
