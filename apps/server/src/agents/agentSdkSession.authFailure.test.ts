import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DeliberationRunKilledError,
  openHeldAgentSdkSession,
  runAgentSdkSession,
  type AgentSdkSessionConfig,
} from "./agentSdkSession.ts";

/**
 * An expired login is not a runaway agent.
 *
 * The status strip read *"coach failed · Deliberation run killed (wall-clock):
 * run threw: Error: Claude Code returned an error result: Failed to
 * authenticate: OAuth session expired and could not be refreshed"* — a run that
 * spent nothing and was nowhere near its budget, reported as one that blew it.
 * The cause was the fallback in the catch: anything thrown AFTER the first SDK
 * message was assumed to be the wall-clock guard's business, and the CLI emits
 * its sign-in failure as an ordinary error late in the stream.
 *
 * So the reason has to be read off the cause, not off how far the stream got.
 * The SDK is stubbed here because what is under test is this adapter's
 * classification, not the CLI's authentication.
 */

const sdk = vi.hoisted(() => ({
  /** What the scripted session does: yield messages, then throw this. */
  throws: undefined as unknown,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      // One assistant message first — this is what used to steer the failure
      // into the "wall-clock" branch.
      yield { type: "assistant", message: { content: [] } };
      throw sdk.throws;
    },
  }),
}));

const CONFIG: AgentSdkSessionConfig = { maxTurns: 12, wallClockMs: 60_000 };

const OAUTH_EXPIRY = new Error(
  "Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed",
);

const killedBy = async (
  effect: Effect.Effect<unknown, DeliberationRunKilledError>,
) => {
  const error: unknown = await Effect.runPromise(Effect.flip(effect));
  if (!(error instanceof DeliberationRunKilledError)) {
    throw new Error(
      `expected a DeliberationRunKilledError, got ${String(error)}`,
    );
  }
  return error;
};

beforeEach(() => {
  sdk.throws = OAUTH_EXPIRY;
});

describe("an expired OAuth session is its own kill reason", () => {
  it("does not report a one-shot run's auth expiry as a wall-clock kill", async () => {
    const error = await killedBy(runAgentSdkSession("deliberate", CONFIG, []));

    expect(error.reason).toBe("not-authenticated");
    expect(error.message).not.toContain("wall-clock");
  });

  it("tells the owner how to fix it, and keeps the original cause", async () => {
    const error = await killedBy(runAgentSdkSession("deliberate", CONFIG, []));

    expect(error.message).toContain("/login");
    expect(error.message).toContain("OAuth session expired");
  });

  it("still reports a genuinely unexplained mid-run throw as wall-clock", async () => {
    sdk.throws = new Error("socket hang up");

    const error = await killedBy(runAgentSdkSession("deliberate", CONFIG, []));

    expect(error.reason).toBe("wall-clock");
  });

  it("classifies the held-open Intake session's auth expiry the same way", async () => {
    const error = await killedBy(
      openHeldAgentSdkSession("seed", CONFIG, [], () => {}),
    );

    expect(error.reason).toBe("not-authenticated");
    expect(error.message).toContain("/login");
  });
});
