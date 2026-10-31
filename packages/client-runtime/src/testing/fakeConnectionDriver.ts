import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Connectivity from "../connection/connectivity.ts";
import * as ConnectionDriver from "../connection/driver.ts";
import {
  DevServerConnectionTarget,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
} from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";

/**
 * Fake connection driver + connectivity + wakeups for rung-1 supervisor
 * tests, adapted from t3code's `supervisor.test.ts` harness (`makeHarness`)
 * down to this repo's single `DevServerConnectionTarget` (no relay/bearer
 * variants to parametrize over).
 */
export const TARGET = new DevServerConnectionTarget({
  environmentId: "dev-server",
  label: "Dev server",
  httpBaseUrl: "http://127.0.0.1:4010",
  wsBaseUrl: "ws://127.0.0.1:4010",
});

const TEST_RPC_CLIENT = {} as RpcSession["client"];

export const PREPARED_CONNECTION: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "ws://127.0.0.1:4010/rpc",
  target: TARGET,
};

export const makeFakeConnectionHarness = Effect.fn("FakeConnectionHarness.make")(function* (options?: {
  readonly networkStatus?: NetworkStatus;
  readonly prepare?: (attempt: number, target: ConnectionTarget) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  readonly ready?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly probe?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
}) {
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(options?.networkStatus ?? "online");
  const prepareCount = yield* Ref.make(0);
  const sessionCount = yield* Ref.make(0);
  const releaseCount = yield* Ref.make(0);
  const wakeups = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly reason: ConnectionWakeups.ConnectionWakeup;
  }>({ sequence: 0, reason: "application-active" });
  const closedSessions = yield* Ref.make<ReadonlyArray<Deferred.Deferred<never, ConnectionAttemptError & { readonly _tag: "ConnectionTransientError" }>>>([]);

  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });

  const prepare = Effect.fn("FakeConnectionDriver.prepare")(function* (target: ConnectionTarget) {
    const attempt = yield* Ref.updateAndGet(prepareCount, (count) => count + 1);
    if (options?.prepare) {
      return yield* options.prepare(attempt, target);
    }
    return PREPARED_CONNECTION;
  });

  const connect = Effect.fn("FakeConnectionDriver.connect")(function* (
    target: ConnectionTarget,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing" });
    const prepared = yield* prepare(target);
    yield* reportProgress({ stage: "opening", prepared });

    const attempt = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
    const closed = yield* Deferred.make<
      never,
      ConnectionAttemptError & { readonly _tag: "ConnectionTransientError" }
    >();
    yield* Ref.update(closedSessions, (sessions) => [...sessions, closed]);

    const session = yield* Effect.acquireRelease(
      Effect.succeed({
        client: TEST_RPC_CLIENT,
        initialConfig: Effect.die(new Error("Initial config is not used by supervisor tests.")),
        ready: options?.ready?.(attempt) ?? Effect.void,
        probe: options?.probe?.(attempt) ?? Effect.void,
        closed: Deferred.await(closed),
      } satisfies RpcSession),
      () => Ref.update(releaseCount, (count) => count + 1),
    );

    yield* reportProgress({ stage: "synchronizing", prepared });
    yield* session.ready;
    return { prepared, session } satisfies ConnectionDriver.EnvironmentConnectionLease;
  });

  const dependencies = Layer.mergeAll(
    Layer.succeed(Connectivity.Connectivity, connectivity),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({
        changes: SubscriptionRef.changes(wakeups).pipe(
          Stream.drop(1),
          Stream.map((event) => event.reason),
        ),
      }),
    ),
    Layer.succeed(ConnectionDriver.ConnectionDriver, ConnectionDriver.ConnectionDriver.of({ connect })),
  );

  return {
    dependencies,
    prepareCount,
    sessionCount,
    releaseCount,
    setNetworkStatus: (status: NetworkStatus) => SubscriptionRef.set(networkStatus, status),
    wake: (reason: ConnectionWakeups.ConnectionWakeup) =>
      SubscriptionRef.update(wakeups, (event) => ({ sequence: event.sequence + 1, reason })),
    closeLatestSession: Effect.fn("FakeConnectionHarness.closeLatestSession")(function* (
      error: ConnectionAttemptError & { readonly _tag: "ConnectionTransientError" },
    ) {
      const sessions = yield* Ref.get(closedSessions);
      const latest = sessions.at(-1);
      if (latest) {
        yield* Deferred.fail(latest, error);
      }
    }),
  };
});
