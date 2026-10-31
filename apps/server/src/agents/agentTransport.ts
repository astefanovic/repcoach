import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

import * as Effect from "effect/Effect";

import {
  openHeldAgentSdkSession,
  runAgentSdkSession,
  type AgentSdkSessionConfig,
  type AgentSdkSessionResult,
  type AgentSdkToolCall,
  type DeliberationRunKilledError,
  type HeldAgentSdkSession,
} from "./agentSdkSession.ts";

/**
 * The seam between "which agent is running" and "what actually runs it"
 * (issue #95).
 *
 * The four real adapters used to call `runAgentSdkSession` /
 * `openHeldAgentSdkSession` as module functions, which made "a real Agent SDK
 * session" the only thing they could ever be. That is why rung 2 had to run
 * against the canned *layers* to stay deterministic — and why the adapters
 * themselves, including every prompt they build and every decode they perform,
 * had no automated coverage at all between rung 1's stand-ins and a human on a
 * phone.
 *
 * A transport is deliberately the NARROWEST possible seam: it carries the
 * prompt out and the model's final text back, and nothing else. Everything the
 * ticket cares about proving — the output-format trailers, `dropNullValues`,
 * `defaultEmptyDecisionLists`, the Schema decodes, the verdict-to-trust
 * derivation — stays on the adapter's side of it, so a replayed session
 * exercises the identical code path a live one does. A seam drawn one level up
 * (a fake `DeliberationAgent` layer) would have replayed past all of it, which
 * is exactly what the canned layers already do.
 */

/**
 * Which of the four agent sessions is being run. Not merely a label: it is what
 * a recorded cassette is filed under and matched by (`agentCassette.ts`), so a
 * replayed Intake sweep can never be handed the deliberator's transcript.
 */
export type AgentSessionStage = "deliberator" | "sweep" | "intake-session" | "intake-sweep";

export const AGENT_SESSION_STAGES: ReadonlyArray<AgentSessionStage> = [
  "deliberator",
  "sweep",
  "intake-session",
  "intake-sweep",
];

export const isAgentSessionStage = (value: string): value is AgentSessionStage =>
  (AGENT_SESSION_STAGES as ReadonlyArray<string>).includes(value);

export interface AgentSessionRequest {
  readonly stage: AgentSessionStage;
  readonly prompt: string;
  readonly config: AgentSdkSessionConfig;
  readonly allowedTools: ReadonlyArray<string>;
}

export interface HeldAgentSessionRequest extends AgentSessionRequest {
  readonly onToolCall: (call: AgentSdkToolCall) => void;
}

export interface AgentSdkTransport {
  /** One session, run to completion — the deliberator, both sweeps. */
  readonly run: (
    request: AgentSessionRequest,
  ) => Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError>;
  /** One session, held open across turns — Intake, and only Intake (ADR 0014 §2). */
  readonly openHeld: (
    request: HeldAgentSessionRequest,
  ) => Effect.Effect<
    { readonly session: HeldAgentSdkSession; readonly first: AgentSdkSessionResult },
    DeliberationRunKilledError
  >;
}

/**
 * The real thing: a live Agent SDK session, exactly as before the seam existed.
 * This is what production runs and what every default resolves to, so wiring
 * nothing changes nothing.
 */
export const LiveAgentSdkTransport: AgentSdkTransport = {
  run: ({ prompt, config, allowedTools }) => runAgentSdkSession(prompt, config, allowedTools),
  openHeld: ({ prompt, config, allowedTools, onToolCall }) =>
    openHeldAgentSdkSession(prompt, config, allowedTools, onToolCall),
};

/** Re-exported so an adapter needs one import to speak to the transport. */
export type { AgentSdkSessionConfig, AgentSdkSessionResult, EffortLevel, HeldAgentSdkSession };
