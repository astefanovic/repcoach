import { describe, expect, it } from "vitest";

import type { PrescribedSession, SessionId } from "@repcoach/contracts";

import { nextUpSession } from "./nextUp.ts";

/**
 * Next up (ADR 0023 §2) is a pure function of the Plan's authored order and
 * the finished workouts, newest first. These pin each rule the ADR names.
 */

const id = (value: string) => value as SessionId;

const session = (sessionId: string, { empty = false } = {}): PrescribedSession =>
  ({
    id: id(sessionId),
    name: sessionId,
    blocks: empty
      ? []
      : [{ id: `${sessionId}-block`, format: "straight", entries: [{ id: `${sessionId}-entry`, exerciseId: "bench", sets: [] }] }],
  }) as never;

const abc = [session("A"), session("B"), session("C")];

describe("nextUpSession", () => {
  it("is the first session when nothing has been finished", () => {
    expect(nextUpSession(abc, [])).toBe("A");
  });

  it("is the session after the one the last finished workout came from", () => {
    expect(nextUpSession(abc, [id("A")])).toBe("B");
    expect(nextUpSession(abc, [id("B"), id("A")])).toBe("C");
  });

  it("wraps from the last session back to the first", () => {
    expect(nextUpSession(abc, [id("C")])).toBe("A");
  });

  it("looks further back when the last finished session was deleted from the Plan", () => {
    expect(nextUpSession(abc, [id("gone"), id("B")])).toBe("C");
  });

  it("falls back to the first session when no finished workout's session still exists", () => {
    expect(nextUpSession(abc, [id("gone"), id("also-gone")])).toBe("A");
  });

  it("skips empty sessions, including across the wrap", () => {
    const plan = [session("A"), session("B", { empty: true }), session("C", { empty: true })];
    expect(nextUpSession(plan, [id("A")])).toBe("A");
    expect(nextUpSession([session("A", { empty: true }), session("B")], [])).toBe("B");
    expect(nextUpSession([session("A"), session("B", { empty: true }), session("C")], [id("A")])).toBe("C");
  });

  it("follows the Plan's current order, not the order a workout was started in", () => {
    const reordered = [session("C"), session("A"), session("B")];
    expect(nextUpSession(reordered, [id("C")])).toBe("A");
  });

  it("is nothing when no session can be started", () => {
    expect(nextUpSession([], [])).toBeUndefined();
    expect(nextUpSession([session("A", { empty: true })], [id("A")])).toBeUndefined();
  });
});
