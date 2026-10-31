import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";

import {
  DeliberationRunKilledError,
  buildRepairInstruction,
  decodeAgentPayload,
  decodeAgentPayloadWithRepair,
  extractJsonPayload,
  makeAgentPayloadShape,
  type AgentSdkSessionResult,
} from "./agentSdkSession.ts";

/**
 * Issue #94: a live session whose final message is not bare JSON must be
 * RECOVERED rather than kill the run. The old defence was a single regex that
 * stripped one markdown fence — safe while every agent was canned and returned
 * a literal object, and a matter of time against a real model. The failure was
 * total: a run that did all the retrieval, all the reasoning and all the
 * verification thrown away over how it wrapped its answer.
 *
 * Two layers, in cost order. The extraction is free and runs on every message;
 * the one repair turn costs a tiny session and runs only when the extraction
 * has already failed.
 */

const OBJECT = { decisions: [], observation_directives: [] };

const usage = (input: number) => ({ input, output: 0, cacheRead: 0, cacheCreation: 0 }) as const;

const sessionResult = (text: string, input = 0, costUsd = 0): AgentSdkSessionResult => ({
  text,
  usage: usage(input),
  costUsd,
});

const TestShape = makeAgentPayloadShape({
  label: "test payload",
  schema: Schema.Struct({ summary: Schema.String, note: Schema.optionalKey(Schema.String) }),
});

/** Runs an Effect expected to succeed. */
const runValue = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

/** Runs an Effect expected to FAIL, handing back the failure value itself. */
const runFailure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

describe("extractJsonPayload: the free layer (issue #94)", () => {
  it("reads a bare object, the shape every agent is actually asked for", () => {
    expect(extractJsonPayload(JSON.stringify(OBJECT))).toEqual(OBJECT);
  });

  it("reads an object wrapped in prose on both sides", () => {
    const text = `Here is the run output you asked for:

${JSON.stringify(OBJECT)}

Let me know if you'd like me to revisit any of it.`;

    expect(extractJsonPayload(text)).toEqual(OBJECT);
  });

  it("reads every fence variant, including ones the old single regex missed", () => {
    const body = JSON.stringify(OBJECT);
    const variants = [
      "```json\n" + body + "\n```",
      "```JSON\n" + body + "\n```",
      "```\n" + body + "\n```",
      "````json\n" + body + "\n````",
      "~~~json\n" + body + "\n~~~",
      // Opened and never closed — the model ran out of message.
      "```json\n" + body,
      // Prose, then a fence.
      "Done. Output below.\n\n```json\n" + body + "\n```\n",
    ];

    for (const variant of variants) expect(extractJsonPayload(variant)).toEqual(OBJECT);
  });

  it("is not fooled by braces inside a string — the object is not truncated at the first inner brace", () => {
    const payload = { summary: "we go from {8} to {10} reps", note: 'a quoted \\" and a } brace' };

    expect(extractJsonPayload(`Here you go: ${JSON.stringify(payload)} — hope that helps.`)).toEqual(payload);
  });

  it("prefers the whole object over a fragment the surrounding prose happens to quote", () => {
    const real = { summary: "the real payload", note: "with everything in it" };
    const text = `I considered { "summary": "a draft" } first, but settled on:\n${JSON.stringify(real)}`;

    expect(extractJsonPayload(text)).toEqual(real);
  });

  it("returns undefined for prose with no object, and for a non-object payload", () => {
    expect(extractJsonPayload("I could not complete this review.")).toBeUndefined();
    expect(extractJsonPayload("[1, 2, 3]")).toBeUndefined();
    expect(extractJsonPayload('"just a string"')).toBeUndefined();
    expect(extractJsonPayload("")).toBeUndefined();
  });
});

describe("decodeAgentPayload: which way it failed (issue #94)", () => {
  it("decodes a recoverable message and reports no failure at all", async () => {
    const value = await runValue(decodeAgentPayload(TestShape, '```json\n{ "summary": "fine" }\n```'));

    expect(value).toEqual({ summary: "fine" });
  });

  it("calls prose with no object `no-json`", async () => {
    const failure = await runFailure(decodeAgentPayload(TestShape, "I was unable to finish."));

    expect(failure.reason).toBe("no-json");
  });

  it("calls a mangled object `invalid-json`, not `no-json` — different diagnoses", async () => {
    const failure = await runFailure(decodeAgentPayload(TestShape, '{ "summary": "trailing", }'));

    expect(failure.reason).toBe("invalid-json");
  });

  it("calls a readable object of the wrong shape `contract`, and keeps an excerpt", async () => {
    const failure = await runFailure(decodeAgentPayload(TestShape, '{ "note": "no summary anywhere" }'));

    expect(failure.reason).toBe("contract");
    expect(failure.detail).toContain("test payload");
    expect(failure.detail).toContain("no summary anywhere");
  });
});

describe("decodeAgentPayloadWithRepair: bounded recovery (issue #94)", () => {
  it("spends nothing when the message reads first time", async () => {
    const repair = vi.fn(() => Effect.succeed(sessionResult("never called")));

    const decoded = await runValue(
      decodeAgentPayloadWithRepair({
        shape: TestShape,
        session: sessionResult('{ "summary": "fine" }', 100, 0.5),
        repair,
      }),
    );

    expect(repair).not.toHaveBeenCalled();
    expect(decoded).toEqual({ value: { summary: "fine" }, usage: usage(100), costUsd: 0.5 });
  });

  it("recovers a message the extraction could not read by asking once", async () => {
    const repair = vi.fn(() => Effect.succeed(sessionResult('{ "summary": "repaired" }', 20, 0.1)));

    const decoded = await runValue(
      decodeAgentPayloadWithRepair({
        shape: TestShape,
        session: sessionResult("I finished, but here is my answer in prose.", 100, 0.5),
        repair,
      }),
    );

    expect(repair).toHaveBeenCalledTimes(1);
    expect(decoded.value).toEqual({ summary: "repaired" });
    // Both turns' spend, summed: a rescue that hid its own cost would make the
    // cheapest possible bug — a model that needs repairing on EVERY run —
    // invisible in the numbers meant to catch it (ADR 0011 §8).
    expect(decoded.usage).toEqual(usage(120));
    expect(decoded.costUsd).toBeCloseTo(0.6);
  });

  it("asks EXACTLY once — a repair that fails the same way does not buy another", async () => {
    const repair = vi.fn(() => Effect.succeed(sessionResult("still prose, still no object")));

    const failure = await runFailure(
      decodeAgentPayloadWithRepair({ shape: TestShape, session: sessionResult("prose"), repair }),
    );

    expect(repair).toHaveBeenCalledTimes(1);
    // Both stories survive: "recovery was tried and did not work" is a
    // different diagnosis from "the output was bad".
    expect(failure.detail).toContain("the one repair turn did not fix it");
  });

  it("fails with a clear reason when the repair turn itself could not run", async () => {
    const repair = vi.fn(() =>
      Effect.fail(
        new DeliberationRunKilledError({ reason: "could-not-start", detail: "OAuth token expired" }),
      ),
    );

    const failure = await runFailure(
      decodeAgentPayloadWithRepair({ shape: TestShape, session: sessionResult("prose"), repair }),
    );

    expect(failure.reason).toBe("no-json");
    expect(failure.detail).toContain("the one repair turn could not run");
    expect(failure.detail).toContain("OAuth token expired");
  });

  it("repairs a contract deviation too — the drift class commissioning actually saw (issue #93)", async () => {
    const repair = vi.fn((_instruction: string) =>
      Effect.succeed(sessionResult('{ "summary": "now with a summary" }')),
    );

    const decoded = await runValue(
      decodeAgentPayloadWithRepair({
        shape: TestShape,
        session: sessionResult('{ "note": "the required key is missing" }'),
        repair,
      }),
    );

    expect(decoded.value).toEqual({ summary: "now with a summary" });
    // The ask names the deviation rather than re-stating the format rules, and
    // forbids re-reasoning: the substance being rescued is what was already done.
    const instruction = repair.mock.calls[0]?.[0] ?? "";
    expect(instruction).toContain("test payload failed contract decode");
    expect(instruction).toContain("Do NOT redo any reasoning");
  });
});

describe("buildRepairInstruction (issue #94)", () => {
  it("forbids inventing content to fill a hole", () => {
    const instruction = buildRepairInstruction({ reason: "contract", detail: "missing citations" });

    expect(instruction).toContain("missing citations");
    expect(instruction).toContain("never invent a citation");
  });
});
