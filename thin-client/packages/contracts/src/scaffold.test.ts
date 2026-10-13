import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { PrescribedSession } from "./scaffold.ts";

const encode = Schema.encodeUnknownSync(PrescribedSession);
const decode = Schema.decodeUnknownSync(PrescribedSession);

const samplePrescribedSession = {
  id: "session-1",
  blocks: [
    {
      // A straight Block is a real node at the schema level (ADR 0001) —
      // hidden only in the UI, never in the data.
      id: "block-1",
      format: "straight",
      entries: [
        {
          id: "entry-1",
          exerciseId: "exercise-bench-press",
          sets: [
            {
              id: "set-1",
              setType: "working",
              // exact target: min === max
              target: { reps: { min: 8, max: 8 }, load: { min: 60, max: 60 } },
              restSec: 120,
            },
            {
              id: "set-2",
              setType: "working",
              // a range target: "8-10"
              target: { reps: { min: 8, max: 10 } },
            },
            {
              id: "set-3",
              setType: "drop",
              // an open rpe entry: "report effort, no target"
              target: { rpe: {} },
            },
          ],
        },
      ],
    },
    {
      id: "block-2",
      format: "superset",
      params: { targetRounds: 3 },
      entries: [
        {
          id: "entry-2",
          exerciseId: "exercise-plank",
          sets: [
            {
              id: "set-4",
              setType: "working",
              // time-based work: duration in place of reps (ADR 0001)
              target: { duration: { min: 30 } },
            },
          ],
        },
      ],
    },
  ],
};

describe("PrescribedSession", () => {
  it("round-trips (encode -> decode identity) the full Session -> Block -> Entry -> Set tree", () => {
    const decoded = decode(samplePrescribedSession);
    const reEncoded = encode(decoded);
    const reDecoded = decode(reEncoded);

    expect(reDecoded).toEqual(decoded);
    expect(decoded.blocks[0]?.format).toBe("straight");
    expect(decoded.blocks[0]?.entries[0]?.sets[0]?.target.reps).toEqual({ min: 8, max: 8 });
    expect(decoded.blocks[0]?.entries[0]?.sets[2]?.target.rpe).toEqual({});
    expect(decoded.blocks[1]?.params?.targetRounds).toBe(3);
  });

  it("rejects a Session missing required scaffold structure", () => {
    expect(() => decode({ id: "session-1" })).toThrow();
    expect(() => decode({ id: "session-1", blocks: [{ id: "block-1" }] })).toThrow();
  });
});
