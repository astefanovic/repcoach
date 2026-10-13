import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import { ZERO_TOKEN_USAGE } from "@repcoach/contracts";

import { DeliberationRunKilledError, type AgentSdkSessionResult } from "./agentSdkSession.ts";
import {
  makeRecordingTransport,
  makeReplayTransport,
  parseCassette,
  readCassetteDirectory,
  AgentCassetteError,
  type AgentCassette,
} from "./agentCassette.ts";
import { agentPromptFingerprint } from "./agentPromptFingerprint.ts";
import type { AgentSdkTransport, AgentSessionStage } from "./agentTransport.ts";

/**
 * Record and replay mechanics (issue #95). The *contract* half — that the
 * committed cassettes still decode through the real adapters — lives in
 * `agentCassette.contract.test.ts`; this file is about the machinery: what a
 * cassette is, what order they are handed out in, and what happens at each of
 * the edges where replay could quietly lie instead of failing.
 *
 * Every failure asserted here is a failure on purpose. Record-and-replay's
 * whole hazard is a suite that stays green while proving less, so "ran off the
 * end of the fixtures", "answered a prompt that has since changed" and "sent a
 * turn nobody recorded" all have to be loud.
 */

const stage: AgentSessionStage = "deliberator";

const cassette = (overrides: Partial<AgentCassette> = {}): AgentCassette => ({
  stage,
  recordedAt: "2026-08-07T00:00:00.000Z",
  promptFingerprint: agentPromptFingerprint(stage),
  provenance: "test",
  turns: [{ prompt: "p", reply: "one", usage: ZERO_TOKEN_USAGE, costUsd: 0.25 }],
  ...overrides,
});

const request = (over: Partial<{ stage: AgentSessionStage; prompt: string }> = {}) => ({
  stage: over.stage ?? stage,
  prompt: over.prompt ?? "prompt",
  config: { maxTurns: 1, wallClockMs: 1000 },
  allowedTools: ["Read"] as ReadonlyArray<string>,
});

/** The failure message of an effect expected to fail — the thing a reader has to be able to act on. */
const failureOf = <A>(effect: Effect.Effect<A, DeliberationRunKilledError>): Promise<string> =>
  Effect.runPromise(Effect.flip(effect)).then((error) => error.message);

const tempDirs: Array<string> = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repcoach-cassette-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- parse --- */

describe("parsing a cassette", () => {
  it("refuses a stage that is not one of the four agent sessions", () => {
    expect(() => parseCassette({ stage: "coach", turns: [{ reply: "x" }] }, "bad.json")).toThrow(
      AgentCassetteError,
    );
  });

  it("refuses an empty transcript rather than replaying nothing", () => {
    expect(() => parseCassette({ stage, turns: [] }, "bad.json")).toThrow(/non-empty/);
  });

  it("refuses a turn with no reply, instead of defaulting it to an empty string", () => {
    // A defaulted `""` would surface much later as "not valid JSON", pointing
    // at the model rather than at the fixture.
    expect(() => parseCassette({ stage, turns: [{ prompt: "p" }] }, "bad.json")).toThrow(/"reply"/);
  });

  it("keeps tool calls and usage, and zero-fills only what a recording genuinely lacks", () => {
    const parsed = parseCassette(
      {
        stage,
        turns: [{ reply: "r", toolCalls: [{ tool: "WebFetch", subject: "https://x" }, { tool: "Read" }] }],
      },
      "ok.json",
    );

    expect(parsed.turns[0]?.toolCalls).toEqual([
      { tool: "WebFetch", subject: "https://x" },
      { tool: "Read" },
    ]);
    expect(parsed.turns[0]?.usage).toEqual(ZERO_TOKEN_USAGE);
    expect(parsed.provenance).toBe("unknown");
  });

  it("names the missing directory rather than replaying an empty set", () => {
    expect(() => readCassetteDirectory(path.join(os.tmpdir(), "repcoach-no-such-cassettes"))).toThrow(
      /no cassette directory/,
    );
  });
});

/* --------------------------------------------------------------- replay --- */

describe("replaying one-shot sessions", () => {
  it("hands cassettes out per stage, in order", async () => {
    const { transport } = makeReplayTransport({
      cassettes: [
        cassette({ turns: [{ prompt: "p", reply: "first", usage: ZERO_TOKEN_USAGE, costUsd: 0 }] }),
        cassette({ turns: [{ prompt: "p", reply: "second", usage: ZERO_TOKEN_USAGE, costUsd: 0 }] }),
      ],
    });

    const a = await Effect.runPromise(transport.run(request()));
    const b = await Effect.runPromise(transport.run(request()));

    expect([a.text, b.text]).toEqual(["first", "second"]);
  });

  it("never crosses the streams: a sweep cannot be answered with the deliberator's transcript", async () => {
    const { transport } = makeReplayTransport({ cassettes: [cassette()] });

    const wrongStage = await failureOf(transport.run(request({ stage: "sweep" })));

    expect(wrongStage).toMatch(/no recorded cassette for the "sweep" session/);
  });

  it("fails loudly when a flow runs more sessions than were recorded", async () => {
    // Deliberately NOT a wrap-around. "This flow ran three deliberator sessions
    // and two were recorded" is a real finding about the flow or the fixtures,
    // and re-serving cassette 1 would bury it under a passing test.
    const { transport } = makeReplayTransport({ cassettes: [cassette()] });
    await Effect.runPromise(transport.run(request()));

    const second = await failureOf(transport.run(request()));

    expect(second).toMatch(/only 1 cassette\(s\) were recorded/);
  });

  it("rewinds on reset, so the next flow replays what the last one did", async () => {
    const { transport, reset } = makeReplayTransport({ cassettes: [cassette()] });
    await Effect.runPromise(transport.run(request()));

    reset();

    expect((await Effect.runPromise(transport.run(request()))).text).toBe("one");
  });

  it("carries the recorded usage and cost through, so spend reads the same as a live run's", async () => {
    const { transport } = makeReplayTransport({
      cassettes: [
        cassette({
          turns: [
            {
              prompt: "p",
              reply: "r",
              usage: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 },
              costUsd: 1.5,
            },
          ],
        }),
      ],
    });

    const result = await Effect.runPromise(transport.run(request()));

    expect(result.usage).toEqual({ input: 10, output: 20, cacheRead: 30, cacheCreation: 40 });
    expect(result.costUsd).toBe(1.5);
  });
});

describe("the staleness signal", () => {
  it("refuses a cassette recorded against a different prompt, and says how to fix it", async () => {
    const { transport } = makeReplayTransport({
      cassettes: [cassette({ promptFingerprint: "sha256:0000000000000000" })],
    });

    const outcome = await failureOf(transport.run(request()));

    expect(outcome).toMatch(/stale/);
    expect(outcome).toMatch(/sha256:0000000000000000/);
    expect(outcome).toMatch(/REPCOACH_AGENT_ALLOW_STALE_CASSETTES=1/);
  });

  it("replays it anyway when the override is set, for a prompt that is deliberately mid-change", async () => {
    const { transport } = makeReplayTransport({
      cassettes: [cassette({ promptFingerprint: "sha256:0000000000000000" })],
      allowStaleFingerprint: true,
    });

    expect((await Effect.runPromise(transport.run(request()))).text).toBe("one");
  });
});

describe("replaying a held-open Intake session", () => {
  const heldStage: AgentSessionStage = "intake-session";
  const held = makeReplayTransport({
    cassettes: [
      {
        stage: heldStage,
        recordedAt: "2026-08-07T00:00:00.000Z",
        promptFingerprint: agentPromptFingerprint(heldStage),
        provenance: "test",
        turns: [
          { prompt: "seed", reply: "cold", usage: ZERO_TOKEN_USAGE, costUsd: 0, toolCalls: [{ tool: "Read" }] },
          { prompt: "answer", reply: "revised", usage: ZERO_TOKEN_USAGE, costUsd: 0 },
        ],
      },
    ],
  });

  it("replays the transcript turn by turn, and reports the recorded tool activity", async () => {
    const seen: Array<string> = [];
    const opened = await Effect.runPromise(
      held.transport.openHeld({
        ...request({ stage: heldStage }),
        onToolCall: (call) => seen.push(call.tool),
      }),
    );

    const second = await Effect.runPromise(opened.session.send("Bad lower back"));
    const third = await failureOf(opened.session.send("and one more"));

    expect(opened.first.text).toBe("cold");
    expect(second.text).toBe("revised");
    // The activity line has real events to narrate, replayed from the run that
    // produced them (ADR 0014 §4 — never staged progress).
    expect(seen).toEqual(["Read"]);
    // A third turn was never recorded, and saying so beats inventing a reply.
    expect(third).toMatch(/only 2 turn\(s\) were recorded/);
    held.reset();
  });
});

/* ------------------------------------------------------------ recording --- */

describe("recording", () => {
  const stubResult = (text: string): AgentSdkSessionResult => ({
    text,
    usage: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
    costUsd: 0.5,
  });

  const stubTransport = (): AgentSdkTransport => ({
    run: () => Effect.succeed(stubResult("recorded reply")),
    openHeld: ({ onToolCall }) =>
      Effect.sync(() => {
        onToolCall({ tool: "WebSearch", subject: "frequency" });
        return {
          first: stubResult("cold draft"),
          session: {
            send: (text: string) => Effect.succeed(stubResult(`answer to ${text}`)),
            close: Effect.void,
          },
        };
      }),
  });

  it("writes a replayable cassette for a one-shot session", async () => {
    const dir = makeTempDir();
    const recording = makeRecordingTransport({ inner: stubTransport(), dir, provenance: "test run" });

    await Effect.runPromise(recording.run(request({ prompt: "the assembled seed" })));

    const [written] = readCassetteDirectory(dir);
    expect(written?.stage).toBe(stage);
    expect(written?.provenance).toBe("test run");
    expect(written?.promptFingerprint).toBe(agentPromptFingerprint(stage));
    // The prompt is stored in full: it is the artifact a refresh is judged
    // against, and the only record of what the model was actually asked.
    expect(written?.turns[0]?.prompt).toBe("the assembled seed");
    expect(written?.turns[0]?.reply).toBe("recorded reply");
    expect(written?.turns[0]?.costUsd).toBe(0.5);
  });

  it("flushes each turn of a held session as it completes, not at close", async () => {
    // A held-open Intake that dies on turn four is exactly the transcript worth
    // having; buffering until close would throw it away.
    const dir = makeTempDir();
    const recording = makeRecordingTransport({ inner: stubTransport(), dir });
    const opened = await Effect.runPromise(
      recording.openHeld({ ...request({ stage: "intake-session" }), onToolCall: () => {} }),
    );

    expect(readCassetteDirectory(dir)[0]?.turns.length).toBe(1);

    await Effect.runPromise(opened.session.send("Bad lower back"));

    const written = readCassetteDirectory(dir)[0];
    expect(written?.turns.length).toBe(2);
    expect(written?.turns[1]?.reply).toBe("answer to Bad lower back");
    expect(written?.turns[0]?.toolCalls).toEqual([{ tool: "WebSearch", subject: "frequency" }]);
  });

  it("round-trips: what the recorder wrote is what the replay hands back", async () => {
    const dir = makeTempDir();
    const recording = makeRecordingTransport({ inner: stubTransport(), dir });
    await Effect.runPromise(recording.run(request()));

    const { transport } = makeReplayTransport({ cassettes: readCassetteDirectory(dir) });
    const replayed = await Effect.runPromise(transport.run(request()));

    expect(replayed.text).toBe("recorded reply");
    expect(replayed.usage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 });
  });

  it("still forwards tool calls to the caller while recording them", async () => {
    const dir = makeTempDir();
    const recording = makeRecordingTransport({ inner: stubTransport(), dir });
    const seen: Array<string> = [];

    await Effect.runPromise(
      recording.openHeld({ ...request({ stage: "intake-session" }), onToolCall: (c) => seen.push(c.tool) }),
    );

    expect(seen).toEqual(["WebSearch"]);
  });
});
