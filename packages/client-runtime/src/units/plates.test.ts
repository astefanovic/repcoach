import { describe, expect, it } from "vitest";

import { DEFAULT_PLATE_SETUP, formatPerSide, loadPlates, parsePlateList } from "./plates.ts";

describe("the plate calculator", () => {
  it("loads a kg barbell heaviest plate first", () => {
    expect(loadPlates(100, DEFAULT_PLATE_SETUP.kg)).toEqual({
      kind: "plates",
      perSide: [25, 15],
      total: 100,
      shortBy: 0,
    });
    expect(loadPlates(142.5, DEFAULT_PLATE_SETUP.kg)).toMatchObject({ perSide: [25, 25, 10, 1.25], shortBy: 0 });
  });

  it("loads a lb barbell", () => {
    expect(loadPlates(225, DEFAULT_PLATE_SETUP.lb)).toMatchObject({ perSide: [45, 45], total: 225, shortBy: 0 });
    expect(loadPlates(135, DEFAULT_PLATE_SETUP.lb)).toMatchObject({ perSide: [45], total: 135 });
  });

  it("says the bar alone is enough at or below its weight", () => {
    expect(loadPlates(20, DEFAULT_PLATE_SETUP.kg)).toEqual({ kind: "bar-only", bar: 20 });
    expect(loadPlates(15, DEFAULT_PLATE_SETUP.kg)).toEqual({ kind: "bar-only", bar: 20 });
  });

  it("reports a shortfall rather than pretending a load is exact", () => {
    // 61 kg: 20 bar + 2 × 20 = 60, and 0.5 per side has no plate.
    expect(loadPlates(61, DEFAULT_PLATE_SETUP.kg)).toMatchObject({ perSide: [20], total: 60, shortBy: 1 });
    // A converted lb prescription (60 kg = 132.3 lb) lands on 130 with 2.3 left over.
    expect(loadPlates(132.3, DEFAULT_PLATE_SETUP.lb)).toMatchObject({ total: 130, shortBy: 2.3 });
  });

  it("uses only the plates on hand", () => {
    expect(loadPlates(100, { bar: 20, plates: [10, 5] })).toMatchObject({ perSide: [10, 10, 10, 10], total: 100 });
  });

  it("calls a side out with repeats folded", () => {
    expect(formatPerSide([25, 25, 10, 1.25])).toBe("2 × 25 + 10 + 1.25");
    expect(formatPerSide([45])).toBe("45");
  });

  it("parses a typed plate list in the usual spellings", () => {
    expect(parsePlateList("25, 20, 15, 10, 5, 2.5")).toEqual([25, 20, 15, 10, 5, 2.5]);
    expect(parsePlateList("25,20,10")).toEqual([25, 20, 10]);
    expect(parsePlateList("20 10 2,5")).toEqual([20, 10, 2.5]);
    expect(parsePlateList("20; ten; -5; 0; 5")).toEqual([20, 5]);
  });
});
