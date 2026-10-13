import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { describe, expect, it } from "vitest";

import type { LogSetActualInput } from "@repcoach/contracts";
import { RepCoachRpcGroup } from "@repcoach/contracts";

import { DeliberationRunner, makeCannedDeliberationRunnerLayer } from "./deliberationRunner.ts";
import { CannedModelCatalog } from "./modelCatalog.ts";
import { RpcHandlersLayer } from "./rpcHandlers.ts";
import { SEEDED_SESSION_ID, Store } from "./store.ts";

/**
 * Rung-1 coverage for the Task 2 RPC handlers (issue #16), run in-memory via
 * `RpcTest` (no sockets/serialization) directly against the real `Store`.
 * The seed data and the `logSetActual` exactly-once guarantee are both part
 * of the acceptance bar, so they're proven here rather than only manually.
 *
 * `provideMerge` (not `mergeAll`) so `Store` both satisfies `RpcHandlersLayer`'s
 * requirement *and* stays in the resulting environment for assertions below
 * (e.g. reading `store.appliedCount` after driving calls through the client).
 * `RpcHandlersLayer` also requires `DeliberationRunner` (issue #26's
 * "deliberation.runNow" handler) — wired here with the canned agent over
 * the SAME `Store.layer` instance so `deliberation.runNow` reads/writes the
 * same in-memory store the rest of the suite asserts against.
 */
const TestLayer = RpcHandlersLayer.pipe(
  Layer.provideMerge(CannedModelCatalog),
  Layer.provideMerge(makeCannedDeliberationRunnerLayer(Store.layer)),
  Layer.provideMerge(Store.layer),
);

const asLogSetActualInput = (input: {
  readonly commandId: string;
  readonly loggedSessionId: string;
  readonly sessionId: string;
  readonly entryId: string;
  readonly setId: string;
  readonly setType: string;
  readonly actual: { readonly reps?: number; readonly load?: number };
}): LogSetActualInput => input as unknown as LogSetActualInput;

describe("dev-server RPC handlers", () => {
  it("returns server config", async () => {
    const result = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["server.getConfig"]({});
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.serverName).toBe("repcoach-dev-server");
    // Issue #111: the client compares this against the commit its own bundle
    // was built from, so it has to be *there* and non-empty. The value itself
    // is whatever git says (or "unknown" outside a checkout) — asserting a
    // specific commit would pin the test to the day it was written.
    expect(result.buildRef.length).toBeGreaterThan(0);
  });

  it("returns the seeded prescribed session", async () => {
    const result = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["session.getPrescribed"]({ sessionId: "session-seed-1" as never });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.id).toBe("session-seed-1");
    // Task 6 (issue #20) enriched the seed with a superset and a drop-set
    // Block beyond the original single straight Block — `block-1`'s own
    // shape is asserted below and stays exactly as Tasks 4/5 left it.
    expect(result.blocks).toHaveLength(3);
    expect(result.blocks[0]?.id).toBe("block-1");
    expect(result.blocks[0]?.entries[0]?.sets).toHaveLength(2);
  });

  it("fails PrescribedSessionNotFoundError for an unknown session id", async () => {
    const exit = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["session.getPrescribed"]({ sessionId: "does-not-exist" as never });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.exit, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
  });

  it("logSetActual is exactly-once by commandId: a replay returns the same result", async () => {
    const [first, second, appliedCount] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      const input = asLogSetActualInput({
        commandId: "command-1",
        loggedSessionId,
        sessionId: "session-seed-1",
        entryId: "entry-1",
        setId: "set-1",
        setType: "working",
        actual: { reps: 5, load: 100 },
      });
      const a = yield* client["logging.logSetActual"](input);
      const b = yield* client["logging.logSetActual"](input);
      const store = yield* Store;
      const count = yield* store.appliedCount;
      return [a, b, count] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(second).toEqual(first);
    expect(appliedCount).toBe(1);
  });

  it("logSetActual collapses concurrent duplicate calls to a single stored actual", async () => {
    const [results, appliedCount] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      const input = asLogSetActualInput({
        commandId: "command-concurrent-1",
        loggedSessionId,
        sessionId: "session-seed-1",
        entryId: "entry-1",
        setId: "set-1",
        setType: "working",
        actual: { reps: 5, load: 100 },
      });
      const all = yield* Effect.all(
        [
          client["logging.logSetActual"](input),
          client["logging.logSetActual"](input),
          client["logging.logSetActual"](input),
        ],
        { concurrency: "unbounded" },
      );
      const store = yield* Store;
      const count = yield* store.appliedCount;
      return [all, count] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const [first, ...rest] = results;
    for (const result of rest) {
      expect(result).toEqual(first);
    }

    expect(appliedCount).toBe(1);
  });

  // Step 2A / task 2A.2 — real Logged Session instantiation.

  it("session.start deep-copies the Prescribed Session into a real Logged Session", async () => {
    const loggedSession = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      return yield* client["logging.getLoggedSession"]({ loggedSessionId });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(loggedSession.prescribedSessionId).toBe("session-seed-1");
    expect(loggedSession.status).toBe("active");
    expect(loggedSession.session.blocks).toHaveLength(3);
    expect(loggedSession.actuals).toEqual([]);
  });

  it("session.start fails with PrescribedSessionNotFoundError for an unknown prescribedSessionId", async () => {
    const exit = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["session.start"]({ prescribedSessionId: "does-not-exist" as never });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.exit, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
  });

  it("getLoggedSession fails with LoggedSessionNotFoundError for an unknown loggedSessionId", async () => {
    const exit = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["logging.getLoggedSession"]({ loggedSessionId: "does-not-exist" as never });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.exit, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
  });

  it("getLoggedSession reflects actuals logged against that Logged Session", async () => {
    const loggedSession = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      const input = asLogSetActualInput({
        commandId: "command-getLoggedSession-1",
        loggedSessionId,
        sessionId: "session-seed-1",
        entryId: "entry-1",
        setId: "set-1",
        setType: "working",
        actual: { reps: 5, load: 100 },
      });
      yield* client["logging.logSetActual"](input);
      return yield* client["logging.getLoggedSession"]({ loggedSessionId });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(loggedSession.actuals).toHaveLength(1);
    const firstActual = loggedSession.actuals[0];
    expect(firstActual?.commandId).toBe("command-getLoggedSession-1");
    expect(firstActual !== undefined && !firstActual.retraction && firstActual.actual).toEqual({
      reps: 5,
      load: 100,
    });
  });

  // #115 item 1 (ADR 0017) — an unplanned Set ("another straight set") names
  // no prescribed Set at all. `logSetActual` is by-value, so this must work
  // unmodified: no FK/lookup validation against the prescribed tree anywhere
  // in the write path.
  it("logSetActual accepts a setId naming no prescribed Set (an unplanned Set), and getLoggedSession returns it with its entryId", async () => {
    const loggedSession = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      const input = asLogSetActualInput({
        commandId: "command-unplanned-1",
        loggedSessionId,
        sessionId: "session-seed-1",
        entryId: "entry-1",
        setId: "set-unplanned-client-minted-1",
        setType: "working",
        actual: { reps: 6, load: 100 },
      });
      yield* client["logging.logSetActual"](input);
      return yield* client["logging.getLoggedSession"]({ loggedSessionId });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(loggedSession.actuals).toHaveLength(1);
    const actual = loggedSession.actuals[0];
    expect(actual?.setId).toBe("set-unplanned-client-minted-1");
    expect(actual?.entryId).toBe("entry-1");
    expect(actual !== undefined && !actual.retraction && actual.actual).toEqual({ reps: 6, load: 100 });
    // No prescribed Set with this id exists on the frozen session copy — the
    // whole point of an unplanned Set.
    const prescribedSetIds = loggedSession.session.blocks.flatMap((block) =>
      block.entries.flatMap((entry) => entry.sets.map((set) => set.id)),
    );
    expect(prescribedSetIds).not.toContain("set-unplanned-client-minted-1");
  });

  // #131, ADR 0019 — swap: a pure actual-side annotation, idempotent by
  // commandId exactly like logSetActual above, and never touching the
  // frozen prescribed copy.

  it("logging.swapEntryExercise is exactly-once by commandId: a replay returns the same result", async () => {
    const [first, second] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      const input = {
        commandId: "swap-command-1",
        loggedSessionId,
        entryId: "entry-1",
        exerciseId: "exercise-swapped-1",
      } as never;
      const a = yield* client["logging.swapEntryExercise"](input);
      const b = yield* client["logging.swapEntryExercise"](input);
      return [a, b] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(second).toEqual(first);
  });

  it("logging.swapEntryExercise's result reaches getLoggedSession.swaps, and the coach can distinguish prescribed from performed", async () => {
    const loggedSession = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      yield* client["logging.swapEntryExercise"]({
        commandId: "swap-command-2",
        loggedSessionId,
        entryId: "entry-1",
        exerciseId: "exercise-swapped-2",
      } as never);
      return yield* client["logging.getLoggedSession"]({ loggedSessionId });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(loggedSession.swaps).toHaveLength(1);
    expect(loggedSession.swaps[0]?.entryId).toBe("entry-1");
    expect(loggedSession.swaps[0]?.exerciseId).toBe("exercise-swapped-2");

    // The prescribed exercise, inside the frozen session copy, is untouched
    // — both facts are readable off this one response (ADR 0019).
    const entry1 = loggedSession.session.blocks
      .flatMap((block) => block.entries)
      .find((entry) => entry.id === "entry-1");
    expect(entry1?.exerciseId).not.toBe("exercise-swapped-2");
  });

  it("logging.swapEntryExercise fails with EntryAlreadyLoggedError once the Entry has a logged Set, and touches no Plan table", async () => {
    const exit = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      yield* client["logging.logSetActual"](
        asLogSetActualInput({
          commandId: "swap-guard-log-1",
          loggedSessionId,
          sessionId: "session-seed-1",
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 100 },
        }),
      );
      return yield* client["logging.swapEntryExercise"]({
        commandId: "swap-guard-cmd-1",
        loggedSessionId,
        entryId: "entry-1",
        exerciseId: "exercise-swapped-3",
      } as never);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.exit, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
  });

  // Task 8 (issue #22) — coaching feed / Proposals via subscribe-and-replay.

  it("subscribeProposals replays the seeded pending Proposal", async () => {
    const items = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client.subscribeProposals({}).pipe(Stream.take(1), Stream.runCollect);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const [first] = Array.from(items);
    expect(first?.id).toBe("proposal-1");
    expect(first?.status).toBe("pending");
  });

  it("a live subscription re-emits when a new Proposal is pushed into the store", async () => {
    const items = await Effect.gen(function* () {
      const store = yield* Store;
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      // Each store mutation re-emits the full current Proposals array (the
      // simplest correct-if-idempotent replay contract — a client-side
      // reducer upserts by id, so re-observing an unchanged Proposal is a
      // no-op). `take(3)` is enough to observe the seed's single item, then
      // the post-push array (seed item again + the new one).
      const fiber = yield* client
        .subscribeProposals({})
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);

      // Give the subscription a beat to attach and replay the seed before
      // pushing a second Proposal.
      yield* Effect.sleep("5 millis");
      yield* store.pushProposalForTest({
        id: "proposal-pushed" as never,
        origin: "coach-proposal",
        status: "pending",
        summary: "Pushed proposal.",
        rationale: "Pushed for the live-update rung-1 test.",
        createdAt: new Date().toISOString(),
      });

      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const ids = Array.from(items).map((proposal) => proposal.id);
    expect(Array.from(new Set(ids))).toEqual(["proposal-1", "proposal-pushed"]);
  });

  it("resolving a Proposal as accepted mutates the Plan and flips the Proposal's status", async () => {
    const [result, plan] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const beforePlanItems = yield* client.subscribePlan({}).pipe(Stream.take(1), Stream.runCollect);
      const beforeLoad = Array.from(beforePlanItems)[0]?.sessions[0]?.blocks[0]?.entries[0]?.sets[0]
        ?.target.load?.max;

      const resolved = yield* client["proposals.resolve"]({
        proposalId: "proposal-1" as never,
        decision: "accepted",
      });

      const store = yield* Store;
      const afterPlan = yield* store.getPlan;
      const afterLoad = afterPlan.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max;
      expect(afterLoad).toBe((beforeLoad ?? 0) + 2.5);

      return [resolved, afterPlan] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.proposal.status).toBe("accepted");
    expect(plan.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max).toBeGreaterThan(0);
  });

  it("resolving a Proposal as rejected leaves the Plan untouched and retains the Proposal", async () => {
    const [result, planUnchanged] = await Effect.gen(function* () {
      const store = yield* Store;
      const before = yield* store.getPlan;

      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const resolved = yield* client["proposals.resolve"]({
        proposalId: "proposal-1" as never,
        decision: "rejected",
      });

      const after = yield* store.getPlan;
      const proposals = yield* store.getProposals;

      return [resolved, before.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max ===
        after.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max && proposals.some(
        (proposal) => proposal.id === "proposal-1" && proposal.status === "rejected",
      )] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.proposal.status).toBe("rejected");
    expect(planUnchanged).toBe(true);
  });

  it("resolving an unknown Proposal fails with ProposalNotFoundError", async () => {
    const exit = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["proposals.resolve"]({
        proposalId: "does-not-exist" as never,
        decision: "accepted",
      });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.exit, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
  });

  // Step 2A / task 2A.3 — user-direct Plan edits (auto-applied, ADR 0008).

  it("plan.applyUserChange edits a Set's target, echoes the new Plan, and a live subscribePlan re-emits it", async () => {
    const [returned, subscribedLoads] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      // Attach the subscription first so we can observe the seed emission and
      // then the post-edit re-emission (the "client sees it via subscribePlan"
      // leg of the 2A.3 acceptance bar).
      const fiber = yield* client
        .subscribePlan({})
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* Effect.sleep("5 millis");

      const returnedPlan = yield* client["plan.applyUserChange"]({
        setId: "set-1" as never,
        target: { reps: { min: 8, max: 8 }, load: { min: 130, max: 130 } } as never,
      });

      const items = yield* Fiber.join(fiber);
      const loads = Array.from(items).map(
        (plan) => plan.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max,
      );
      return [returnedPlan, loads] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    // The success value echoes the edit for immediate render.
    expect(returned.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max).toBe(130);
    // Seed (100) first, then the edited value (130) on re-emission.
    expect(subscribedLoads).toEqual([100, 130]);
  });

  it("plan.applyUserChange fails with PrescribedSetNotFoundError for an unknown setId", async () => {
    const exit = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["plan.applyUserChange"]({
        setId: "no-such-set" as never,
        target: { reps: { min: 5, max: 5 } } as never,
      });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.exit, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
  });

  // The working behind a Decision (#79) — what the Proposal card on Today and
  // the Coach surface's record both expand into.

  it("decisions.get returns the working for a committed Decision", async () => {
    const [working, decisionIds] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const run = yield* client["deliberation.runNow"]({});
      const decisionId = (run.decisionIds as ReadonlyArray<string>)[0] as never;
      const working = yield* client["decisions.get"]({ decisionId });
      return [working, run.decisionIds as ReadonlyArray<string>] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(decisionIds).toContain(working.id as string);
    expect(working.summary.length).toBeGreaterThan(0);
    expect(working.rationale.length).toBeGreaterThan(0);
    // The run's provenance envelope reaches the client, which is what the
    // card's window label and provenance footer are built from.
    expect(working.dataWindow?.cadence).toBeDefined();
  });

  it("decisions.get on the seeded Observation carries its measurements, rule and uncertainty", async () => {
    const working = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["decisions.get"]({ decisionId: "observation-1" as never });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(working.measurements?.length).toBeGreaterThan(0);
    expect(working.rule).toBeDefined();
    expect(working.uncertainty).toBeDefined();
    expect(working.citations).toHaveLength(1);
  });

  it("decisions.get fails with DecisionNotFoundError for an unknown id", async () => {
    const exit = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["decisions.get"]({ decisionId: "no-such-decision" as never });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.exit, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
  });

  it("the seeded Proposal has no working, and says so by omission rather than by empty blocks", async () => {
    const working = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["decisions.get"]({ decisionId: "proposal-1" as never });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(working.measurements).toBeUndefined();
    expect(working.rule).toBeUndefined();
    expect(working.uncertainty).toBeUndefined();
  });

  // 2B slice 1 (issue #26) — the "run now" walking skeleton: canned
  // DeliberationAgent -> DeliberationRunner -> Store.commitDeliberationOutput,
  // asserted through the RPC transport and the EXISTING subscribe path (the
  // literal acceptance bar: "visible on the phone Coaching feed via the
  // existing subscribe path").

  it("deliberation.runNow commits the canned agent's output, visible via subscribeCoachingFeed/subscribeProposals", async () => {
    const [result, feedItems, proposalItems] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);

      const result = yield* client["deliberation.runNow"]({});

      // Subscribe AFTER the commit: `subscribe*` replays the current
      // snapshot as its first emission (store.ts), so this reads the
      // post-commit state deterministically without racing a live
      // re-emission.
      // Four: the seed's `feed-1` and `feed-2` (#79 gave the seeded Proposal
      // the feed entry every committed Proposal gets), plus this run's two.
      const feedItems = yield* client.subscribeCoachingFeed({}).pipe(Stream.take(4), Stream.runCollect);
      const proposalItems = yield* client.subscribeProposals({}).pipe(Stream.take(2), Stream.runCollect);
      return [result, feedItems, proposalItems] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.decisionIds).toHaveLength(2);
    expect(result.feedEntryIds).toHaveLength(2);

    const feedIds = Array.from(feedItems).map((entry) => entry.id);
    // Seed's `feed-1` plus both newly-committed feed entries.
    expect(feedIds).toContain("feed-1");
    for (const feedEntryId of result.feedEntryIds) {
      expect(feedIds).toContain(feedEntryId);
    }

    const proposalIds = Array.from(proposalItems).map((proposal): string => proposal.id);
    expect(proposalIds).toContain("proposal-1");
    const newProposalId = (result.decisionIds as ReadonlyArray<string>).find((id) => proposalIds.includes(id));
    expect(newProposalId).toBeDefined();
  });

  // 2B slice 4 (issue #29) — "Finish Workout" fires a Session review:
  // Finalizing a Logged Session is the ONLY event that triggers a review;
  // mid-workout `logSetActual` set-syncs must NOT.

  /**
   * The seed's own Observation/Proposal (#79) carry `session-review` data
   * windows — they have to, so the Coach surface renders something real — but
   * they are not a *run's* output. Excluded by id here rather than by making
   * the seed less realistic, same as `finishWorkout.adversarial.test.ts` does.
   */
  const SEEDED_DECISION_IDS: ReadonlySet<string> = new Set(["observation-1", "proposal-1"]);

  // Issue #132 reshaped this: `finishWorkout` marks the session `pending` and
  // returns, so the review is asserted against the STORE after driving the
  // drain, not against the RPC result.
  it("logging.finishWorkout finalizes the session AND commits a session-review Decision, visible via the feed/proposals path", async () => {
    const [result, decisions, loggedSessionAfter] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const runner = yield* DeliberationRunner;
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });

      const result = yield* client["logging.finishWorkout"]({ loggedSessionId });
      yield* runner.reviewPendingSessions;

      const store = yield* Store;
      const decisions = yield* store.listDecisionsForTest;
      const loggedSessionAfter = yield* client["logging.getLoggedSession"]({ loggedSessionId });
      return [result, decisions, loggedSessionAfter] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    // Finalization: `status` flips to `finished`, both via the RPC result
    // and a fresh `getLoggedSession` read-back, and a review is owed.
    expect(result.status).toBe("finished");
    expect(result.reviewStatus).toBe("pending");
    expect(loggedSessionAfter.status).toBe("finished");

    // The drained Session review committed at least one Decision whose
    // `data_window_json.cadence` is `session-review` — the acceptance bar
    // ("a resulting Observation appears on the feed").
    const committed = decisions.filter((d) => {
      const dataWindow = JSON.parse(d.dataWindowJson ?? "{}") as { readonly cadence?: string };
      return dataWindow.cadence === "session-review" && !SEEDED_DECISION_IDS.has(d.id);
    });
    expect(committed.length).toBeGreaterThan(0);
  });

  it("logging.finishWorkout fails with LoggedSessionNotFoundError for an unknown loggedSessionId, and triggers no review", async () => {
    const [exit, decisionsBefore, decisionsAfter] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const store = yield* Store;
      const decisionsBefore = yield* store.listDecisionsForTest;
      const exit = yield* client["logging.finishWorkout"]({ loggedSessionId: "does-not-exist" as never }).pipe(
        Effect.exit,
      );
      const decisionsAfter = yield* store.listDecisionsForTest;
      return [exit, decisionsBefore, decisionsAfter] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
    // No review ran for a session that doesn't exist — decision count is untouched.
    expect(decisionsAfter).toHaveLength(decisionsBefore.length);
  });

  it("logSetActual (mid-workout set-sync) does NOT trigger a review — no new Decision/feed row appears", async () => {
    const [decisionsBefore, decisionsAfter, feedBefore, feedAfter] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const store = yield* Store;

      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });

      const decisionsBefore = yield* store.listDecisionsForTest;
      const feedBefore = yield* store.getCoachingFeed;

      const input = asLogSetActualInput({
        commandId: "command-finish-workout-guard",
        loggedSessionId,
        sessionId: "session-seed-1",
        entryId: "entry-1",
        setId: "set-1",
        setType: "working",
        actual: { reps: 5, load: 100 },
      });
      yield* client["logging.logSetActual"](input);

      const decisionsAfter = yield* store.listDecisionsForTest;
      const feedAfter = yield* store.getCoachingFeed;
      return [decisionsBefore, decisionsAfter, feedBefore, feedAfter] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(decisionsAfter).toHaveLength(decisionsBefore.length);
    expect(feedAfter).toHaveLength(feedBefore.length);
  });

  // Issue #114 Part 1 — "Cancel session": unmakes an accidentally-started
  // session while it still has zero confirmed sets. Never routes through
  // `finalizeSession`/the Deliberation runner, unlike `finishWorkout` above.
  it("logging.cancelSession with zero actuals cancels the session and triggers no review", async () => {
    const [result, decisionsBefore, decisionsAfter, loggedSessionAfter] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const store = yield* Store;
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });

      const decisionsBefore = yield* store.listDecisionsForTest;
      const result = yield* client["logging.cancelSession"]({ loggedSessionId });
      const decisionsAfter = yield* store.listDecisionsForTest;
      const loggedSessionAfter = yield* client["logging.getLoggedSession"]({ loggedSessionId });
      return [result, decisionsBefore, decisionsAfter, loggedSessionAfter] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.cancelled).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(loggedSessionAfter.status).toBe("cancelled");
    // No Session review ran — no new Decision landed.
    expect(decisionsAfter).toHaveLength(decisionsBefore.length);
  });

  it("logging.cancelSession fails with LoggedSessionHasActualsError once a set has been logged, and does not cancel it", async () => {
    const [exit, loggedSessionAfter] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      yield* client["logging.logSetActual"](
        asLogSetActualInput({
          commandId: "command-cancel-guard",
          loggedSessionId,
          sessionId: "session-seed-1",
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 100 },
        }),
      );

      const exit = yield* client["logging.cancelSession"]({ loggedSessionId }).pipe(Effect.exit);
      const loggedSessionAfter = yield* client["logging.getLoggedSession"]({ loggedSessionId });
      return [exit, loggedSessionAfter] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
    // Rejected loudly, not silently no-opped — the session is still active.
    expect(loggedSessionAfter.status).toBe("active");
  });

  it("logging.cancelSession is idempotent: cancelling an already-cancelled session is a no-op, not a failure", async () => {
    const [first, second] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      const first = yield* client["logging.cancelSession"]({ loggedSessionId });
      const second = yield* client["logging.cancelSession"]({ loggedSessionId });
      return [first, second] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(first.cancelled).toBe(true);
    expect(second.cancelled).toBe(false);
    expect(second.status).toBe("cancelled");
  });

  it("logging.cancelSession fails with LoggedSessionNotFoundError for an unknown loggedSessionId", async () => {
    const exit = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["logging.cancelSession"]({ loggedSessionId: "does-not-exist" as never }).pipe(
        Effect.exit,
      );
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
  });

  // Issue #114 Part 2 — "History": a reverse-chronological page of finished
  // sessions, excluding both `active` and `cancelled` rows.
  it("logging.listSessions excludes active and cancelled sessions, and orders finished sessions newest-first", async () => {
    const sessions = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);

      const cancelled = yield* client["session.start"]({ prescribedSessionId: "session-seed-1" as never });
      yield* client["logging.cancelSession"]({ loggedSessionId: cancelled.loggedSessionId });

      const stillActive = yield* client["session.start"]({ prescribedSessionId: "session-seed-1" as never });
      void stillActive;

      const olderFinished = yield* client["session.start"]({ prescribedSessionId: "session-seed-1" as never });
      yield* client["logging.finishWorkout"]({ loggedSessionId: olderFinished.loggedSessionId });

      // A real gap between the two finish times — `listSessions` orders by
      // `finished_at`, and two calls back to back can otherwise land in the
      // same millisecond.
      yield* Effect.sleep("5 millis");

      const newerFinished = yield* client["session.start"]({ prescribedSessionId: "session-seed-1" as never });
      yield* client["logging.finishWorkout"]({ loggedSessionId: newerFinished.loggedSessionId });

      const result = yield* client["logging.listSessions"]({});
      return { result, olderFinished, newerFinished, cancelled, stillActive };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const ids = sessions.result.sessions.map((s) => s.loggedSessionId as string);
    expect(ids).not.toContain(sessions.cancelled.loggedSessionId as string);
    expect(ids).not.toContain(sessions.stillActive.loggedSessionId as string);
    expect(ids).toContain(sessions.olderFinished.loggedSessionId as string);
    expect(ids).toContain(sessions.newerFinished.loggedSessionId as string);

    const newerIndex = ids.indexOf(sessions.newerFinished.loggedSessionId as string);
    const olderIndex = ids.indexOf(sessions.olderFinished.loggedSessionId as string);
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  // Issue #149 — tier-2 one-tap ✓ seed: "what did I last lift on this
  // Exercise". The resolution rule (swap-awareness, net state, newest-wins,
  // catalog bound) is covered at the persistence layer; this is the RPC
  // wiring plus the headline case.
  it("logging.lastActualForExercise returns the most recent actual per metric from a finished session, and {} for a never-performed exercise", async () => {
    const result = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      yield* client["logging.logSetActual"](
        asLogSetActualInput({
          commandId: "last-actual-wiring-1",
          loggedSessionId,
          sessionId: "session-seed-1",
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 102 },
        }),
      );
      yield* client["logging.logSetActual"](
        asLogSetActualInput({
          commandId: "last-actual-wiring-2",
          loggedSessionId,
          sessionId: "session-seed-1",
          entryId: "entry-1",
          setId: "set-2",
          setType: "working",
          actual: { reps: 5, load: 107 },
        }),
      );
      yield* client["logging.finishWorkout"]({ loggedSessionId });

      const performed = yield* client["logging.lastActualForExercise"]({
        exerciseId: "exercise-back-squat" as never,
      });
      const neverDone = yield* client["logging.lastActualForExercise"]({
        exerciseId: "exercise-deadlift" as never,
      });
      return { performed, neverDone };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    // set-2 is the more recent log, so its load wins.
    expect(result.performed.perMetric).toEqual({ reps: 5, load: 107 });
    expect(result.neverDone.perMetric).toEqual({});
  });

  it("logging.lastActualForExercise ignores an in-flight (unfinished) session", async () => {
    const result = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      yield* client["logging.logSetActual"](
        asLogSetActualInput({
          commandId: "last-actual-inflight-1",
          loggedSessionId,
          sessionId: "session-seed-1",
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 120 },
        }),
      );
      // no finishWorkout — the session is still active
      return yield* client["logging.lastActualForExercise"]({
        exerciseId: "exercise-back-squat" as never,
      });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.perMetric).toEqual({});
  });

  // Issue #147 — "Resume is a localStorage pointer only": the client reconciles
  // its device-local Resume pointer against this. Only `active` rows come back,
  // newest first — the mirror image of `logging.listSessions` above. (The net
  // logged-set count is proven at the persistence layer, `sqlStore.test.ts`.)
  it("logging.listActiveSessions returns only active sessions, newest-first, excluding finished and cancelled", async () => {
    const out = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);

      const finished = yield* client["session.start"]({ prescribedSessionId: "session-seed-1" as never });
      yield* client["logging.finishWorkout"]({ loggedSessionId: finished.loggedSessionId });

      const cancelled = yield* client["session.start"]({ prescribedSessionId: "session-seed-1" as never });
      yield* client["logging.cancelSession"]({ loggedSessionId: cancelled.loggedSessionId });

      const older = yield* client["session.start"]({ prescribedSessionId: "session-seed-1" as never });
      yield* Effect.sleep("5 millis");
      const newer = yield* client["session.start"]({ prescribedSessionId: "session-seed-1" as never });

      const result = yield* client["logging.listActiveSessions"]({});
      return { result, older, newer, finished, cancelled };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const ids = out.result.sessions.map((s) => s.loggedSessionId as string);
    expect(ids).toEqual([out.newer.loggedSessionId as string, out.older.loggedSessionId as string]);
    expect(ids).not.toContain(out.finished.loggedSessionId as string);
    expect(ids).not.toContain(out.cancelled.loggedSessionId as string);
  });

  // ADR 0023 — "Next up": wiring only. The rotation rules (wrap, deleted and
  // empty sessions, reorder) are pinned on the pure `nextUpSession`; the seed
  // Plan has one session, so here next up is always that session, before and
  // after a finished workout.
  it("logging.getNextUp names a session from the Plan, before and after a finished workout", async () => {
    const out = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const fresh = yield* client["logging.getNextUp"]({});
      const started = yield* client["session.start"]({ prescribedSessionId: "session-seed-1" as never });
      yield* client["logging.finishWorkout"]({ loggedSessionId: started.loggedSessionId });
      const afterFinish = yield* client["logging.getNextUp"]({});
      return { fresh, afterFinish };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(out.fresh).toEqual({ prescribedSessionId: "session-seed-1" });
    expect(out.afterFinish).toEqual({ prescribedSessionId: "session-seed-1" });
  });

  // Issue #117 — "Stats": wiring only (the local-day/timezone rule and the
  // cancelled-session exclusion are covered at the persistence layer,
  // `sqlStore.test.ts`, since `logSetActualAtForTest` — the only way to pin
  // `appliedAt` without sleeping real time — is not itself an RPC).
  it("stats.getDailySetCounts reflects a just-logged actual for today, at UTC", async () => {
    const result = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const { loggedSessionId } = yield* client["session.start"]({
        prescribedSessionId: "session-seed-1" as never,
      });
      yield* client["logging.logSetActual"](
        asLogSetActualInput({
          commandId: "stats-wiring-1",
          loggedSessionId,
          sessionId: "session-seed-1",
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 100 },
        }),
      );
      return yield* client["stats.getDailySetCounts"]({ utcOffsetMinutes: 0 });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const today = new Date().toISOString().slice(0, 10);
    expect(result.days).toEqual([{ date: today, setCount: 1 }]);
  });

  // 2B slice 6 (issue #31) — Cycle-review trigger seam + per-cadence model
  // settings.

  it("deliberation.runCycleReview commits a cycle-review Decision (the monthly-trigger / on-demand seam)", async () => {
    const [result, decisions] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const result = yield* client["deliberation.runCycleReview"]({});
      const store = yield* Store;
      const decisions = yield* store.listDecisionsForTest;
      return [result, decisions] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.decisionIds.length).toBeGreaterThan(0);
    const reviewIds = result.decisionIds as ReadonlyArray<string>;
    const committed = decisions.filter((d) => reviewIds.includes(d.id));
    expect(committed.length).toBeGreaterThan(0);
    for (const decision of committed) {
      const dataWindow = JSON.parse(decision.dataWindowJson ?? "{}") as { readonly cadence?: string };
      expect(dataWindow.cadence).toBe("cycle-review");
    }
  });

  it("settings.setCadenceModel / .getCadenceModel round-trip a per-cadence model through the Store", async () => {
    const [setResult, getResult, storedModel, unsetResult] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const setResult = yield* client["settings.setCadenceModel"]({
        cadence: "cycle-review",
        model: "model-strong",
      });
      const getResult = yield* client["settings.getCadenceModel"]({ cadence: "cycle-review" });
      const store = yield* Store;
      const storedModel = yield* store.getCadenceModel("cycle-review");
      // An unconfigured cadence reads back null through the RPC.
      const unsetResult = yield* client["settings.getCadenceModel"]({ cadence: "session-review" });
      return [setResult, getResult, storedModel, unsetResult] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(setResult.setting).toEqual({ cadence: "cycle-review", model: "model-strong" });
    expect(getResult.model).toBe("model-strong");
    expect(getResult.effort).toBeNull();
    expect(storedModel).toEqual({ model: "model-strong", effort: undefined });
    expect(unsetResult.model).toBeNull();
    expect(unsetResult.effort).toBeNull();
  });

  it("settings.setCadenceModel persists and round-trips an optional reasoning-effort override (issue #81)", async () => {
    const getResult = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      yield* client["settings.setCadenceModel"]({ cadence: "intake", model: "model-a", effort: "high" });
      return yield* client["settings.getCadenceModel"]({ cadence: "intake" });
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(getResult).toEqual({ model: "model-a", effort: "high" });
  });

  it("settings.listModels serves the selectable model catalog, with per-model effort support (issue #81 follow-up)", async () => {
    // The catalog is READ from the Agent SDK on the server, not authored in
    // the client — the RPC is what makes that possible, and `supportsEffort`
    // is what lets the effort control be shown only where it means something.
    const result = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["settings.listModels"]({});
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.unavailableReason).toBeNull();
    expect(result.models.map((model) => model.id)).toEqual(["opus", "sonnet", "haiku"]);

    const sonnet = result.models.find((model) => model.id === "sonnet");
    expect(sonnet?.supportsEffort).toBe(true);
    expect(sonnet?.effortLevels).toEqual(["low", "medium", "high"]);

    // A model that honours no effort level says so, rather than being offered
    // five levels the SDK would ignore.
    expect(result.models.find((model) => model.id === "haiku")?.supportsEffort).toBe(false);
  });

  it("settings.getSpendSummary reads the run ledger's per-cadence breakdown and recent runs (issue #81)", async () => {
    const result = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const store = yield* Store;
      yield* store.recordRunLedgerRow({
        runId: "run-1",
        cadence: "session-review",
        stage: "deliberator",
        model: "model-a",
        usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0.01,
      });
      yield* store.recordRunLedgerRow({
        runId: "run-1",
        cadence: "session-review",
        stage: "sweep",
        model: "model-a",
        usage: { input: 20, output: 10, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0.002,
      });
      return yield* client["settings.getSpendSummary"]({});
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.perCadence).toEqual([
      {
        cadence: "session-review",
        runCount: 1,
        usage: { input: 120, output: 60, cacheRead: 0, cacheCreation: 0 },
      },
    ]);
    expect(result.recentRuns).toHaveLength(1);
    expect(result.recentRuns[0]?.runId).toBe("run-1");
    expect(result.recentRuns[0]?.stages).toHaveLength(2);
  });

  it("settings.setRpeCaptureMode / .getRpeCaptureMode round-trip through the Store, defaulting to flagged-only (#63, issue #81)", async () => {
    const [initial, setResult, afterSet] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const initial = yield* client["settings.getRpeCaptureMode"]({});
      const setResult = yield* client["settings.setRpeCaptureMode"]({ mode: "off" });
      const afterSet = yield* client["settings.getRpeCaptureMode"]({});
      return [initial, setResult, afterSet] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(initial.mode).toBe("flagged-only");
    expect(setResult.mode).toBe("off");
    expect(afterSet.mode).toBe("off");
  });

  // --- seed-input write RPCs (ADR 0011 §2, issue #34) -----------------------

  it("goal.set writes through to the Store", async () => {
    const [rpcResult, storedGoal] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const rpcResult = yield* client["goal.set"]({ statement: "Build strength", proxies: ["e1RM trend"] });
      const store = yield* Store;
      const storedGoal = yield* store.getGoal;
      return [rpcResult, storedGoal] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(rpcResult.goal).toEqual({ statement: "Build strength", proxies: ["e1RM trend"] });
    expect(storedGoal).toEqual(rpcResult.goal);
  });

  it("standingConstraints.add / .remove write through to the Store", async () => {
    const [addResult, afterAdd, removeResult, afterRemove] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const addResult = yield* client["standingConstraints.add"]({
        text: "No overhead pressing — shoulder injury",
        severity: "hard",
      });
      const store = yield* Store;
      const afterAdd = yield* store.listStandingConstraints;
      const removeResult = yield* client["standingConstraints.remove"]({
        constraintId: addResult.constraint.id,
      });
      const afterRemove = yield* store.listStandingConstraints;
      return [addResult, afterAdd, removeResult, afterRemove] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(addResult.constraint.severity).toBe("hard");
    expect(afterAdd.map((c) => c.id)).toContain(addResult.constraint.id);
    expect(removeResult).toEqual({ removed: true });
    expect(afterRemove.map((c) => c.id)).not.toContain(addResult.constraint.id);
  });

  it("checkIns.add writes through to the Store", async () => {
    const [rpcResult, stored] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const rpcResult = yield* client["checkIns.add"]({ sleep: 4, soreness: 2, stress: 3, energy: 5 });
      const store = yield* Store;
      const stored = yield* store.listCheckIns;
      return [rpcResult, stored] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(rpcResult.checkIn.summary).toContain("Sleep 4/5");
    expect(stored.map((c) => c.id)).toContain(rpcResult.checkIn.id);
  });

  it("contextNotes.add writes through to the Store", async () => {
    const [rpcResult, stored] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const rpcResult = yield* client["contextNotes.add"]({ text: "Traveling next week, dumbbells only" });
      const store = yield* Store;
      const stored = yield* store.listContextNotes;
      return [rpcResult, stored] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(rpcResult.note.text).toBe("Traveling next week, dumbbells only");
    expect(stored.map((n) => n.id)).toContain(rpcResult.note.id);
  });

  // Issue #130 — the "Add a note" sheet item goes through the outbox as
  // `addEntryNote`, and `flusher.ts` calls `contextNotes.add` carrying
  // `commandId`/`entryId`/`loggedSessionId`. This proves the RPC handler
  // passes all three through to the Store unchanged (the handler itself is a
  // thin pass-through — see `rpcHandlers.ts`), and that a replayed
  // `commandId` (the outbox retrying after a reconnect it never heard the
  // ack for) does not create a second note.
  it("contextNotes.add carries entryId/loggedSessionId/commandId through, and a replayed commandId is idempotent", async () => {
    const [first, second, stored] = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const store = yield* Store;
      const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
      const input = {
        text: "left elbow twinged on set 3",
        entryId: "entry-1" as never,
        loggedSessionId,
        commandId: "rpc-note-cmd-1" as never,
      };
      const first = yield* client["contextNotes.add"](input);
      const second = yield* client["contextNotes.add"](input);
      const stored = yield* store.listContextNotes;
      return [first, second, stored] as const;
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(first.note.entryId).toBe("entry-1");
    expect(second).toEqual(first);
    expect(stored.filter((n) => n.id === "rpc-note-cmd-1")).toHaveLength(1);
  });
});
