import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  ConnectionTarget,
  PreparedConnection,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";

/**
 * Adapted from t3code's `connection/driver.ts`. t3code splits "prepare a
 * target into a `PreparedConnection`" into a separate `ConnectionResolver`
 * with per-target-kind auth brokers (primary/bearer/relay/ssh). This
 * experiment has exactly one target kind and no auth handshake (Task 2's
 * dev-server is unauthenticated), so resolution folds directly into the
 * driver instead of vendoring the resolver/broker/authorization layers.
 */
export type ConnectionDriverProgress =
  | {
      readonly stage: "preparing";
    }
  | {
      readonly stage: Exclude<ConnectionAttemptStage, "preparing">;
      readonly prepared: PreparedConnection;
    };

export interface EnvironmentConnectionLease {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
}

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      target: ConnectionTarget,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
  }
>()("@repcoach/client-runtime/connection/driver/ConnectionDriver") {}

function socketUrl(target: ConnectionTarget): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/rpc";
  }
  return url.toString();
}

function prepare(target: ConnectionTarget): PreparedConnection {
  return {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: socketUrl(target),
    target,
  };
}

export const make = Effect.gen(function* () {
  const sessions = yield* RpcSession.RpcSessionFactory;

  const connect = Effect.fn("ConnectionDriver.connect")(function* (
    target: ConnectionTarget,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    yield* reportProgress({ stage: "preparing" });
    const prepared = prepare(target);
    yield* reportProgress({ stage: "opening", prepared });
    const session = yield* sessions.connect(prepared);
    yield* reportProgress({ stage: "synchronizing", prepared });
    yield* session.ready;
    return { prepared, session } satisfies EnvironmentConnectionLease;
  });

  return ConnectionDriver.of({ connect });
});

export const layer = Layer.effect(ConnectionDriver, make);
