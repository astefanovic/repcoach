import { describe, expect, it } from "vitest";

import type { DeliberationRunRecord } from "@repcoach/contracts";

import { groupRuns } from "./runGroups.ts";

/**
 * The drain retries a failed Session review every tick, so one lasting cause
 * (an expired login) wrote a red node per tick and buried the reviews that
 * ran. Identical consecutive failures fold into one node.
 */

const LOGIN = "Claude Code is not signed in — run /login";

let seq = 0;
const run = (
  outcome: DeliberationRunRecord["outcome"],
  extra: Partial<DeliberationRunRecord> = {},
): DeliberationRunRecord =>
  ({
    runId: `run-${++seq}`,
    cadence: "session-review",
    outcome,
    startedAt: "2026-10-31T08:00:00.000Z",
    stages: [],
    decisions: [],
    ...(outcome === "failed" ? { failureReason: LOGIN } : {}),
    ...extra,
  }) as DeliberationRunRecord;

describe("repeated failures fold on the Coach rail", () => {
  it("folds a streak of the same failure into its newest run", () => {
    const newest = run("failed");
    const runs = [newest, run("failed"), run("failed")];

    const groups = groupRuns(runs);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.run).toBe(newest);
    expect(groups[0]?.attempts).toEqual(runs);
  });

  it("does not fold across a run that succeeded in between", () => {
    const groups = groupRuns([run("failed"), run("committed"), run("failed")]);

    expect(groups.map((group) => group.attempts.length)).toEqual([1, 1, 1]);
  });

  it("keeps different failure reasons apart", () => {
    const groups = groupRuns([
      run("failed"),
      run("failed", { failureReason: "Deliberation run killed (wall-clock)" }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("keeps the same reason on a different cadence apart", () => {
    const groups = groupRuns([run("failed"), run("failed", { cadence: "cycle-review" })]);

    expect(groups).toHaveLength(2);
  });

  it("never folds runs that did not fail", () => {
    const groups = groupRuns([run("committed"), run("committed")]);

    expect(groups).toHaveLength(2);
  });
});
