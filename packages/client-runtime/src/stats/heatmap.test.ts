import { describe, expect, it } from "vitest";

import { bucketFor, buildWeekColumns, computeBucketThresholds, type CalendarDay } from "./heatmap.ts";

/** Issue #117 Rung 1 — pure bucketing and week-column layout, no DOM, no clock. */

describe("computeBucketThresholds", () => {
  it("falls back to a fixed low-sample scale with no active days at all", () => {
    expect(computeBucketThresholds([])).toEqual([1, 2, 3]);
  });

  it("derives thresholds from the user's own distribution, not a fixed absolute scale", () => {
    // A heavy user's "quiet" day (2 sets) would be a big day for someone
    // whose max is 4 — the thresholds must move with the data, not be pinned
    // to GitHub's 1/10/20/30.
    const heavy = computeBucketThresholds([10, 12, 15, 18, 20, 22, 25, 28, 30, 32]);
    const light = computeBucketThresholds([1, 2, 2, 3, 4]);
    expect(heavy[0]).toBeGreaterThan(light[0]);
  });

  it("thresholds are always non-decreasing, even with heavy ties", () => {
    const [t1, t2, t3] = computeBucketThresholds([3, 3, 3, 3, 3]);
    expect(t1).toBeLessThanOrEqual(t2);
    expect(t2).toBeLessThanOrEqual(t3);
  });
});

describe("bucketFor", () => {
  const thresholds: readonly [number, number, number] = [2, 5, 9];

  it("zero or negative sets is bucket 0 — categorical 'did not train', not the scale's bottom", () => {
    expect(bucketFor(0, thresholds)).toBe(0);
  });

  it("buckets rise with the threshold boundaries", () => {
    expect(bucketFor(1, thresholds)).toBe(1);
    expect(bucketFor(2, thresholds)).toBe(1);
    expect(bucketFor(3, thresholds)).toBe(2);
    expect(bucketFor(5, thresholds)).toBe(2);
    expect(bucketFor(6, thresholds)).toBe(3);
    expect(bucketFor(9, thresholds)).toBe(3);
    expect(bucketFor(10, thresholds)).toBe(4);
  });
});

describe("buildWeekColumns", () => {
  // A Wednesday, chosen arbitrarily but fixed so every assertion below is
  // deterministic. 2026-08-12 is a Wednesday.
  const today: CalendarDay = { year: 2026, month: 8, day: 12 };

  it("ends on today's own week, with days after today left blank (not zero)", () => {
    const columns = buildWeekColumns([], { weeksBack: 0, today });
    expect(columns).toHaveLength(1);
    const week = columns[0]!;
    expect(week).toHaveLength(7);
    // Sunday-first: index 0 = Sun 8/9 .. index 6 = Sat 8/15. Today (Wed) is index 3.
    expect(week[3]?.date).toBe("2026-08-12");
    expect(week[3]?.setCount).toBe(0);
    // Thursday/Friday/Saturday this week have not happened yet.
    expect(week[4]).toBeUndefined();
    expect(week[5]).toBeUndefined();
    expect(week[6]).toBeUndefined();
    // Sunday through Tuesday already happened, and are honestly empty (0), not blank.
    expect(week[0]?.setCount).toBe(0);
    expect(week[0]).not.toBeUndefined();
  });

  it("produces weeksBack + 1 columns, oldest first", () => {
    const columns = buildWeekColumns([], { weeksBack: 3, today });
    expect(columns).toHaveLength(4);
    const firstDayOfFirstColumn = columns[0]!.find((c) => c !== undefined)?.date;
    const lastColumn = columns[3]!;
    expect(firstDayOfFirstColumn).toBeDefined();
    expect(lastColumn.some((c) => c?.date === "2026-08-12")).toBe(true);
  });

  it("carries real counts through to the matching cell and buckets them", () => {
    const columns = buildWeekColumns(
      [
        { date: "2026-08-10", setCount: 1 },
        { date: "2026-08-11", setCount: 12 },
      ],
      { weeksBack: 0, today },
    );
    const week = columns[0]!;
    const monday = week[1]; // 8/10 is a Monday
    const tuesday = week[2]; // 8/11 is a Tuesday
    expect(monday?.setCount).toBe(1);
    expect(tuesday?.setCount).toBe(12);
    expect(tuesday!.bucket).toBeGreaterThan(monday!.bucket);
  });

  it("a day with data outside the window simply never appears — no crash, no leak into an adjacent cell", () => {
    const columns = buildWeekColumns([{ date: "2020-01-01", setCount: 99 }], { weeksBack: 0, today });
    const allDates = columns.flat().filter((c) => c !== undefined).map((c) => c!.date);
    expect(allDates).not.toContain("2020-01-01");
  });
});
