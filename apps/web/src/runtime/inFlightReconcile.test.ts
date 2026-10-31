import { describe, expect, it } from "vitest";

import type { ActiveLoggedSessionSummary } from "@repcoach/contracts";

import { reconcileInFlight } from "./inFlightReconcile.ts";
import type { InFlightSession } from "./inFlightSession.ts";

/**
 * Rung 1 for the #147 reconcile decision: the pointer is a first-render hint,
 * the server's `active` list is the truth, and this pure function is where the
 * two are reconciled.
 */

const active = (id: string, startedAt: string, prescribed = "sess"): ActiveLoggedSessionSummary =>
  ({
    loggedSessionId: id as never,
    prescribedSessionId: prescribed as never,
    startedAt: startedAt as never,
    loggedSetCount: 0 as never,
  }) as ActiveLoggedSessionSummary;

const pointer = (id: string): InFlightSession =>
  ({
    loggedSessionId: id as never,
    prescribedSessionId: "sess" as never,
    startedAt: "2026-08-30T00:00:00.000Z",
  }) as InFlightSession;

describe("reconcileInFlight", () => {
  it("keeps a pointer the server still calls active", () => {
    const action = reconcileInFlight({
      pointer: pointer("L1"),
      activeSessions: [active("L1", "2026-08-30T09:00:00.000Z")],
    });
    expect(action).toEqual({ kind: "keep" });
  });

  it("adopts the server's active session when there is no pointer — the site-data-loss case", () => {
    const action = reconcileInFlight({
      pointer: undefined,
      activeSessions: [active("L9", "2026-08-30T09:00:00.000Z", "push-day")],
    });
    expect(action).toEqual({
      kind: "adopt",
      session: {
        loggedSessionId: "L9",
        prescribedSessionId: "push-day",
        startedAt: "2026-08-30T09:00:00.000Z",
      },
    });
  });

  it("adopts the newest-started when the server has several active rows", () => {
    const action = reconcileInFlight({
      pointer: undefined,
      activeSessions: [
        active("old", "2026-08-30T07:00:00.000Z"),
        active("new", "2026-08-30T11:00:00.000Z"),
      ],
    });
    expect(action.kind === "adopt" && action.session.loggedSessionId).toBe("new");
  });

  it("adopts the real active session when the pointer names one the server has dropped", () => {
    const action = reconcileInFlight({
      pointer: pointer("stale"),
      activeSessions: [active("real", "2026-08-30T09:00:00.000Z")],
    });
    expect(action.kind === "adopt" && action.session.loggedSessionId).toBe("real");
  });

  it("clears a pointer when the server says nothing is active", () => {
    const action = reconcileInFlight({ pointer: pointer("gone"), activeSessions: [] });
    expect(action).toEqual({ kind: "clear" });
  });

  it("does nothing when there is neither a pointer nor an active session", () => {
    const action = reconcileInFlight({ pointer: undefined, activeSessions: [] });
    expect(action).toEqual({ kind: "keep" });
  });
});
