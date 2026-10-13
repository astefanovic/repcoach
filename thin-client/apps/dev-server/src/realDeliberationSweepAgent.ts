import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type DeliberationRunOutput, type EvidenceClaim } from "@repcoach/contracts";

import {
  withSessionOverrides,
  DEFAULT_AGENT_SDK_SESSION_CONFIG,
  DeliberationRunOutputParseError,
  decodeAgentPayloadWithRepair,
  oneShotRepairTurn,
  sanitizeCatalogEnrichments,
  type AgentSdkSessionConfig,
} from "./agentSdkSession.ts";
import { LiveAgentSdkTransport, type AgentSdkTransport } from "./agentTransport.ts";
import { DeliberationSweepAgent } from "./deliberationSweepAgent.ts";
import { DELIBERATION_RUN_OUTPUT_SHAPE } from "./realDeliberationAgent.ts";
import { renderEvidenceRoster } from "./seedContext.ts";

/**
 * The real `DeliberationSweepAgent` (ADR 0011 §1/§6, issue #28 — 2B slice
 * 3): a SECOND, SEPARATE Claude Agent SDK session from the deliberator
 * (`realDeliberationAgent.ts`) — same kill-guard mechanics
 * (`agentSdkSession.ts`), same "final JSON message" output contract, but a
 * different job and a different prompt. It is handed the deliberator's
 * drafted `DeliberationRunOutput` (serialized into the prompt, not passed as
 * a live object the model could ignore) and native tools to fetch and READ
 * each cited source — `WebFetch` for URLs, `Read` for anything resolvable
 * locally — to check claim-**support**, not merely that the URL resolves.
 *
 * It has one-way, final authority (ADR 0011 §1): it rewrites the draft in
 * place and returns the FINAL `DeliberationRunOutput`. There is no loop back
 * to the deliberator — `DeliberationRunner.runNow` commits exactly what this
 * agent returns, never the draft it was given (ADR 0011 §6).
 */

/**
 * Tool names the sweep session is allowed. `WebFetch` is the claim-support
 * verification tool (fetch the cited URL and read its content against the
 * claim); `Read`/`Grep` let it cross-check anything resolvable as a local
 * file (e.g. a corpus document already on disk); no `Bash`/`WebSearch` — the
 * sweep verifies specific cited sources, it does not go discover new ones
 * (that is the deliberator's job). No custom MCP tools (ADR 0011 §2).
 */
const ALLOWED_TOOLS = ["Read", "Grep", "WebFetch"] as const;

export type RealDeliberationSweepAgentConfig = AgentSdkSessionConfig;

export const DEFAULT_REAL_DELIBERATION_SWEEP_AGENT_CONFIG: RealDeliberationSweepAgentConfig =
  DEFAULT_AGENT_SDK_SESSION_CONFIG;

/**
 * Builds the sweep session's prompt: the drafted output as JSON, plus the
 * ADR 0011/issue #28 instructions for what a claim-support pass must do, plus
 * the same "final message is ONLY the JSON object" output contract the
 * deliberator uses (so the runner can parse both sessions' results the same
 * way).
 */
export const buildSweepPrompt = (
  draft: DeliberationRunOutput,
  evidenceRoster: ReadonlyArray<EvidenceClaim>,
): string => `
You are the ADVERSARIAL SWEEP over a Deliberation run's DRAFT output. A separate deliberator agent produced the
draft below. Your job is claim-support verification, not a rubber stamp: for EVERY citation in the draft, fetch
and read the cited source (\`source_url\`) and judge whether its content actually SUPPORTS the claim text — a URL
that merely resolves is not enough.

## Evidence-base roster (corpus-verified claims, ADR 0003 §5)
This is the SAME roster the deliberator was seeded with — check every citation against it below.
${renderEvidenceRoster(evidenceRoster)}

Apply these rules, ONE-WAY (there is no negotiation back to the deliberator — you have final authority):
- If a citation's URL does not resolve, or its content does not support the claim, STRIP the citation from the
  decision and move its claim text into that decision's \`reasoning_only_points\` as a "reasoning only, uncited"
  point. Never fabricate a replacement source.
- The source bar (ADR 0003 §3) applies independently of claim support: STRIP a citation whose source is not
  scientific — PubMed, a meta-analysis/systematic review, or a reputable evidence-based practitioner — even when
  its content resolves and genuinely supports the claim. An open-web blog or forum post never clears this bar.
  This bar does not apply to a citation that matches an entry in the Evidence-base roster above (a seed entry
  already passed human vetting, ADR 0003 §4).
- A citation may only ship with \`trust: "corpus-verified"\` if it matches an entry in the Evidence-base roster
  above (if you cannot confirm a citation against the roster, downgrade it to \`"retrieved-unverified"\` rather
  than assume it is corpus-backed). For a citation that DOES match the roster, your fetch-and-read check is
  satisfied at ABSTRACT LEVEL (ADR 0003 §2/Consequences): roster claims are broad, settled principles, and a
  paywalled source is not to be stripped for being unreadable past its abstract or conclusion — read what is
  openly available and judge support at that level. This is a DELIBERATE asymmetry: a citation that does NOT
  match the roster gets the full fetch-and-read scrutiny below, with no abstract-level leniency — \`retrieved-
  unverified\` is only honest once you have actually fetched and read the source in full and confirmed it
  supports the claim; if you could not do that, strip the citation entirely per the rule above.
- If, after stripping, a "proposal" decision's \`citations\` array is empty (its evidentiary basis has fully
  collapsed), REWRITE that decision's \`kind\` to \`"observation"\`. An "observation" decision with no citations is
  fine as-is (reasoning-only observations are allowed).
- Leave \`summary\`/\`rationale\`/\`surface\`/\`observation_directives\` untouched unless a decision's \`kind\` changes
  per the rule above — you are verifying citations, not re-drafting the run's judgment calls.
- The same applies to \`measurements\`/\`rule\`/\`uncertainty\` — the decision's WORKING. Echo them back exactly as
  they appear in the draft, including omitting the ones the draft omitted. They are not citations and are not
  yours to verify, strip or improve; a field you drop here disappears from what the user is shown, so dropping
  one silently removes evidence rather than removing a claim.
- \`plan_operations\` — the PRESCRIPTION, the actual change accepting the Proposal applies to the user's training
  Plan. Echo it back BYTE-FOR-BYTE, including omitting it where the draft omitted it. You govern the
  justification, never the prescription: you may collapse a Proposal to an Observation when its evidence
  collapses (in which case drop \`plan_operations\` with it, since an Observation applies nothing), but you may
  never edit, reorder, trim, "fix" or invent an operation. The user accepts what they were shown; a load you
  quietly adjusted here is a change nobody proposed and nobody reviewed.
- \`catalog_exercises\` — the Exercise catalog rows those operations need created before they can apply (ADR
  0016). Echo it back BYTE-FOR-BYTE too, and by the same rule: drop it only when you collapse its Proposal to
  an Observation, since an Observation applies nothing. Dropping it while keeping the operations is the one
  edit here that BREAKS the Proposal outright — an \`addEntry\` naming a row nobody created is rejected, and the
  user's Accept fails on a Proposal that was fine when it was drafted.

## Draft to sweep
${JSON.stringify(draft, null, 2)}

## Required output format
When you are done fetching and verifying, your FINAL message must be ONLY a single JSON object matching this
EXACT shape (no prose before or after, no markdown fence) — the same contract as the draft above, after your
rewrites:

{
  "decisions": [
    {
      "kind": "observation" | "proposal",
      "summary": "...",
      "rationale": "...",
      "citations": [ { "claim": "...", "source_url": "...", "trust": "corpus-verified" | "retrieved-unverified" } ],
      "reasoning_only_points": ["..."],
      "surface": true | false,
      "measurements": [ { "label": "...", "series": "...", "delta": "..." } ],
      "rule": "...",
      "uncertainty": "...",
      "plan_operations": [ { "_tag": "...", ... } ],
      "catalog_exercises": [ { "exercise_id": "...", "name": "...", "tracked_metrics": ["reps", "load"] } ]
    }
  ],
  "observation_directives": [ { "id": "<existing observation decision id>", "action": "escalate" | "close" } ]
}`;

/**
 * Builds the real `DeliberationSweepAgent` layer: one Agent SDK session per
 * `run` call (given the deliberator's draft), with the same max-turns/
 * wall-clock kill guard as the deliberator, parsing the session's final JSON
 * message against the `DeliberationRunOutput` contract before handing it
 * back to the runner as the FINAL output to commit.
 */
export const RealDeliberationSweepAgent = (
  config: RealDeliberationSweepAgentConfig = DEFAULT_REAL_DELIBERATION_SWEEP_AGENT_CONFIG,
  /** What runs the session (issue #95) — see `agentTransport.ts`. */
  transport: AgentSdkTransport = LiveAgentSdkTransport,
): Layer.Layer<DeliberationSweepAgent> =>
  Layer.succeed(DeliberationSweepAgent)({
    run: (draft, evidenceRoster, model, effort) =>
      transport
        .run({
          stage: "sweep",
          prompt: buildSweepPrompt(draft, evidenceRoster),
          config: withSessionOverrides(config, model, effort),
          allowedTools: ALLOWED_TOOLS,
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              // ADR 0011 §4: a killed run must be LOGGED, never silently dropped.
              // The sweep is never skipped to save budget (issue #28 acceptance
              // criterion) — a killed sweep is a run failure, not a fallback to
              // committing the unverified draft.
              // eslint-disable-next-line no-console
              console.error(`[repcoach-server] adversarial sweep killed: ${error.message}`);
            }),
          ),
          Effect.flatMap((session) =>
            // The sweep is never told about `catalog_enrichments` (#104) — it
            // verifies citations, and an enrichment carries none — so it normally
            // returns none and the runner reads them off the deliberator's draft
            // instead. The shared shape sanitises them anyway, for the sweep that
            // echoes the draft's field back verbatim: a malformed echo must not
            // fail a run whose sweep otherwise succeeded.
            // Issue #94: the SAME extraction, normalisation and single repair
            // turn as the deliberator, through the same shared shape. The sweep
            // is the one whose output gets committed, so being even slightly
            // less tolerant here would mean a run the deliberator survived dying
            // at the last step.
            decodeAgentPayloadWithRepair({
              shape: DELIBERATION_RUN_OUTPUT_SHAPE,
              session,
              // Through the same transport as the session it is repairing
              // (issue #95) — see the deliberator for why.
              repair: oneShotRepairTurn(
                withSessionOverrides(config, model, effort),
                session.text,
                (prompt, repairConfig, allowedTools) =>
                  transport.run({ stage: "sweep", prompt, config: repairConfig, allowedTools }),
              ),
            }).pipe(
              Effect.mapError(
                (failure) =>
                  new DeliberationRunOutputParseError({
                    reason: failure.reason,
                    detail: `sweep output: ${failure.detail}`,
                  }),
              ),
              Effect.tapError((error) =>
                Effect.sync(() => {
                  // A sweep that cannot be read fails the run — it never falls
                  // back to committing the unverified draft, which would defeat
                  // the entire trust floor this agent exists to enforce.
                  // eslint-disable-next-line no-console
                  console.error(`[repcoach-server] sweep output unrecoverable: ${error.message}`);
                }),
              ),
              // Pair the parsed FINAL output with the SDK's usage counts AND
              // cost for THIS session (issue #81 bug fix — the sweep used to
              // report no usage at all, so its cost was invisible to the run
              // ledger; ADR 0011 §8 is explicit the sweep is a permanent,
              // non-trivial share of every run's cost), repair turn included.
              Effect.map((decoded) => ({
                output: decoded.value,
                usage: decoded.usage,
                costUsd: decoded.costUsd,
              })),
            ),
          ),
          // Same rationale as the deliberator (see realDeliberationAgent.ts):
          // a killed/unparseable sweep surfaces as a defect rather than
          // silently falling back to the unverified draft, which would defeat
          // the entire trust floor this agent exists to enforce.
          Effect.orDie,
        ),
  });
