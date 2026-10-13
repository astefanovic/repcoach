import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ZERO_TOKEN_USAGE as CONTRACT_ZERO_TOKEN_USAGE,
  type DeliberationEffort,
  type DeliberationRunOutput,
  type TokenUsage,
} from "@repcoach/contracts";

import type { DeliberationRunFailure } from "./agentSdkSession.ts";

/**
 * One deliberator run's result: the drafted output plus the SDK's token-usage
 * counts for the session (issue #32 — the runner surfaces these on the run
 * state so the phone can show real usage numbers). The canned/test agents
 * report zero usage; the real agent reports the Agent SDK's counts.
 */
export interface AgentRunResult {
  readonly output: DeliberationRunOutput;
  readonly usage: TokenUsage;
  /** The SDK's own `total_cost_usd` for this session (issue #81) — stored on the run ledger, never rendered (ADR 0011 §8). */
  readonly costUsd: number;
}

/** Convenience zero-usage value for canned/test deliberators (no real SDK spend). */
export const ZERO_TOKEN_USAGE: TokenUsage = CONTRACT_ZERO_TOKEN_USAGE;

/**
 * The DELIBERATOR agent boundary (ADR 0011 §1/§3, issue #26 — 2B slice 1):
 * given an assembled prompt (the thin seed context, ADR 0011 §2), returns
 * the run's DRAFT output object. This is the FIRST of the two agents in a
 * run (ADR 0011 §1) — its output is never committed directly. The runner
 * (`deliberationRunner.ts`) passes this agent's return value into a SECOND,
 * separate `DeliberationSweepAgent` (`deliberationSweepAgent.ts`, issue #28
 * — 2B slice 3), the one-way adversarial sweep with final authority, and
 * commits ONLY the sweep's output — never this agent's raw draft (ADR 0011
 * §1/§6). This slice's ONLY implementation (`CannedDeliberationAgent` below)
 * is a stand-in returning fixed JSON already conforming to the output
 * contract, so the runner → `Store.commitDeliberationOutput` seam could be
 * proven end-to-end before the real Agent SDK session existed.
 */
export class DeliberationAgent extends Context.Service<
  DeliberationAgent,
  {
    /**
     * `model` (ADR 0011 §4, issue #31 — 2B slice 6) is the per-cadence
     * configured model the runner read from settings for this run's cadence,
     * or `undefined` when none is configured (the agent then uses its own
     * default). The real deliberator uses it as the Agent SDK session's model;
     * the canned agent ignores it. Passed as a second arg (not folded into the
     * prompt) so it stays a machine field the runner owns, never model-visible
     * text.
     *
     * `effort` (issue #81) rides alongside it for the same reason and from the
     * same place: it is the OTHER half of the per-cadence model choice, read
     * from the same settings row, and a model selector that could not also
     * pick how hard the model tries would be a half-wired control. Passing it
     * separately (rather than folding it into `model`) keeps the two
     * independently `undefined` — "SDK default model at SDK default effort"
     * and "this model at whatever effort it defaults to" are different, real
     * states.
     */
    readonly run: (
      assembledPrompt: string,
      model?: string,
      effort?: DeliberationEffort,
    ) => Effect.Effect<AgentRunResult, DeliberationRunFailure>;
  }
>()("@repcoach/dev-server/DeliberationAgent") {}

/**
 * Fixed run-output JSON (ADR 0011 §6 shape) proving both feed-write paths
 * this slice's acceptance bar cares about: an Observation with
 * `surface: true` (gets a `coaching_feed_entry`) and a Proposal (always
 * gets one, regardless of `surface`). `observation_directives` is empty —
 * the canned run has no prior open Observations to reference.
 */
export const CANNED_RUN_OUTPUT: DeliberationRunOutput = {
  decisions: [
    {
      kind: "observation",
      summary: "Bench press working load has held flat for 3 straight sessions.",
      rationale:
        "Across the last 3 logged sessions the bench press working sets landed at the same load with reps " +
        "at the top of the prescribed range — a plateau worth watching, not yet a confirmed stall.",
      citations: [
        {
          claim: "A load plateau across 3+ sessions at matched reps is an early stall signal worth surfacing.",
          source_url: "https://example.com/research/load-plateau-detection",
          trust: "retrieved-unverified",
        },
      ],
      reasoning_only_points: [],
      surface: true,
    },
    {
      kind: "proposal",
      summary: "Add a fourth back squat working set next session to build volume headroom.",
      rationale:
        "Squat load has progressed cleanly for 3 sessions with reps consistently at the top of range and no " +
        "reported difficulty — capacity to add volume before the next load increase.",
      citations: [
        {
          claim:
            "Adding a working set before increasing load is a lower-risk progression when reps-in-reserve " +
            "stays high across consecutive sessions.",
          source_url: "https://example.com/research/volume-before-load-progression",
          trust: "corpus-verified",
        },
      ],
      reasoning_only_points: ["Session-review restraint favors one small change at a time."],
      surface: false,
    },
  ],
  observation_directives: [],
};

/**
 * The walking-skeleton stand-in for the real deliberator: ignores
 * `assembledPrompt` entirely and returns the fixed `CANNED_RUN_OUTPUT`
 * above as a DRAFT — `DeliberationRunner` still runs it through a
 * `DeliberationSweepAgent` (canned or real) before committing anything.
 */
export const CannedDeliberationAgent: Layer.Layer<DeliberationAgent> = Layer.succeed(DeliberationAgent)({
  run: (_assembledPrompt, _model, _effort) => Effect.succeed({ output: CANNED_RUN_OUTPUT, usage: ZERO_TOKEN_USAGE, costUsd: 0 }),
});
