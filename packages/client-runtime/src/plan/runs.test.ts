import { describe, expect, it, vi } from "vitest";

import type { PrescribedSet, SetId } from "@repcoach/contracts";

import { formatRest, formatSetRun } from "./format.ts";
import {
  coalesceSetRuns,
  expandSetRuns,
  isRunIncomplete,
  sameTarget,
  summarizeRunsRest,
  withRestAcrossRuns,
} from "./runs.ts";

/**
 * Set runs are the Plan editor's authoring unit and are **derived, never
 * stored** (#71) — so the contract worth pinning is the round trip: an
 * ordered Set list coalesces into the runs a person would say out loud, and
 * those runs expand back into an ordered Set list.
 */

/** `restSec: undefined` is meaningful here — it is how a fixture prescribes no rest at all. */
interface SetOverrides {
  readonly setType?: PrescribedSet["setType"];
  readonly target?: PrescribedSet["target"];
  readonly restSec?: number | undefined;
}

const set = (id: string, overrides: SetOverrides = {}): PrescribedSet => {
  const restSec = "restSec" in overrides ? overrides.restSec : 120;
  return {
    id: id as SetId,
    setType: overrides.setType ?? "working",
    target: overrides.target ?? { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } },
    ...(restSec === undefined ? {} : { restSec }),
  };
};

describe("coalesceSetRuns", () => {
  it("collapses identical consecutive Sets into one run carrying their ids", () => {
    const runs = coalesceSetRuns([set("s1"), set("s2"), set("s3")]);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.count).toBe(3);
    expect(runs[0]?.setIds).toEqual(["s1", "s2", "s3"]);
    expect(runs[0]?.restSec).toBe(120);
  });

  it("splits on a differing target, set type or rest", () => {
    const runs = coalesceSetRuns([
      set("s1"),
      set("s2", { target: { reps: { min: 8, max: 10 }, load: { min: 80, max: 80 } } }),
      set("s3", { setType: "drop" }),
      set("s4", { restSec: 60 }),
    ]);

    expect(runs.map((run) => run.count)).toEqual([1, 1, 1, 1]);
  });

  it("keeps two identical runs separated by a different Set apart — Set order IS the prescription", () => {
    // A top set, a lighter backoff, then the same top set again is a ramp,
    // not "2 × top set".
    const runs = coalesceSetRuns([
      set("s1"),
      set("s2", { target: { reps: { min: 8, max: 8 }, load: { min: 70, max: 70 } } }),
      set("s3"),
    ]);

    expect(runs).toHaveLength(3);
  });

  it("merges two adjacent runs whose targets are edited into agreement", () => {
    // The edge case that only exists because runs are derived: the user
    // drags the backoff up to the top set's load and the two become one run.
    const runs = coalesceSetRuns([set("s1"), set("s2"), set("s3"), set("s4")]);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.count).toBe(4);
  });

  it("treats an absent metric and an open interval as different targets", () => {
    const runs = coalesceSetRuns([
      set("s1", { target: { reps: { min: 5, max: 5 } } }),
      set("s2", { target: { reps: { min: 5, max: 5 }, rpe: {} } }),
    ]);

    expect(runs).toHaveLength(2);
    expect(sameTarget({ reps: { min: 5, max: 5 } }, { reps: { min: 5, max: 5 }, rpe: {} })).toBe(
      false,
    );
  });

  it("coalesces an empty Set list into no runs", () => {
    expect(coalesceSetRuns([])).toEqual([]);
  });
});

describe("expandSetRuns", () => {
  it("round-trips an ordered Set list unchanged", () => {
    const sets = [
      set("s1"),
      set("s2"),
      set("s3", { setType: "drop", target: { load: { max: 60 } }, restSec: undefined }),
    ];

    const makeSetId = vi.fn(() => "unused" as SetId);
    const roundTripped = expandSetRuns(coalesceSetRuns(sets), makeSetId);

    expect(roundTripped).toEqual(sets);
    expect(makeSetId).not.toHaveBeenCalled();
  });

  it("mints ids only for Sets the count edit genuinely added", () => {
    const runs = coalesceSetRuns([set("s1"), set("s2")]);
    let next = 0;
    const makeSetId = vi.fn(() => `new-${++next}` as SetId);

    const expanded = expandSetRuns([{ ...runs[0]!, count: 4 }], makeSetId);

    expect(expanded.map((s) => s.id)).toEqual(["s1", "s2", "new-1", "new-2"]);
    expect(makeSetId).toHaveBeenCalledTimes(2);
  });

  it("drops trailing ids when the count shrinks, leaving the surviving Sets untouched", () => {
    const runs = coalesceSetRuns([set("s1"), set("s2"), set("s3")]);

    const expanded = expandSetRuns([{ ...runs[0]!, count: 1 }], () => "never" as SetId);

    expect(expanded.map((s) => s.id)).toEqual(["s1"]);
  });

  it("omits restSec entirely when a run prescribes no rest — absent means no timer", () => {
    const expanded = expandSetRuns(
      [{ count: 1, setType: "working", target: { reps: { min: 10, max: 10 } }, setIds: [] }],
      () => "s-new" as SetId,
    );

    expect(expanded[0]).not.toHaveProperty("restSec");
  });
});

describe("withRestAcrossRuns", () => {
  it("writes one rest value across every run — rest lives on the Set, not the Entry", () => {
    const runs = coalesceSetRuns([set("s1"), set("s2", { restSec: 60 })]);

    expect(withRestAcrossRuns(runs, 90).map((run) => run.restSec)).toEqual([90, 90]);
  });

  it("clears rest entirely, which is what suppresses the rest timer", () => {
    const runs = coalesceSetRuns([set("s1")]);

    expect(withRestAcrossRuns(runs, undefined)[0]).not.toHaveProperty("restSec");
  });
});

describe("isRunIncomplete", () => {
  it("is complete when the run's target covers every metric the catalog declares", () => {
    const [run] = coalesceSetRuns([set("s1")]);

    expect(isRunIncomplete(run!, ["reps", "load"])).toBe(false);
  });

  it("is incomplete when the catalog declares a metric the run's target is silent on", () => {
    const [run] = coalesceSetRuns([set("s1", { target: { reps: { min: 5, max: 5 } } })]);

    expect(isRunIncomplete(run!, ["reps", "load"])).toBe(true);
  });

  it("ignores metrics the catalog does not declare, even if the target omits them", () => {
    const [run] = coalesceSetRuns([set("s1", { target: { reps: { min: 5, max: 5 } } })]);

    expect(isRunIncomplete(run!, ["reps"])).toBe(false);
  });
});

describe("summarizeRunsRest", () => {
  it("reports 'tracked' when every run agrees on a defined rest", () => {
    const runs = coalesceSetRuns([set("s1", { restSec: 90 }), set("s2", { restSec: 90 })]);

    expect(summarizeRunsRest(runs)).toEqual({ kind: "tracked", restSec: 90 });
  });

  it("reports 'not-tracked' when every run agrees on no rest at all", () => {
    const runs = coalesceSetRuns([set("s1", { restSec: undefined }), set("s2", { restSec: undefined })]);

    expect(summarizeRunsRest(runs)).toEqual({ kind: "not-tracked" });
  });

  it("reports 'varies' when the runs disagree", () => {
    const runs = coalesceSetRuns([set("s1", { restSec: 60 }), set("s2", { restSec: 90 })]);

    expect(summarizeRunsRest(runs)).toEqual({ kind: "varies" });
  });

  it("reports 'varies' when one run tracks rest and another does not", () => {
    const runs = coalesceSetRuns([set("s1", { restSec: 60 }), set("s2", { restSec: undefined })]);

    expect(summarizeRunsRest(runs)).toEqual({ kind: "varies" });
  });
});

describe("formatSetRun", () => {
  it("says a strength run the way a person says it", () => {
    const runs = coalesceSetRuns([
      set("s1", { target: { reps: { min: 5, max: 8 }, load: { min: 80, max: 80 } } }),
      set("s2", { target: { reps: { min: 5, max: 8 }, load: { min: 80, max: 80 } } }),
      set("s3", { target: { reps: { min: 5, max: 8 }, load: { min: 80, max: 80 } } }),
      set("s4", { target: { reps: { min: 5, max: 8 }, load: { min: 80, max: 80 } } }),
    ]);

    expect(formatSetRun(runs[0]!)).toBe("4 × 5-8 reps @ 80 kg");
  });

  it("separates a non-load metric with a dot, because @ only reads as 'at this load'", () => {
    const runs = coalesceSetRuns([
      set("s1", { target: { load: { min: 40, max: 40 }, distance: { min: 20, max: 20 } } }),
    ]);

    expect(formatSetRun(runs[0]!)).toBe("1 × 40 kg · 20 m");
  });

  it("carries the interval vocabulary through unchanged — one-sided targets and open effort", () => {
    const plus = coalesceSetRuns([set("s1", { target: { reps: { min: 8 } } })]);
    const capped = coalesceSetRuns([set("s2", { target: { rpe: { max: 8 } } })]);
    const open = coalesceSetRuns([set("s3", { target: { rpe: {} } })]);

    expect(formatSetRun(plus[0]!)).toBe("1 × 8+ reps");
    expect(formatSetRun(capped[0]!)).toBe("1 × <=8 RPE");
    expect(formatSetRun(open[0]!)).toBe("1 × report effort");
  });

  it("names the set type for anything that is not a plain working Set", () => {
    const runs = coalesceSetRuns([set("s1", { setType: "drop", target: { load: { max: 60 } } })]);

    expect(formatSetRun(runs[0]!)).toBe("1 × drop <=60 kg");
  });

  it("says 'unprescribed' rather than nothing when a run has no target at all", () => {
    const runs = coalesceSetRuns([set("s1", { target: {} })]);

    expect(formatSetRun(runs[0]!)).toBe("1 × unprescribed");
  });
});

describe("formatRest", () => {
  it("reads rest in minutes and seconds", () => {
    expect(formatRest(120)).toBe("2:00");
    expect(formatRest(90)).toBe("1:30");
  });

  it("says no rest when none is prescribed", () => {
    expect(formatRest(undefined)).toBe("no rest");
  });
});
