import { describe, expect, it } from "vitest";

import type { BodyweightEntry } from "@repcoach/contracts";

import { bodyweightTrend, localDateKey, TREND_SMOOTHING, trendChange } from "./bodyweight.ts";

const entry = (date: string, weightKg: number): BodyweightEntry =>
  ({ date, weightKg, recordedAt: `${date}T07:00:00Z` }) as BodyweightEntry;

describe("bodyweightTrend", () => {
  it("starts at the first reading and moves a tenth of the way toward each daily one", () => {
    const points = bodyweightTrend([entry("2026-01-01", 80), entry("2026-01-02", 81)]);
    expect(points[0]?.trendKg).toBe(80);
    expect(points[1]?.trendKg).toBeCloseTo(80 + TREND_SMOOTHING * 1, 6);
  });

  it("moves as far over a gap as daily readings would have", () => {
    const gap = bodyweightTrend([entry("2026-01-01", 80), entry("2026-01-04", 83)]);
    // Three days' worth of smoothing toward 83.
    expect(gap[1]?.trendKg).toBeCloseTo(80 + (1 - 0.9 ** 3) * 3, 6);
  });

  it("sorts by date and damps a one-day spike", () => {
    const points = bodyweightTrend([
      entry("2026-01-03", 80),
      entry("2026-01-01", 80),
      entry("2026-01-02", 84),
    ]);
    expect(points.map((p) => p.date)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(points[1]!.trendKg).toBeLessThan(81);
  });
});

describe("trendChange", () => {
  // Thirty-one days of January, a tenth of a kilo lighter each day.
  const steadyLoss = Array.from({ length: 31 }, (_, i) =>
    entry(`2026-01-${String(i + 1).padStart(2, "0")}`, 90 - i * 0.1),
  );

  it("reads the change since the last reading at least N days back", () => {
    const points = bodyweightTrend(steadyLoss);
    const week = trendChange(points, 7);
    expect(week).toBeLessThan(0);
  });

  it("is undefined when the log does not reach back that far", () => {
    const points = bodyweightTrend([entry("2026-01-01", 80), entry("2026-01-03", 79)]);
    expect(trendChange(points, 7)).toBeUndefined();
    expect(trendChange([], 7)).toBeUndefined();
  });
});

describe("localDateKey", () => {
  it("formats a local day", () => {
    expect(localDateKey(new Date(2026, 0, 5, 7, 30))).toBe("2026-01-05");
  });
});
