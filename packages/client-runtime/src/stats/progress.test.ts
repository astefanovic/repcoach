import { describe, expect, it } from "vitest";

import type { ExerciseProgress } from "@repcoach/contracts";

import { chartableExercises, isPersonalRecord, plotSeries, progressPoints } from "./progress.ts";

const exercise = (
  exerciseId: string,
  sessions: ReadonlyArray<{ at: string; sets: ReadonlyArray<{ load?: number; reps?: number; setType?: "working" | "warmup" }> }>,
): ExerciseProgress =>
  ({
    exerciseId,
    sessions: sessions.map((session, i) => ({
      loggedSessionId: `ls-${exerciseId}-${i}`,
      performedAt: session.at,
      sets: session.sets.map((set) => ({ setType: set.setType ?? "working", ...set })),
    })),
  }) as unknown as ExerciseProgress;

describe("progressPoints", () => {
  it("takes each session's best e1RM, its volume, and marks only sessions that beat every earlier one", () => {
    const points = progressPoints(
      exercise("squat", [
        { at: "2026-01-01", sets: [{ load: 100, reps: 5 }, { load: 100, reps: 5 }] },
        { at: "2026-01-08", sets: [{ load: 105, reps: 5 }] },
        { at: "2026-01-15", sets: [{ load: 100, reps: 3 }] },
        { at: "2026-01-22", sets: [{ load: 60, reps: 10, setType: "warmup" }, { load: 110, reps: 5 }] },
      ]),
    );
    expect(points.map((p) => p.isPr)).toEqual([false, true, false, true]);
    expect(points[0]?.e1rm).toBeCloseTo(116.667, 2);
    expect(points[0]?.volume).toBe(1000);
    expect(points[3]?.topSet).toEqual({ load: 110, reps: 5 });
    // The warmup counts for neither volume nor set count.
    expect(points[3]?.volume).toBe(550);
    expect(points[3]?.setCount).toBe(1);
  });

  it("orders by date whatever order the sessions arrive in", () => {
    const points = progressPoints(
      exercise("bench", [
        { at: "2026-02-01", sets: [{ load: 80, reps: 5 }] },
        { at: "2026-01-01", sets: [{ load: 70, reps: 5 }] },
      ]),
    );
    expect(points.map((p) => p.performedAt)).toEqual(["2026-01-01", "2026-02-01"]);
    expect(points[1]?.isPr).toBe(true);
  });

  it("leaves e1RM undefined for a bodyweight session and never calls it a record", () => {
    const points = progressPoints(exercise("pull-up", [{ at: "2026-01-01", sets: [{ reps: 10 }] }]));
    expect(points[0]).toMatchObject({ e1rm: undefined, volume: 0, setCount: 1, isPr: false });
  });
});

describe("isPersonalRecord", () => {
  it("is a record only when it beats the historical best", () => {
    expect(isPersonalRecord({ load: 105, reps: 5 }, "working", 116.67)).toBe(true);
    expect(isPersonalRecord({ load: 100, reps: 5 }, "working", 116.67)).toBe(false);
  });

  it("is never a record with no history, for a warmup, or without a load", () => {
    expect(isPersonalRecord({ load: 200, reps: 1 }, "working", undefined)).toBe(false);
    expect(isPersonalRecord({ load: 200, reps: 1 }, "warmup", 100)).toBe(false);
    expect(isPersonalRecord({ reps: 30 }, "working", 100)).toBe(false);
  });
});

describe("chartableExercises", () => {
  it("lists the most recently performed first and drops warmup-only exercises", () => {
    const list = chartableExercises([
      exercise("old", [{ at: "2026-01-01", sets: [{ load: 1, reps: 1 }] }]),
      exercise("warm", [{ at: "2026-03-01", sets: [{ load: 1, reps: 1, setType: "warmup" }] }]),
      exercise("new", [{ at: "2026-02-01", sets: [{ load: 1, reps: 1 }] }]),
    ]);
    expect(list.map((e) => e.exerciseId)).toEqual(["new", "old"]);
  });
});

describe("plotSeries", () => {
  it("spreads points across the width and keeps them inside the box", () => {
    const { points } = plotSeries([100, undefined, 110, 120], { width: 300, height: 100 });
    expect(points.map((p) => p.x)).toEqual([0, 200, 300]);
    for (const point of points) {
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(100);
    }
    // Higher is up.
    expect(points[2]!.y).toBeLessThan(points[0]!.y);
  });

  it("centres a single point and survives a flat series", () => {
    expect(plotSeries([80], { width: 300, height: 100 }).points[0]).toMatchObject({ x: 150, y: 50 });
    expect(plotSeries([], { width: 300, height: 100 }).points).toEqual([]);
  });
});
