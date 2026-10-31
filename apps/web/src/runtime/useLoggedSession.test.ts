import { describe, expect, it } from "vitest";

import type { LoggedSession } from "@repcoach/contracts";

import { foldServerActuals } from "./useLoggedSession.ts";

/**
 * Rung 1 for the net-state fold (#83, ADR 0019): `log -> un-log -> log` and
 * `log -> log -> un-log` must differ, and only this fold decides how. Fixture
 * rows use `as never` for branded ids, matching the rest of the codebase's
 * seed-building convention.
 */

const log = (setId: string, appliedAt: string): LoggedSession["actuals"][number] =>
  ({
    commandId: `cmd-${appliedAt}` as never,
    loggedSessionId: "logged-1" as never,
    sessionId: "session-1" as never,
    entryId: "entry-1" as never,
    setId: setId as never,
    setType: "working" as never,
    actual: { reps: 5, load: 100 } as never,
    appliedAt,
    retraction: false,
  }) as LoggedSession["actuals"][number];

const unlog = (setId: string, appliedAt: string): LoggedSession["actuals"][number] =>
  ({
    commandId: `cmd-${appliedAt}` as never,
    loggedSessionId: "logged-1" as never,
    entryId: "entry-1" as never,
    setId: setId as never,
    appliedAt,
    retraction: true,
  }) as LoggedSession["actuals"][number];

describe("foldServerActuals", () => {
  it("a plain log is logged", () => {
    const result = foldServerActuals([log("set-1", "2026-08-23T00:00:00.000Z")]);
    expect(result.has("set-1" as never)).toBe(true);
  });

  it("log -> un-log leaves the Set unlogged", () => {
    const result = foldServerActuals([
      log("set-1", "2026-08-23T00:00:00.000Z"),
      unlog("set-1", "2026-08-23T00:00:10.000Z"),
    ]);
    expect(result.has("set-1" as never)).toBe(false);
  });

  it("log -> un-log -> log ends logged again", () => {
    const result = foldServerActuals([
      log("set-1", "2026-08-23T00:00:00.000Z"),
      unlog("set-1", "2026-08-23T00:00:10.000Z"),
      log("set-1", "2026-08-23T00:00:20.000Z"),
    ]);
    expect(result.has("set-1" as never)).toBe(true);
  });

  it("log -> log -> un-log ends unlogged — differs from the reverse order by the fold alone", () => {
    const result = foldServerActuals([
      log("set-1", "2026-08-23T00:00:00.000Z"),
      log("set-1", "2026-08-23T00:00:10.000Z"),
      unlog("set-1", "2026-08-23T00:00:20.000Z"),
    ]);
    expect(result.has("set-1" as never)).toBe(false);
  });

  it("a retraction for a different Set leaves this one alone", () => {
    const result = foldServerActuals([
      log("set-1", "2026-08-23T00:00:00.000Z"),
      unlog("set-2", "2026-08-23T00:00:10.000Z"),
    ]);
    expect(result.has("set-1" as never)).toBe(true);
    expect(result.has("set-2" as never)).toBe(false);
  });
});
