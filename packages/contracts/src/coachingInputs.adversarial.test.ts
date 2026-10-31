import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { AddCheckInInput, AddContextNoteInput, SetGoalInput } from "./coachingInputs.ts";

/**
 * Adversarial black-box coverage for the coaching-input RPC payload schemas
 * (issue #34). These schemas ARE the RPC input validation boundary (each is
 * wired verbatim as an `Rpc.make(..., { payload: ... })` in `rpc.ts`), so
 * decoding here is equivalent to sending the RPC — no server needed.
 *
 * Spec under test: "sleep/soreness/stress/energy validated to 1-5 on the RPC
 * input — out-of-range (0, 6, negative, non-integer) REJECTED; boundaries 1
 * and 5 ACCEPTED."
 */

const decodeCheckIn = Schema.decodeUnknownSync(AddCheckInInput);
const decodeCheckInEither = Schema.decodeUnknownExit(AddCheckInInput);

const validCheckIn = {
  recordedAt: "2026-07-10T08:00:00.000Z",
  sleep: 3,
  soreness: 3,
  stress: 3,
  energy: 3,
};

describe("AddCheckInInput — rating bounds (1-5 inclusive integer)", () => {
  const fields = ["sleep", "soreness", "stress", "energy"] as const;

  for (const field of fields) {
    describe(`field: ${field}`, () => {
      it("accepts the lower boundary 1", () => {
        expect(() => decodeCheckIn({ ...validCheckIn, [field]: 1 })).not.toThrow();
      });

      it("accepts the upper boundary 5", () => {
        expect(() => decodeCheckIn({ ...validCheckIn, [field]: 5 })).not.toThrow();
      });

      it("rejects 0 (below range)", () => {
        expect(decodeCheckInEither({ ...validCheckIn, [field]: 0 })._tag).toBe("Failure");
      });

      it("rejects 6 (above range)", () => {
        expect(decodeCheckInEither({ ...validCheckIn, [field]: 6 })._tag).toBe("Failure");
      });

      it("rejects a negative value", () => {
        expect(decodeCheckInEither({ ...validCheckIn, [field]: -1 })._tag).toBe("Failure");
      });

      it("rejects a non-integer value within range (1.5)", () => {
        expect(decodeCheckInEither({ ...validCheckIn, [field]: 1.5 })._tag).toBe("Failure");
      });
    });
  }

  it("accepts a fully valid check-in at the boundaries on every field simultaneously", () => {
    const decoded = decodeCheckIn({
      recordedAt: "2026-07-10T08:00:00.000Z",
      sleep: 1,
      soreness: 5,
      stress: 1,
      energy: 5,
    });
    expect(decoded).toEqual({
      recordedAt: "2026-07-10T08:00:00.000Z",
      sleep: 1,
      soreness: 5,
      stress: 1,
      energy: 5,
    });
  });

  it("recordedAt is optional — omitting it still decodes", () => {
    const { recordedAt: _drop, ...withoutRecordedAt } = validCheckIn;
    expect(() => decodeCheckIn(withoutRecordedAt)).not.toThrow();
  });

  it("a single out-of-range field rejects the WHOLE payload, even when the other three are valid", () => {
    expect(decodeCheckInEither({ ...validCheckIn, energy: 0 })._tag).toBe("Failure");
    expect(decodeCheckInEither({ ...validCheckIn, energy: 6 })._tag).toBe("Failure");
  });
});

describe("SetGoalInput", () => {
  const decode = Schema.decodeUnknownSync(SetGoalInput);
  const decodeEither = Schema.decodeUnknownExit(SetGoalInput);

  it("an empty proxies array decodes successfully — proxies are optional in substance, not required to be non-empty", () => {
    const decoded = decode({ statement: "Build strength", proxies: [] });
    expect(decoded.proxies).toEqual([]);
  });

  // NOTE: despite its name, `TrimmedNonEmptyString` (packages/contracts/src/
  // baseSchemas.ts) does NOT actually trim — it only checks `Schema.isNonEmpty()`,
  // so a whitespace-only string passes. This predates issue #34 (shared
  // infra used across many contracts, not introduced by this slice) and is
  // outside the agreed #34 spec, so this documents the actual behavior
  // rather than asserting the (misleadingly-named) rejection.
  it("a whitespace-only statement currently DECODES SUCCESSFULLY — TrimmedNonEmptyString does not trim, only checks non-emptiness", () => {
    expect(decodeEither({ statement: "   ", proxies: [] })._tag).toBe("Success");
  });
});

describe("AddContextNoteInput", () => {
  const decode = Schema.decodeUnknownSync(AddContextNoteInput);
  const decodeEither = Schema.decodeUnknownExit(AddContextNoteInput);

  it("recordedAt is optional", () => {
    expect(() => decode({ text: "Traveling next week" })).not.toThrow();
  });

  // See the equivalent NOTE above `SetGoalInput`'s test — same shared,
  // not-actually-trimming schema.
  it("a whitespace-only text currently DECODES SUCCESSFULLY — TrimmedNonEmptyString does not trim, only checks non-emptiness", () => {
    expect(decodeEither({ text: "   " })._tag).toBe("Success");
  });
});
