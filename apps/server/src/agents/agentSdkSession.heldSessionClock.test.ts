import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openHeldAgentSdkSession, type AgentSdkSessionConfig } from "./agentSdkSession.ts";

/**
 * Issue #72: a held-open Intake session runs on NO clock.
 *
 * It started as a session-lifetime budget, which killed conversations for the
 * user's thinking time — leave the tab open after one turn and the coach was
 * reported as a runaway agent. Scoping the same budget to a single turn fixed
 * that case and kept the flaw: a turn doing real retrieval would still be cut
 * off mid-flight, throwing away work whose only sin was taking a while. So the
 * clock is gone. `maxTurns` bounds the conversation, and the client connection
 * bounds the session's life (ADR 0014 §8) — both of which measure something
 * real, which elapsed time here never did.
 *
 * The SDK's `query` is stubbed with a scripted async generator, because the
 * thing under test is this adapter's own bookkeeping around the stream, not
 * the SDK.
 */

const sdk = vi.hoisted(() => ({
  /** How the scripted session answers one user message: reply, or take forever. */
  behaviour: (_text: string) => "reply" as "reply" | "still-working",
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt }: { readonly prompt: AsyncIterable<{ readonly message: { readonly content: string } }> }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const message of prompt) {
        const text = message.message.content;
        if (sdk.behaviour(text) === "still-working") {
          // A turn that is taking its time — the case the clock used to kill.
          await new Promise<never>(() => {});
        }
        yield {
          type: "result",
          subtype: "success",
          result: `echo:${text}`,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        };
      }
    },
  }),
}));

const CONFIG: AgentSdkSessionConfig = { maxTurns: 40, wallClockMs: 60_000 };

const AN_HOUR = 60 * 60 * 1000;

const open = () => Effect.runPromise(openHeldAgentSdkSession("seed", CONFIG, [], () => {}));

beforeEach(() => {
  sdk.behaviour = () => "reply";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("openHeldAgentSdkSession: no clock kills a held session (issue #72)", () => {
  it("takes a turn after the session has sat idle far longer than any budget", async () => {
    const { session, first } = await open();
    expect(first.text).toBe("echo:seed");

    // The user reads the draft, makes coffee, comes back. This alone used to
    // kill the session.
    await vi.advanceTimersByTimeAsync(AN_HOUR);

    const reply = await Effect.runPromise(session.send("that is too much volume"));
    expect(reply.text).toBe("echo:that is too much volume");

    await Effect.runPromise(session.close);
  });

  it("leaves a long-running turn in flight rather than killing it", async () => {
    const { session } = await open();

    sdk.behaviour = () => "still-working";
    let settled = false;
    void Effect.runPromise(session.send("what about deadlifts?")).then(
      () => (settled = true),
      () => (settled = true),
    );

    await vi.advanceTimersByTimeAsync(AN_HOUR);

    expect(settled).toBe(false);

    await Effect.runPromise(session.close);
  });

  it("holds the opening turn open too, however long the cold draft takes", async () => {
    sdk.behaviour = () => "still-working";
    let settled = false;
    void Effect.runPromise(openHeldAgentSdkSession("seed", CONFIG, [], () => {})).then(
      () => (settled = true),
      () => (settled = true),
    );

    await vi.advanceTimersByTimeAsync(AN_HOUR);

    expect(settled).toBe(false);
  });
});
