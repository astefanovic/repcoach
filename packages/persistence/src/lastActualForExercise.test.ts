import { describe, expect, it } from "vitest";

import type {
  ActualMetricMap,
  LogSetActualResult,
  MetricName,
  PrescribedSession,
  UnlogSetActualResult,
} from "@repcoach/contracts";

import {
  resolveBestE1rm,
  resolveExerciseProgress,
  resolveLastActualForExercise,
  resolveLastSetsForExercise,
  type FinishedSessionView,
} from "./lastActualForExercise.ts";

/** One Entry with one Block wrapper, the shape `resolveLastActualForExercise` reads. */
const session = (
  args: {
    readonly loggedSessionId: string;
    readonly finishedAt: string;
    readonly startedAt?: string;
    readonly entries: ReadonlyArray<{
      readonly id: string;
      readonly exerciseId: string;
      readonly setIds: ReadonlyArray<string>;
    }>;
    readonly actuals: ReadonlyArray<{
      readonly setId: string;
      readonly appliedAt: string;
      readonly actual?: ActualMetricMap;
      readonly retraction?: boolean;
      readonly entryId?: string;
      readonly setType?: "working" | "warmup" | "drop";
    }>;
    readonly swaps?: ReadonlyArray<{ entryId: string; exerciseId: string; swappedAt: string }>;
  },
): FinishedSessionView => ({
  loggedSessionId: args.loggedSessionId,
  finishedAt: args.finishedAt,
  startedAt: args.startedAt ?? args.finishedAt,
  snapshot: {
    id: args.loggedSessionId as never,
    blocks: [
      {
        id: "block-1" as never,
        format: "straight",
        entries: args.entries.map((entry) => ({
          id: entry.id as never,
          exerciseId: entry.exerciseId as never,
          sets: entry.setIds.map((setId) => ({
            id: setId as never,
            setType: "working" as const,
            target: {},
          })),
        })),
      },
    ],
  } as PrescribedSession,
  actuals: args.actuals.map((row) =>
    row.retraction
      ? ({
          commandId: `${row.setId}-${row.appliedAt}` as never,
          loggedSessionId: args.loggedSessionId as never,
          entryId: (row.entryId ?? "entry-1") as never,
          setId: row.setId as never,
          appliedAt: row.appliedAt,
          retraction: true,
        } satisfies UnlogSetActualResult)
      : ({
          commandId: `${row.setId}-${row.appliedAt}` as never,
          loggedSessionId: args.loggedSessionId as never,
          sessionId: args.loggedSessionId as never,
          entryId: (row.entryId ?? "entry-1") as never,
          setId: row.setId as never,
          setType: row.setType ?? "working",
          actual: row.actual ?? {},
          appliedAt: row.appliedAt,
          retraction: false,
        } satisfies LogSetActualResult),
  ),
  swaps: args.swaps ?? [],
});

const REPS_LOAD: ReadonlyArray<MetricName> = ["reps", "load"];

/** Order and values only — the `target` each Set carries has its own describe block. */
const withoutTargets = (sets: ReturnType<typeof resolveLastSetsForExercise>) =>
  sets.map(({ setType, actual }) => ({ setType, actual }));

describe("resolveLastActualForExercise (issue #149 tier-2 seed)", () => {
  it("returns the most recent actual per metric for a performed exercise", () => {
    const result = resolveLastActualForExercise(
      [
        session({
          loggedSessionId: "s1",
          finishedAt: "2026-01-01T10:00:00Z",
          entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["set-1", "set-2"] }],
          actuals: [
            { setId: "set-1", appliedAt: "2026-01-01T09:00:00Z", actual: { reps: 8, load: 100 } },
            { setId: "set-2", appliedAt: "2026-01-01T09:05:00Z", actual: { reps: 7, load: 105 } },
          ],
        }),
      ],
      "ex-a",
      REPS_LOAD,
    );
    expect(result).toEqual({ reps: 7, load: 105 });
  });

  it("is {} for an exercise never performed", () => {
    const result = resolveLastActualForExercise(
      [
        session({
          loggedSessionId: "s1",
          finishedAt: "2026-01-01T10:00:00Z",
          entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["set-1"] }],
          actuals: [{ setId: "set-1", appliedAt: "2026-01-01T09:00:00Z", actual: { reps: 8 } }],
        }),
      ],
      "ex-z",
      REPS_LOAD,
    );
    expect(result).toEqual({});
  });

  it("walks sessions newest-first — a later session's value wins", () => {
    const older = session({
      loggedSessionId: "s-old",
      finishedAt: "2026-01-01T10:00:00Z",
      entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["set-1"] }],
      actuals: [{ setId: "set-1", appliedAt: "2026-01-01T09:00:00Z", actual: { load: 100 } }],
    });
    const newer = session({
      loggedSessionId: "s-new",
      finishedAt: "2026-02-01T10:00:00Z",
      entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["set-1"] }],
      actuals: [{ setId: "set-1", appliedAt: "2026-02-01T09:00:00Z", actual: { load: 110 } }],
    });
    // input order deliberately oldest-first, to prove the sort does the work
    expect(resolveLastActualForExercise([older, newer], "ex-a", REPS_LOAD)).toEqual({ load: 110 });
  });

  it("fills each metric from whichever set most recently carried it", () => {
    const result = resolveLastActualForExercise(
      [
        session({
          loggedSessionId: "s1",
          finishedAt: "2026-01-01T10:00:00Z",
          entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["set-1", "set-2"] }],
          actuals: [
            { setId: "set-1", appliedAt: "2026-01-01T09:00:00Z", actual: { reps: 5, load: 50 } },
            { setId: "set-2", appliedAt: "2026-01-01T09:05:00Z", actual: { reps: 10 } },
          ],
        }),
      ],
      "ex-a",
      REPS_LOAD,
    );
    expect(result).toEqual({ reps: 10, load: 50 });
  });

  it("folds net state — a set logged then retracted contributes nothing", () => {
    const result = resolveLastActualForExercise(
      [
        session({
          loggedSessionId: "s1",
          finishedAt: "2026-01-01T10:00:00Z",
          entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["set-1", "set-2"] }],
          actuals: [
            { setId: "set-1", appliedAt: "2026-01-01T09:00:00Z", actual: { load: 90 } },
            { setId: "set-2", appliedAt: "2026-01-01T09:05:00Z", actual: { load: 200 } },
            { setId: "set-2", appliedAt: "2026-01-01T09:06:00Z", retraction: true },
          ],
        }),
      ],
      "ex-a",
      REPS_LOAD,
    );
    expect(result).toEqual({ load: 90 });
  });

  it("keys on the performed exercise after a swap, not the prescribed one", () => {
    const sessions = [
      session({
        loggedSessionId: "s1",
        finishedAt: "2026-01-01T10:00:00Z",
        entries: [{ id: "entry-1", exerciseId: "ex-prescribed", setIds: ["set-1"] }],
        actuals: [{ setId: "set-1", appliedAt: "2026-01-01T09:00:00Z", actual: { load: 200 } }],
        swaps: [{ entryId: "entry-1", exerciseId: "ex-performed", swappedAt: "2026-01-01T08:00:00Z" }],
      }),
    ];
    expect(resolveLastActualForExercise(sessions, "ex-performed", REPS_LOAD)).toEqual({ load: 200 });
    expect(resolveLastActualForExercise(sessions, "ex-prescribed", REPS_LOAD)).toEqual({});
  });

  it("drops a metric outside the exercise's tracked metrics", () => {
    const sessions = [
      session({
        loggedSessionId: "s1",
        finishedAt: "2026-01-01T10:00:00Z",
        entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["set-1"] }],
        actuals: [{ setId: "set-1", appliedAt: "2026-01-01T09:00:00Z", actual: { reps: 5, rpe: 9 } }],
      }),
    ];
    expect(resolveLastActualForExercise(sessions, "ex-a", ["reps"])).toEqual({ reps: 5 });
  });
});

describe("resolveLastActualForExercise — Sets outside the frozen prescription (UAT)", () => {
  it("counts an unplanned Set and an exercise added mid-workout, by the Entry they were logged on", () => {
    const sessions = [
      session({
        loggedSessionId: "s1",
        finishedAt: "2026-01-01T10:00:00Z",
        entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["set-1"] }],
        actuals: [
          { setId: "set-1", appliedAt: "2026-01-01T09:00:00Z", actual: { load: 100 } },
          { setId: "added:1", entryId: "added", appliedAt: "2026-01-01T09:30:00Z", actual: { load: 20 } },
        ],
        // An added exercise is recorded as the performed exercise of an Entry
        // the snapshot does not hold.
        swaps: [{ entryId: "added", exerciseId: "ex-curl", swappedAt: "2026-01-01T09:20:00Z" }],
      }),
    ];
    expect(resolveLastActualForExercise(sessions, "ex-curl", REPS_LOAD)).toEqual({ load: 20 });
    expect(resolveLastActualForExercise(sessions, "ex-a", REPS_LOAD)).toEqual({ load: 100 });
  });
});

describe("resolveLastSetsForExercise (UAT — what was lifted last time, Set by Set)", () => {
  it("returns the most recent session's Sets for the exercise, in the order they sat on the Entry", () => {
    const sessions = [
      session({
        loggedSessionId: "old",
        finishedAt: "2026-01-01T10:00:00Z",
        entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["o1"] }],
        actuals: [{ setId: "o1", appliedAt: "2026-01-01T09:00:00Z", actual: { reps: 5, load: 80 } }],
      }),
      session({
        loggedSessionId: "new",
        finishedAt: "2026-01-08T10:00:00Z",
        entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["n1", "n2", "n3"] }],
        actuals: [
          // Set 1 corrected after set 2 was logged: prescription order, not log order.
          { setId: "n2", appliedAt: "2026-01-08T09:02:00Z", actual: { reps: 9, load: 60 } },
          { setId: "n1", appliedAt: "2026-01-08T09:03:00Z", actual: { reps: 10, load: 60 } },
          { setId: "n3", appliedAt: "2026-01-08T09:04:00Z", actual: { reps: 8, load: 60 } },
          { setId: "x1", appliedAt: "2026-01-08T09:05:00Z", setType: "drop", actual: { reps: 12, load: 40 } },
        ],
      }),
    ];
    expect(withoutTargets(resolveLastSetsForExercise(sessions, "ex-a", REPS_LOAD))).toEqual([
      { setType: "working", actual: { reps: 10, load: 60 } },
      { setType: "working", actual: { reps: 9, load: 60 } },
      { setType: "working", actual: { reps: 8, load: 60 } },
      { setType: "drop", actual: { reps: 12, load: 40 } },
    ]);
  });

  it("skips a session where the exercise was prescribed but nothing was logged", () => {
    const sessions = [
      session({
        loggedSessionId: "logged",
        finishedAt: "2026-01-01T10:00:00Z",
        entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["a1"] }],
        actuals: [{ setId: "a1", appliedAt: "2026-01-01T09:00:00Z", actual: { reps: 5 } }],
      }),
      session({
        loggedSessionId: "skipped",
        finishedAt: "2026-01-08T10:00:00Z",
        entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["b1"] }],
        actuals: [
          { setId: "b1", appliedAt: "2026-01-08T09:00:00Z", actual: { reps: 6 } },
          { setId: "b1", appliedAt: "2026-01-08T09:01:00Z", retraction: true },
        ],
      }),
    ];
    expect(withoutTargets(resolveLastSetsForExercise(sessions, "ex-a", REPS_LOAD))).toEqual([
      { setType: "working", actual: { reps: 5 } },
    ]);
  });

  it("is empty for an exercise never performed, and drops untracked metrics", () => {
    const sessions = [
      session({
        loggedSessionId: "s1",
        finishedAt: "2026-01-01T10:00:00Z",
        entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["set-1"] }],
        actuals: [{ setId: "set-1", appliedAt: "2026-01-01T09:00:00Z", actual: { reps: 5, rpe: 9 } }],
      }),
    ];
    expect(withoutTargets(resolveLastSetsForExercise(sessions, "ex-b", REPS_LOAD))).toEqual([]);
    expect(withoutTargets(resolveLastSetsForExercise(sessions, "ex-a", ["reps"]))).toEqual([
      { setType: "working", actual: { reps: 5 } },
    ]);
  });
});

describe("an exercise the catalog has not described yet (ADR 0016)", () => {
  it("keeps every metric when trackedMetrics is empty — un-enriched is unknown, not 'tracks nothing'", () => {
    const sessions = [
      session({
        loggedSessionId: "s1",
        finishedAt: "2026-01-01T10:00:00Z",
        entries: [{ id: "entry-1", exerciseId: "ex-new", setIds: ["set-1"] }],
        actuals: [{ setId: "set-1", appliedAt: "2026-01-01T09:00:00Z", actual: { reps: 8, load: 40 } }],
      }),
    ];
    expect(resolveLastActualForExercise(sessions, "ex-new", [])).toEqual({ reps: 8, load: 40 });
    expect(withoutTargets(resolveLastSetsForExercise(sessions, "ex-new", []))).toEqual([
      { setType: "working", actual: { reps: 8, load: 40 } },
    ]);
  });
});

describe("resolveLastSetsForExercise — the prescription each Set was logged against", () => {
  it("carries the snapshot's target for a prescribed Set, and none for one the snapshot never held", () => {
    const sessions = [
      session({
        loggedSessionId: "s1",
        finishedAt: "2026-01-01T10:00:00Z",
        entries: [{ id: "entry-1", exerciseId: "ex-a", setIds: ["set-1"] }],
        actuals: [
          { setId: "set-1", appliedAt: "2026-01-01T09:00:00Z", actual: { reps: 5 } },
          { setId: "extra", appliedAt: "2026-01-01T09:01:00Z", actual: { reps: 4 } },
        ],
      }),
    ];
    expect(resolveLastSetsForExercise(sessions, "ex-a", ["reps"])).toEqual([
      { setType: "working", actual: { reps: 5 }, target: {} },
      { setType: "working", actual: { reps: 4 } },
    ]);
  });
});

describe("resolveBestE1rm (the PR badge's bar)", () => {
  const squat = (loggedSessionId: string, finishedAt: string, sets: ReadonlyArray<ActualMetricMap>) =>
    session({
      loggedSessionId,
      finishedAt,
      entries: [{ id: "entry-1", exerciseId: "squat", setIds: sets.map((_, i) => `set-${i + 1}`) }],
      actuals: sets.map((actual, i) => ({ setId: `set-${i + 1}`, appliedAt: `${finishedAt}-${i}`, actual })),
    });

  it("is the highest Epley estimate across every finished session", () => {
    const best = resolveBestE1rm(
      [
        squat("a", "2026-01-01", [{ load: 100, reps: 5 }]), // 116.67
        squat("b", "2026-01-08", [{ load: 110, reps: 1 }, { load: 90, reps: 10 }]), // 110, 120
      ],
      "squat",
    );
    expect(best).toBeCloseTo(120, 5);
  });

  it("ignores warmups, retracted Sets, other exercises, and Sets past 12 reps", () => {
    const sessions = [
      session({
        loggedSessionId: "a",
        finishedAt: "2026-01-01",
        entries: [
          { id: "entry-1", exerciseId: "squat", setIds: ["w", "s1", "s2", "s3"] },
          { id: "entry-2", exerciseId: "bench", setIds: ["b1"] },
        ],
        actuals: [
          { setId: "w", appliedAt: "1", actual: { load: 200, reps: 5 }, setType: "warmup" },
          { setId: "s1", appliedAt: "2", actual: { load: 300, reps: 5 } },
          { setId: "s1", appliedAt: "3", retraction: true },
          { setId: "s2", appliedAt: "4", actual: { load: 60, reps: 20 } },
          { setId: "s3", appliedAt: "5", actual: { load: 80, reps: 3 } },
          { setId: "b1", appliedAt: "6", actual: { load: 500, reps: 1 }, entryId: "entry-2" },
        ],
      }),
    ];
    expect(resolveBestE1rm(sessions, "squat")).toBeCloseTo(88, 5);
  });

  it("is undefined when nothing had a load and reps", () => {
    expect(resolveBestE1rm([squat("a", "2026-01-01", [{ reps: 10 }])], "squat")).toBeUndefined();
    expect(resolveBestE1rm([], "squat")).toBeUndefined();
  });

  it("counts a swapped Entry toward the exercise actually performed", () => {
    const swapped = session({
      loggedSessionId: "a",
      finishedAt: "2026-01-01",
      entries: [{ id: "entry-1", exerciseId: "squat", setIds: ["set-1"] }],
      actuals: [{ setId: "set-1", appliedAt: "1", actual: { load: 150, reps: 1 } }],
      swaps: [{ entryId: "entry-1", exerciseId: "leg-press", swappedAt: "0" }],
    });
    expect(resolveBestE1rm([swapped], "squat")).toBeUndefined();
    expect(resolveBestE1rm([swapped], "leg-press")).toBe(150);
  });
});

describe("resolveExerciseProgress (the Progress surface's read)", () => {
  it("groups each exercise's finished sessions oldest first, Sets in Entry order", () => {
    const sessions = [
      session({
        loggedSessionId: "later",
        finishedAt: "2026-02-01",
        entries: [{ id: "entry-1", exerciseId: "squat", setIds: ["s1", "s2"] }],
        actuals: [
          { setId: "s2", appliedAt: "1", actual: { load: 105, reps: 4 } },
          { setId: "s1", appliedAt: "2", actual: { load: 100, reps: 5 } },
        ],
      }),
      session({
        loggedSessionId: "earlier",
        finishedAt: "2026-01-01",
        entries: [
          { id: "entry-1", exerciseId: "squat", setIds: ["s1"] },
          { id: "entry-2", exerciseId: "bench", setIds: ["b1"] },
        ],
        actuals: [
          { setId: "s1", appliedAt: "1", actual: { load: 95, reps: 5 } },
          { setId: "b1", appliedAt: "2", actual: { load: 70, reps: 8 }, entryId: "entry-2" },
        ],
      }),
    ];
    const progress = resolveExerciseProgress(sessions);
    const squat = progress.find((exercise) => exercise.exerciseId === "squat");
    expect(squat?.sessions.map((s) => s.loggedSessionId)).toEqual(["earlier", "later"]);
    expect(squat?.sessions[1]?.sets).toEqual([
      { setType: "working", load: 100, reps: 5 },
      { setType: "working", load: 105, reps: 4 },
    ]);
    expect(progress.find((exercise) => exercise.exerciseId === "bench")?.sessions).toHaveLength(1);
  });
});
