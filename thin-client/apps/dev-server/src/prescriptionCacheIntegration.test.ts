import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/unstable/socket/Socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Connection, Prescription, Rpc } from "@repcoach/client-runtime";
import { RPC_METHODS, SessionId } from "@repcoach/contracts";

import { makeDevServer } from "./server.ts";
import { fetchWithRetry, waitForServerReady } from "./testServerReady.ts";

const { Connectivity, ConnectionDriverModule, DevServerConnectionTarget, SupervisorModule, Wakeups } =
  Connection;
type SupervisorState = Connection.SupervisorConnectionState;

/**
 * Task 5 (issue #19, G3) rung-1: the frozen-in-flight requirement, proven
 * against the real Task 2 dev-server (not a fake) — the one place a
 * server-side prescription edit genuinely exists independently of the
 * client. Prefetch a session via `PrescriptionCache.startWorkout`, then use
 * the `/__test__/mutate-prescribed-session` lever to edit the server's copy,
 * and assert a re-read from `cache.current` still returns the original.
 * Only an explicit next `startWorkout` call (simulating the next connected
 * "Start workout") picks up the edit.
 */
describe("prescription cache frozen-in-flight (Node, real dev-server)", () => {
  let httpBaseUrl: string;
  let wsBaseUrl: string;
  let serverFiber: Fiber.Fiber<never, never>;

  beforeAll(async () => {
    const { layer, nodeServer } = makeDevServer({ port: 0 });
    const listening = new Promise<void>((resolve) => {
      nodeServer.once("listening", () => resolve());
    });
    serverFiber = Effect.runFork(Layer.launch(layer) as Effect.Effect<never, never>);
    await listening;

    const address = nodeServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from the dev-server's Node HTTP server");
    }
    httpBaseUrl = `http://127.0.0.1:${address.port}`;
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;
    await waitForServerReady(httpBaseUrl);
  });

  afterAll(async () => {
    await Effect.runPromise(Fiber.interrupt(serverFiber));
    await fetch(`${httpBaseUrl}/__test__/reset`, { method: "POST" }).catch(() => undefined);
  });

  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (url: string | URL) => new WebSocket(url) as unknown as globalThis.WebSocket,
  );

  const dependencies = Layer.mergeAll(
    Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.empty }),
    Wakeups.layer({ changes: Stream.empty }),
    ConnectionDriverModule.layer.pipe(
      Layer.provide(Rpc.sessionLayer.pipe(Layer.provide(webSocketConstructorLayer))),
    ),
  );

  it("a mid-session prescription change on the server does not mutate the cached in-flight session", async () => {
    const sessionId = SessionId.make("session-seed-1");

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* SupervisorModule.make(
            new DevServerConnectionTarget({
              environmentId: "dev-server",
              label: "Local dev-server",
              httpBaseUrl,
              wsBaseUrl,
            }),
            { initiallyDesired: true },
          );

          yield* SubscriptionRef.changes(supervisor.state).pipe(
            Stream.filter((state: SupervisorState) => state.phase === "connected"),
            Stream.runHead,
          );
          const session = yield* SubscriptionRef.get(supervisor.session).pipe(
            Effect.map(Option.getOrThrow),
          );

          const cache = yield* Prescription.makePrescriptionCache(
            Prescription.makeInMemoryPrescriptionCacheStorage(),
          );

          const fetchPrescribedSession = (id: SessionId) =>
            session.client[RPC_METHODS.getPrescribedSession]({ sessionId: id });

          const firstFetch = yield* cache.startWorkout(sessionId, fetchPrescribedSession);
          const firstLoadTarget = firstFetch.blocks[0]?.entries[0]?.sets[0]?.target.load;

          // Mutate the server's prescription for this same session id — the
          // external lever, never a client hook.
          yield* Effect.promise(() =>
            fetchWithRetry(`${httpBaseUrl}/__test__/mutate-prescribed-session`, { method: "POST" }),
          );

          // A direct RPC re-fetch proves the server really did change...
          const rawRefetch = yield* fetchPrescribedSession(sessionId);
          const rawRefetchLoadTarget = rawRefetch.blocks[0]?.entries[0]?.sets[0]?.target.load;

          // ...but the CACHE, read without any further fetch, must still
          // hold the original frozen copy.
          const stillCached = yield* SubscriptionRef.get(cache.current).pipe(
            Effect.map(Option.getOrThrow),
          );
          const cachedLoadTarget =
            stillCached.session.blocks[0]?.entries[0]?.sets[0]?.target.load;

          // Only an explicit next `startWorkout` picks up the change.
          const refreshed = yield* cache.startWorkout(sessionId, fetchPrescribedSession);
          const refreshedLoadTarget = refreshed.blocks[0]?.entries[0]?.sets[0]?.target.load;

          return {
            firstLoadTarget,
            rawRefetchLoadTarget,
            cachedLoadTarget,
            refreshedLoadTarget,
          };
        }),
      ).pipe(Effect.provide(dependencies)) as Effect.Effect<
        {
          readonly firstLoadTarget: unknown;
          readonly rawRefetchLoadTarget: unknown;
          readonly cachedLoadTarget: unknown;
          readonly refreshedLoadTarget: unknown;
        },
        unknown,
        never
      >,
    );

    expect(outcome.rawRefetchLoadTarget).not.toEqual(outcome.firstLoadTarget);
    expect(outcome.cachedLoadTarget).toEqual(outcome.firstLoadTarget);
    expect(outcome.refreshedLoadTarget).toEqual(outcome.rawRefetchLoadTarget);
  });
});
