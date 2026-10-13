import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/unstable/socket/Socket";
import { afterAll, describe, expect, it } from "vitest";

import { Connection, Rpc } from "@repcoach/client-runtime";
import {
  BlockId,
  EntryId,
  ExerciseId,
  type LogSetActualInput,
  RPC_METHODS,
  SessionId,
  SetId,
} from "@repcoach/contracts";

import { QuotaServiceAlwaysAvailable } from "./quotaService.ts";
import { CannedModelCatalog } from "./modelCatalog.ts";
import { makeProductionServer } from "./server.ts";
import { waitForServerReady } from "./testServerReady.ts";

const { Connectivity, ConnectionDriverModule, DevServerConnectionTarget, SupervisorModule, Wakeups } =
  Connection;
type SupervisorState = Connection.SupervisorConnectionState;

/**
 * Step 2A / task 2A.6 — the real G5 artifact, proven without the physical
 * phone: the exact wire the Pixel 7 exercises (client-runtime supervisor over a
 * real `ws://…/rpc` socket, NOT the browser and NOT an in-memory RpcTest) but
 * against the **production** server (`makeProductionServer`, persistent SQLite,
 * no `/__test__/*` channel), across a genuine **server restart**.
 *
 * A logged actual is enqueued through the real RPC client against process 1;
 * process 1 is torn down (its `node:sqlite` connection closed via the layer
 * scope); a brand-new production server (process 2) is booted over the SAME DB
 * file and the client reconnects and reads the actual back. If persistence
 * weren't real, the in-memory store this replaced would lose it here.
 */

const webSocketConstructorLayer = Layer.succeed(
  Socket.WebSocketConstructor,
  (url: string | URL) => new WebSocket(url) as unknown as globalThis.WebSocket,
);

const clientDependencies = Layer.mergeAll(
  Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.empty }),
  Wakeups.layer({ changes: Stream.empty }),
  ConnectionDriverModule.layer.pipe(
    Layer.provide(Rpc.sessionLayer.pipe(Layer.provide(webSocketConstructorLayer))),
  ),
);

interface BootedServer {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly fiber: Fiber.Fiber<never, never>;
  readonly close: () => Promise<void>;
}

/** Boots a production server over `dbPath` on an ephemeral port and waits for it to listen. */
const bootProductionServer = async (dbPath: string): Promise<BootedServer> => {
  const { layer, nodeServer } = makeProductionServer({
    port: 0,
    host: "127.0.0.1",
    dbPath,
    // No live quota probe in a unit rung (issue #88) — see productionServer.test.ts.
    quotaService: QuotaServiceAlwaysAvailable,
    // Reading the real model catalog opens an Agent SDK session too (issue #81 follow-up).
    modelCatalog: CannedModelCatalog,
  });
  const listening = new Promise<void>((resolve) => nodeServer.once("listening", () => resolve()));
  const fiber = Effect.runFork(Layer.launch(layer) as Effect.Effect<never, never>);
  await listening;

  const address = nodeServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected an AddressInfo from the production server");
  }
  const httpBaseUrl = `http://127.0.0.1:${address.port}`;
  await waitForServerReady(httpBaseUrl);

  return {
    wsBaseUrl: `ws://127.0.0.1:${address.port}`,
    httpBaseUrl,
    fiber,
    close: async () => {
      // Interrupting the launch fiber runs the layer scope finalizers — which
      // close the `node:sqlite` connection for real, the whole point of a
      // "restart" — then make sure the raw socket is down before we reopen.
      await Effect.runPromise(Fiber.interrupt(fiber));
      await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
};

/** Drives `effect` through a freshly-connected supervisor against `server`, then tears the client down. */
const withConnectedClient = <A>(
  server: BootedServer,
  use: (session: Rpc.RpcSession) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* SupervisorModule.make(
          new DevServerConnectionTarget({
            environmentId: "prod-server",
            label: "RepCoach production server",
            httpBaseUrl: server.httpBaseUrl,
            wsBaseUrl: server.wsBaseUrl,
          }),
          { initiallyDesired: true },
        );

        yield* SubscriptionRef.changes(supervisor.state).pipe(
          Stream.filter((state: SupervisorState) => state.phase === "connected"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );

        const session = yield* SubscriptionRef.get(supervisor.session).pipe(
          Effect.map(Option.getOrThrow),
        );

        return yield* use(session);
      }),
    ).pipe(Effect.provide(clientDependencies)) as Effect.Effect<A, unknown, never>,
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

describe("production server durability across a restart (Step 2A / task 2A.6)", () => {
  const dbPath = path.join(os.tmpdir(), `repcoach-prod-durability-${randomUUID()}.sqlite`);

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("a session logged via the real RPC client survives a full production-server restart", async () => {
    // A production database boots with an empty Plan (no demo Session) —
    // build a real one through the same structural-edit RPC a user's client
    // uses (`plan.applyUserChange`, ADR 0007's only Plan-authoring path)
    // rather than depending on the dev/e2e demo seed a production server no
    // longer has.
    const prescribedSessionId = SessionId.make("session-durability-1");
    const blockId = BlockId.make("block-durability-1");
    const entryId = EntryId.make("entry-durability-1");
    const exerciseId = ExerciseId.make("exercise-durability-1");
    const setId = SetId.make("set-durability-1");

    // --- process 1: start a Logged Session and log an actual against it ------
    const server1 = await bootProductionServer(dbPath);
    const { loggedSessionId, logged } = await withConnectedClient(server1, (session) =>
      Effect.gen(function* () {
        yield* session.client[RPC_METHODS.applyUserPlanChange]({
          operation: { _tag: "createSession", sessionId: prescribedSessionId, name: "Durability Session" },
        });
        // The catalog row before the Entry that references it — the same two
        // writes the web client makes (`useExerciseCatalog.create`, then the
        // `addEntry`), because a production catalog starts empty and
        // `addEntry` refuses an id that joins to nothing (ADR 0016).
        yield* session.client[RPC_METHODS.createExercise]({
          exerciseId,
          name: "Durability Lift",
        });
        yield* session.client[RPC_METHODS.applyUserPlanChange]({
          operation: {
            _tag: "addEntry",
            sessionId: prescribedSessionId,
            blockId,
            entryId,
            exerciseId,
          },
        });
        yield* session.client[RPC_METHODS.applyUserPlanChange]({
          operation: {
            _tag: "replaceEntrySets",
            entryId,
            sets: [
              {
                id: setId,
                setType: "working",
                target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } },
              },
            ],
          },
        });

        const started = yield* session.client[RPC_METHODS.startSession]({
          prescribedSessionId,
        });
        const result = yield* session.client[RPC_METHODS.logSetActual](
          asLogSetActualInput({
            commandId: "prod-durability-cmd-1",
            loggedSessionId: started.loggedSessionId,
            sessionId: prescribedSessionId,
            entryId,
            setId,
            setType: "working",
            actual: { reps: 5, load: 100 },
          }),
        );
        return { loggedSessionId: started.loggedSessionId, logged: result };
      }),
    );
    expect(logged.commandId).toBe("prod-durability-cmd-1");
    await server1.close();

    // --- process 2: a brand-new server over the SAME file reads it back ------
    const server2 = await bootProductionServer(dbPath);
    const readBack = await withConnectedClient(server2, (session) =>
      session.client[RPC_METHODS.getLoggedSession]({ loggedSessionId }),
    );
    await server2.close();

    expect(readBack.loggedSessionId).toBe(loggedSessionId);
    expect(readBack.status).toBe("active");
    expect(readBack.actuals.map((a) => a.commandId)).toContain("prod-durability-cmd-1");
    const rehydrated = readBack.actuals.find((a) => a.commandId === "prod-durability-cmd-1");
    expect(rehydrated !== undefined && !rehydrated.retraction && rehydrated.actual).toEqual({
      reps: 5,
      load: 100,
    });
  });
});
