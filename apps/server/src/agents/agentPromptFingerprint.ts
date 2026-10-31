import { createHash } from "node:crypto";

import type { DeliberationRunOutput } from "@repcoach/contracts";

import type { AgentSessionStage } from "./agentTransport.ts";
import { DELIBERATOR_OUTPUT_FORMAT_INSTRUCTION } from "./realDeliberationAgent.ts";
import { buildSweepPrompt } from "./realDeliberationSweepAgent.ts";
import { INTAKE_TURN_FORMAT_INSTRUCTION } from "./realIntakeSessionAgent.ts";
import { buildIntakeSweepPrompt } from "./realIntakeSweepAgent.ts";

/**
 * The staleness signal for recorded fixtures (issue #95).
 *
 * Record-and-replay's known failure mode is that the fixtures go stale
 * *silently*: the prompt changes, the recorded reply is now an answer to a
 * question nobody asks any more, and the suite stays green while proving less
 * and less. The ticket asks for a signal instead, and this is it.
 *
 * What is hashed is each stage's **static scaffold** — the instructions and the
 * output-format contract the adapter wraps around the run's data — with the
 * data itself rendered from fixed placeholders. That line is deliberate: a
 * fingerprint over the whole prompt would change with every seed row and cry
 * wolf on every run, while a fingerprint over nothing at all is what we have
 * today. The scaffold is exactly the part a recorded reply is an answer to.
 *
 * It is a staleness signal, not a correctness proof. A prompt change that
 * leaves the scaffold untouched (new seed sections, a reworded pointer digest)
 * slips past it, which is why each cassette also stores the full prompt of
 * every recorded turn — the thing to diff by hand when a refresh is being
 * judged.
 */

/** A `DeliberationRunOutput`-shaped placeholder: structurally valid, carries no data. */
const EMPTY_DRAFT = { decisions: [], observation_directives: [] } as unknown as DeliberationRunOutput;

/**
 * The static half of each stage's prompt. Built by calling the real prompt
 * builders with empty inputs, so a scaffold cannot drift from what the adapter
 * actually sends without this file noticing.
 */
export const agentPromptScaffold = (stage: AgentSessionStage): string => {
  switch (stage) {
    case "deliberator":
      return DELIBERATOR_OUTPUT_FORMAT_INSTRUCTION;
    case "sweep":
      return buildSweepPrompt(EMPTY_DRAFT, []);
    case "intake-session":
      return INTAKE_TURN_FORMAT_INSTRUCTION;
    case "intake-sweep":
      return buildIntakeSweepPrompt({
        planJson: "",
        rationaleJson: "",
        citationsJson: "",
        evidenceRoster: [],
      });
  }
};

/**
 * A short, stable hash of a stage's scaffold. Truncated because it is read by
 * humans in fixture files and in failure messages — the full digest buys
 * nothing here and makes both harder to scan.
 */
export const agentPromptFingerprint = (stage: AgentSessionStage): string =>
  `sha256:${createHash("sha256").update(agentPromptScaffold(stage)).digest("hex").slice(0, 16)}`;
