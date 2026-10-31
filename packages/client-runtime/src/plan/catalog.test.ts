import { describe, expect, it } from "vitest";

import type { CatalogExercise } from "@repcoach/contracts";

import { findExerciseByName, matchesExerciseQuery, normalizeExerciseName, rankExerciseMatch } from "./catalog.ts";

const exercise = (id: string, name: string): CatalogExercise =>
  ({ id, name, trackedMetrics: [] }) as unknown as CatalogExercise;

describe("normalizeExerciseName", () => {
  it("collapses the spellings people alternate between onto one key", () => {
    const spellings = ["Face Pull", "face-pull", "FACEPULL", "  face   pull  "];
    expect(new Set(spellings.map(normalizeExerciseName)).size).toBe(1);
  });

  it("strips accents, so a name typed without them still compares equal", () => {
    expect(normalizeExerciseName("Pallof Préss")).toBe(normalizeExerciseName("pallof press"));
  });
});

describe("matchesExerciseQuery", () => {
  it("matches across separators the user did not type", () => {
    expect(matchesExerciseQuery("Bulgarian Split-Squat", "splitsquat")).toBe(true);
    expect(matchesExerciseQuery("Bulgarian Split-Squat", "split squat")).toBe(true);
  });

  it("matches multi-word queries in any order", () => {
    expect(matchesExerciseQuery("Bench Press", "press bench")).toBe(true);
  });

  it("does not match an unrelated name", () => {
    expect(matchesExerciseQuery("Bench Press", "zercher")).toBe(false);
  });

  it("matches everything on an empty query — an unfiltered picker is the catalog", () => {
    expect(matchesExerciseQuery("Bench Press", "   ")).toBe(true);
  });

  it("expands a common equipment abbreviation inside a multi-word query", () => {
    expect(matchesExerciseQuery("Incline Dumbbell Bench Press", "incline db press")).toBe(true);
  });

  it("does not match missing intermediate words that aren't abbreviations", () => {
    expect(matchesExerciseQuery("Incline Dumbbell Bench Press", "incline xyz press")).toBe(false);
  });
});

describe("rankExerciseMatch", () => {
  it("ranks an exact match above a mere substring", () => {
    const exact = rankExerciseMatch("Bench Press", "bench press");
    const prefix = rankExerciseMatch("Bench Press Wide Grip", "bench press");
    expect(exact).toBeLessThan(prefix!);
  });

  it("ranks a name that starts with the query above one that merely contains it", () => {
    const starts = rankExerciseMatch("Bench Press", "bench");
    const contains = rankExerciseMatch("Incline Bench Press", "bench");
    expect(starts).toBeLessThan(contains!);
  });

  it("ranks a substring match above a word-order match", () => {
    const substring = rankExerciseMatch("DB Bench Press", "bench press");
    const wordOrder = rankExerciseMatch("Bench Press", "press bench");
    expect(substring).toBeLessThan(wordOrder!);
  });

  it("is undefined — no match — for an unrelated name", () => {
    expect(rankExerciseMatch("Bench Press", "zercher")).toBeUndefined();
  });

  it("orders a catalog best-match-first under a single query", () => {
    const names = ["Incline Bench Press", "Bench Press", "Bench Press Wide Grip"];
    const ranked = names
      .map((name) => ({ name, rank: rankExerciseMatch(name, "bench press") }))
      .sort((a, b) => a.rank! - b.rank!)
      .map((entry) => entry.name);
    expect(ranked).toEqual(["Bench Press", "Bench Press Wide Grip", "Incline Bench Press"]);
  });
});

describe("findExerciseByName", () => {
  const catalog = [exercise("exercise-face-pull", "Face Pull")];

  it("finds the row a differently-spelled query names outright", () => {
    // The duplicate guard: `create "face pull"` must not be offered under an
    // existing `Face Pull`, because the row is the join key (ADR 0016 §2).
    expect(findExerciseByName(catalog, "face-pull")?.id).toBe("exercise-face-pull");
  });

  it("does not treat a near miss as the same exercise", () => {
    // `Face Pull (cable)` is allowed to be its own exercise if the user says
    // so — only an exact normalized match suppresses creation.
    expect(findExerciseByName(catalog, "Face Pull (cable)")).toBeUndefined();
  });

  it("names nothing on an empty query", () => {
    expect(findExerciseByName(catalog, "  ")).toBeUndefined();
  });
});
