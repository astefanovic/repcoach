import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { ZERO_TOKEN_USAGE } from "@repcoach/contracts";

import { makeAgentBacking, readAgentModeSettings, DEFAULT_CASSETTE_DIR } from "./agentMode.ts";
import { makeGovernedTransport, DEFAULT_AGENT_SESSION_BUDGET } from "./agentSessionLog.ts";
import type { AgentSdkSessionResult } from "./agentSdkSession.ts";
import type { AgentSdkTransport } from "./agentTransport.ts";

/**
 * Choosing which agents a server runs, and bounding what a live one may spend
 * (issue #95).
 *
 * The two acceptance criteria this file defends are in tension by design: the
 * mode must be selectable **without editing source**, and the default must stay
 * fast, deterministic and quota-free. Both hold only if an unset variable means
 * `canned` and a mistyped one is loud — a typo that fell back to `canned` would
 * produce a green "agent-backed" run that exercised no agent at all, which is
 * the exact failure this whole capability exists to remove.
 */

describe("reading the mode from the environment", () => {
  it("defaults to canned, so the ordinary suite is unchanged", () => {
    expect(readAgentModeSettings({}).mode).toBe("canned");
    expect(readAgentModeSettings({ REPCOACH_AGENT_MODE: "" }).mode).toBe("canned");
    expect(readAgentModeSettings({}).cassetteDir).toBe(DEFAULT_CASSETTE_DIR);
  });

  it("accepts the three modes", () => {
    expect(readAgentModeSettings({ REPCOACH_AGENT_MODE: "replay" }).mode).toBe("replay");
    expect(readAgentModeSettings({ REPCOACH_AGENT_MODE: " live " }).mode).toBe("live");
  });

  it("refuses a typo rather than silently running canned agents", () => {
    expect(() => readAgentModeSettings({ REPCOACH_AGENT_MODE: "replays" })).toThrow(
      /canned \| replay \| live/,
    );
  });

  it("carries the spend bound, defaulted and overridable", () => {
    expect(readAgentModeSettings({}).budget).toEqual(DEFAULT_AGENT_SESSION_BUDGET);
    expect(
      readAgentModeSettings({ REPCOACH_AGENT_MAX_SESSIONS: "3", REPCOACH_AGENT_MAX_COST_USD: "0.5" })
        .budget,
    ).toEqual({ maxSessions: 3, maxCostUsd: 0.5 });
    // Junk falls back rather than disabling the bound — a cap parsed as `NaN`
    // is not a cap.
    expect(readAgentModeSettings({ REPCOACH_AGENT_MAX_SESSIONS: "lots" }).budget.maxSessions).toBe(
      DEFAULT_AGENT_SESSION_BUDGET.maxSessions,
    );
  });

  it("refuses live mode when it can see a coding-agent session started it", () => {
    // The owner's rule: live agents spend subscription quota, and that is the
    // owner's call per run. A default of `canned` only stops an accident — it
    // does nothing about an agent that has read the testing doc and knows the
    // variable. Every marker is checked independently so the guard does not
    // hinge on one vendor's single variable name.
    for (const marker of ["CLAUDECODE", "AI_AGENT", "CLAUDE_CODE_ENTRYPOINT"]) {
      expect(
        () => readAgentModeSettings({ REPCOACH_AGENT_MODE: "live", [marker]: "1" }),
        `${marker} should have blocked a live run`,
      ).toThrow(/refuses to start from a coding-agent session/);
    }
  });

  it("points the refusal at replay rather than just saying no", () => {
    // A guardrail that only forbids teaches you to route around it. This one
    // names the free equivalent that exercises the same real adapters.
    expect(() => readAgentModeSettings({ REPCOACH_AGENT_MODE: "live", CLAUDECODE: "1" })).toThrow(
      /REPCOACH_AGENT_MODE=replay/,
    );
  });

  it("still allows the owner's own shell, and an explicitly authorised agent run", () => {
    expect(readAgentModeSettings({ REPCOACH_AGENT_MODE: "live" }).mode).toBe("live");
    expect(
      readAgentModeSettings({
        REPCOACH_AGENT_MODE: "live",
        CLAUDECODE: "1",
        REPCOACH_AGENT_LIVE_OK: "1",
      }).mode,
    ).toBe("live");
  });

  it("never blocks the two quota-free modes, whoever started them", () => {
    // The guard is about spend, not about who is running. Blocking replay from
    // an agent session would break the one mode agents are supposed to use.
    expect(readAgentModeSettings({ REPCOACH_AGENT_MODE: "replay", CLAUDECODE: "1" }).mode).toBe("replay");
    expect(readAgentModeSettings({ CLAUDECODE: "1" }).mode).toBe("canned");
  });

  it("treats an empty marker as absent, so a stray blank variable cannot block the owner", () => {
    expect(readAgentModeSettings({ REPCOACH_AGENT_MODE: "live", CLAUDECODE: "  " }).mode).toBe("live");
  });

  it("builds no backing at all for canned, which is what keeps the default path untouched", () => {
    expect(makeAgentBacking(readAgentModeSettings({}))).toBeUndefined();
  });

  it("replays the committed cassettes when asked", () => {
    const backing = makeAgentBacking(readAgentModeSettings({ REPCOACH_AGENT_MODE: "replay" }));

    expect(backing?.mode).toBe("replay");
    expect(backing?.snapshot().mode).toBe("replay");
  });
});

/* ------------------------------------------------------------- the bound --- */

const result = (costUsd: number): AgentSdkSessionResult => ({
  text: "{}",
  usage: ZERO_TOKEN_USAGE,
  costUsd,
});

const stub = (costUsd = 0): AgentSdkTransport => ({
  run: () => Effect.succeed(result(costUsd)),
  openHeld: () =>
    Effect.succeed({
      first: result(costUsd),
      session: { send: () => Effect.succeed(result(costUsd)), close: Effect.void },
    }),
});

const request = {
  stage: "deliberator" as const,
  prompt: "p",
  config: { maxTurns: 1, wallClockMs: 1 },
  allowedTools: ["Read"] as ReadonlyArray<string>,
};

describe("the live-mode budget", () => {
  it("stops at the session cap instead of warning about it", async () => {
    const governed = makeGovernedTransport(stub(), { maxSessions: 2, maxCostUsd: 100 });
    await Effect.runPromise(governed.transport.run(request));
    await Effect.runPromise(governed.transport.run(request));

    const third = await Effect.runPromise(Effect.flip(governed.transport.run(request)));

    expect(String(third)).toMatch(/session budget exhausted/);
    expect(governed.snapshot().sessions).toBe(2);
  });

  it("stops at the spend cap, counting the SDK's own reported cost", async () => {
    const governed = makeGovernedTransport(stub(0.75), { maxSessions: 100, maxCostUsd: 1 });
    await Effect.runPromise(governed.transport.run(request));
    await Effect.runPromise(governed.transport.run(request));

    const third = await Effect.runPromise(Effect.flip(governed.transport.run(request)));

    expect(String(third)).toMatch(/spend budget exhausted/);
    expect(governed.snapshot().cumulativeCostUsd).toBeCloseTo(1.5);
  });

  it("counts every turn of a held session, because that is where a runaway loop would live", async () => {
    const governed = makeGovernedTransport(stub(), { maxSessions: 2, maxCostUsd: 100 });
    const opened = await Effect.runPromise(
      governed.transport.openHeld({ ...request, onToolCall: () => {} }),
    );
    await Effect.runPromise(opened.session.send("one"));

    const third = await Effect.runPromise(Effect.flip(opened.session.send("two")));

    expect(String(third)).toMatch(/session budget exhausted/);
  });

  it("logs every session with its outcome, which is what makes a live failure legible", async () => {
    const governed = makeGovernedTransport(stub(0.25));
    await Effect.runPromise(governed.transport.run(request));

    const snapshot = governed.snapshot();
    expect(snapshot.entries.length).toBe(1);
    expect(snapshot.entries[0]).toMatchObject({
      stage: "deliberator",
      outcome: "ok",
      costUsd: 0.25,
      cumulativeCostUsd: 0.25,
    });
  });

  it("records a refusal in the log too, so a bounded run does not look like a silent one", async () => {
    const governed = makeGovernedTransport(stub(), { maxSessions: 1, maxCostUsd: 100 });
    await Effect.runPromise(governed.transport.run(request));
    await Effect.runPromise(Effect.flip(governed.transport.run(request)));

    expect(governed.snapshot().entries.map((entry) => entry.outcome)).toEqual(["ok", "refused"]);
  });
});
