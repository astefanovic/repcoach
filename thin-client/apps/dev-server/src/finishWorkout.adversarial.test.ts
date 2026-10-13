import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { describe, expect, it } from "vitest";

import { RepCoachRpcGroup } from "@repcoach/contracts";

import { DeliberationRunner, makeCannedDeliberationRunnerLayer } from "./deliberationRunner.ts";
import { CannedModelCatalog } from "./modelCatalog.ts";
import { RpcHandlersLayer } from "./rpcHandlers.ts";
import { Store } from "./store.ts";

/**
 * ADVERSARIAL coverage for the Finish-Workout trigger (issue #29), black-box
 * through the RPC surface. Probes edges beyond the implementer's happy-path /
 * unknown-id / set-sync-isolation tests: the data-window provenance of the
 * triggered review, and the DOUBLE-FINISH behavior.
 *
 * **Reshaped by issue #132.** `finishWorkout` no longer runs the review inside
 * the call, so there is no `result.review` to assert on; it marks the session
 * `pending` and a background drain does the run. These tests therefore drive
 * `reviewPendingSessions` explicitly and assert against the store, which is
 * strictly better black-box coverage: they now prove the review actually
 * COMMITTED rather than that an RPC echoed some ids back.
 *
 * The idempotency test's mechanism changed with it — see its own note.
 */
const TestLayer = RpcHandlersLayer.pipe(
  Layer.provideMerge(CannedModelCatalog),
  Layer.provideMerge(makeCannedDeliberationRunnerLayer(Store.layer)),
  Layer.provideMerge(Store.layer),
);

/**
 * The seed's own Observation (#79) is a plausible Session-review output and
 * carries a matching data window, which is the point of it — the Coach
 * surface has to have something real to render. It is not a *run's* output,
 * though, and these tests count runs, so it is excluded by id here rather
 * than by making the seed less realistic.
 */
const SEEDED_DECISION_IDS: ReadonlySet<string> = new Set(["observation-1", "proposal-1"]);

const sessionReviewDecisionIds = (
  decisions: ReadonlyArray<{ readonly id: string; readonly dataWindowJson: string | null }>,
): ReadonlyArray<string> =>
  decisions
    .filter((d) => {
      if (SEEDED_DECISION_IDS.has(d.id)) return false;
      const dw = JSON.parse(d.dataWindowJson ?? "{}") as { readonly cadence?: string };
      return dw.cadence === "session-review";
    })
    .map((d) => d.id);

describe("finishWorkout — ADVERSARIAL edges (issue #29)", () => {
  it("records the finished session id in the Session review's data_window.session_ids_considered", async () => {
    const [reviewIds, decisions, loggedSessionId] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const store = yield* Store;
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      const runner = yield* DeliberationRunner;
      yield* client["logging.finishWorkout"]({ loggedSessionId });
      // Drive the drain directly rather than racing the fork `finishWorkout`
      // starts — the claim guard makes the second caller a no-op either way.
      yield* runner.reviewPendingSessions;
      const decisions = yield* store.listDecisionsForTest;
      return [sessionReviewDecisionIds(decisions), decisions, loggedSessionId] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(reviewIds.length).toBeGreaterThan(0);
    const committed = decisions.filter((d) => reviewIds.includes(d.id));
    for (const decision of committed) {
      const dw = JSON.parse(decision.dataWindowJson ?? "{}") as {
        readonly session_ids_considered?: ReadonlyArray<string>;
      };
      expect(dw.session_ids_considered).toContain(loggedSessionId);
    }
  });

  it("a single finishWorkout triggers exactly ONE review (no double-run for one call)", async () => {
    const [reviewIds, allSessionReviewIds] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const store = yield* Store;
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      const runner = yield* DeliberationRunner;
      yield* client["logging.finishWorkout"]({ loggedSessionId });
      yield* runner.reviewPendingSessions;
      const decisions = yield* store.listDecisionsForTest;
      const ids = sessionReviewDecisionIds(decisions);
      // A second drain must add nothing: the session is `reviewed` now, and
      // `pending` is the only trigger.
      yield* runner.reviewPendingSessions;
      const after = sessionReviewDecisionIds(yield* store.listDecisionsForTest);
      return [ids, after] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    // Every session-review decision in the store came from this one run, and a
    // second drain added none.
    expect(reviewIds.length).toBeGreaterThan(0);
    expect([...allSessionReviewIds].sort()).toEqual([...reviewIds].sort());
  });

  it("is idempotent: a second finishWorkout does NOT re-run a Session review (issue #29 — no duplicate Observations, no wasted quota)", async () => {
    const [afterFirst, afterSecond, statusAfter, reviewStatuses] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const store = yield* Store;
      const runner = yield* DeliberationRunner;
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });

      // Finish, then let the drain actually run the review.
      const first = yield* client["logging.finishWorkout"]({ loggedSessionId });
      yield* runner.reviewPendingSessions;
      const afterFirst = sessionReviewDecisionIds(yield* store.listDecisionsForTest).length;

      // Re-finish and drain again. #29's guarantee has to hold through a
      // mechanism change: it is no longer `transitioned: false` that prevents
      // the second run (that flag is what LOST reviews in #132) but the
      // durable `reviewed` marker, which `pending`-only triggering respects.
      const second = yield* client["logging.finishWorkout"]({ loggedSessionId });
      yield* runner.reviewPendingSessions;
      const afterSecond = sessionReviewDecisionIds(yield* store.listDecisionsForTest).length;

      const after = yield* client["logging.getLoggedSession"]({ loggedSessionId });

      return [
        afterFirst,
        afterSecond,
        after.status,
        [first.reviewStatus, second.reviewStatus] as const,
      ] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(afterFirst).toBeGreaterThan(0); // the first finish's review ran
    expect(afterSecond).toBe(afterFirst); // the re-finish added nothing
    expect(statusAfter).toBe("finished");
    // The first finish owes a review; by the second, the coach has been.
    expect(reviewStatuses).toEqual(["pending", "reviewed"]);
  });
});
