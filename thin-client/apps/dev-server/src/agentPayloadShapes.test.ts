import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { decodeAgentPayload, type AgentPayloadShape } from "./agentSdkSession.ts";
import { CANNED_RUN_OUTPUT } from "./deliberationAgent.ts";
import { DELIBERATION_RUN_OUTPUT_SHAPE } from "./realDeliberationAgent.ts";
import { INTAKE_TURN_PAYLOAD_SHAPE } from "./realIntakeSessionAgent.ts";
import { INTAKE_SWEEP_PAYLOAD_SHAPE } from "./realIntakeSweepAgent.ts";

/**
 * Issue #94's last acceptance criterion: "both cadence agents and both Intake
 * agents are covered — they share the extraction and must not diverge".
 *
 * Four adapters, three payload shapes — the deliberator and the cadence sweep
 * deliberately share ONE shape, because the sweep rewrites the deliberator's
 * draft into the identical contract and a sweep even slightly less tolerant
 * would mean a run the deliberator survived dying at the last step.
 *
 * Every case below is driven through the SHAPES the real adapters use, so a
 * fifth deviation learnt for one of them is learnt for all of them, and an
 * adapter that quietly stopped using the shared path fails here.
 */

const INTAKE_TURN_PAYLOAD = {
  draftPlan: {
    planModel: "manual",
    headline: "Upper / lower, four days a week",
    sessions: [
      {
        label: "Lower A",
        entries: [
          {
            exerciseId: "exercise-back-squat",
            exerciseName: "Back Squat",
            trackedMetrics: ["reps", "load"],
            sets: [
              { setType: "working", target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } }, restSec: 180 },
            ],
          },
        ],
      },
    ],
  },
  rationale: [{ text: "Four days lets every muscle be trained twice a week.", citationId: "c1" }],
  citations: [
    { id: "c1", claim: "Twice-weekly frequency beats once.", source_url: "https://example.com/frequency" },
  ],
  calibrationNote: "This first block is more template than coaching — there is no logged data yet.",
} as const;

const INTAKE_SWEEP_PAYLOAD = {
  verdicts: [
    {
      citationId: "c1",
      claim: "Twice-weekly frequency beats once.",
      source_url: "https://example.com/frequency",
      outcome: "corpus-verified",
    },
  ],
  rationale: [{ text: "Four days lets every muscle be trained twice a week.", citationId: "c1" }],
} as const;

/** The three shapes, each with a payload its own contract accepts. */
const SHAPES: ReadonlyArray<{
  readonly name: string;
  readonly agents: string;
  readonly shape: AgentPayloadShape<unknown>;
  readonly payload: unknown;
}> = [
  {
    name: "deliberation run output",
    agents: "the deliberator AND the cadence sweep",
    shape: DELIBERATION_RUN_OUTPUT_SHAPE as AgentPayloadShape<unknown>,
    payload: CANNED_RUN_OUTPUT,
  },
  {
    name: "intake reply",
    agents: "the held-open Intake session",
    shape: INTAKE_TURN_PAYLOAD_SHAPE as AgentPayloadShape<unknown>,
    payload: INTAKE_TURN_PAYLOAD,
  },
  {
    name: "intake sweep output",
    agents: "the Intake sweep",
    shape: INTAKE_SWEEP_PAYLOAD_SHAPE as AgentPayloadShape<unknown>,
    payload: INTAKE_SWEEP_PAYLOAD,
  },
];

const decode = (shape: AgentPayloadShape<unknown>, text: string) =>
  Effect.runPromise(decodeAgentPayload(shape, text));

const decodeFailure = (shape: AgentPayloadShape<unknown>, text: string) =>
  Effect.runPromise(Effect.flip(decodeAgentPayload(shape, text)));

describe.each(SHAPES)("$name (used by $agents)", ({ shape, payload }) => {
  const body = JSON.stringify(payload);

  it("reads the bare object it is actually asked for", async () => {
    await expect(decode(shape, body)).resolves.toEqual(payload);
  });

  it("reads the object with prose around it", async () => {
    const text = `I've finished the review. Here is the output:\n\n${body}\n\nHappy to revisit any of it.`;

    await expect(decode(shape, text)).resolves.toEqual(payload);
  });

  it("reads the object inside a fence variant the old regex missed", async () => {
    await expect(decode(shape, "~~~JSON\n" + body + "\n~~~")).resolves.toEqual(payload);
  });

  it("collapses `null` into absent, the first deviation a live session produced (issue #93)", async () => {
    // Every optional field in these contracts is `Schema.optionalKey`, and a
    // real model very often spells "omitted" as `null`. The normalisation is
    // shared, so no adapter is the one that still dies on it.
    const withNull = body.replace(/}$/, ', "citationId": null }');

    await expect(decode(shape, withNull)).resolves.toEqual(payload);
  });

  it("fails as a typed reason, never a defect, when the message carries no object at all", async () => {
    const failure = await decodeFailure(shape, "I was not able to complete this.");

    expect(failure.reason).toBe("no-json");
    expect(failure.detail).toContain("I was not able to complete this.");
  });
});
