import * as Effect from "effect/Effect";

import { DeliberationRunKilledError, type AgentSdkSessionResult } from "./agentSdkSession.ts";
import type { AgentSdkTransport, AgentSessionStage } from "./agentTransport.ts";

/**
 * The legibility and spend half of running e2e flows against real agents
 * (issue #95).
 *
 * A live agent failure seen only through the browser reads as flake: the draft
 * never appears, a locator times out after 30 seconds, and the report says "the
 * element was not found" — which sends the next reader to debug the client. So
 * every session this server runs is logged with its outcome, and the log is
 * readable over the control channel: a flow that fails can then say *the
 * intake-session session failed: session could not start: …* instead of
 * describing a missing heading.
 *
 * The same wrapper enforces the spend bound, because both are answers to the
 * same question — what did this run actually do — and splitting them across two
 * wrappers would mean a budget refusal that is invisible in the log.
 */

export interface AgentSessionLogEntry {
  readonly stage: AgentSessionStage;
  readonly at: string;
  readonly outcome: "ok" | "failed" | "refused";
  readonly detail?: string;
  readonly costUsd: number;
  /** Running total across the server's lifetime, so one read answers "what has this cost". */
  readonly cumulativeCostUsd: number;
}

export interface AgentSessionBudget {
  /** Hard cap on sessions (a held-open Intake counts one per turn). */
  readonly maxSessions: number;
  /** Hard cap on the SDK's own reported spend, in USD. */
  readonly maxCostUsd: number;
}

export interface GovernedTransport {
  readonly transport: AgentSdkTransport;
  readonly snapshot: () => {
    readonly sessions: number;
    readonly cumulativeCostUsd: number;
    readonly budget: AgentSessionBudget;
    readonly entries: ReadonlyArray<AgentSessionLogEntry>;
  };
  /** Clears the log and the counters — folded into `POST /__test__/reset`. */
  readonly reset: () => void;
}

/**
 * A budget generous enough that no honest run of the agent-backed flows hits
 * it, and small enough that a runaway one stops before it matters. Deliberately
 * a stop, not a warning: the failure mode being guarded is a loop that keeps
 * opening sessions, and a warning nobody is watching at 2am is not a bound.
 */
export const DEFAULT_AGENT_SESSION_BUDGET: AgentSessionBudget = {
  maxSessions: 24,
  maxCostUsd: 5,
};

export const makeGovernedTransport = (
  inner: AgentSdkTransport,
  budget: AgentSessionBudget = DEFAULT_AGENT_SESSION_BUDGET,
): GovernedTransport => {
  let sessions = 0;
  let cumulativeCostUsd = 0;
  let entries: Array<AgentSessionLogEntry> = [];

  const log = (stage: AgentSessionStage, outcome: AgentSessionLogEntry["outcome"], costUsd: number, detail?: string) => {
    cumulativeCostUsd += costUsd;
    entries.push({
      stage,
      at: new Date().toISOString(),
      outcome,
      ...(detail === undefined ? {} : { detail }),
      costUsd,
      cumulativeCostUsd,
    });
  };

  /** `undefined` = there is room; a string = the refusal to report and fail with. */
  const refuseIfOverBudget = (stage: AgentSessionStage): string | undefined => {
    if (sessions >= budget.maxSessions) {
      return `agent session budget exhausted: ${sessions} sessions already run (cap ${budget.maxSessions}) — refusing to open another "${stage}" session`;
    }
    if (cumulativeCostUsd >= budget.maxCostUsd) {
      return `agent spend budget exhausted: $${cumulativeCostUsd.toFixed(4)} already spent (cap $${budget.maxCostUsd.toFixed(2)}) — refusing to open another "${stage}" session`;
    }
    sessions += 1;
    return undefined;
  };

  const observe = <A extends AgentSdkSessionResult>(
    stage: AgentSessionStage,
    effect: Effect.Effect<A, DeliberationRunKilledError>,
  ): Effect.Effect<A, DeliberationRunKilledError> =>
    effect.pipe(
      Effect.tap((result) => Effect.sync(() => log(stage, "ok", result.costUsd))),
      Effect.tapError((error) => Effect.sync(() => log(stage, "failed", 0, error.message))),
    );

  const refusal = (stage: AgentSessionStage, detail: string) =>
    Effect.sync(() => log(stage, "refused", 0, detail)).pipe(
      Effect.andThen(Effect.fail(new DeliberationRunKilledError({ reason: "could-not-start", detail }))),
    );

  const transport: AgentSdkTransport = {
    run: (request) =>
      Effect.suspend(() => {
        const refused = refuseIfOverBudget(request.stage);
        return refused === undefined ? observe(request.stage, inner.run(request)) : refusal(request.stage, refused);
      }),

    openHeld: (request) =>
      Effect.suspend(() => {
        const refused = refuseIfOverBudget(request.stage);
        if (refused !== undefined) return refusal(request.stage, refused);
        return inner.openHeld(request).pipe(
          Effect.tap((opened) => Effect.sync(() => log(request.stage, "ok", opened.first.costUsd))),
          Effect.tapError((error) => Effect.sync(() => log(request.stage, "failed", 0, error.message))),
          Effect.map((opened) => ({
            first: opened.first,
            session: {
              // Each turn is its own session for budget purposes: a held-open
              // exchange is where an unbounded loop would actually happen, and
              // counting the whole conversation as one would leave that
              // unbounded.
              send: (text: string) =>
                Effect.suspend(() => {
                  const turnRefused = refuseIfOverBudget(request.stage);
                  return turnRefused === undefined
                    ? observe(request.stage, opened.session.send(text))
                    : refusal(request.stage, turnRefused);
                }),
              close: opened.session.close,
            },
          })),
        );
      }),
  };

  return {
    transport,
    snapshot: () => ({ sessions, cumulativeCostUsd, budget, entries: [...entries] }),
    reset: () => {
      sessions = 0;
      cumulativeCostUsd = 0;
      entries = [];
    },
  };
};
