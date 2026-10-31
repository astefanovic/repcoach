import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv.ts";
import { matchImportedExercise, parseLocalDateTime, parseWorkoutCsv, toImportPayload } from "./parse.ts";

const local = (...parts: [number, number, number, number, number]) =>
  new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]).toISOString();

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes, embedded newlines and CRLF", () => {
    expect(parseCsv('a,b,c\r\n"x, y","say ""hi""","line\nbreak"\r\n\r\n')).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line\nbreak"],
    ]);
  });

  it("sniffs a semicolon delimiter and drops a BOM", () => {
    expect(parseCsv("﻿a;b\n1,5;2")).toEqual([
      ["a", "b"],
      ["1,5", "2"],
    ]);
  });
});

describe("parseWorkoutCsv — Strong", () => {
  const strong = [
    "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE",
    '2024-01-15 07:30:00,"Push A",1h 5m,Bench Press (Barbell),W,40,10,0,0,,,',
    "2024-01-15 07:30:00,Push A,1h 5m,Bench Press (Barbell),1,80,5,0,0,,,8",
    "2024-01-15 07:30:00,Push A,1h 5m,Bench Press (Barbell),D,60,8,0,0,,,",
    "2024-01-15 07:30:00,Push A,1h 5m,Bench Press (Barbell),Rest Timer,0,0,0,90,,,",
    "2024-01-15 07:30:00,Push A,1h 5m,Plank,1,0,0,0,60,,,",
    "2024-01-15 07:30:00,Push A,1h 5m,Plank,2,0,0,0,0,,,",
    "2024-01-12 18:00:00,Legs,45m,Squat (Barbell),1,100,5,0,0,,,",
  ].join("\n");

  it("groups rows into workouts, oldest first, in local time and kg", () => {
    const result = parseWorkoutCsv(strong, { fallbackWeightUnit: "kg" });
    if (!result.ok) throw new Error(result.reason);
    const { workouts, exerciseNames, setCount, skippedRows, source } = result.value;
    expect(source).toBe("strong");
    expect(exerciseNames).toEqual(["Bench Press (Barbell)", "Plank", "Squat (Barbell)"]);
    expect(setCount).toBe(5);
    // The rest-timer row and the empty Plank set.
    expect(skippedRows).toBe(2);
    expect(workouts.map((workout) => workout.name)).toEqual(["Legs", "Push A"]);
    const push = workouts[1]!;
    expect(push.startedAt).toBe(local(2024, 1, 15, 7, 30));
    expect(push.finishedAt).toBe(local(2024, 1, 15, 8, 35));
    expect(push.importKey).toBe("strong|2024-01-15 07:30:00|Push A");
    expect(push.exercises[0]!.sets).toEqual([
      { setType: "warmup", actual: { reps: 10, load: 40 } },
      { setType: "working", actual: { reps: 5, load: 80, rpe: 8 } },
      { setType: "drop", actual: { reps: 8, load: 60 } },
    ]);
    expect(push.exercises[0]!.trackedMetrics).toEqual(["reps", "load", "rpe"]);
    expect(push.exercises[1]).toEqual({
      name: "Plank",
      trackedMetrics: ["duration"],
      sets: [{ setType: "working", actual: { duration: 60 } }],
    });
  });

  it("converts pounds from a unit column, a unit header, or the fallback", () => {
    const loadOf = (csv: string, fallbackWeightUnit: "kg" | "lb") => {
      const result = parseWorkoutCsv(csv, { fallbackWeightUnit });
      if (!result.ok) throw new Error(result.reason);
      return result.value.workouts[0]!.exercises[0]!.sets[0]!.actual.load;
    };
    const column = "Date,Workout Name,Exercise Name,Set Order,Weight,Weight Unit,Reps\n2024-01-01 09:00:00,A,Squat,1,225,lbs,5";
    const header = "Date,Workout Name,Exercise Name,Set Order,Weight (lbs),Reps\n2024-01-01 09:00:00,A,Squat,1,225,5";
    const bare = "Date,Workout Name,Exercise Name,Set Order,Weight,Reps\n2024-01-01 09:00:00,A,Squat,1,225,5";
    expect(loadOf(column, "kg")).toBe(102.058);
    expect(loadOf(header, "kg")).toBe(102.058);
    expect(loadOf(bare, "lb")).toBe(102.058);
    expect(loadOf(bare, "kg")).toBe(225);
  });

  it("reads a semicolon export with decimal commas", () => {
    const csv = "Date;Workout Name;Exercise Name;Set Order;Weight;Reps\n2024-01-01 09:00:00;A;Curl;1;12,5;10";
    const result = parseWorkoutCsv(csv, { fallbackWeightUnit: "kg" });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.workouts[0]!.exercises[0]!.sets[0]!.actual).toEqual({ reps: 10, load: 12.5 });
  });
});

describe("parseWorkoutCsv — Hevy", () => {
  it("reads Hevy's columns, set types and named-month times", () => {
    const csv = [
      '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"',
      '"Pull","3 Feb 2024, 18:05","3 Feb 2024, 19:10","","Pull Up","","","0","warmup","","5","","",""',
      '"Pull","3 Feb 2024, 18:05","3 Feb 2024, 19:10","","Pull Up","","","1","normal","10","8","","","9"',
      '"Pull","3 Feb 2024, 18:05","3 Feb 2024, 19:10","","Rowing Machine","","","0","normal","","","2.5","600",""',
    ].join("\n");
    const result = parseWorkoutCsv(csv, { fallbackWeightUnit: "kg" });
    if (!result.ok) throw new Error(result.reason);
    const [workout] = result.value.workouts;
    expect(result.value.source).toBe("hevy");
    expect(workout!.startedAt).toBe(local(2024, 2, 3, 18, 5));
    expect(workout!.finishedAt).toBe(local(2024, 2, 3, 19, 10));
    expect(workout!.exercises.map((exercise) => exercise.sets)).toEqual([
      [
        { setType: "warmup", actual: { reps: 5 } },
        { setType: "working", actual: { reps: 8, load: 10, rpe: 9 } },
      ],
      [{ setType: "working", actual: { distance: 2500, duration: 600 } }],
    ]);
  });
});

describe("parseWorkoutCsv — not an export", () => {
  it("says so rather than importing nothing", () => {
    expect(parseWorkoutCsv("", { fallbackWeightUnit: "kg" }).ok).toBe(false);
    expect(parseWorkoutCsv("name,email\nA,b", { fallbackWeightUnit: "kg" }).ok).toBe(false);
    expect(parseWorkoutCsv("Date,Exercise Name,Set Order\n", { fallbackWeightUnit: "kg" }).ok).toBe(false);
  });
});

describe("parseLocalDateTime", () => {
  it("keeps an explicit offset", () => {
    expect(parseLocalDateTime("2024-01-01T09:00:00Z")?.toISOString()).toBe("2024-01-01T09:00:00.000Z");
  });
  it("rejects nonsense", () => {
    expect(parseLocalDateTime("yesterday")).toBeUndefined();
  });
});

describe("matchImportedExercise", () => {
  const catalog = [
    { id: "a" as never, name: "Barbell Bench Press", trackedMetrics: [] },
    { id: "b" as never, name: "Plank", trackedMetrics: [] },
  ];
  it("tries the equipment-first and bare forms of a parenthesised name", () => {
    expect(matchImportedExercise(catalog, "Bench Press (Barbell)")?.id).toBe("a");
    expect(matchImportedExercise(catalog, "Plank (Weighted)")?.id).toBe("b");
    expect(matchImportedExercise(catalog, "plank")?.id).toBe("b");
    expect(matchImportedExercise(catalog, "Deadlift (Barbell)")).toBeUndefined();
  });
});

describe("toImportPayload", () => {
  it("drops unmapped exercises and workouts left empty", () => {
    const csv = [
      "Date,Workout Name,Exercise Name,Set Order,Weight,Reps",
      "2024-01-01 09:00:00,A,Squat,1,100,5",
      "2024-01-01 09:00:00,A,Curl,1,10,10",
      "2024-01-02 09:00:00,B,Curl,1,10,10",
    ].join("\n");
    const result = parseWorkoutCsv(csv, { fallbackWeightUnit: "kg" });
    if (!result.ok) throw new Error(result.reason);
    const payload = toImportPayload(result.value.workouts, new Map([["Squat", "squat-id" as never]]));
    expect(payload).toEqual([
      {
        importKey: "strong|2024-01-01 09:00:00|A",
        name: "A",
        startedAt: local(2024, 1, 1, 9, 0),
        finishedAt: local(2024, 1, 1, 9, 0),
        entries: [
          { exerciseId: "squat-id", trackedMetrics: ["reps", "load"], sets: [{ setType: "working", actual: { reps: 5, load: 100 } }] },
        ],
      },
    ]);
  });
});
