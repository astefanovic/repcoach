import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Connectivity from "../connection/connectivity.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";

/**
 * Trivial platform-seam fakes for integration tests: always-online
 * connectivity and a wakeup stream that never fires. Real platform
 * implementations live under `apps/web/src/platform/`.
 */
export const alwaysOnlineConnectivityLayer = Connectivity.layer({
  status: Effect.succeed("online"),
  changes: Stream.empty,
});

export const noWakeupsLayer = ConnectionWakeups.layer({
  changes: Stream.empty,
});
