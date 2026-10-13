import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { Connection } from "@repcoach/client-runtime";

type NetworkStatus = Connection.NetworkStatus;

/**
 * DOM platform seam for `Connectivity` (#50, absorbing #51): `navigator.onLine`
 * plus the `online`/`offline` window events, replacing the Expo app's
 * `@react-native-community/netinfo` adapter.
 *
 * **What this can and cannot know.** `navigator.onLine === false` is
 * trustworthy: the browser is certain there is no route out. `true` is only a
 * claim that an interface exists — a captive portal, or a home server that is
 * simply down, both read as `"online"` here. That is why the status never
 * maps to `"unknown"` the way NetInfo's `isConnected === null` did: the DOM
 * has no third state to report. It is also why nothing important rests on
 * this signal alone. The supervisor treats connectivity as a *hint* to
 * re-probe and owns the actual verdict through its health probe
 * (`monitorConnectedLease` in
 * `packages/client-runtime/src/connection/supervisor.ts`), and
 * `Connection.resolveServerBaseUrls` keeps the client same-origin so "the
 * network is up but home is unreachable" is the supervisor's call to make.
 *
 * Playwright's `context.setOffline` drives exactly these events, which is how
 * the G1/G2 acceptance flows force true offline (`e2e/driver.ts`).
 */
function currentStatus(): NetworkStatus {
  return navigator.onLine ? "online" : "offline";
}

export const domConnectivityLayer = Connection.Connectivity.layer({
  status: Effect.sync(currentStatus),
  changes: Stream.callback<NetworkStatus>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const emit = () => {
          Queue.offerUnsafe(queue, currentStatus());
        };
        window.addEventListener("online", emit);
        window.addEventListener("offline", emit);
        return () => {
          window.removeEventListener("online", emit);
          window.removeEventListener("offline", emit);
        };
      }),
      (unsubscribe) => Effect.sync(() => unsubscribe()),
    ).pipe(Effect.asVoid),
  ),
});
