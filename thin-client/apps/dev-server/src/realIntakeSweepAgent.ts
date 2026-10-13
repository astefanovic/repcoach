import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  IntakeCitationVerdict,
  IntakeRationaleLine,
  type EvidenceClaim,
  type IntakeProvisionalCitation,
  type IntakeVerifiedCitation,
} from "@repcoach/contracts";

import {
  withSessionOverrides,
  DEFAULT_AGENT_SDK_SESSION_CONFIG,
  decodeAgentPayloadWithRepair,
  makeAgentPayloadShape,
  oneShotRepairTurn,
  type AgentSdkSessionConfig,
} from "./agentSdkSession.ts";
import { LiveAgentSdkTransport, type AgentSdkTransport } from "./agentTransport.ts";
import { IntakeAgentError } from "./intakeSessionAgent.ts";
import { IntakeSweepAgent, type IntakeSweepResult } from "./intakeSweepAgent.ts";
import { renderEvidenceRoster } from "./seedContext.ts";

/**
 * The real Intake sweep (ADR 0014 §5): one Agent SDK session, fired ONCE at
 * convergence, doing the same claim-support verification as
 * `realDeliberationSweepAgent.ts` but returning a **verdict per citation**
 * rather than a rewritten run output.
 *
 * The verdicts exist because ADR 0014 §5 requires the card to disclose its own
 * edits — "two sources didn't hold up and were removed" is the feature working
 * in public, on the exact surface where a first-time user decides whether to
 * trust any of this. A sweep that only returned the surviving citations would
 * make that disclosure unbuildable, and the user would silently lose the source
 * that convinced them.
 *
 * It is handed the plan for context and cannot return one: the prescription the
 * user converged on is not the sweep's to rewrite (§5).
 */

/** Same tool surface as the ordinary sweep: verify cited sources, do not go discover new ones. */
const ALLOWED_TOOLS = ["Read", "Grep", "WebFetch"] as const;

export type RealIntakeSweepAgentConfig = AgentSdkSessionConfig;

export const DEFAULT_REAL_INTAKE_SWEEP_AGENT_CONFIG: RealIntakeSweepAgentConfig =
  DEFAULT_AGENT_SDK_SESSION_CONFIG;

const IntakeSweepPayload = Schema.Struct({
  verdicts: Schema.Array(IntakeCitationVerdict),
  rationale: Schema.Array(IntakeRationaleLine),
});

/**
 * The sweep verdict payload's shape, read through the same shared extraction
 * as the other three agents (issue #94). This one is fired once, at the moment
 * the user asked to review the sources, after an entire exchange — the single
 * most expensive message in the app to throw away over its wrapping.
 */
export const INTAKE_SWEEP_PAYLOAD_SHAPE = makeAgentPayloadShape({
  label: "intake sweep output",
  schema: IntakeSweepPayload,
});

// Exported for the cassette fingerprint (issue #95): this prompt is the static
// half of what a recorded intake-sweep reply is an answer to.
export const buildIntakeSweepPrompt = (params: {
  readonly planJson: string;
  readonly rationaleJson: string;
  readonly citationsJson: string;
  readonly evidenceRoster: ReadonlyArray<EvidenceClaim>;
}): string => `
You are the single ADVERSARIAL SWEEP over a first training Plan a user has just finished shaping with the coach.
This runs exactly once, at the moment the user asked to "review the sources", and its output is what they will be
shown and asked to accept. There is no second pass and no loop back to the coach.

Your job is claim-support verification, not a rubber stamp: for EVERY citation below, fetch and read the cited
source and judge whether its content actually SUPPORTS the claim text. A URL that merely resolves is not enough.

## Evidence-base roster (corpus-verified claims, ADR 0003 §5)
This is the SAME roster the coach's Intake seed carried — check every citation against it below.
${renderEvidenceRoster(params.evidenceRoster)}

Before judging support, first check the source bar (ADR 0003 §3): scientific only — PubMed, a meta-analysis/
systematic review, or a reputable evidence-based practitioner. An open-web blog or forum post fails this bar
regardless of whether it appears to support the claim, and gets "removed" with that stated as the "why". This bar
does not apply to a citation that matches an entry in the Evidence-base roster above (a seed entry already passed
human vetting, ADR 0003 §4).

## The prescription (context — you must NOT change it)

${params.planJson}

The sets, reps and loads above are what the user converged on over the exchange. They are not yours to rewrite.
You govern the justification only.

## The justification

${params.rationaleJson}

## The citations to verify

${params.citationsJson}

## What to return

Rule one and only one verdict per citation, in the SAME ORDER as the list above:

- "corpus-verified" — the citation matches an entry in the Evidence-base roster above and supports the claim. For
  a roster match, your fetch-and-read check is satisfied at ABSTRACT LEVEL (ADR 0003 §2/Consequences): roster
  claims are broad, settled principles, and a paywalled source is not "removed" for being unreadable past its
  abstract or conclusion — read what is openly available and judge support at that level. Never award this
  outcome to a citation that does not match the roster, no matter how strong its support looks.
- "retrieved-unverified" — the source was retrieved (it does NOT match the roster), and you fetched and read it
  IN FULL and confirmed it supports the claim and clears the source bar. This is a DELIBERATE asymmetry with
  corpus-verified above: a non-roster citation gets full scrutiny, with no abstract-level leniency.
- "removed" — the source does not support the claim, does not exist, traces only to itself, fails the source bar
  above, or (for a non-roster citation) you could not fetch and read it in full. Removals MUST state "why" in one
  plain sentence: a disclosure without the reason is worthless to the person reading it.

Then return the rewritten justification. A rationale line whose citation you removed **stays** — drop its
"citationId" so it reads as reasoning-only, uncited. Never delete the line and never invent a replacement
source: degrading to uncited is honest, and quietly shrinking the plan's reasoning is not.

## Required output format
Your FINAL message must be ONLY a single JSON object, no prose and no markdown fence:

{
  "verdicts": [
    { "citationId": "c1", "claim": "...", "source_url": "...", "outcome": "corpus-verified" },
    { "citationId": "c2", "claim": "...", "source_url": "...", "outcome": "removed", "why": "..." }
  ],
  "rationale": [ { "text": "...", "citationId": "c1" }, { "text": "..." } ]
}`;

export const RealIntakeSweepAgent = (
  config: RealIntakeSweepAgentConfig = DEFAULT_REAL_INTAKE_SWEEP_AGENT_CONFIG,
  /** What runs the session (issue #95) — see `agentTransport.ts`. */
  transport: AgentSdkTransport = LiveAgentSdkTransport,
): Layer.Layer<IntakeSweepAgent> =>
  Layer.succeed(IntakeSweepAgent)({
    run: ({ draftPlan, rationale, citations, evidenceRoster, sink, model, effort }) =>
      Effect.gen(function* () {
        // The wait is the most trust-building moment the app has, so it is
        // narrated from the real work: one event per citation, in verdict order,
        // before the session starts. The client derives "source 3 of 5" from the
        // citations it already holds — ordinals are its job, ordering is ours.
        yield* sink.emit({ tool: "collect_claims", subject: `${citations.length}` });
        yield* Effect.forEach(
          citations,
          (citation) => sink.emit({ tool: "verify_citation", subject: citation.source_url }),
          { discard: true },
        );

        const session = yield* transport
          .run({
            stage: "intake-sweep",
            // A killed or failed sweep session is a TYPED failure here, not a
            // defect: ADR 0014 §8 gives the user a retry and leaves them able to
            // keep tweaking, so the runner has to be able to see it.
            prompt: buildIntakeSweepPrompt({
              planJson: JSON.stringify(draftPlan, null, 2),
              rationaleJson: JSON.stringify(rationale, null, 2),
              citationsJson: JSON.stringify(citations, null, 2),
              evidenceRoster,
            }),
            config: withSessionOverrides(config, model, effort),
            allowedTools: ALLOWED_TOOLS,
          })
          .pipe(Effect.mapError((error) => new IntakeAgentError({ detail: error.message })));

        yield* sink.emit({ tool: "rewrite_rationale" });

        const decoded = yield* decodeAgentPayloadWithRepair({
          shape: INTAKE_SWEEP_PAYLOAD_SHAPE,
          session,
          // Through the same transport as the session it is repairing (issue
          // #95): a replayed convergence must not open a live session at the
          // one moment the user is waiting on it.
          repair: oneShotRepairTurn(
            withSessionOverrides(config, model, effort),
            session.text,
            (prompt, repairConfig, allowedTools) =>
              transport.run({ stage: "intake-sweep", prompt, config: repairConfig, allowedTools }),
          ),
        }).pipe(Effect.mapError((failure) => new IntakeAgentError({ detail: failure.detail })));
        const payload = decoded.value;

        // Trust is derived from the verdicts rather than taken from a second
        // field the model could contradict itself on: what survives, and with
        // which badge, is one fact.
        const byId = new Map<string, IntakeProvisionalCitation>(citations.map((c) => [c.id, c]));
        const verified: Array<IntakeVerifiedCitation> = [];
        for (const verdict of payload.verdicts) {
          if (verdict.outcome === "removed") continue;
          const citation = byId.get(verdict.citationId);
          if (citation === undefined) continue;
          verified.push({ ...citation, trust: verdict.outcome });
        }

        const result: IntakeSweepResult = {
          rationale: payload.rationale,
          citations: verified,
          verdicts: payload.verdicts,
          // Both already include the repair turn's spend when there was one
          // (issue #94) — a rescue that hides its own cost is the one bug the
          // ledger exists to catch.
          usage: decoded.usage,
          costUsd: decoded.costUsd,
        };
        return result;
      }),
  });
