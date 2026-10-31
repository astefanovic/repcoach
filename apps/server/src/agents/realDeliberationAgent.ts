import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DeliberationRunOutput } from "@repcoach/contracts";

import {
  withSessionOverrides,
  DEFAULT_AGENT_SDK_SESSION_CONFIG,
  DeliberationRunKilledError,
  DeliberationRunOutputParseError,
  decodeAgentPayloadWithRepair,
  defaultEmptyDecisionLists,
  dropNullValues,
  makeAgentPayloadShape,
  oneShotRepairTurn,
  sanitizeCatalogEnrichments,
  type AgentSdkSessionConfig,
} from "./agentSdkSession.ts";
import { LiveAgentSdkTransport, type AgentSdkTransport } from "./agentTransport.ts";
import { DeliberationAgent } from "./deliberationAgent.ts";
import { COACH_PROSE_STYLE } from "./coachProseStyle.ts";
import { PLAN_OPERATION_VOCABULARY } from "./planOperationVocabulary.ts";

/**
 * The real `DeliberationAgent` (ADR 0011 §1/§2, issue #27 — 2B slice 2): a
 * single Claude Agent SDK (programmatic Claude Code) session, given native
 * tools only (`Read`, `Bash`, `Grep`, `WebSearch`, `WebFetch`) and NO custom
 * MCP tools (ADR 0011 §2 — "Claude Code already ships Read/Bash/Grep/web
 * tools; custom tools add breakable surface area"). This IS the ADR 0005
 * thin call site: `run` takes the assembled seed string and nothing else,
 * and the runner never sees the SDK's message stream — only the final
 * parsed `DeliberationRunOutput`.
 *
 * This is the DELIBERATOR half of the two-agent run (ADR 0011 §1): its
 * output is a DRAFT, never committed directly. `DeliberationRunner.runNow`
 * (see `deliberationRunner.ts`) passes this agent's return value into a
 * SEPARATE `DeliberationSweepAgent` session (`realDeliberationSweepAgent.ts`,
 * issue #28 — 2B slice 3), and only the sweep's rewritten output is
 * committed. The two sessions share their max-turns/wall-clock kill
 * mechanics via `agentSdkSession.ts` but are otherwise independent Agent SDK
 * calls — the deliberator never sees the sweep's verdict (one-way, ADR 0011
 * §1).
 */

/** Tool names the deliberator session is allowed — no MCP tools (ADR 0011 §2). */
const ALLOWED_TOOLS = ["Read", "Bash", "Grep", "WebSearch", "WebFetch"] as const;

export type RealDeliberationAgentConfig = AgentSdkSessionConfig;

export const DEFAULT_REAL_DELIBERATION_AGENT_CONFIG: RealDeliberationAgentConfig = DEFAULT_AGENT_SDK_SESSION_CONFIG;

/**
 * The output-format instruction appended to every assembled seed for the real
 * agent.
 *
 * Exported because it is half of what a recorded cassette is a recording OF
 * (issue #95): a change here can invalidate every fixture reply that was
 * produced under the old wording, so `agentPromptFingerprint.ts` hashes it and
 * the replay refuses a cassette recorded against a different one.
 */
export const DELIBERATOR_OUTPUT_FORMAT_INSTRUCTION = `

## Required output format
When you are done reasoning and retrieving, your FINAL message must be ONLY a single JSON object
matching this shape (no prose before or after, no markdown fence):

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
}

Do not set id/status/created_at/origin on decisions — the runner assigns those. "surface" only matters for
"observation" kind decisions (whether it gets a coaching feed entry) — a "proposal" always surfaces.

The last three fields are your WORKING — what the user sees when they expand the decision to ask "how do you
know?". All three are OPTIONAL, and omitting one is always better than padding it:

- "measurements": the numbers this decision actually rests on, each already formatted for reading. "label" names
  the quantity ("e1RM, bench"), "series" shows how it moved ("142.5 -> 148.4 kg", "8, 8, 8, 8 of 8"), and "delta"
  is the change with its own sign and unit ("+4.1%", "4/4", "±0"). Include the measurements that did NOT move if
  they mattered to your judgment — evidence against your own conclusion is the most valuable thing here. Omit the
  field entirely if the decision rests on no measurement at all.
- "rule": the single named principle that fired, stated as a rule rather than as a description of this case
  ("Double progression — advance load once every working set reaches the top of the prescribed rep range"). If
  you were not applying a nameable rule, omit it rather than inventing a plausible-sounding one.
- "uncertainty": the concrete thing that would make this decision wrong, in a sentence the user could check
  against their own experience ("Your last session's second set dropped to 7 reps. If that repeats, this is
  early"). Not a hedge, not a disclaimer, and never a restatement of "I could be wrong" — name the specific
  observation that would overturn this. Omit it if you genuinely cannot name one.

A Proposal is a CHANGE to the Plan awaiting the user's approval, so "plan_operations" is what makes it a real
one: accepting the Proposal applies exactly those operations and nothing else. A Proposal whose summary says
"add a fourth working set" and whose operations say something else is a lie the user finds out about after
tapping Accept — the prose and the operations must describe the same change.
${PLAN_OPERATION_VOCABULARY}

Note: this is your DRAFT. A separate adversarial sweep will fetch and verify every citation you emit and may
strip citations it cannot confirm, downgrade trust levels, or rewrite a Proposal down to an Observation where
its evidence collapses. Cite honestly — do not inflate trust or invent sources, since unverifiable citations
will be stripped and their points degraded to "reasoning only, uncited" regardless.
${COACH_PROSE_STYLE}`;

/**
 * The run-output payload shape, shared with the sweep (issue #94): the same
 * contract, the same normalisation, the same extraction. The sweep rewrites
 * the deliberator's draft into this exact object, so a message shape one of
 * them tolerates and the other does not would fail runs on a coin flip.
 */
export const DELIBERATION_RUN_OUTPUT_SHAPE = makeAgentPayloadShape({
  label: "deliberation run output",
  schema: DeliberationRunOutput,
  normalize: (raw) => sanitizeCatalogEnrichments(defaultEmptyDecisionLists(dropNullValues(raw))),
});

/**
 * Builds the real `DeliberationAgent` layer: a single Agent SDK session per
 * `run` call, with the ADR 0011 §4 max-turns/wall-clock kill guard, parsing
 * the session's final JSON message against the `DeliberationRunOutput`
 * contract before handing it back to the runner (which then passes it to the
 * `DeliberationSweepAgent`, never committing it directly).
 */
export const RealDeliberationAgent = (
  config: RealDeliberationAgentConfig = DEFAULT_REAL_DELIBERATION_AGENT_CONFIG,
  /**
   * What actually runs the session (issue #95). Defaults to a live Agent SDK
   * session, so production and every existing caller are unchanged; a replay or
   * recording transport swaps only the network call, leaving the prompt built
   * above and the decode below exactly as production runs them.
   */
  transport: AgentSdkTransport = LiveAgentSdkTransport,
): Layer.Layer<DeliberationAgent> =>
  Layer.succeed(DeliberationAgent)({
    run: (assembledPrompt, model, effort) =>
      // ADR 0011 §4 / issue #31: the runner passes the cadence's configured
      // model (or `undefined`); it overrides this layer's default `config.model`
      // for THIS run only, so Session review and Cycle review run on their
      // separately-configured models through the same real deliberator layer.
      transport
        .run({
          stage: "deliberator",
          prompt: assembledPrompt + DELIBERATOR_OUTPUT_FORMAT_INSTRUCTION,
          config: withSessionOverrides(config, model, effort),
          allowedTools: ALLOWED_TOOLS,
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              // ADR 0011 §4: a killed run must be LOGGED, never silently dropped.
              // eslint-disable-next-line no-console
              console.error(`[repcoach-server] deliberation run killed: ${error.message}`);
            }),
          ),
          Effect.flatMap((session) =>
            // Issue #94: the extraction survives prose and fence variants for
            // free, and a message it still cannot read buys exactly ONE repair
            // turn (no tools, one turn, two minutes) before the run is failed.
            // The run being rescued did all the retrieval and all the reasoning;
            // throwing that away over how the answer was wrapped is the worst
            // trade in the pipeline.
            decodeAgentPayloadWithRepair({
              shape: DELIBERATION_RUN_OUTPUT_SHAPE,
              session,
              // The repair session goes through the SAME transport (issue #95),
              // so a replayed run's repair comes from a cassette rather than
              // quietly opening a live session at the least visible moment in
              // the pipeline.
              repair: oneShotRepairTurn(
                withSessionOverrides(config, model, effort),
                session.text,
                (prompt, repairConfig, allowedTools) =>
                  transport.run({ stage: "deliberator", prompt, config: repairConfig, allowedTools }),
              ),
            }).pipe(
              Effect.mapError(
                (failure) =>
                  new DeliberationRunOutputParseError({ reason: failure.reason, detail: failure.detail }),
              ),
              Effect.tapError((error) =>
                Effect.sync(() => {
                  // eslint-disable-next-line no-console
                  console.error(`[repcoach-server] deliberation output unrecoverable: ${error.message}`);
                }),
              ),
              // Pair the parsed output with the SDK's usage counts (issue #32)
              // and cost (issue #81 — the run ledger stores it, per-run). Both
              // already include the repair turn's spend when there was one.
              Effect.map((decoded) => ({
                output: decoded.value,
                usage: decoded.usage,
                costUsd: decoded.costUsd,
              })),
            ),
          ),
          // The real agent's failure modes (killed run, unparseable output) are
          // not part of `DeliberationAgent.run`'s declared error channel
          // (`Effect.Effect<DeliberationRunOutput>`, no `E`) — surfacing them
          // as defects here (rather than silently downgrading them) keeps a
          // failed real run loud (ADR 0011 §4 "logged, never left spending
          // indefinitely") without widening the interface every consumer
          // (including the canned agent, and every slice-1 test) has to
          // handle.
          Effect.orDie,
        ),
  });

export { DeliberationRunKilledError, DeliberationRunOutputParseError };
