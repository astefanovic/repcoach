import { describe, expect, it, vi } from "vitest";

import type { PrescribedBlock, PrescribedSet } from "@repcoach/contracts";

import {
  addedEntry,
  anotherDropSet,
  anotherMyoClusterSet,
  anotherRestPauseSet,
  anotherSetOfType,
  anotherStraightSet,
  blockWrapperLabel,
  buildConfirmCommand,
  buildSwapCommand,
  buildUnlogCommand,
  canCancelSession,
  canSwapEntry,
  carryForwardPrescribedMetric,
  deriveSetFields,
  formatGhostText,
  groupSetsWithContinuations,
  isBlockWrapperVisible,
  isContinuationSetType,
  lastTimeActual,
  nudgeMetricValue,
  parseMetricDraft,
  oneTapActual,
  resolveGhostActual,
  seedFromPreviousSet,
  seedUnprescribedMetric,
  suggestMetric,
} from "./grid.ts";

describe("formatGhostText", () => {
  it("formats an exact target (min === max)", () => {
    expect(formatGhostText("reps", { min: 5, max: 5 })).toBe("5");
  });

  it("formats a range", () => {
    expect(formatGhostText("reps", { min: 8, max: 10 })).toBe("8-10");
  });

  it("formats a one-sided lower bound as a plus", () => {
    expect(formatGhostText("reps", { min: 8 })).toBe("8+");
  });

  it("formats a one-sided upper bound as a cap, RPE-flavored for effort", () => {
    expect(formatGhostText("load", { max: 100 })).toBe("<=100");
    expect(formatGhostText("rpe", { max: 8 })).toBe("<=8 RPE");
  });

  it("formats an entirely open interval as report-only", () => {
    expect(formatGhostText("rpe", {})).toBe("report effort");
    expect(formatGhostText("reps", {})).toBe("report");
  });

  it("returns empty text for an absent (untracked) metric", () => {
    expect(formatGhostText("distance", undefined)).toBe("");
  });
});

describe("deriveSetFields", () => {
  it("derives reps+load for a strength Set", () => {
    expect(deriveSetFields({ reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } })).toEqual([
      "reps",
      "load",
    ]);
  });

  it("derives duration only for a timed Set (e.g. plank) — no fixed reps/load layout", () => {
    expect(deriveSetFields({ duration: { min: 30, max: 45 } })).toEqual(["duration"]);
  });

  it("derives load+distance for a carry-style Set", () => {
    expect(deriveSetFields({ load: { min: 40, max: 40 }, distance: { min: 20, max: 20 } })).toEqual([
      "load",
      "distance",
    ]);
  });

  it("includes an open rpe field (report-only, still rendered)", () => {
    expect(deriveSetFields({ reps: { min: 5, max: 5 }, rpe: {} })).toEqual(["reps", "rpe"]);
  });
});

describe("resolveGhostActual (one-tap confirm)", () => {
  it("resolves an exact target to that value", () => {
    expect(resolveGhostActual({ reps: { min: 5, max: 5 } })).toEqual({ reps: 5 });
  });

  it("resolves a range to the top of the range (double-progression intent)", () => {
    expect(resolveGhostActual({ reps: { min: 8, max: 10 } })).toEqual({ reps: 10 });
  });

  it("resolves a one-sided lower bound to itself (no upper bound to resolve to)", () => {
    expect(resolveGhostActual({ reps: { min: 8 } })).toEqual({ reps: 8 });
  });

  it("resolves a one-sided upper bound (cap) to that cap", () => {
    expect(resolveGhostActual({ load: { max: 60 } })).toEqual({ load: 60 });
  });

  it("leaves an open interval absent — nothing to one-tap fill", () => {
    expect(resolveGhostActual({ reps: { min: 5, max: 5 }, rpe: {} })).toEqual({ reps: 5 });
  });

  it("resolves a multi-metric target across all declared fields", () => {
    expect(
      resolveGhostActual({ duration: { min: 30, max: 45 } }),
    ).toEqual({ duration: 45 });
  });
});

/* ---------------------------- #113 item 4: the previous set's number === */

describe("seedFromPreviousSet (where the editor opens when nothing is prescribed)", () => {
  /** An Entry whose load the Plan never prescribed — reps only. */
  const unprescribedLoad = (id: string): PrescribedSet => ({
    id: id as never,
    setType: "working",
    target: { reps: { min: 8, max: 8 }, load: {} },
  });
  const sets = [unprescribedLoad("s1"), unprescribedLoad("s2"), unprescribedLoad("s3")];
  const actuals = (
    entries: ReadonlyArray<readonly [string, Record<string, number>]>,
  ): ReadonlyMap<PrescribedSet["id"], { readonly actual: Record<string, number> }> =>
    new Map(entries.map(([id, actual]) => [id as never, { actual }]));

  it("seeds from the immediately preceding set's logged actual", () => {
    expect(
      seedFromPreviousSet(sets, "s2" as never, "load", actuals([["s1", { reps: 8, load: 60 }]])),
    ).toBe(60);
  });

  it("reaches back past a set that never logged the metric — nearest earlier wins", () => {
    const map = actuals([
      ["s1", { reps: 8, load: 60 }],
      ["s2", { reps: 8 }],
    ]);
    expect(seedFromPreviousSet(sets, "s3" as never, "load", map)).toBe(60);
    // …and the NEAREST one wins once the middle set does carry it.
    const later = actuals([
      ["s1", { reps: 8, load: 60 }],
      ["s2", { reps: 8, load: 65 }],
    ]);
    expect(seedFromPreviousSet(sets, "s3" as never, "load", later)).toBe(65);
  });

  it("never looks FORWARD — the first set of an entry has nothing to inherit", () => {
    const map = actuals([
      ["s2", { load: 65 }],
      ["s3", { load: 70 }],
    ]);
    expect(seedFromPreviousSet(sets, "s1" as never, "load", map)).toBeUndefined();
  });

  it("is per-metric: a logged rep count does not seed a load", () => {
    expect(
      seedFromPreviousSet(sets, "s2" as never, "load", actuals([["s1", { reps: 8 }]])),
    ).toBeUndefined();
  });

  it("is scoped to the Entry it was given — a bench load never seeds a curl", () => {
    // The caller passes ONE Entry's sets, so a set from another exercise is
    // simply not in the array and cannot be reached, however recently it was
    // logged. This is the whole of the same-exercise rule.
    const otherEntrysActuals = actuals([["bench-1", { load: 100 }]]);
    expect(seedFromPreviousSet(sets, "s1" as never, "load", otherEntrysActuals)).toBeUndefined();
    expect(seedFromPreviousSet(sets, "s3" as never, "load", otherEntrysActuals)).toBeUndefined();
  });

  it("returns nothing for a set that is not in the entry at all", () => {
    expect(
      seedFromPreviousSet(sets, "elsewhere" as never, "load", actuals([["s1", { load: 60 }]])),
    ).toBeUndefined();
  });

  it("returns nothing when nothing has been logged yet — the caller falls back to 0", () => {
    expect(seedFromPreviousSet(sets, "s3" as never, "load", actuals([]))).toBeUndefined();
  });
});

/* ------------------------ #149: tier-2 seed + one-tap ✓ writes it ======= */

describe("seedUnprescribedMetric (#149 — tier 1, else tier 2)", () => {
  const unprescribedLoad = (id: string): PrescribedSet => ({
    id: id as never,
    setType: "working",
    target: { reps: { min: 8, max: 8 }, load: {} },
  });
  const sets = [unprescribedLoad("s1"), unprescribedLoad("s2")];
  const actuals = (
    entries: ReadonlyArray<readonly [string, Record<string, number>]>,
  ): ReadonlyMap<PrescribedSet["id"], { readonly actual: Record<string, number> }> =>
    new Map(entries.map(([id, actual]) => [id as never, { actual }]));

  it("tier 1 (this session's previous set) wins even when tier 2 also has a value", () => {
    expect(
      seedUnprescribedMetric(
        sets,
        "s2" as never,
        "load",
        actuals([["s1", { load: 60 }]]),
        new Map([["load", 999]]),
      ),
    ).toBe(60);
  });

  it("falls back to tier 2 (last time the exercise was performed) when this session has none", () => {
    expect(
      seedUnprescribedMetric(sets, "s1" as never, "load", actuals([]), new Map([["load", 82.5]])),
    ).toBe(82.5);
  });

  it("is undefined when neither tier has the metric", () => {
    expect(
      seedUnprescribedMetric(sets, "s1" as never, "load", actuals([]), new Map([["reps", 8]])),
    ).toBeUndefined();
    expect(
      seedUnprescribedMetric(sets, "s1" as never, "load", actuals([]), undefined),
    ).toBeUndefined();
  });
});

describe("oneTapActual (#149 — what one tap on ✓ writes)", () => {
  const set = (target: PrescribedSet["target"]): PrescribedSet => ({
    id: "s1" as never,
    setType: "working",
    target,
  });
  const noActuals = new Map<PrescribedSet["id"], { readonly actual: Record<string, number> }>();

  it("is unchanged when every rendered metric is bounded — prescription resolves, seeds are ignored", () => {
    const target = { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } };
    expect(
      oneTapActual([set(target)][0]!.target, [set(target)], "s1" as never, noActuals, new Map([["load", 60]])),
    ).toEqual({ reps: 5, load: 100 });
  });

  it("resolves a range to its top and leaves an unseeded open metric absent", () => {
    const target = { reps: { min: 8, max: 10 }, load: {} };
    expect(oneTapActual(target, [set(target)], "s1" as never, noActuals, undefined)).toEqual({ reps: 10 });
  });

  it("fills an open metric from the seed, but never overrides the prescription", () => {
    const target = { reps: { min: 5, max: 5 }, load: {} };
    expect(
      oneTapActual(target, [set(target)], "s1" as never, noActuals, new Map([["load", 62.5], ["reps", 99]])),
    ).toEqual({ reps: 5, load: 62.5 });
  });
});

/* ------------- UAT: ✓ carries the previous Set's weight and reps forward ==== */

describe("carryForwardPrescribedMetric / oneTapActual (UAT — ✓ repeats the last set)", () => {
  const working = (id: string, target: PrescribedSet["target"]): PrescribedSet => ({
    id: id as never,
    setType: "working",
    target,
  });
  const straight = { reps: { min: 8, max: 10 }, load: { min: 60, max: 60 } };
  const actuals = (
    entries: ReadonlyArray<readonly [string, Record<string, number>]>,
  ): ReadonlyMap<PrescribedSet["id"], { readonly actual: Record<string, number> }> =>
    new Map(entries.map(([id, actual]) => [id as never, { actual }]));

  it("writes what the previous set of the same shape actually logged, over the prescription", () => {
    const sets = [working("s1", straight), working("s2", straight)];
    const map = actuals([["s1", { reps: 9, load: 62.5 }]]);
    expect(carryForwardPrescribedMetric(sets, "s2" as never, "load", map)).toBe(62.5);
    expect(oneTapActual(straight, sets, "s2" as never, map, undefined)).toEqual({ reps: 9, load: 62.5 });
  });

  it("falls back to the prescription on the first set, with nothing logged before it", () => {
    const sets = [working("s1", straight), working("s2", straight)];
    expect(oneTapActual(straight, sets, "s1" as never, actuals([]), undefined)).toEqual({ reps: 10, load: 60 });
  });

  it("does not carry across a changed prescription — a ramp or pyramid keeps its own numbers", () => {
    const heavier = { reps: { min: 8, max: 10 }, load: { min: 70, max: 70 } };
    const sets = [working("s1", straight), working("s2", heavier)];
    const map = actuals([["s1", { reps: 9, load: 62.5 }]]);
    // Reps shared the same target, so they carry; the load target moved, so it does not.
    expect(oneTapActual(heavier, sets, "s2" as never, map, undefined)).toEqual({ reps: 9, load: 70 });
  });

  it("does not carry across set types — a warmup never sets a working set's numbers", () => {
    const sets: PrescribedSet[] = [
      { id: "w1" as never, setType: "warmup", target: straight },
      working("s1", straight),
    ];
    const map = actuals([["w1", { reps: 5, load: 40 }]]);
    expect(oneTapActual(straight, sets, "s1" as never, map, undefined)).toEqual({ reps: 10, load: 60 });
  });

  it("never carries RPE — effort is reported after the fact, not repeated", () => {
    const withRpe = { reps: { min: 8, max: 8 }, rpe: { min: 8, max: 8 } };
    const sets = [working("s1", withRpe), working("s2", withRpe)];
    expect(
      carryForwardPrescribedMetric(sets, "s2" as never, "rpe", actuals([["s1", { reps: 8, rpe: 9.5 }]])),
    ).toBeUndefined();
  });

  it("leaves an unprescribed metric to the #149 seed path", () => {
    const openLoad = { reps: { min: 8, max: 8 }, load: {} };
    const sets = [working("s1", openLoad), working("s2", openLoad)];
    expect(
      carryForwardPrescribedMetric(sets, "s2" as never, "load", actuals([["s1", { load: 60 }]])),
    ).toBeUndefined();
  });
});

describe("isBlockWrapperVisible / blockWrapperLabel", () => {
  const block = (
    format: PrescribedBlock["format"],
    entryCount: number,
  ): PrescribedBlock => ({
    id: "block-x" as never,
    format,
    entries: Array.from({ length: entryCount }, (_, i) => ({
      id: `entry-${i}` as never,
      exerciseId: "exercise-x" as never,
      sets: [],
    })),
  });

  it("hides a plain single-exercise straight Block", () => {
    expect(isBlockWrapperVisible(block("straight", 1))).toBe(false);
  });

  it("surfaces a straight Block only if it (unusually) groups multiple exercises", () => {
    expect(isBlockWrapperVisible(block("straight", 2))).toBe(true);
  });

  it("surfaces a superset regardless of entry count", () => {
    expect(isBlockWrapperVisible(block("superset", 2))).toBe(true);
    expect(blockWrapperLabel(block("superset", 2))).toBe("Superset");
  });

  it("surfaces a timed format (EMOM/AMRAP) even with a single Entry", () => {
    expect(isBlockWrapperVisible(block("emom", 1))).toBe(true);
    expect(blockWrapperLabel(block("emom", 1))).toBe("EMOM");
  });

  it("straight Block's label is empty (never shown)", () => {
    expect(blockWrapperLabel(block("straight", 1))).toBe("");
  });
});

describe("special-set continuation grouping", () => {
  const workingSet = (id: string): PrescribedSet => ({
    id: id as never,
    setType: "working",
    target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
    restSec: 90,
  });
  const dropSet = (id: string): PrescribedSet => ({
    id: id as never,
    setType: "drop",
    target: { load: { max: 60 } },
  });

  it("classifies drop/rest-pause/myo-cluster as continuation types", () => {
    expect(isContinuationSetType("drop")).toBe(true);
    expect(isContinuationSetType("rest-pause")).toBe(true);
    expect(isContinuationSetType("myo-cluster")).toBe(true);
    expect(isContinuationSetType("working")).toBe(false);
    expect(isContinuationSetType("warmup")).toBe(false);
  });

  it("groups a trailing drop set under its preceding working Set", () => {
    const groups = groupSetsWithContinuations([workingSet("set-5"), dropSet("set-6")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.anchor.id).toBe("set-5");
    expect(groups[0]!.continuations.map((s) => s.id)).toEqual(["set-6"]);
  });

  it("keeps independent working Sets as separate groups", () => {
    const groups = groupSetsWithContinuations([workingSet("set-1"), workingSet("set-2")]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.continuations).toEqual([]);
    expect(groups[1]!.continuations).toEqual([]);
  });

  it("chains multiple continuations onto the same anchor", () => {
    const groups = groupSetsWithContinuations([
      workingSet("set-1"),
      dropSet("set-2"),
      dropSet("set-3"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.continuations.map((s) => s.id)).toEqual(["set-2", "set-3"]);
  });
});

describe("anotherStraightSet (#115 item 1, ADR 0017)", () => {
  const workingSet = (id: string, restSec?: number): PrescribedSet => ({
    id: id as never,
    setType: "working",
    target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
    ...(restSec === undefined ? {} : { restSec }),
  });
  const dropSet = (id: string): PrescribedSet => ({
    id: id as never,
    setType: "drop",
    target: { load: { max: 60 } },
  });

  it("echoes the last working Set's target and rest, with the supplied id and setType working", () => {
    const echoed = anotherStraightSet([workingSet("set-1", 90)], "set-new" as never);
    expect(echoed).toEqual({
      id: "set-new",
      setType: "working",
      target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
      restSec: 90,
    });
  });

  it("echoes the last non-continuation Set, skipping a trailing drop set", () => {
    const echoed = anotherStraightSet([workingSet("set-1", 90), dropSet("set-2")], "set-new" as never);
    expect(echoed.target).toEqual({ reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } });
  });

  it("falls back to the last Set of any type when every Set is a continuation", () => {
    const echoed = anotherStraightSet([dropSet("set-1")], "set-new" as never);
    expect(echoed.target).toEqual({ load: { max: 60 } });
  });

  it("returns an open target with no rest for an empty Entry", () => {
    const echoed = anotherStraightSet([], "set-new" as never);
    expect(echoed).toEqual({ id: "set-new", setType: "working", target: {}, restSec: undefined });
  });
});

describe("anotherDropSet (#129 item 1)", () => {
  const workingSet = (id: string, restSec?: number): PrescribedSet => ({
    id: id as never,
    setType: "working",
    target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
    ...(restSec === undefined ? {} : { restSec }),
  });

  it("echoes the anchor's non-load metrics but opens the load, and forces restSec to 0", () => {
    const echoed = anotherDropSet([workingSet("set-1", 90)], "set-new" as never);
    expect(echoed).toEqual({
      id: "set-new",
      setType: "drop",
      target: { reps: { min: 10, max: 10 }, load: {} },
      restSec: 0,
    });
  });

  it("leaves the target untouched when the anchor prescribes no load", () => {
    const noLoad = (id: string): PrescribedSet => ({
      id: id as never,
      setType: "working",
      target: { reps: { min: 10, max: 10 } },
    });
    const echoed = anotherDropSet([noLoad("set-1")], "set-new" as never);
    expect(echoed.target).toEqual({ reps: { min: 10, max: 10 } });
  });

  it("returns an open target with restSec 0 for an empty Entry", () => {
    const echoed = anotherDropSet([], "set-new" as never);
    expect(echoed).toEqual({ id: "set-new", setType: "drop", target: {}, restSec: 0 });
  });

  it("chains a second drop off the first, still opening load from its own anchor's target", () => {
    const dropSet = (id: string): PrescribedSet => ({
      id: id as never,
      setType: "drop",
      target: { reps: { min: 10, max: 10 }, load: {} },
    });
    // A run of drops should still resolve back to the last *working* anchor,
    // not chain off a previous drop's already-open load.
    const echoed = anotherDropSet([workingSet("set-1", 90), dropSet("set-2")], "set-new" as never);
    expect(echoed.target).toEqual({ reps: { min: 10, max: 10 }, load: {} });
  });
});

describe("anotherRestPauseSet (#129 item 1)", () => {
  const workingSet = (id: string, restSec?: number): PrescribedSet => ({
    id: id as never,
    setType: "working",
    target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
    ...(restSec === undefined ? {} : { restSec }),
  });

  it("echoes the anchor's target verbatim with a fixed short rest, regardless of the anchor's own rest", () => {
    const echoed = anotherRestPauseSet([workingSet("set-1", 90)], "set-new" as never);
    expect(echoed).toEqual({
      id: "set-new",
      setType: "rest-pause",
      target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
      restSec: 15,
    });
  });
});

describe("anotherMyoClusterSet (#129 item 1)", () => {
  const workingSet = (id: string): PrescribedSet => ({
    id: id as never,
    setType: "working",
    target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
    restSec: 90,
  });

  it("echoes the anchor's target verbatim with a fixed rest shorter than rest-pause's", () => {
    const echoed = anotherMyoClusterSet([workingSet("set-1")], "set-new" as never);
    expect(echoed).toEqual({
      id: "set-new",
      setType: "myo-cluster",
      target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
      restSec: 10,
    });
  });
});

describe("anotherSetOfType (#129 item 2 — the seam orphan reconstruction shares with the sheet)", () => {
  const workingSet = (id: string): PrescribedSet => ({
    id: id as never,
    setType: "working",
    target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
    restSec: 90,
  });

  it("dispatches working to anotherStraightSet", () => {
    expect(anotherSetOfType("working", [workingSet("set-1")], "set-new" as never)).toEqual(
      anotherStraightSet([workingSet("set-1")], "set-new" as never),
    );
  });

  it("dispatches warmup to anotherStraightSet, since no continuation reconstructs as one", () => {
    expect(anotherSetOfType("warmup", [workingSet("set-1")], "set-new" as never)).toEqual(
      anotherStraightSet([workingSet("set-1")], "set-new" as never),
    );
  });

  it("dispatches drop to anotherDropSet", () => {
    expect(anotherSetOfType("drop", [workingSet("set-1")], "set-new" as never)).toEqual(
      anotherDropSet([workingSet("set-1")], "set-new" as never),
    );
  });

  it("dispatches rest-pause to anotherRestPauseSet", () => {
    expect(anotherSetOfType("rest-pause", [workingSet("set-1")], "set-new" as never)).toEqual(
      anotherRestPauseSet([workingSet("set-1")], "set-new" as never),
    );
  });

  it("dispatches myo-cluster to anotherMyoClusterSet", () => {
    expect(anotherSetOfType("myo-cluster", [workingSet("set-1")], "set-new" as never)).toEqual(
      anotherMyoClusterSet([workingSet("set-1")], "set-new" as never),
    );
  });
});

describe("buildConfirmCommand (confirm -> outbox mapping)", () => {
  it("calls makeCommandId exactly once and maps the fields through", () => {
    const makeCommandId = vi.fn(() => "cmd-1" as never);
    const command = buildConfirmCommand({
      makeCommandId,
      loggedSessionId: "logged-session-1" as never,
      sessionId: "session-seed-1" as never,
      entryId: "entry-1" as never,
      setId: "set-1" as never,
      setType: "working",
      actual: { reps: 5, load: 100 },
    });
    expect(makeCommandId).toHaveBeenCalledTimes(1);
    expect(command).toEqual({
      // #80: the outbox carries more than one command shape now, so a confirm
      // has to say which one it is — an unstamped row would be delivered down
      // the wrong arm of the flusher.
      kind: "logSetActual",
      commandId: "cmd-1",
      loggedSessionId: "logged-session-1",
      sessionId: "session-seed-1",
      entryId: "entry-1",
      setId: "set-1",
      setType: "working",
      actual: { reps: 5, load: 100 },
    });
  });
});

describe("canSwapEntry (#131, ADR 0019 — offered only before any Set is logged)", () => {
  it("allows a swap when no actual names the Entry", () => {
    const actuals = [
      { entryId: "entry-2" as never },
      { entryId: "entry-3" as never },
    ];
    expect(canSwapEntry("entry-1" as never, actuals)).toBe(true);
  });

  it("refuses once any actual names the Entry, regardless of which Set", () => {
    const actuals = [{ entryId: "entry-1" as never }];
    expect(canSwapEntry("entry-1" as never, actuals)).toBe(false);
  });

  it("allows a swap for an Entry with zero actuals at all", () => {
    expect(canSwapEntry("entry-1" as never, [])).toBe(true);
  });
});

describe("buildSwapCommand (swap -> outbox mapping, #131 ADR 0019)", () => {
  it("calls makeCommandId exactly once and maps the fields through", () => {
    const makeCommandId = vi.fn(() => "cmd-1" as never);
    const command = buildSwapCommand({
      makeCommandId,
      loggedSessionId: "logged-session-1" as never,
      entryId: "entry-1" as never,
      exerciseId: "exercise-2" as never,
    });
    expect(makeCommandId).toHaveBeenCalledTimes(1);
    expect(command).toEqual({
      kind: "swapExercise",
      commandId: "cmd-1",
      loggedSessionId: "logged-session-1",
      entryId: "entry-1",
      exerciseId: "exercise-2",
    });
  });
});

describe("buildUnlogCommand (retraction -> outbox mapping, #83 ADR 0019)", () => {
  it("calls makeCommandId exactly once and maps the fields through, no metric map", () => {
    const makeCommandId = vi.fn(() => "cmd-1" as never);
    const command = buildUnlogCommand({
      makeCommandId,
      loggedSessionId: "logged-session-1" as never,
      entryId: "entry-1" as never,
      setId: "set-1" as never,
    });
    expect(makeCommandId).toHaveBeenCalledTimes(1);
    expect(command).toEqual({
      kind: "unlogSetActual",
      commandId: "cmd-1",
      loggedSessionId: "logged-session-1",
      entryId: "entry-1",
      setId: "set-1",
    });
  });
});

describe("canCancelSession (issue #114 Part 1)", () => {
  it("allows cancel while live with zero confirmed sets", () => {
    expect(canCancelSession({ live: true, confirmedCount: 0 })).toBe(true);
  });

  it("refuses once a set is confirmed", () => {
    expect(canCancelSession({ live: true, confirmedCount: 1 })).toBe(false);
  });

  it("refuses once the session is no longer live (backfill), even with zero confirmed sets", () => {
    expect(canCancelSession({ live: false, confirmedCount: 0 })).toBe(false);
  });
});

describe("parseMetricDraft", () => {
  it("parses a plain integer draft", () => {
    expect(parseMetricDraft("62")).toBe(62);
  });

  it("accepts a comma as a decimal separator", () => {
    expect(parseMetricDraft("62,5")).toBe(62.5);
  });

  it("accepts a dot as a decimal separator", () => {
    expect(parseMetricDraft("62.5")).toBe(62.5);
  });

  it("trims surrounding whitespace", () => {
    expect(parseMetricDraft("  62  ")).toBe(62);
  });

  it("does not commit an empty draft", () => {
    expect(parseMetricDraft("")).toBeUndefined();
    expect(parseMetricDraft("   ")).toBeUndefined();
  });

  it("does not commit a non-numeric draft", () => {
    expect(parseMetricDraft("abc")).toBeUndefined();
  });

  it("does not commit a negative draft", () => {
    expect(parseMetricDraft("-5")).toBeUndefined();
  });
});

describe("nudgeMetricValue", () => {
  it("steps from the current committable value", () => {
    expect(nudgeMetricValue(60, 0, 2.5)).toBe(62.5);
  });

  it("falls back to the start value when the draft does not currently commit", () => {
    expect(nudgeMetricValue(undefined, 60, 2.5)).toBe(62.5);
  });

  it("clamps at zero", () => {
    expect(nudgeMetricValue(1, 0, -5)).toBe(0);
  });

  it("rounds to 2 decimals to avoid floating-point drift", () => {
    expect(nudgeMetricValue(0.1, 0, 0.2)).toBe(0.3);
  });
});

/* ------------- UAT: each Set suggests what was lifted last time ============ */

describe("lastTimeActual / suggestMetric / oneTapActual (UAT — last time, not the range)", () => {
  const range = { reps: { min: 8, max: 12 }, load: { min: 50, max: 70 } };
  const working = (id: string, target: PrescribedSet["target"] = range): PrescribedSet => ({
    id: id as never,
    setType: "working",
    target,
  });
  const warmup = (id: string): PrescribedSet => ({ id: id as never, setType: "warmup", target: range });
  const drop = (id: string): PrescribedSet => ({
    id: id as never,
    setType: "drop",
    target: { reps: range.reps, load: {} },
  });
  const actuals = (
    entries: ReadonlyArray<readonly [string, Record<string, number>]>,
  ): ReadonlyMap<PrescribedSet["id"], { readonly actual: Record<string, number> }> =>
    new Map(entries.map(([id, actual]) => [id as never, { actual }]));
  const lastTime = [
    { setType: "warmup" as const, actual: { reps: 10, load: 30 } },
    { setType: "working" as const, actual: { reps: 10, load: 60 } },
    { setType: "working" as const, actual: { reps: 9, load: 60 } },
    { setType: "working" as const, actual: { reps: 8, load: 60 } },
    { setType: "drop" as const, actual: { reps: 12, load: 40 } },
  ];

  it("matches a Set to last time's Set of the same type, by position", () => {
    const sets = [warmup("w1"), working("s1"), working("s2"), working("s3"), drop("d1")];
    expect(lastTimeActual(sets, "w1" as never, lastTime)).toEqual({ reps: 10, load: 30 });
    expect(lastTimeActual(sets, "s2" as never, lastTime)).toEqual({ reps: 9, load: 60 });
    expect(lastTimeActual(sets, "d1" as never, lastTime)).toEqual({ reps: 12, load: 40 });
  });

  it("repeats last time's final Set of that type when this session has more of them", () => {
    const sets = [working("s1"), working("s2"), working("s3"), working("s4")];
    expect(lastTimeActual(sets, "s4" as never, lastTime)).toEqual({ reps: 8, load: 60 });
  });

  it("has nothing for a type last time never had, or with no history at all", () => {
    const sets = [working("s1"), { ...drop("d1"), setType: "rest-pause" as const }];
    expect(lastTimeActual(sets, "d1" as never, lastTime)).toBeUndefined();
    expect(lastTimeActual(sets, "s1" as never, undefined)).toBeUndefined();
    expect(lastTimeActual(sets, "s1" as never, [])).toBeUndefined();
  });

  it("one tap writes last time's numbers over the plan's range", () => {
    const sets = [working("s1"), working("s2")];
    expect(oneTapActual(range, sets, "s1" as never, actuals([]), undefined, lastTime)).toEqual({
      reps: 10,
      load: 60,
    });
    expect(oneTapActual(range, sets, "s2" as never, actuals([]), undefined, lastTime)).toEqual({
      reps: 9,
      load: 60,
    });
  });

  it("falls back to the range when the exercise has never been done", () => {
    const sets = [working("s1")];
    expect(oneTapActual(range, sets, "s1" as never, actuals([]), undefined, [])).toEqual({
      reps: 12,
      load: 70,
    });
  });

  it("keeps each Set on its own history while the user is matching last time", () => {
    const sets = [working("s1"), working("s2"), working("s3")];
    const map = actuals([["s1", { reps: 10, load: 60 }]]);
    expect(suggestMetric(sets, "s2" as never, "reps", map, lastTime)).toBe(9);
  });

  it("repeats this session's previous Set once the user departs from last time", () => {
    const sets = [working("s1"), working("s2"), working("s3")];
    const map = actuals([["s1", { reps: 10, load: 62.5 }]]);
    expect(suggestMetric(sets, "s2" as never, "load", map, lastTime)).toBe(62.5);
    // Reps still matched last time on set 1, so set 2 keeps last time's 9.
    expect(suggestMetric(sets, "s2" as never, "reps", map, lastTime)).toBe(9);
  });

  it("carries the previous Set as before when there is no history for it", () => {
    const sets = [working("s1"), working("s2")];
    const map = actuals([["s1", { reps: 9, load: 62.5 }]]);
    expect(suggestMetric(sets, "s2" as never, "load", map, undefined)).toBe(62.5);
  });

  it("suggests last time for a metric the plan leaves open too", () => {
    const open = { reps: {}, load: {} };
    const sets = [working("s1", open), working("s2", open)];
    expect(oneTapActual(open, sets, "s2" as never, actuals([]), undefined, lastTime)).toEqual({
      reps: 9,
      load: 60,
    });
  });

  it("never suggests effort from last time", () => {
    const withRpe = { ...range, rpe: {} };
    const sets = [working("s1", withRpe)];
    const history = [{ setType: "working" as const, actual: { reps: 10, load: 60, rpe: 8 } }];
    expect(suggestMetric(sets, "s1" as never, "rpe", actuals([]), history)).toBeUndefined();
  });
});

describe("addedEntry (UAT — an exercise added mid-workout)", () => {
  it("opens one row per working Set last time, every catalog metric open", () => {
    const entry = addedEntry({
      entryId: "entry-x" as never,
      exerciseId: "exercise-curl" as never,
      trackedMetrics: ["reps", "load"],
      setCount: 2,
    });
    expect(entry.exerciseId).toBe("exercise-curl");
    expect(entry.sets.map((set) => set.id)).toEqual(["entry-x:1", "entry-x:2"]);
    expect(entry.sets.every((set) => set.setType === "working")).toBe(true);
    expect(entry.sets[0]?.target).toEqual({ reps: {}, load: {} });
  });

  it("falls back to reps and load for an exercise the catalog has not described yet", () => {
    const entry = addedEntry({
      entryId: "entry-x" as never,
      exerciseId: "exercise-new" as never,
      trackedMetrics: [],
      setCount: 1,
    });
    expect(entry.sets[0]?.target).toEqual({ reps: {}, load: {} });
  });

  it("keeps the same Set ids however often it is rebuilt, so a logged row finds its actual", () => {
    const args = { entryId: "entry-x" as never, exerciseId: "e" as never, trackedMetrics: [], setCount: 3 };
    expect(addedEntry(args).sets.map((set) => set.id)).toEqual(addedEntry(args).sets.map((set) => set.id));
  });

  it("does not echo effort as a field — RPE is asked after the fact, not prescribed", () => {
    const entry = addedEntry({
      entryId: "entry-x" as never,
      exerciseId: "e" as never,
      trackedMetrics: ["reps", "load", "rpe"],
      setCount: 1,
    });
    expect(entry.sets[0]?.target).toEqual({ reps: {}, load: {} });
  });
});

describe("suggestMetric (UAT — a plan change since last time wins)", () => {
  const was = { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } };
  const now = { reps: { min: 5, max: 5 }, load: { min: 102.5, max: 102.5 } };
  const working = (id: string, target: PrescribedSet["target"]): PrescribedSet => ({
    id: id as never,
    setType: "working",
    target,
  });
  const actuals = (
    entries: ReadonlyArray<readonly [string, Record<string, number>]>,
  ): ReadonlyMap<PrescribedSet["id"], { readonly actual: Record<string, number> }> =>
    new Map(entries.map(([id, actual]) => [id as never, { actual }]));
  const lastTime = [
    { setType: "working" as const, actual: { reps: 6, load: 100 }, target: was },
    { setType: "working" as const, actual: { reps: 5, load: 100 }, target: was },
  ];

  it("shows the plan's new number for a metric whose prescription moved (an accepted Proposal)", () => {
    const sets = [working("s1", now), working("s2", now)];
    expect(suggestMetric(sets, "s1" as never, "load", actuals([]), lastTime)).toBeUndefined();
    expect(oneTapActual(now, sets, "s1" as never, actuals([]), undefined, lastTime)).toEqual({
      reps: 6,
      load: 102.5,
    });
  });

  it("keeps last time for the metrics the change did not touch", () => {
    const sets = [working("s1", now)];
    expect(suggestMetric(sets, "s1" as never, "reps", actuals([]), lastTime)).toBe(6);
  });

  it("still uses last time when the prescription is the same as it was", () => {
    const sets = [working("s1", was)];
    expect(suggestMetric(sets, "s1" as never, "load", actuals([]), lastTime)).toBe(100);
  });

  it("uses last time when last time's Set had no prescription to compare (an added Set)", () => {
    const sets = [working("s1", now)];
    const unplanned = [{ setType: "working" as const, actual: { load: 95 } }];
    expect(suggestMetric(sets, "s1" as never, "load", actuals([]), unplanned)).toBe(95);
  });

  it("carries a departure from the new number like any other", () => {
    const sets = [working("s1", now), working("s2", now)];
    const map = actuals([["s1", { reps: 5, load: 105 }]]);
    expect(suggestMetric(sets, "s2" as never, "load", map, lastTime)).toBe(105);
  });
});
