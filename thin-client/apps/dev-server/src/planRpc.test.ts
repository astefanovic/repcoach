import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { describe, expect, it } from "vitest";

import type { ApplyUserChangeInput, PlanOperation } from "@repcoach/contracts";
import { RepCoachRpcGroup } from "@repcoach/contracts";

import { makeCannedDeliberationRunnerLayer } from "./deliberationRunner.ts";
import { CannedModelCatalog } from "./modelCatalog.ts";
import { RpcHandlersLayer } from "./rpcHandlers.ts";
import { Store } from "./store.ts";

/**
 * Rung-1 coverage for the Plan read + structural edit RPCs (#71), driven
 * through `RpcTest` against the real in-memory `Store` — the same shape the
 * existing handler suite uses.
 *
 * What is proven here is the *seam*, not the operations: that one RPC
 * dispatches the whole union, that a rejected operation surfaces as a
 * failure rather than a half-applied Plan, that a replayed `commandId`
 * applies once, and that `plan.get` and `subscribePlan` show the same Plan.
 * The operations' own behaviour is proven at the store and runtime-module
 * layers.
 */
const TestLayer = RpcHandlersLayer.pipe(
  Layer.provideMerge(CannedModelCatalog),
  Layer.provideMerge(makeCannedDeliberationRunnerLayer(Store.layer)),
  Layer.provideMerge(Store.layer),
);

const edit = (
  operation: PlanOperation,
  envelope: Record<string, unknown> = {},
): ApplyUserChangeInput => ({ operation, ...envelope }) as ApplyUserChangeInput;

describe("plan.get", () => {
  it("returns the Plan the store holds, so the picker and the editor read one shape", async () => {
    const plan = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["plan.get"]({});
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(plan.sessions.map((session) => session.id)).toEqual(["session-seed-1"]);
    expect(plan.sessions[0]?.blocks[0]?.entries[0]?.trackedMetrics).toEqual(["reps", "load"]);
  });

  it("shows a Session created through the edit RPC without a refetch of anything else", async () => {
    const plan = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      yield* client["plan.applyUserChange"](
        edit({ _tag: "createSession", sessionId: "session-legs" as never, name: "Legs" }),
      );
      return yield* client["plan.get"]({});
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(plan.sessions.map((session) => session.name)).toEqual([undefined, "Legs"]);
  });
});

describe("plan.applyUserChange — the structural seam", () => {
  it("dispatches the operation union: one RPC creates a Session, adds an exercise and prescribes its Sets", async () => {
    const plan = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      yield* client["plan.applyUserChange"](
        edit({ _tag: "createSession", sessionId: "session-legs" as never, name: "Legs" }),
      );
      yield* client["plan.applyUserChange"](
        edit({
          _tag: "addEntry",
          sessionId: "session-legs" as never,
          blockId: "block-l1" as never,
          entryId: "entry-l1" as never,
          exerciseId: "exercise-back-squat" as never,
        }),
      );
      return yield* client["plan.applyUserChange"](
        edit({
          _tag: "replaceEntrySets",
          entryId: "entry-l1" as never,
          sets: [
            {
              id: "set-l1",
              setType: "working",
              target: { reps: { min: 5, max: 8 }, load: { min: 80, max: 80 } },
              restSec: 120,
            },
          ],
        } as never),
      );
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const entry = plan.sessions[1]?.blocks[0]?.entries[0];
    expect(entry?.exerciseId).toBe("exercise-back-squat");
    expect(entry?.sets[0]?.restSec).toBe(120);
  });

  it("fails for an operation naming an entity that is not there", async () => {
    const exit = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["plan.applyUserChange"](
        edit({ _tag: "removeEntry", entryId: "entry-ghost" as never }),
      );
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.exit, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
  });

  it("fails for a reorder that does not name exactly the current members", async () => {
    const exit = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      return yield* client["plan.applyUserChange"](
        edit({ _tag: "orderSessions", sessionIds: ["session-seed-1", "session-ghost"] as never }),
      );
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.exit, Effect.runPromise);

    expect(exit._tag).toBe("Failure");
  });

  it("applies a replayed commandId once — a retry over a dead spot cannot duplicate a Session", async () => {
    const plan = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const command = edit(
        { _tag: "createSession", sessionId: "session-legs" as never, name: "Legs" },
        { commandId: "plan-cmd-1" },
      );
      yield* client["plan.applyUserChange"](command);
      yield* client["plan.applyUserChange"](command);
      return yield* client["plan.get"]({});
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(plan.sessions.filter((session) => session.name === "Legs")).toHaveLength(1);
  });

  it("re-emits on subscribePlan, so authoring in the editor updates the picker with no refetch", async () => {
    const names = await Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
      const fiber = yield* client
        .subscribePlan({})
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* Effect.sleep("5 millis");

      yield* client["plan.applyUserChange"](
        edit({ _tag: "createSession", sessionId: "session-legs" as never, name: "Legs" }),
      );

      const items = yield* Fiber.join(fiber);
      return Array.from(items).map((plan) => plan.sessions.length);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(names).toEqual([1, 2]);
  });
});
