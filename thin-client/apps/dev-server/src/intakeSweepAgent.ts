import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  DeliberationEffort,
  EvidenceClaim,
  IntakeCitationVerdict,
  IntakeDraftPlan,
  IntakeProvisionalCitation,
  IntakeRationaleLine,
  IntakeVerifiedCitation,
  TokenUsage,
} from "@repcoach/contracts";

import type { IntakeAgentError, IntakeToolEventSink } from "./intakeSessionAgent.ts";

/**
 * The Intake-shaped adversarial sweep (ADR 0011 §1/§6 as amended by ADR 0014
 * §5): fired **exactly once**, at convergence, over the final plan and every
 * citation it accumulated.
 *
 * A separate port from `DeliberationSweepAgent` rather than a widening of it,
 * for two reasons. First, the fire-and-forget cadences sweep a
 * `DeliberationRunOutput` and are untouched by this ticket. Second, and more
 * usefully: this signature **cannot rewrite the prescription**. It is handed the
 * plan for context but returns only a justification — rationale, citations and
 * verdicts — so ADR 0014 §5's "the sweep governs the justification, never the
 * prescription" is enforced by the type rather than by a code review noticing.
 * The sets and reps the user converged on are not reachable from here.
 *
 * Why once, at convergence, rather than per turn: verification of nothing,
 * repeatedly, against a subscription quota. And why *before* Accept rather than
 * behind it: under ADR 0011 the sweep's output IS the committed Decision, so it
 * has to be the thing the user is shown — putting it behind Accept would have
 * them agree to a plan and then have its rationale rewritten underneath,
 * possibly stripping the very source that convinced them.
 */

export interface IntakeSweepResult {
  /** The rewritten justification — lines whose source did not hold survive, uncited. */
  readonly rationale: ReadonlyArray<IntakeRationaleLine>;
  /** What held, badge-bearing (ADR 0014 §5). */
  readonly citations: ReadonlyArray<IntakeVerifiedCitation>;
  /**
   * One verdict per citation the swept plan carried, held ones included — the
   * disclosure the card renders. In the SAME order the sweep emitted its tool
   * events, so "checking source 3 of 5" can never name a number the card then
   * contradicts.
   */
  readonly verdicts: ReadonlyArray<IntakeCitationVerdict>;
  readonly usage: TokenUsage;
  /** The SDK's own `total_cost_usd` for the convergence sweep (issue #81) — stored on the run ledger, never rendered. */
  readonly costUsd: number;
}

export class IntakeSweepAgent extends Context.Service<
  IntakeSweepAgent,
  {
    readonly run: (params: {
      /** Context only — the sweep cannot return a plan, so it cannot change one. */
      readonly draftPlan: IntakeDraftPlan;
      readonly rationale: ReadonlyArray<IntakeRationaleLine>;
      /**
       * The citations THIS plan accumulated — scoped by the caller, not the
       * session's running set. Converging straight off the cold draft is
       * legitimate (the coach's questions are optional and an impatient
       * first-time user taps through), and a sweep over the fully-argued
       * citation set would then disclose removing sources the user never saw.
       */
      readonly citations: ReadonlyArray<IntakeProvisionalCitation>;
      /**
       * The SAME Evidence-base roster the deliberator's Intake seed carried
       * (ADR 0003 §5, issue #92) — this session never saw that seed, so
       * without this it could never confirm a citation against the roster.
       */
      readonly evidenceRoster: ReadonlyArray<EvidenceClaim>;
      readonly sink: IntakeToolEventSink;
      readonly model?: string;
      /** Per-cadence reasoning effort for the Intake cadence (issue #81) — the other half of `model`. */
      readonly effort?: DeliberationEffort;
    }) => Effect.Effect<IntakeSweepResult, IntakeAgentError>;
  }
>()("@repcoach/dev-server/IntakeSweepAgent") {}

/** Stands in for "matches the injected Evidence-base roster" (ADR 0003 §5). */
const CANNED_CORPUS: ReadonlySet<string> = new Set([
  "https://example.com/corpus/verified-claim",
  "https://example.com/corpus/frequency-meta-analysis",
]);

/**
 * The canned Intake sweep: a deterministic function of its input, so a test can
 * assert the runner commits the SWEEP's justification rather than the
 * deliberator's draft. It demonstrates all three outcomes ADR 0014 §5 names:
 *
 * - a source in the corpus is `corpus-verified`;
 * - a source that traces to a blog post is **removed**, with the reason stated —
 *   a disclosure without the reason is worthless;
 * - anything else survives as `retrieved-unverified`.
 *
 * A removed citation's rationale line **stays**, stripped of its citation:
 * "degrade to uncited, never fabricate" (ADR 0011 §1). Deleting the line would
 * quietly shrink the plan's reasoning; keeping it uncited is the honest version,
 * and it is what lets the card say which points are now reasoning-only.
 *
 * One tool event is emitted per citation, immediately before its verdict, so the
 * emission order and the verdict order are the same list by construction rather
 * than by two functions agreeing.
 *
 * Note what the canned sweep never does: **fail**. A sweep that guts every
 * citation still returns a result, because ADR 0014 §8 is explicit that a gutted
 * plan is the machinery working — thinner rationale, prescription intact, still
 * acceptable. The port's error channel is for a sweep that could not RUN, which
 * is the case where no Proposal may be offered at all.
 */
export const CannedIntakeSweepAgent: Layer.Layer<IntakeSweepAgent> = Layer.succeed(IntakeSweepAgent)({
  // `evidenceRoster` is accepted for signature parity with the real agent
  // (issue #92) but not consulted — `CANNED_CORPUS` above already stands in
  // for "matches the injected roster" for this deterministic test double.
  run: ({ rationale, citations, evidenceRoster: _evidenceRoster, sink }) =>
    Effect.gen(function* () {
      yield* sink.emit({ tool: "collect_claims", subject: `${citations.length}` });

      const verdicts: Array<IntakeCitationVerdict> = [];
      const verified: Array<IntakeVerifiedCitation> = [];

      for (const citation of citations) {
        yield* sink.emit({ tool: "verify_citation", subject: citation.source_url });

        if (CANNED_CORPUS.has(citation.source_url)) {
          verdicts.push({
            citationId: citation.id,
            claim: citation.claim,
            source_url: citation.source_url,
            outcome: "corpus-verified",
          });
          verified.push({ ...citation, trust: "corpus-verified" });
          continue;
        }
        if (citation.source_url.includes("blog")) {
          verdicts.push({
            citationId: citation.id,
            claim: citation.claim,
            source_url: citation.source_url,
            outcome: "removed",
            why: "the claim traces to a blog post citing itself — no primary source found",
          });
          continue;
        }
        verdicts.push({
          citationId: citation.id,
          claim: citation.claim,
          source_url: citation.source_url,
          outcome: "retrieved-unverified",
        });
        verified.push({ ...citation, trust: "retrieved-unverified" });
      }

      const survivingIds = new Set(verified.map((citation) => citation.id));
      const sweptRationale = rationale.map((line) =>
        line.citationId !== undefined && !survivingIds.has(line.citationId)
          ? { text: line.text }
          : line,
      );

      yield* sink.emit({ tool: "rewrite_rationale" });

      return {
        rationale: sweptRationale,
        citations: verified,
        verdicts,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0,
      };
    }),
});
