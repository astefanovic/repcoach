import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { Connection } from "@repcoach/client-runtime";

/**
 * DOM platform seam for `ConnectionWakeups` (#50, absorbing #51): emits
 * `"application-active"` when the document becomes visible again, replacing
 * the Expo app's RN `AppState` adapter. This is what triggers the
 * supervisor's resume health-probe (`monitorConnectedLease` in
 * `packages/client-runtime/src/connection/supervisor.ts`) — the moment the
 * client has to find out whether home is still there after being backgrounded.
 *
 * `visibilitychange` is the load-bearing event and the closest analogue to
 * `AppState` going `"active"`: on a phone, switching tabs, locking the screen
 * and backgrounding the browser all fire it, and a websocket left open across
 * a long background stretch is exactly the one most likely to be silently
 * dead. `focus` is also listened for because a desktop window regaining focus
 * without ever becoming hidden — clicking back into a background window —
 * fires only `focus`, and that is a real resume from the user's point of
 * view.
 *
 * The two overlap, so a single alt-tab can emit twice. That is deliberate and
 * safe: a wakeup is idempotent, it asks the supervisor to re-probe rather
 * than mutating anything, and a redundant probe against a same-origin server
 * is cheaper than a missed one that leaves the user staring at a dead
 * connection.
 */
export const domWakeupsLayer = Connection.Wakeups.layer({
  changes: Stream.callback<Connection.Wakeups.ConnectionWakeup>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const wake = () => {
          Queue.offerUnsafe(queue, "application-active");
        };
        const onVisibilityChange = () => {
          if (document.visibilityState === "visible") {
            wake();
          }
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener("focus", wake);
        return () => {
          document.removeEventListener("visibilitychange", onVisibilityChange);
          window.removeEventListener("focus", wake);
        };
      }),
      (unsubscribe) => Effect.sync(() => unsubscribe()),
    ).pipe(Effect.asVoid),
  ),
});
