import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { LogSetActualInput } from "./logging.ts";

const encode = Schema.encodeUnknownSync(LogSetActualInput);
const decode = Schema.decodeUnknownSync(LogSetActualInput);

const sampleLogSetActualInput = {
  commandId: "cmd-9f2e1a",
  loggedSessionId: "logged-session-1",
  sessionId: "session-1",
  entryId: "entry-1",
  setId: "set-1",
  setType: "working",
  // actual capture (ADR 0006) — scalar values only, never an interval.
  actual: { reps: 7, load: 60, rpe: 8.5 },
};

describe("LogSetActualInput", () => {
  it("round-trips (encode -> decode identity)", () => {
    const decoded = decode(sampleLogSetActualInput);
    const reEncoded = encode(decoded);
    const reDecoded = decode(reEncoded);

    expect(reDecoded).toEqual(decoded);
    expect(decoded.actual).toEqual({ reps: 7, load: 60, rpe: 8.5 });
  });

  it("is keyed by commandId for idempotent replay — same commandId decodes identically on replay", () => {
    const first = decode(sampleLogSetActualInput);
    const replayed = decode(sampleLogSetActualInput);

    expect(replayed.commandId).toBe(first.commandId);
    expect(replayed).toEqual(first);
  });

  it("rejects a malformed metric map — an interval where a scalar actual is required", () => {
    expect(() =>
      decode({
        ...sampleLogSetActualInput,
        // actual reps must be a scalar number, not a prescribed-style interval
        actual: { reps: { min: 7, max: 8 } },
      }),
    ).toThrow();
  });

  it("rejects a malformed metric map — a non-numeric metric value", () => {
    expect(() =>
      decode({
        ...sampleLogSetActualInput,
        actual: { reps: "seven" },
      }),
    ).toThrow();
  });

  it("rejects an unknown set-type tag", () => {
    expect(() =>
      decode({
        ...sampleLogSetActualInput,
        setType: "not-a-real-set-type",
      }),
    ).toThrow();
  });

  it("rejects a missing commandId", () => {
    const { commandId: _commandId, ...withoutCommandId } = sampleLogSetActualInput;
    expect(() => decode(withoutCommandId)).toThrow();
  });
});
