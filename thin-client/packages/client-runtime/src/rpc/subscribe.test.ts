import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "vitest";

import type {
  ConnectionTarget,
  PreparedConnection,
  SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { subscribe } from "./client.ts";
import type { RpcSession } from "./session.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";

/**
 * Rung-1 coverage for `subscribe`'s subscribe-and-replay behavior (Task 8,
 * issue #22): the coaching feed / Proposals surfaces rely entirely on this
 * vendored `switchMap`-over-`supervisor.session` mechanism (Task 3a) to
 * survive a reconnect transparently, so this proves it directly against a
 * fake session swap rather than through a real socket.
 */
const FAKE_TARGET: ConnectionTarget = {
  _tag: "DevServerConnectionTarget",
  environmentId: "dev-server",
  label: "Dev server",
  httpBaseUrl: "http://127.0.0.1:0",
  wsBaseUrl: "ws://127.0.0.1:0",
} as unknown as ConnectionTarget;

const makeFakeSession = (
  subscribeProposals: (input: Record<string, never>) => Stream.Stream<unknown, never>,
): RpcSession => ({
  client: { subscribeProposals } as unknown as WsRpcProtocolClient,
  initialConfig: Effect.die(new Error("not used")),
  ready: Effect.void,
  probe: Effect.void,
  closed: Effect.never,
});

const makeFakeSupervisor = Effect.fn("makeFakeSupervisor")(function* () {
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
  const supervisor = EnvironmentSupervisor.of({
    target: FAKE_TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({ phase: "available" } as never),
    session,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  return { supervisor, session };
});

describe("EnvironmentRpc.subscribe (rung 1, fake session swap)", () => {
  it("replays the current session's stream on first attach", async () => {
    const result = await Effect.gen(function* () {
      const { supervisor, session } = yield* makeFakeSupervisor();
      yield* SubscriptionRef.set(
        session,
        Option.some(makeFakeSession(() => Stream.fromIterable(["a", "b"]))),
      );

      const fiber = yield* Effect.forkChild(
        subscribe("subscribeProposals" as never, {} as never).pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.provide(Layer.succeed(EnvironmentSupervisor, supervisor)),
        ),
      );
      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.runPromise);

    expect(Array.from(result)).toEqual(["a", "b"]);
  });

  it("re-attaches and replays on a new session after a reconnect (session swap)", async () => {
    const result = await Effect.gen(function* () {
      const { supervisor, session } = yield* makeFakeSupervisor();

      // First "connection": emits one item then never completes (an open
      // subscription, as a live RPC stream would be).
      yield* SubscriptionRef.set(
        session,
        Option.some(makeFakeSession(() => Stream.concat(Stream.fromIterable(["first-1"]), Stream.never))),
      );

      const fiber = yield* Effect.forkChild(
        subscribe("subscribeProposals" as never, {} as never).pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.provide(Layer.succeed(EnvironmentSupervisor, supervisor)),
        ),
      );

      // Let the first subscription attach and emit before swapping sessions.
      yield* Effect.sleep("10 millis");

      // Simulate a reconnect: session goes to None (dropped) then to a new
      // session (Some) — `switchMap` must cancel the old stream and
      // re-subscribe against the new one, replaying its current state.
      yield* SubscriptionRef.set(session, Option.none());
      yield* SubscriptionRef.set(
        session,
        Option.some(
          makeFakeSession(() => Stream.concat(Stream.fromIterable(["second-1", "second-2"]), Stream.never)),
        ),
      );

      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.runPromise);

    // The stream carried the old session's item ("first-1"), then cut over
    // to the NEW session on reconnect and replayed ITS current state from
    // the top ("second-1", "second-2") — subscribe-and-replay, no manual
    // refresh, no stale item from the dropped session bleeding into the new
    // session's replay.
    expect(Array.from(result)).toEqual(["first-1", "second-1", "second-2"]);
  });
});
