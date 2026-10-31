import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import type { CommitDeliberationOutputInput } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { SEEDED_SESSION_ID, Store } from "./store.ts";

/**
 * Adversarial black-box coverage for the six seed-input `Store` methods
 * (issue #34), targeting the specific edges the naive-implementation
 * checklist calls out: singleton-Goal history accumulation, unknown-id
 * removal semantics, duplicate-text constraints, evidence-roster
 * read-only-ness, and the pointer-digest strict-inequality / latest-wins
 * edges. Run against BOTH `Store` layers via one shared assertion body,
 * mirroring `seedInputStorage.test.ts`'s pattern.
 */

const runAdversarialSuite = (withStore: <A>(effect: Effect.Effect<A, never, Store>) => Promise<A>) => {
  describe("Goal — singleton semantics", () => {
    it("setGoal called THREE times keeps exactly one row — the third call's statement/proxies win", async () => {
      const finalGoal = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.setGoal({ statement: "Build strength", proxies: ["e1RM trend"] });
          yield* store.setGoal({ statement: "Lose fat", proxies: ["bodyweight"] });
          yield* store.setGoal({ statement: "Improve mobility", proxies: [] });
          return yield* store.getGoal;
        }),
      );

      expect(finalGoal).toEqual({ statement: "Improve mobility", proxies: [] });
    });

    it("an empty proxies array round-trips through setGoal/getGoal without being coerced to undefined or dropped", async () => {
      const goal = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.setGoal({ statement: "Build strength", proxies: [] });
          return yield* store.getGoal;
        }),
      );

      expect(goal?.proxies).toEqual([]);
    });
  });

  describe("Standing constraints — adversarial", () => {
    it("preserves multiple constraints with IDENTICAL text — never silently deduped", async () => {
      const constraints = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.addStandingConstraint({ text: "No overhead pressing", severity: "hard" });
          yield* store.addStandingConstraint({ text: "No overhead pressing", severity: "hard" });
          return yield* store.listStandingConstraints;
        }),
      );

      expect(constraints).toHaveLength(2);
      expect(new Set(constraints.map((c) => c.id)).size).toBe(2);
    });

    it("removing an unknown constraintId is a no-op ({removed:false}) and does NOT throw, even with several real constraints present", async () => {
      const result = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.addStandingConstraint({ text: "A", severity: "hard" });
          yield* store.addStandingConstraint({ text: "B", severity: "soft" });
          const removed = yield* store.removeStandingConstraint({ constraintId: "totally-unknown-id" });
          const remaining = yield* store.listStandingConstraints;
          return { removed, remaining };
        }),
      );

      expect(result.removed).toEqual({ removed: false });
      expect(result.remaining).toHaveLength(2);
    });

    it("removing one of several constraints leaves the rest fully intact", async () => {
      const result = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const a = yield* store.addStandingConstraint({ text: "A", severity: "hard" });
          const b = yield* store.addStandingConstraint({ text: "B", severity: "soft" });
          const c = yield* store.addStandingConstraint({ text: "C", severity: "hard" });
          const removed = yield* store.removeStandingConstraint({ constraintId: b.id });
          const remaining = yield* store.listStandingConstraints;
          return { removed, remaining, a, c };
        }),
      );

      expect(result.removed).toEqual({ removed: true });
      expect(result.remaining).toHaveLength(2);
      expect(result.remaining.map((c) => c.id).sort()).toEqual([result.a.id, result.c.id].sort());
    });

    it("removing an id twice: first call removes it, second call on the now-unknown id returns removed:false", async () => {
      const result = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const c = yield* store.addStandingConstraint({ text: "A", severity: "soft" });
          const first = yield* store.removeStandingConstraint({ constraintId: c.id });
          const second = yield* store.removeStandingConstraint({ constraintId: c.id });
          return { first, second };
        }),
      );

      expect(result.first).toEqual({ removed: true });
      expect(result.second).toEqual({ removed: false });
    });
  });

  describe("Evidence-base roster — read-only", () => {
    it("listEvidenceRoster returns a STABLE roster across repeated calls — not regenerated with new ids each time", async () => {
      const [first, second] = await withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const first = yield* store.listEvidenceRoster;
          const second = yield* store.listEvidenceRoster;
          return [first, second] as const;
        }),
      );

      expect(second).toEqual(first);
    });

    it("has no Store method that mutates the evidence roster (write path is server-seeded only, per ADR 0003)", async () => {
      const store = await withStore(
        Effect.gen(function* () {
          return yield* Store;
        }),
      );

      // Black-box surface check: the Store interface exposes no
      // addEvidenceClaim/removeEvidenceClaim/setEvidenceRoster-shaped method.
      const storeKeys = Object.keys(store as unknown as Record<string, unknown>);
      const writeLikeEvidenceKeys = storeKeys.filter(
        (k) => /evidence/i.test(k) && !/^list/i.test(k),
      );
      expect(writeLikeEvidenceKeys).toEqual([]);
    });
  });

  describe("Pointer-digest history — strict-inequality and latest-wins edges", () => {
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

    it("a session started at the SAME instant as the latest review-kind decision's created_at is EXCLUDED (strictly-after, not on-or-after)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

        const digest = await withStore(
          Effect.gen(function* () {
            const store = yield* Store;
            // Decision and session both stamped at the exact same frozen instant.
            yield* store.commitDeliberationOutput(commitReviewDecision("cycle-review"));
            yield* store.startSession(SEEDED_SESSION_ID as never);
            return yield* store.getPointerDigestHistory;
          }).pipe(Effect.orDie),
        );

        // The same-instant session must NOT count — 0, not 1.
        expect(digest.sessionsSinceLastReview).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a session started one tick AFTER the review's created_at (same frozen instant, then advanced) DOES count", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

        const digest = await withStore(
          Effect.gen(function* () {
            const store = yield* Store;
            yield* store.commitDeliberationOutput(commitReviewDecision("cycle-review"));
            vi.setSystemTime(new Date("2026-07-10T12:00:00.001Z"));
            yield* store.startSession(SEEDED_SESSION_ID as never);
            return yield* store.getPointerDigestHistory;
          }).pipe(Effect.orDie),
        );

        expect(digest.sessionsSinceLastReview).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("multiple cycle-review decisions: lastCycleReviewAt reflects the LATEST one, not the first", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));

        const result = await withStore(
          Effect.gen(function* () {
            const store = yield* Store;
            yield* store.commitDeliberationOutput(commitReviewDecision("cycle-review"));

            vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
            const secondCommit = yield* store.commitDeliberationOutput(commitReviewDecision("cycle-review"));
            const latestDecisionId = secondCommit.decisionIds[0] as unknown as string;

            const decisions = yield* store.listDecisionsForTest;
            const latestDecision = decisions.find((d) => d.id === latestDecisionId);
            const digest = yield* store.getPointerDigestHistory;
            return { digest, latestCreatedAt: latestDecision?.createdAt };
          }),
        );

        expect(result.digest.lastCycleReviewAt).toBe(result.latestCreatedAt);
        expect(result.digest.lastCycleReviewAt).toBe(new Date("2026-07-15T00:00:00.000Z").toISOString());
      } finally {
        vi.useRealTimers();
      }
    });

    it("a cycle-review followed by an EARLIER-cadence session-review does not regress lastCycleReviewAt (latest cycle-review still wins over an intervening session-review)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));

        const result = await withStore(
          Effect.gen(function* () {
            const store = yield* Store;
            const cycleCommit = yield* store.commitDeliberationOutput(commitReviewDecision("cycle-review"));
            const cycleDecisionId = cycleCommit.decisionIds[0] as unknown as string;

            vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
            yield* store.commitDeliberationOutput(commitReviewDecision("session-review"));

            const decisions = yield* store.listDecisionsForTest;
            const cycleDecision = decisions.find((d) => d.id === cycleDecisionId);
            const digest = yield* store.getPointerDigestHistory;
            return { digest, cycleCreatedAt: cycleDecision?.createdAt };
          }),
        );

        expect(result.digest.lastCycleReviewAt).toBe(result.cycleCreatedAt);
      } finally {
        vi.useRealTimers();
      }
    });
  });
};

describe("Seed-input storage adversarial — in-memory Store", () => {
  const withStore = <A>(effect: Effect.Effect<A, never, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runAdversarialSuite(withStore);
});

describe("Seed-input storage adversarial — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string => path.join(os.tmpdir(), `repcoach-seed-input-adv-${randomUUID()}.sqlite`);

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

  runAdversarialSuite(withStore);
});
