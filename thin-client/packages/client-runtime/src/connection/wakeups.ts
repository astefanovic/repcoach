import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

/**
 * Vendored unchanged from t3code `connection/wakeups.ts`. `"credentials-changed"`
 * is kept for shape-compatibility with the vendored supervisor even though
 * this experiment has no credential-rotation source yet; only
 * `"application-active"` is emitted today (RN `AppState` foreground).
 */
export type ConnectionWakeup = "application-active" | "credentials-changed";

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@repcoach/client-runtime/connection/wakeups/ConnectionWakeups") {}

export const make = (service: ConnectionWakeups["Service"]) => ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, make(service));
