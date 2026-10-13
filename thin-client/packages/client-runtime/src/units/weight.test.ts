import { describe, expect, it } from "vitest";

import { formatSetRun } from "../plan/format.ts";
import {
  displayToKg,
  formatLoad,
  intervalToDisplay,
  kgToDisplay,
  loadStep,
  nudgeDisplayLoad,
} from "./weight.ts";

describe("weight display units", () => {
  it("kg is the identity: what is stored is what is shown", () => {
    expect(kgToDisplay(82.5, "kg")).toBe(82.5);
    expect(displayToKg(82.5, "kg")).toBe(82.5);
    expect(intervalToDisplay({ min: 60, max: 70 }, "kg")).toEqual({ min: 60, max: 70 });
  });

  it("shows a kg value in lb, rounded to a tenth", () => {
    expect(kgToDisplay(60, "lb")).toBe(132.3);
    expect(kgToDisplay(100, "lb")).toBe(220.5);
    expect(formatLoad(20, "lb")).toBe("44.1 lb");
  });

  it("a typed lb value round-trips to the same number on screen", () => {
    for (const lb of [45, 95, 135, 185, 225, 315, 405, 2.5, 137.5]) {
      expect(kgToDisplay(displayToKg(lb, "lb"), "lb")).toBe(lb);
    }
  });

  it("stores lb conversions at three decimals, not float noise", () => {
    expect(displayToKg(135, "lb")).toBe(61.235);
  });

  it("converts both bounds of a load interval and leaves an open one open", () => {
    expect(intervalToDisplay({ min: 60, max: 70 }, "lb")).toEqual({ min: 132.3, max: 154.3 });
    expect(intervalToDisplay({ max: 60 }, "lb")).toEqual({ max: 132.3 });
    expect(intervalToDisplay({}, "lb")).toEqual({});
  });

  it("steps by 2.5 kg or 5 lb", () => {
    expect(loadStep("kg")).toBe(2.5);
    expect(loadStep("lb")).toBe(5);
  });

  it("a kg nudge is plain addition, as the steppers always were", () => {
    expect(nudgeDisplayLoad(81, 2.5, "kg")).toBe(83.5);
    expect(nudgeDisplayLoad(1, -2.5, "kg")).toBe(0);
  });

  it("a lb nudge from an off-grid value lands on the next plate-able number", () => {
    expect(nudgeDisplayLoad(176.4, 5, "lb")).toBe(180);
    expect(nudgeDisplayLoad(176.4, -5, "lb")).toBe(175);
    expect(nudgeDisplayLoad(180, 5, "lb")).toBe(185);
    expect(nudgeDisplayLoad(180, -5, "lb")).toBe(175);
    expect(nudgeDisplayLoad(2, -5, "lb")).toBe(0);
  });

  it("the Plan sentence reads in the display unit", () => {
    const run = { count: 3, setType: "working" as const, target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } }, setIds: [] };
    expect(formatSetRun(run)).toBe("3 × 5 reps @ 100 kg");
    expect(formatSetRun(run, "lb")).toBe("3 × 5 reps @ 220.5 lb");
  });
});
