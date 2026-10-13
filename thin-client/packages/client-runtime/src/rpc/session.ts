import { RPC_METHODS, type ServerConfig } from "@repcoach/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import type { ConnectionAttemptError, ConnectionTransientError, PreparedConnection } from "../connection/model.ts";
import { ConnectionTransientError as ConnectionTransientErrorClass } from "../connection/model.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

/**
 * Vendored from t3code's `rpc/session.ts`. Two adaptations:
 *  - `WS_METHODS.serverGetConfig` -> this repo's `RPC_METHODS.serverGetConfig`.
 *  - `RpcSerialization.layerJson` -> `RpcSerialization.layerNdjson`, to match
 *    the Task 2 dev-server, which serves NDJSON over `/rpc`
 *    (`apps/dev-server/src/server.ts`).
 * The `mapInitialConfigError` t3code variant also handled
 * `EnvironmentAuthorizationError`/`KeybindingsConfigParseError`/
 * `ServerSettingsError`, none of which exist in `@repcoach/contracts`; this
 * repo's `serverGetConfig` only fails with `ServerConfigUnavailableError` or
 * a transport-level `RpcClientError`, both mapped below.
 */
export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionTransientError>;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@repcoach/client-runtime/rpc/session/RpcSessionFactory") {}

function mapInitialConfigError(error: unknown): ConnectionAttemptError {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { readonly _tag: unknown })._tag === "ServerConfigUnavailableError"
  ) {
    return new ConnectionTransientErrorClass({
      reason: "remote-unavailable",
      detail: (error as { readonly message?: string }).message ?? "serverGetConfig failed.",
    });
  }
  return new ConnectionTransientErrorClass({
    reason: "transport",
    detail: (error as { readonly message?: string })?.message ?? "serverGetConfig failed.",
  });
}

export const make = Effect.gen(function* () {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Deferred.isDone(connected).pipe(
        Effect.flatMap((wasConnected) =>
          Deferred.fail(
            disconnected,
            new ConnectionTransientErrorClass({
              reason: "transport",
              detail: wasConnected
                ? `${connection.label} disconnected.`
                : `${connection.label} could not establish a WebSocket connection.`,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    });
    const socketLayer = Socket.layerWebSocket(connection.socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)));
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          socketLayer,
          RpcSerialization.layerNdjson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfig = yield* Effect.cached(
      client[RPC_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(mapInitialConfigError),
        Effect.withSpan("environment.initialSync"),
      ),
    );
    const probe = client[RPC_METHODS.serverGetConfig]({}).pipe(
      Effect.mapError(mapInitialConfigError),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client,
      initialConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Deferred.await(disconnected),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = Layer.effect(RpcSessionFactory, make);
