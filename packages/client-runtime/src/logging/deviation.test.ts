import { describe, expect, it } from "vitest";

import {
  deviationDelta,
  hasDeviation,
  isDeviated,
  metricDeviation,
  setDeviations,
} from "./deviation.ts";

/**
 * #72 Rung 1 — per-metric deviation against a prescribed *interval*. The
 * case the prototype's number-or-pair model could not express (an actual
 * inside a prescribed range is not a deviation) is the first one here.
 */

describe("metricDeviation", () => {
  it("an actual inside a prescribed range is not a deviation", () => {
    expect(metricDeviation({ min: 5, max: 8 }, 7)).toEqual({ status: "on-target" });
    expect(metricDeviation({ min: 5, max: 8 }, 5)).toEqual({ status: "on-target" });
    expect(metricDeviation({ min: 5, max: 8 }, 8)).toEqual({ status: "on-target" });
  });

  it("measures a miss from the nearest violated bound", () => {
    expect(metricDeviation({ min: 5, max: 8 }, 4)).toEqual({ status: "under", by: 1 });
    expect(metricDeviation({ min: 5, max: 8 }, 10)).toEqual({ status: "over", by: 2 });
  });

  it("treats an exact target (min === max) as the degenerate range", () => {
    expect(metricDeviation({ min: 80, max: 80 }, 80)).toEqual({ status: "on-target" });
    expect(metricDeviation({ min: 80, max: 80 }, 77.5)).toEqual({ status: "under", by: 2.5 });
  });

  it("a one-sided lower bound can only be undershot", () => {
    expect(metricDeviation({ min: 8 }, 12)).toEqual({ status: "on-target" });
    expect(metricDeviation({ min: 8 }, 6)).toEqual({ status: "under", by: 2 });
  });

  it("a one-sided upper bound can only be exceeded", () => {
    expect(metricDeviation({ max: 8 }, 6)).toEqual({ status: "on-target" });
    expect(metricDeviation({ max: 8 }, 9)).toEqual({ status: "over", by: 1 });
  });

  it("an open interval prescribes nothing to miss", () => {
    expect(metricDeviation({}, 9)).toEqual({ status: "unprescribed" });
  });

  it("an untracked metric, or one with no actual yet, is unprescribed", () => {
    expect(metricDeviation(undefined, 9)).toEqual({ status: "unprescribed" });
    expect(metricDeviation({ min: 5, max: 8 }, undefined)).toEqual({ status: "unprescribed" });
  });

  it("does not surface float noise on 2.5 kg load steps", () => {
    expect(metricDeviation({ min: 82.5, max: 82.5 }, 80)).toEqual({ status: "under", by: 2.5 });
    expect(metricDeviation({ min: 0.1, max: 0.1 }, 0.3)).toEqual({ status: "over", by: 0.2 });
  });
});

describe("deviationDelta / isDeviated", () => {
  it("signs the delta by direction and leaves non-misses at zero", () => {
    expect(deviationDelta(metricDeviation({ min: 5, max: 8 }, 4))).toBe(-1);
    expect(deviationDelta(metricDeviation({ min: 5, max: 8 }, 10))).toBe(2);
    expect(deviationDelta(metricDeviation({ min: 5, max: 8 }, 6))).toBe(0);
    expect(deviationDelta(metricDeviation({}, 6))).toBe(0);
  });

  it("only a real miss is painted", () => {
    expect(isDeviated(metricDeviation({ min: 5, max: 8 }, 6))).toBe(false);
    expect(isDeviated(metricDeviation({ min: 5, max: 8 }, 3))).toBe(true);
    expect(isDeviated(metricDeviation({}, 3))).toBe(false);
  });
});

describe("setDeviations", () => {
  it("walks the Set's tracked metrics in field order", () => {
    const result = setDeviations(
      { reps: { min: 5, max: 8 }, load: { min: 80, max: 80 }, rpe: {} },
      { reps: 8, load: 77.5, rpe: 9 },
    );
    expect(result).toEqual([
      { metric: "reps", deviation: { status: "on-target" } },
      { metric: "load", deviation: { status: "under", by: 2.5 } },
      { metric: "rpe", deviation: { status: "unprescribed" } },
    ]);
  });

  it("an unlogged Set has nothing to deviate from", () => {
    expect(hasDeviation({ reps: { min: 5, max: 8 } }, undefined)).toBe(false);
  });

  it("one missed metric deviates the row", () => {
    const target = { reps: { min: 5, max: 8 }, load: { min: 80, max: 80 } };
    expect(hasDeviation(target, { reps: 8, load: 80 })).toBe(false);
    expect(hasDeviation(target, { reps: 8, load: 75 })).toBe(true);
  });
});
