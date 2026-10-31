import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/unstable/socket/Socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Connection, Rpc } from "@repcoach/client-runtime";
import { RPC_METHODS, SessionId } from "@repcoach/contracts";

import { makeDevServer } from "./server.ts";
import { waitForServerReady } from "./testing/testServerReady.ts";

const {
  Connectivity,
  ConnectionDriverModule,
  DevServerConnectionTarget,
  SupervisorModule,
  Wakeups,
} = Connection;
type SupervisorState = Connection.SupervisorConnectionState;

/**
 * Task 3a's evidence for "the client reaches `connected`": boots the real
 * Task 2 dev-server (same pattern as `server.test.ts`) on an ephemeral port,
 * then drives the vendored `EnvironmentSupervisor` (Task 3) against it over
 * a real `ws://127.0.0.1:<port>/rpc` socket — not the browser (that's 3b).
 * Proves: supervisor reaches `connected`, a unary RPC (`getPrescribedSession`)
 * succeeds, and a subscription (`subscribeCoachingFeed`) yields data.
 */
describe("client-runtime supervisor against the Task 2 dev-server (Node, real socket)", () => {
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
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;
    await waitForServerReady(`http://127.0.0.1:${address.port}`);
  });

  afterAll(async () => {
    await Effect.runPromise(Fiber.interrupt(serverFiber));
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

  it("reaches connected, calls getPrescribedSession, and opens a subscription", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* SupervisorModule.make(
            new DevServerConnectionTarget({
              environmentId: "dev-server",
              label: "Local dev-server",
              httpBaseUrl: wsBaseUrl.replace("ws://", "http://"),
              wsBaseUrl,
            }),
            { initiallyDesired: true },
          );

          const connected = yield* SubscriptionRef.changes(supervisor.state).pipe(
            Stream.filter((state: SupervisorState) => state.phase === "connected"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
          expect(connected.phase).toBe("connected");

          const session = yield* SubscriptionRef.get(supervisor.session).pipe(
            Effect.map(Option.getOrThrow),
          );

          const prescribed = yield* session.client[RPC_METHODS.getPrescribedSession]({
            sessionId: SessionId.make("session-seed-1"),
          });
          expect(prescribed.id).toBe("session-seed-1");

          const feedEntries = yield* session.client[RPC_METHODS.subscribeCoachingFeed]({}).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          expect(feedEntries.length).toBeGreaterThan(0);

          return { phase: connected.phase, feedCount: feedEntries.length };
        }),
      ).pipe(Effect.provide(dependencies)) as Effect.Effect<
        { readonly phase: string; readonly feedCount: number },
        unknown,
        never
      >,
    );

    expect(outcome.phase).toBe("connected");
    expect(outcome.feedCount).toBeGreaterThan(0);
  });
});
