import { fileURLToPath } from "node:url";

import { makeRecordingTransport, makeReplayTransport, readCassetteDirectory } from "./agentCassette.ts";
import {
  makeGovernedTransport,
  DEFAULT_AGENT_SESSION_BUDGET,
  type AgentSessionBudget,
  type AgentSessionLogEntry,
} from "./agentSessionLog.ts";
import { LiveAgentSdkTransport, type AgentSdkTransport } from "./agentTransport.ts";

/**
 * Which agents a server runs, chosen from the environment (issue #95).
 *
 * The ticket's first acceptance criterion is that this be selectable **without
 * editing source**, and its second is that the default stay fast, deterministic
 * and quota-free. Both are met by making `canned` the value of an unset
 * variable: `pnpm --filter @repcoach/e2e test` is byte-for-byte the suite it was
 * before this existed, and the other two modes are things a person asks for.
 *
 * - `canned` — the scripted layers. The default, and what CI runs.
 * - `replay` — the real adapters, answered from recorded transcripts. Still
 *   deterministic and free, but now the prompts, the decode boundary and the
 *   contract are all in the path.
 * - `live` — the real adapters against real Agent SDK sessions. Costs
 *   subscription quota, is non-deterministic by nature, and is bounded and
 *   logged rather than trusted (`agentSessionLog.ts`).
 */
export type AgentMode = "canned" | "replay" | "live";

export const AGENT_MODES: ReadonlyArray<AgentMode> = ["canned", "replay", "live"];

/**
 * Where the committed fixtures live. Under `e2e/` rather than beside the
 * server: they are rung-2 fixtures that rung 1 also reads, not server data, and
 * the directory a reader goes looking in is the one next to the flows.
 */
export const DEFAULT_CASSETTE_DIR = fileURLToPath(
  new URL("../../../../e2e/fixtures/agent-cassettes", import.meta.url),
);

export interface AgentModeSettings {
  readonly mode: AgentMode;
  readonly cassetteDir: string;
  /** When set, every live session run is written here as a cassette. */
  readonly recordDir?: string;
  readonly allowStaleFingerprint: boolean;
  readonly budget: AgentSessionBudget;
}

/**
 * Environment markers a coding-agent session sets on every shell it spawns.
 * Claude Code sets all three; `CLAUDECODE` alone would do, and the other two
 * are here so the guard does not hinge on one vendor's single variable name.
 */
const AGENT_SESSION_MARKERS = ["CLAUDECODE", "AI_AGENT", "CLAUDE_CODE_ENTRYPOINT"] as const;

export const runningUnderACodingAgent = (env: Record<string, string | undefined>): boolean =>
  AGENT_SESSION_MARKERS.some((marker) => (env[marker] ?? "").trim() !== "");

/**
 * The escape hatch, and it is spelled to be typed by a person: an agent that
 * sets this has gone out of its way rather than merely inherited a variable.
 */
const LIVE_OVERRIDE = "REPCOACH_AGENT_LIVE_OK";

/**
 * **Live mode is the owner's to spend, not an agent's** — the guard, in code.
 *
 * `live` opens real Agent SDK sessions against the owner's *subscription
 * quota*. Defaulting to `canned` stops that happening by accident, but it does
 * not stop an agent that read the docs, and an agent burning a weekly rate
 * limit overnight is a real cost with no undo. So a live run refuses outright
 * when it can see it was started from a coding-agent session.
 *
 * It is a guard, not a sandbox, and the difference is worth stating plainly: a
 * determined agent can clear its own environment. What this enforces is that
 * spending quota can never be *incidental* — not something a suite picks up
 * from an inherited variable, a copied command line, or a doc example.
 */
const assertLiveModeIsAllowed = (env: Record<string, string | undefined>): void => {
  if (!runningUnderACodingAgent(env)) return;
  if ((env[LIVE_OVERRIDE] ?? "").trim() === "1") return;
  throw new Error(
    "REPCOACH_AGENT_MODE=live refuses to start from a coding-agent session: live agents spend the owner's " +
      "subscription quota, and that is the owner's call to make, per run.\n" +
      "  - To run the agent-backed suite here, use REPCOACH_AGENT_MODE=replay — it exercises the same real " +
      "adapters against recorded transcripts, deterministically and for free.\n" +
      `  - If the owner has asked for a live run, they set ${LIVE_OVERRIDE}=1 alongside it.\n` +
      "See docs/agents/testing.md → 'Agent-backed rung 2'.",
  );
};

const readNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const readAgentModeSettings = (
  env: Record<string, string | undefined> = process.env,
): AgentModeSettings => {
  const raw = env["REPCOACH_AGENT_MODE"]?.trim();
  const mode = raw === undefined || raw === "" ? "canned" : raw;
  if (!(AGENT_MODES as ReadonlyArray<string>).includes(mode)) {
    // Loud, at boot. A typo that silently fell back to `canned` would produce a
    // green suite that proved nothing about the agents — the exact failure this
    // whole ticket exists to remove.
    throw new Error(
      `REPCOACH_AGENT_MODE must be one of ${AGENT_MODES.join(" | ")} (got "${raw}")`,
    );
  }
  if (mode === "live") assertLiveModeIsAllowed(env);

  const recordDir = env["REPCOACH_AGENT_RECORD_DIR"]?.trim();
  return {
    mode: mode as AgentMode,
    cassetteDir: env["REPCOACH_AGENT_CASSETTE_DIR"]?.trim() ?? DEFAULT_CASSETTE_DIR,
    ...(recordDir === undefined || recordDir === "" ? {} : { recordDir }),
    allowStaleFingerprint: env["REPCOACH_AGENT_ALLOW_STALE_CASSETTES"] === "1",
    budget: {
      maxSessions: readNumber(env["REPCOACH_AGENT_MAX_SESSIONS"], DEFAULT_AGENT_SESSION_BUDGET.maxSessions),
      maxCostUsd: readNumber(env["REPCOACH_AGENT_MAX_COST_USD"], DEFAULT_AGENT_SESSION_BUDGET.maxCostUsd),
    },
  };
};

export interface AgentBacking {
  readonly mode: Exclude<AgentMode, "canned">;
  readonly transport: AgentSdkTransport;
  readonly snapshot: () => {
    readonly mode: AgentMode;
    readonly sessions: number;
    readonly cumulativeCostUsd: number;
    readonly budget: AgentSessionBudget;
    readonly entries: ReadonlyArray<AgentSessionLogEntry>;
  };
  /** Rewinds cassette cursors and clears the log — driven by `POST /__test__/reset`. */
  readonly reset: () => void;
}

/**
 * Builds the transport a non-canned server runs on, or `undefined` for
 * `canned`, which is the signal to wire the scripted layers exactly as before.
 *
 * Note the ordering: the budget/log wrapper is OUTERMOST in both modes. Replay
 * costs nothing, but a replayed flow that runs eleven sessions where two were
 * recorded is worth seeing in the same log, in the same shape, as a live one
 * that did — the two modes are supposed to be comparable.
 */
export const makeAgentBacking = (settings: AgentModeSettings): AgentBacking | undefined => {
  if (settings.mode === "canned") return undefined;

  if (settings.mode === "replay") {
    const replay = makeReplayTransport({
      cassettes: readCassetteDirectory(settings.cassetteDir),
      allowStaleFingerprint: settings.allowStaleFingerprint,
    });
    const governed = makeGovernedTransport(replay.transport, settings.budget);
    return {
      mode: "replay",
      transport: governed.transport,
      snapshot: () => ({ mode: "replay" as const, ...governed.snapshot() }),
      reset: () => {
        replay.reset();
        governed.reset();
      },
    };
  }

  const recorded =
    settings.recordDir === undefined
      ? LiveAgentSdkTransport
      : makeRecordingTransport({ inner: LiveAgentSdkTransport, dir: settings.recordDir });
  const governed = makeGovernedTransport(recorded, settings.budget);
  return {
    mode: "live",
    transport: governed.transport,
    snapshot: () => ({ mode: "live" as const, ...governed.snapshot() }),
    // A no-op on purpose. `POST /__test__/reset` runs between flows, and
    // clearing the counters there would turn a hard cap on the run into a
    // per-test allowance that bounds nothing — the one thing a live mode must
    // not do. The log is kept for the same reason: what a live run spent, and
    // which sessions failed, is the record of the whole run.
    reset: () => {},
  };
};
