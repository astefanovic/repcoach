import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { describe, expect, it } from "vitest";

import { RepCoachRpcGroup } from "@repcoach/contracts";

import { CANNED_RUN_OUTPUT, DeliberationAgent, ZERO_TOKEN_USAGE } from "../agents/deliberationAgent.ts";
import { DeliberationRunner, makeCannedDeliberationRunnerLayer } from "./deliberationRunner.ts";
import { CannedModelCatalog } from "../agents/modelCatalog.ts";
import { RpcHandlersLayer } from "../rpcHandlers.ts";
import { runSessionReviewDrainTick } from "./sessionReviewDrain.ts";
import { Store } from "../store.ts";

/**
 * Issue #132 — the tests whose absence let the coach silently never run.
 *
 * The bug was not a subtle one, and that is the point: `finishWorkout`
 * committed the `active → finished` transition, then ran the Session review
 * synchronously, and used `transitioned` to decide whether a review was owed.
 * When a run failed, the transition was already durable, every retry read
 * `transitioned: false`, and the review became permanently unreachable. Three
 * real sessions and 103 logged sets were never reviewed.
 *
 * Nothing covered the failure path. The existing suites all exercised a canned
 * deliberator that always succeeds, so they proved the happy path and the
 * double-tap guard and nothing about what happens when the coach falls over.
 * The first test below is the missing one.
 */

/** A deliberator that always fails — the condition no suite previously created. */
const FailingDeliberationAgent = Layer.succeed(DeliberationAgent)({
  run: () => Effect.die(new Error("deliberator exploded")),
});

/**
 * A deliberator that fails its first N calls and succeeds afterwards, so one
 * test can cover "the review is lost" and "the retry recovers it" without two
 * server graphs and without asserting on an intermediate that no user sees.
 */
const makeFlakyDeliberationAgent = (failures: number) =>
  Layer.effect(DeliberationAgent)(
    Effect.gen(function* () {
      const remaining = yield* Ref.make(failures);
      return {
        run: () =>
          Effect.gen(function* () {
            const left = yield* Ref.getAndUpdate(remaining, (n) => Math.max(0, n - 1));
            if (left > 0) return yield* Effect.die(new Error("deliberator exploded"));
            return { output: CANNED_RUN_OUTPUT, usage: ZERO_TOKEN_USAGE, costUsd: 0 };
          }),
      };
    }),
  );

const makeTestLayer = (deliberationAgent: Layer.Layer<DeliberationAgent>) =>
  RpcHandlersLayer.pipe(
    Layer.provideMerge(CannedModelCatalog),
    Layer.provideMerge(makeCannedDeliberationRunnerLayer(Store.layer, { deliberationAgent })),
    Layer.provideMerge(Store.layer),
  );

/**
 * The seed's own Decisions carry `session-review` data windows but are not a
 * run's output.
 *
 * Counts DECISIONS, not runs — one committed review writes more than one — so
 * every assertion below is relative ("more than before" / "the same as
 * before") rather than an absolute count. The question these tests ask is
 * whether a review ran at all and whether it ran twice, and a decisions-per-run
 * constant would be an unrelated fact to couple them to.
 */
const SEEDED_DECISION_IDS: ReadonlySet<string> = new Set(["observation-1", "proposal-1"]);

const sessionReviewCount = (
  decisions: ReadonlyArray<{ readonly id: string; readonly dataWindowJson: string | null }>,
): number =>
  decisions.filter((d) => {
    if (SEEDED_DECISION_IDS.has(d.id)) return false;
    const dw = JSON.parse(d.dataWindowJson ?? "{}") as { readonly cadence?: string };
    return dw.cadence === "session-review";
  }).length;

describe("Session-review drain (issue #132)", () => {
  it("THE REGRESSION: a review that fails leaves the session finished-but-pending, and a later drain runs it", async () => {
    const [pendingAfterFailure, reviewsAfterFailure, statusAfterFailure, reviewsAfterRetry, pendingAfterRetry] =
      await Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
        const store = yield* Store;
        const runner = yield* DeliberationRunner;
        const { loggedSessionId } = yield* client["session.start"]({
          prescribedSessionId: "session-seed-1" as never,
        });

        // Finish the workout. The deliberator will fail the first run — exactly
        // what happened in production.
        yield* client["logging.finishWorkout"]({ loggedSessionId });
        yield* runner.reviewPendingSessions;

        const pendingAfterFailure = yield* store.listSessionsPendingReview;
        const reviewsAfterFailure = sessionReviewCount(yield* store.listDecisionsForTest);
        const afterFailure = yield* client["logging.getLoggedSession"]({ loggedSessionId });

        // The retry. Under the old code this was unreachable: `finishWorkout`
        // was the only caller and its `transitioned: false` short-circuit made
        // it a no-op forever.
        yield* runner.reviewPendingSessions;
        const reviewsAfterRetry = sessionReviewCount(yield* store.listDecisionsForTest);
        const pendingAfterRetry = yield* store.listSessionsPendingReview;

        return [
          pendingAfterFailure.map((id) => id as string),
          reviewsAfterFailure,
          afterFailure.status,
          reviewsAfterRetry,
          pendingAfterRetry.map((id) => id as string),
          loggedSessionId as string,
        ] as const;
      }).pipe(Effect.provide(makeTestLayer(makeFlakyDeliberationAgent(1))), Effect.scoped, Effect.runPromise);

    // After the failed run: the workout is finished (the user's work is not
    // lost) AND the review is still owed (the coach's work is not lost either).
    // Losing the second half is the whole bug.
    expect(statusAfterFailure).toBe("finished");
    expect(reviewsAfterFailure).toBe(0);
    expect(pendingAfterFailure).toHaveLength(1);

    // The retry recovers it, and the session stops being pending.
    expect(reviewsAfterRetry).toBeGreaterThan(0);
    expect(pendingAfterRetry).toHaveLength(0);
  });

  it("a review that never succeeds stays pending indefinitely rather than being marked reviewed", async () => {
    const [pending, reviews] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      yield* client["logging.finishWorkout"]({ loggedSessionId });

      // Three attempts, all failing. The marker must not drift to `reviewed`
      // on any of them — `markSessionReviewed` is called only after a run
      // COMMITS, and a marker written before the run is the bug.
      yield* runner.reviewPendingSessions;
      yield* runner.reviewPendingSessions;
      yield* runner.reviewPendingSessions;

      return [
        (yield* store.listSessionsPendingReview).length,
        sessionReviewCount(yield* store.listDecisionsForTest),
      ] as const;
    }).pipe(Effect.provide(makeTestLayer(FailingDeliberationAgent)), Effect.scoped, Effect.runPromise);

    expect(pending).toBe(1);
    expect(reviews).toBe(0);
  });

  it("reviews each pending session exactly once across repeated drains — a backlog is not re-reviewed every tick", async () => {
    const [reviewsAfterFirst, reviewsAfterSecond, pendingAfter] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const store = yield* Store;
      const runner = yield* DeliberationRunner;

      // Three finished sessions, mirroring the live DB's backlog.
      for (let i = 0; i < 3; i += 1) {
        const { loggedSessionId } = yield* client["session.start"]({
          prescribedSessionId: "session-seed-1" as never,
        });
        yield* client["logging.finishWorkout"]({ loggedSessionId });
      }

      const beforeDrain = (yield* store.listSessionsPendingReview).length;
      expect(beforeDrain).toBe(3);

      const first = yield* runner.reviewPendingSessions;
      const reviewsAfterFirst = sessionReviewCount(yield* store.listDecisionsForTest);
      expect(first.reviewed).toBe(3);

      // A second tick must be a complete no-op: nothing is pending, so no
      // quota is spent and no Observation is duplicated.
      const second = yield* runner.reviewPendingSessions;
      expect(second.reviewed).toBe(0);
      const reviewsAfterSecond = sessionReviewCount(yield* store.listDecisionsForTest);

      return [reviewsAfterFirst, reviewsAfterSecond, (yield* store.listSessionsPendingReview).length] as const;
    }).pipe(Effect.provide(makeTestLayer(makeFlakyDeliberationAgent(0))), Effect.scoped, Effect.runPromise);

    expect(reviewsAfterFirst).toBeGreaterThan(0);
    expect(reviewsAfterSecond).toBe(reviewsAfterFirst); // unchanged — not re-reviewed
    expect(pendingAfter).toBe(0);
  });

  it("a cancelled session is never pending and never reviewed (issue #114's rule survives)", async () => {
    const [pending, reviews] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      yield* client["logging.cancelSession"]({ loggedSessionId });
      yield* runner.reviewPendingSessions;
      return [
        (yield* store.listSessionsPendingReview).length,
        sessionReviewCount(yield* store.listDecisionsForTest),
      ] as const;
    }).pipe(Effect.provide(makeTestLayer(makeFlakyDeliberationAgent(0))), Effect.scoped, Effect.runPromise);

    expect(pending).toBe(0);
    expect(reviews).toBe(0);
  });

  it("the drain tick survives a failing run, so the schedule is not killed by one bad session", async () => {
    // `runSessionReviewDrainTick` is what the poll loop calls. If a failing run
    // escaped it, `Effect.forever` would die and the schedule would stop —
    // silently reintroducing "no review ever runs again".
    const result = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      yield* client["logging.finishWorkout"]({ loggedSessionId });
      return yield* runSessionReviewDrainTick();
    }).pipe(Effect.provide(makeTestLayer(FailingDeliberationAgent)), Effect.scoped, Effect.runPromise);

    expect(result.reviewed).toBe(0); // it failed, but it returned rather than dying
  });

  it("finishWorkout reports pending on a re-finish whose review never ran, so a retry can still recover it", async () => {
    const statuses = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const runner = yield* DeliberationRunner;
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      const first = yield* client["logging.finishWorkout"]({ loggedSessionId });
      yield* runner.reviewPendingSessions; // fails
      // The user taps Finish again — the exact thing that used to return
      // success with an empty review and lose the session forever.
      const second = yield* client["logging.finishWorkout"]({ loggedSessionId });
      return [first.reviewStatus, second.reviewStatus] as const;
    }).pipe(Effect.provide(makeTestLayer(FailingDeliberationAgent)), Effect.scoped, Effect.runPromise);

    expect(statuses).toEqual(["pending", "pending"]);
  });
});
