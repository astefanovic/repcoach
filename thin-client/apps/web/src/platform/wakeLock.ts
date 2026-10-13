import { useEffect } from "react";

/**
 * Keeps the screen on while a workout is live — the Screen Wake Lock API.
 *
 * A phone that dims and locks between sets costs an unlock on every ✓, with
 * chalk on your hands, which is exactly the tap the one-tap confirm exists to
 * save. So Logging holds a `screen` lock for as long as the session is live
 * (`model.active`), and never for backfill: editing last Tuesday's session is
 * not a reason to keep anyone's screen on.
 *
 * The browser releases the lock on its own whenever the page is hidden (tab
 * switched, phone locked by the side button), and does not give it back, so
 * the lock is re-requested each time the page becomes visible again.
 *
 * Best effort and silent: an unsupported browser (`navigator.wakeLock`
 * missing), an insecure origin, or a refused request (battery saver) just
 * means the screen behaves as it always did. Nothing on screen depends on
 * the lock being held, so there is nothing to tell the user.
 */
export function useScreenWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const wakeLock = (navigator as Navigator & { readonly wakeLock?: WakeLockLike }).wakeLock;
    if (wakeLock === undefined) return;

    let sentinel: WakeLockSentinelLike | undefined;
    let disposed = false;

    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      if (sentinel !== undefined && !sentinel.released) return;
      wakeLock.request("screen").then(
        (next) => {
          if (disposed) {
            void next.release();
            return;
          }
          sentinel = next;
        },
        (cause: unknown) => {
          console.warn("[wake-lock] screen wake lock refused", cause);
        },
      );
    };

    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", acquire);
      if (sentinel !== undefined && !sentinel.released) void sentinel.release();
    };
  }, [enabled]);
}

/** The slice of the Wake Lock API used here — not in every TS DOM lib this repo builds against. */
interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}
