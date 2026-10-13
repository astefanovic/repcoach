import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ZERO_TOKEN_USAGE,
  type DeliberationEffort,
  type DeliberationRunOutput,
  type EvidenceClaim,
  type TokenUsage,
} from "@repcoach/contracts";

import type { DeliberationRunFailure } from "./agentSdkSession.ts";

/**
 * The sweep's own result: the final output PLUS this session's token usage
 * (issue #81 bug fix — the sweep used to return output with no usage at all,
 * so a permanent, non-trivial share of every run's cost — the sweep is never
 * skipped, ADR 0011 §8 — was invisible to the run ledger). Mirrors
 * `AgentRunResult` (`deliberationAgent.ts`) deliberately: the two agents in a
 * run report the same shape so the runner's ledger write-through does not
 * need two cases.
 */
export interface SweepRunResult {
  readonly output: DeliberationRunOutput;
  readonly usage: TokenUsage;
  /** The SDK's own `total_cost_usd` for this session (issue #81) — stored on the run ledger, never rendered. */
  readonly costUsd: number;
}

/**
 * The one-way adversarial sweep boundary (ADR 0011 §1/§6, issue #28 — 2B
 * slice 3): takes the deliberator's DRAFTED `DeliberationRunOutput` and
 * returns the FINAL `DeliberationRunOutput` the runner commits. This is a
 * SEPARATE agent from `DeliberationAgent` (the deliberator) — mirroring how
 * that boundary is structured (a `Context.Service` with one `run` method, a
 * canned stand-in for tests, and a real Agent SDK implementation) but with a
 * different signature: it consumes a draft rather than a prompt string,
 * because its job is to fetch-and-verify each cited source and rewrite the
 * draft in place, not to originate reasoning from a seed.
 *
 * The sweep has FINAL, ONE-WAY authority (ADR 0011 §1): there is no
 * negotiation loop back to the deliberator. Its output IS the committed
 * Decision — `DeliberationRunner.runNow` parses and commits ONLY what the
 * sweep returns, never the deliberator's draft (ADR 0011 §6, "the
 * adversarial agent's output is the committed Decision"). The sweep is
 * ALWAYS invoked; a run that cannot afford it defers entirely (a later
 * slice), it never skips the sweep to ship the raw draft.
 *
 * `run` also takes the Evidence-base roster (issue #92): the sweep is a
 * brand-new Agent SDK session with no access to the deliberator's own seed
 * context, so it cannot check a citation against the roster unless the
 * caller hands it over explicitly — the roster is the SAME
 * `SeedInputs.evidenceRoster` the deliberator itself was seeded with (ADR
 * 0003 §5), not a second, possibly-drifted copy.
 */
export class DeliberationSweepAgent extends Context.Service<
  DeliberationSweepAgent,
  {
    /**
     * `model`/`effort` are the SAME per-cadence pair the deliberator was given
     * (issue #81). The sweep used to take neither and silently ran on the SDK
     * default while the run ledger recorded its row under the cadence's
     * configured model — a spend row attributed to a model that never ran it.
     * Both halves are threaded now, so the ledger's `model` column is true of
     * every stage it names.
     */
    readonly run: (
      draft: DeliberationRunOutput,
      evidenceRoster: ReadonlyArray<EvidenceClaim>,
      model?: string,
      effort?: DeliberationEffort,
    ) => Effect.Effect<SweepRunResult, DeliberationRunFailure>;
  }
>()("@repcoach/dev-server/DeliberationSweepAgent") {}

/**
 * The canned `DeliberationSweepAgent`: a deterministic, fixed transformation
 * proving the runner-level wiring (issue #28's unit-testable surface — the
 * live claim-support verification itself is UAT/e2e, not unit-tested) without
 * a live Agent SDK session. Given ANY draft, it demonstrates all three sweep
 * behaviours the acceptance criteria name:
 *
 * - strips the FIRST citation off the FIRST decision that has one, and moves
 *   the stripped citation's `claim` into that decision's
 *   `reasoning_only_points` ("degrade to uncited, never fabricate");
 * - downgrades every remaining `corpus-verified` citation to
 *   `retrieved-unverified` UNLESS its `source_url` is in the tiny
 *   allow-listed set below (stands in for "matches the injected roster");
 * - rewrites the FIRST `proposal` decision whose citations end up empty
 *   after the strip/downgrade pass down to an `observation` (its evidentiary
 *   basis "collapsed").
 *
 * This is intentionally simple/fixed — the point is to prove
 * `DeliberationRunner` commits the SWEEP's output rather than the
 * deliberator's draft, not to model real claim-support verification (that is
 * the real agent's job, verified in e2e/UAT).
 */
const CANNED_SWEEP_VERIFIED_SOURCES: ReadonlySet<string> = new Set(["https://example.com/corpus/verified-claim"]);

export const cannedSweepTransform = (draft: DeliberationRunOutput): DeliberationRunOutput => {
  let strippedOneCitation = false;

  const sweptDecisions = draft.decisions.map((decision) => {
    let citations = decision.citations;
    let reasoningOnlyPoints = decision.reasoning_only_points;

    if (!strippedOneCitation && citations.length > 0) {
      const stripped = citations[0];
      const rest = citations.slice(1);
      strippedOneCitation = true;
      citations = rest;
      if (stripped !== undefined) {
        reasoningOnlyPoints = [...reasoningOnlyPoints, stripped.claim];
      }
    }

    citations = citations.map((citation) =>
      citation.trust === "corpus-verified" && !CANNED_SWEEP_VERIFIED_SOURCES.has(citation.source_url)
        ? { ...citation, trust: "retrieved-unverified" as const }
        : citation,
    );

    return { ...decision, citations, reasoning_only_points: reasoningOnlyPoints };
  });

  let rewroteOneProposal = false;
  const finalDecisions = sweptDecisions.map((decision) => {
    if (!rewroteOneProposal && decision.kind === "proposal" && decision.citations.length === 0) {
      rewroteOneProposal = true;
      // The collapse takes the proposed Change with it (#86): an Observation
      // applies nothing, so operations left attached would be a prescription
      // nothing could ever act on. Note what does NOT happen anywhere else in
      // this transform — `plan_operations` is spread through untouched. ADR
      // 0014 §5: the sweep governs the justification, never the prescription.
      const { plan_operations: _dropped, ...rest } = decision;
      return { ...rest, kind: "observation" as const };
    }
    return decision;
  });

  return { ...draft, decisions: finalDecisions };
};

/**
 * The walking-skeleton stand-in for the real adversarial sweep: applies
 * `cannedSweepTransform` to whatever draft `DeliberationRunner` hands it —
 * unlike `CannedDeliberationAgent` (which ignores its input entirely), this
 * one is a genuine function of its input so tests can assert the runner
 * commits a TRANSFORMED draft, not a fixed constant.
 */
export const CannedDeliberationSweepAgent: Layer.Layer<DeliberationSweepAgent> = Layer.succeed(
  DeliberationSweepAgent,
)({
  // The canned transform's allow-listed source stands in for "matches the
  // injected roster" already (see `CANNED_SWEEP_VERIFIED_SOURCES` above), so
  // the real roster is accepted for signature parity with the real agent but
  // not consulted here — this stand-in is about proving the runner commits
  // the sweep's output, not about modelling roster-matching.
  run: (draft, _evidenceRoster, _model, _effort) =>
    Effect.succeed({ output: cannedSweepTransform(draft), usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
});
