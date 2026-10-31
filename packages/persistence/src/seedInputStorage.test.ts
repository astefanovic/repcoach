import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { CommitDeliberationOutputInput } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { SEEDED_SESSION_ID, Store } from "./store.ts";

/**
 * Black-box rung-1 coverage for the six seed-input Store methods added by
 * issue #34 (2B "seed-input storage"), run against BOTH `Store` layers — the
 * in-memory `Store.layer` and the real SQLite `SqlStore` — via one shared
 * assertion body, mirroring `commitDeliberationOutput.test.ts`'s
 * pattern so the two layers can't silently drift.
 *
 * Deliberately tests ONLY the public `Store` surface (`getGoal`/`setGoal`,
 * `listStandingConstraints`/`addStandingConstraint`/
 * `removeStandingConstraint`, `listCheckIns`/`addCheckIn`,
 * `listContextNotes`/`addContextNote`, `listEvidenceRoster`,
 * `getPointerDigestHistory`), never internals.
 */

const runSeedInputSuite = (withStore: <A>(effect: Effect.Effect<A, never, Store>) => Promise<A>) => {
  describe("Goal", () => {
    it("getGoal is undefined until setGoal is called; setGoal returns and persists the Goal", async () => {
      const [beforeGoal, setResult, afterGoal] = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const before = yield* store.getGoal;
          const set = yield* store.setGoal({ statement: "Build strength", proxies: ["e1RM trend", "bodyweight"] });
          const after = yield* store.getGoal;
          return [before, set, after] as const;
        }),
      );

      expect(beforeGoal).toBeUndefined();
      expect(setResult).toEqual({ statement: "Build strength", proxies: ["e1RM trend", "bodyweight"] });
      expect(afterGoal).toEqual(setResult);
    });

    it("setGoal REPLACES the prior Goal — never accumulates a history (CONTEXT: one current Goal)", async () => {
      const finalGoal = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.setGoal({ statement: "Build strength", proxies: ["e1RM trend"] });
          yield* store.setGoal({ statement: "Lose fat while retaining muscle", proxies: ["bodyweight", "waist"] });
          return yield* store.getGoal;
        }),
      );

      expect(finalGoal).toEqual({ statement: "Lose fat while retaining muscle", proxies: ["bodyweight", "waist"] });
    });
  });

  describe("Standing constraints", () => {
    it("addStandingConstraint stores hard and soft constraints; listStandingConstraints returns ALL of them", async () => {
      const constraints = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.addStandingConstraint({ text: "No overhead pressing — shoulder injury", severity: "hard" });
          yield* store.addStandingConstraint({ text: "Prefers barbell over machines", severity: "soft" });
          return yield* store.listStandingConstraints;
        }),
      );

      expect(constraints).toHaveLength(2);
      expect(constraints.filter((c) => c.severity === "hard")).toHaveLength(1);
      expect(constraints.filter((c) => c.severity === "soft")).toHaveLength(1);
      // Every constraint got a distinct runner-assigned id.
      expect(new Set(constraints.map((c) => c.id)).size).toBe(2);
    });

    it("removeStandingConstraint deletes an existing constraint (removed: true) and is a no-op for an unknown id (removed: false)", async () => {
      const [removedExisting, removedUnknown, remaining] = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const constraint = yield* store.addStandingConstraint({ text: "Trains at 6am", severity: "soft" });
          const removedExisting = yield* store.removeStandingConstraint({ constraintId: constraint.id });
          const removedUnknown = yield* store.removeStandingConstraint({ constraintId: "does-not-exist" });
          const remaining = yield* store.listStandingConstraints;
          return [removedExisting, removedUnknown, remaining] as const;
        }),
      );

      expect(removedExisting).toEqual({ removed: true });
      expect(removedUnknown).toEqual({ removed: false });
      expect(remaining).toHaveLength(0);
    });
  });

  describe("Check-ins", () => {
    it("addCheckIn stores structured sleep/soreness/stress/energy and returns a rendered summary; listCheckIns round-trips it", async () => {
      const [added, listed] = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const added = yield* store.addCheckIn({
            recordedAt: "2026-07-10T08:00:00.000Z",
            sleep: 4,
            soreness: 2,
            stress: 3,
            energy: 5,
          });
          const listed = yield* store.listCheckIns;
          return [added, listed] as const;
        }),
      );

      expect(added.recordedAt).toBe("2026-07-10T08:00:00.000Z");
      expect(added.summary).toContain("Sleep 4/5");
      expect(added.summary).toContain("Soreness 2/5");
      expect(added.summary).toContain("Stress 3/5");
      expect(added.summary).toContain("Energy 5/5");
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(added);
    });

    it("listCheckIns orders by recordedAt ascending", async () => {
      const recordedAts = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.addCheckIn({
            recordedAt: "2026-07-12T08:00:00.000Z",
            sleep: 3,
            soreness: 3,
            stress: 3,
            energy: 3,
          });
          yield* store.addCheckIn({
            recordedAt: "2026-07-10T08:00:00.000Z",
            sleep: 3,
            soreness: 3,
            stress: 3,
            energy: 3,
          });
          yield* store.addCheckIn({
            recordedAt: "2026-07-11T08:00:00.000Z",
            sleep: 3,
            soreness: 3,
            stress: 3,
            energy: 3,
          });
          const listed = yield* store.listCheckIns;
          return listed.map((c) => c.recordedAt);
        }),
      );

      expect(recordedAts).toEqual(["2026-07-10T08:00:00.000Z", "2026-07-11T08:00:00.000Z", "2026-07-12T08:00:00.000Z"]);
    });
  });

  describe("Context notes", () => {
    it("addContextNote stores free text; listContextNotes round-trips it", async () => {
      const [added, listed] = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const added = yield* store.addContextNote({
            text: "Traveling next week, dumbbells only",
            recordedAt: "2026-07-10T08:00:00.000Z",
          });
          const listed = yield* store.listContextNotes;
          return [added, listed] as const;
        }),
      );

      expect(added.text).toBe("Traveling next week, dumbbells only");
      expect(added.recordedAt).toBe("2026-07-10T08:00:00.000Z");
      expect(listed).toEqual([added]);
    });

    // Issue #130: an Entry-anchored note (both `entryId` and
    // `loggedSessionId` present) is the "Add a note" sheet item — the
    // unanchored case above stays the pre-#130 free-floating Context note.
    it("addContextNote carries entryId/loggedSessionId when supplied, absent otherwise", async () => {
      const [unanchored, anchored] = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never).pipe(Effect.orDie);
          const unanchoredNote = yield* store.addContextNote({ text: "Sleeping badly this week" });
          const anchoredNote = yield* store.addContextNote({
            text: "left elbow twinged on set 3",
            entryId: "entry-1" as never,
            loggedSessionId,
          });
          return [unanchoredNote, anchoredNote] as const;
        }),
      );

      expect(unanchored.entryId).toBeUndefined();
      expect(unanchored.loggedSessionId).toBeUndefined();
      expect(anchored.entryId).toBe("entry-1");
      expect(anchored.loggedSessionId).toBeDefined();
    });

    // A `commandId` makes the write idempotent under outbox replay — it
    // doubles as the note's own `id` (migration `018`), so a repeated call
    // with the same `commandId` returns the SAME note rather than a second
    // one, exactly like a repeated `logSetActual` with the same `commandId`.
    it("addContextNote is idempotent by commandId — a replayed call returns the same note, not a duplicate", async () => {
      const [first, second, listed] = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const input = { text: "left elbow twinged", commandId: "note-cmd-idempotent-1" as never };
          const a = yield* store.addContextNote(input);
          const b = yield* store.addContextNote(input);
          const all = yield* store.listContextNotes;
          return [a, b, all] as const;
        }),
      );

      expect(second).toEqual(first);
      expect(listed.filter((n) => n.id === "note-cmd-idempotent-1")).toHaveLength(1);
    });
  });

  describe("Evidence-base roster", () => {
    it("listEvidenceRoster is real and non-empty on a fresh store — server-seeded, not user-authored (ADR 0003)", async () => {
      const roster = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.listEvidenceRoster;
        }),
      );

      expect(roster.length).toBeGreaterThan(0);
      for (const entry of roster) {
        expect(entry.trust).toBe("corpus-verified");
        expect(entry.claim.length).toBeGreaterThan(0);
        expect(entry.source.length).toBeGreaterThan(0);
        expect(entry.applicability.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Pointer-digest history derivation", () => {
    const dataWindowFor = (cadence: "session-review" | "cycle-review" | "on-demand") => ({
      cadence,
      ran_at: "2026-07-01T00:00:00.000Z",
      session_ids_considered: [],
      evidence_roster_version: "roster-v1",
    });

    const commitReviewDecision = (
      cadence: "session-review" | "cycle-review" | "on-demand",
    ): CommitDeliberationOutputInput => ({
      runOutput: {
        decisions: [
          {
            kind: "observation",
            summary: "test observation",
            rationale: "test rationale",
            citations: [],
            reasoning_only_points: [],
            surface: false,
          },
        ],
        observation_directives: [],
      },
      dataWindow: dataWindowFor(cadence),
    });

    it("no-prior-review edge: sessionsSinceLastReview counts ALL logged sessions ever, lastCycleReviewAt is undefined", async () => {
      const digest = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.startSession(SEEDED_SESSION_ID as never);
          return yield* store.getPointerDigestHistory;
        }).pipe(Effect.orDie),
      );

      expect(digest.sessionsSinceLastReview).toBe(2);
      expect(digest.lastCycleReviewAt).toBeUndefined();
    });

    it("counts only logged sessions started AFTER the most recent review-kind decision, and reports its cadence-specific timestamp", async () => {
      const digest = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;

          // Two sessions BEFORE any review — must not count toward "since last review".
          yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.startSession(SEEDED_SESSION_ID as never);
          // `createdAt`/`startedAt` are millisecond-resolution wall-clock
          // timestamps — sleep between events so ordering is unambiguous
          // rather than racing same-millisecond ties in a fast test run.
          yield* Effect.sleep("5 millis");

          // A session-review run commits a decision with `created_at` set to
          // "now" by the store — no way to inject an exact timestamp via the
          // public Store surface, so this test proves ORDERING (sessions
          // started after the commit count, sessions started before do not)
          // rather than exact clock values.
          yield* store.commitDeliberationOutput(commitReviewDecision("session-review"));
          yield* Effect.sleep("5 millis");

          // One session AFTER the session-review — must count.
          yield* store.startSession(SEEDED_SESSION_ID as never);

          return yield* store.getPointerDigestHistory;
        }).pipe(Effect.orDie),
      );

      expect(digest.sessionsSinceLastReview).toBe(1);
      // A session-review (not a cycle-review) doesn't set lastCycleReviewAt.
      expect(digest.lastCycleReviewAt).toBeUndefined();
    });

    it("lastCycleReviewAt reflects the most recent cycle-review decision's timestamp, distinct from session-review runs", async () => {
      const digest = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.commitDeliberationOutput(commitReviewDecision("session-review"));
          const cycleResult = yield* store.commitDeliberationOutput(commitReviewDecision("cycle-review"));
          const cycleDecisionId = cycleResult.decisionIds[0] as unknown as string;
          const decisions = yield* store.listDecisionsForTest;
          const cycleDecision = decisions.find((d) => d.id === cycleDecisionId);
          const digest = yield* store.getPointerDigestHistory;
          return { digest, cycleCreatedAt: cycleDecision?.createdAt };
        }),
      ).then((r) => ({ ...r.digest, cycleCreatedAt: r.cycleCreatedAt }));

      expect(digest.lastCycleReviewAt).toBe(digest.cycleCreatedAt);
      expect(digest.lastCycleReviewAt).toBeDefined();
    });

    it("an on-demand run does NOT count as a review for sessionsSinceLastReview/lastCycleReviewAt purposes", async () => {
      const digest = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.commitDeliberationOutput(commitReviewDecision("on-demand"));
          yield* store.startSession(SEEDED_SESSION_ID as never);
          return yield* store.getPointerDigestHistory;
        }).pipe(Effect.orDie),
      );

      // Both sessions count — the on-demand run is not a review boundary.
      expect(digest.sessionsSinceLastReview).toBe(2);
      expect(digest.lastCycleReviewAt).toBeUndefined();
    });
  });
};

describe("Seed-input storage — in-memory Store", () => {
  const withStore = <A>(effect: Effect.Effect<A, never, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runSeedInputSuite(withStore);
});

describe("Seed-input storage — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string => path.join(os.tmpdir(), `repcoach-seed-input-storage-${randomUUID()}.sqlite`);

  const cleanupDbFile = (dbPath: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };

  const withStore = <A>(effect: Effect.Effect<A, never, Store>): Promise<A> => {
    const dbPath = tempDbPath();
    return effect
      .pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise)
      .finally(() => cleanupDbFile(dbPath));
  };

  runSeedInputSuite(withStore);
});
