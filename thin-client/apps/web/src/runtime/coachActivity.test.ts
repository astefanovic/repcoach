import { describe, expect, it } from "vitest";

import {
  coachHasUnseenActivity,
  seenThrough,
  type CoachActivityRun,
} from "./coachActivity.ts";

/**
 * Rung 1 for the Coach activity pip (#150). The pip predicate is the one piece
 * of this feature with real logic — the `localStorage` marker and the React
 * hook are DOM adapters proven by the Playwright flow, the same split
 * `inFlightSession.ts` / `statusStrip.ts` already make.
 *
 * These pin the *rules* the ADR settles, not wording: a settled run newer than
 * last-seen lights it, a run in flight never does, the numeric badge is a
 * separate concern this file does not touch.
 */

const run = (over: Partial<CoachActivityRun> & Pick<CoachActivityRun, "runId">): CoachActivityRun => ({
  outcome: "committed",
  startedAt: "2026-08-01T10:00:00.000Z",
  ...over,
});

describe("coachHasUnseenActivity", () => {
  it("lights when a settled run is newer than last seen", () => {
    expect(
      coachHasUnseenActivity({
        runs: [run({ runId: "r1", finishedAt: "2026-08-02T10:00:00.000Z" })],
        lastSeenAt: "2026-08-01T12:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("stays dark when every settled run is older than last seen", () => {
    expect(
      coachHasUnseenActivity({
        runs: [
          run({ runId: "r1", finishedAt: "2026-08-01T10:05:00.000Z" }),
          run({ runId: "r2", finishedAt: "2026-08-01T11:00:00.000Z" }),
        ],
        lastSeenAt: "2026-08-01T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("lights when the record has never been opened and any settled run exists", () => {
    expect(
      coachHasUnseenActivity({
        runs: [run({ runId: "r1" })],
        lastSeenAt: undefined,
      }),
    ).toBe(true);
  });

  it("does not light for a run still in flight, even a brand-new one", () => {
    expect(
      coachHasUnseenActivity({
        runs: [run({ runId: "r1", outcome: "running", startedAt: "2026-09-01T10:00:00.000Z" })],
        lastSeenAt: "2026-08-01T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("lights for a failed run — a failure that lives only on the strip is gone once you look away", () => {
    expect(
      coachHasUnseenActivity({
        runs: [
          run({ runId: "r1", outcome: "failed", finishedAt: "2026-08-03T10:00:00.000Z" }),
        ],
        lastSeenAt: "2026-08-02T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("uses startedAt when a settled run has no finishedAt", () => {
    expect(
      coachHasUnseenActivity({
        runs: [run({ runId: "r1", outcome: "committed", startedAt: "2026-08-05T10:00:00.000Z" })],
        lastSeenAt: "2026-08-04T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  describe("reconnect replay", () => {
    it("is unchanged when the same runs are replayed (accumulate-by-id, deduped input)", () => {
      const runs = [
        run({ runId: "r1", finishedAt: "2026-08-02T10:00:00.000Z" }),
        run({ runId: "r2", finishedAt: "2026-08-02T11:00:00.000Z" }),
      ];
      const input = { runs, lastSeenAt: "2026-08-02T12:00:00.000Z" } as const;
      expect(coachHasUnseenActivity(input)).toBe(false);
      // a replay hands back the same set — same answer
      expect(coachHasUnseenActivity({ ...input, runs: [...runs, ...runs] })).toBe(false);
    });

    it("flips on exactly when a run's closing emission replaces its running one", () => {
      const seen = "2026-09-01T09:00:00.000Z";
      const running: CoachActivityRun = {
        runId: "r1",
        outcome: "running",
        startedAt: "2026-09-01T10:00:00.000Z",
      };
      expect(coachHasUnseenActivity({ runs: [running], lastSeenAt: seen })).toBe(false);

      const committed: CoachActivityRun = {
        ...running,
        outcome: "committed",
        finishedAt: "2026-09-01T10:03:00.000Z",
      };
      expect(coachHasUnseenActivity({ runs: [committed], lastSeenAt: seen })).toBe(true);
    });
  });
});

describe("seenThrough", () => {
  it("returns the newest settled run when it is ahead of now", () => {
    expect(
      seenThrough(
        [
          { runId: "r1", outcome: "committed", startedAt: "2026-08-01T10:00:00.000Z", finishedAt: "2026-08-01T10:05:00.000Z" },
          { runId: "r2", outcome: "failed", startedAt: "2026-08-09T10:00:00.000Z", finishedAt: "2026-08-09T10:02:00.000Z" },
        ],
        "2026-08-05T00:00:00.000Z",
      ),
    ).toBe("2026-08-09T10:02:00.000Z");
  });

  it("ignores a run in flight and falls back to now when nothing has settled", () => {
    expect(
      seenThrough(
        [{ runId: "r1", outcome: "running", startedAt: "2026-08-20T10:00:00.000Z" }],
        "2026-08-10T00:00:00.000Z",
      ),
    ).toBe("2026-08-10T00:00:00.000Z");
  });

  it("marking seen through the newest run makes the pip go dark", () => {
    const runs: CoachActivityRun[] = [
      { runId: "r1", outcome: "committed", startedAt: "2026-08-01T10:00:00.000Z", finishedAt: "2026-08-02T10:00:00.000Z" },
    ];
    const marked = seenThrough(runs, "2026-08-01T00:00:00.000Z");
    expect(coachHasUnseenActivity({ runs, lastSeenAt: marked })).toBe(false);
  });
});
