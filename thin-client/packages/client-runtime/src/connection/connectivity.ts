import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

import type { NetworkStatus } from "./model.ts";

/**
 * Vendored unchanged from t3code `connection/connectivity.ts` — the platform
 * seam the supervisor depends on for online/offline transitions. The Expo
 * app supplies a `@react-native-community/netinfo`-backed layer; tests
 * supply a fake (see `testing/fakeConnectivity.ts`).
 */
export class Connectivity extends Context.Service<
  Connectivity,
  {
    readonly status: Effect.Effect<NetworkStatus>;
    readonly changes: Stream.Stream<NetworkStatus>;
  }
>()("@repcoach/client-runtime/connection/connectivity") {}

export const make = (service: Connectivity["Service"]) => Connectivity.of(service);

export const layer = (service: Connectivity["Service"]) =>
  Layer.succeed(Connectivity, make(service));
