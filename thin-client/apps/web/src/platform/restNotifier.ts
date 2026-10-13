import { Timer } from "@repcoach/client-runtime";

/**
 * DOM platform seam for the rest-timer's off-tab notification (#116 part 2).
 * `packages/client-runtime/src/timer/restNotify.ts` carries the decision,
 * pure and DOM-free; everything here is the one place that actually touches
 * `Notification`, `document` and `navigator`.
 */

/** `Notification.permission`, or `"denied"` for a browser that has no `Notification` at all. */
export function readNotificationPermission(): "granted" | "denied" | "default" {
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission;
}

export function vibrateSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

/**
 * Requests Notification permission — but only the FIRST time, and only when
 * nothing has been decided yet. Call this from the rest timer actually
 * starting, never from app load: the permission prompt must be a consequence
 * of the user starting a set, not a surprise on first paint (#116).
 */
export function requestNotificationPermissionIfNeeded(): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "default") return;
  void requestNotificationPermission();
}

/**
 * Asks for permission from an explicit user gesture (the Settings toggle
 * being switched on) and reports where it landed. A rejected request
 * degrades to `"denied"`, same as an explicit refusal.
 */
export async function requestNotificationPermission(): Promise<"granted" | "denied" | "default"> {
  if (typeof Notification === "undefined") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return readNotificationPermission();
  }
}

/* ------------------------------------------------------------ the worker */

/**
 * `public/rest-sw.js` — see that file for why a worker exists at all: on
 * Android Chrome it is the only way to show a notification, and it keeps the
 * deadline while a locked phone has suspended this page.
 */
const WORKER_URL = "/rest-sw.js";

/**
 * Registers the rest-timer worker. Called once from app start, because the
 * worker has to be active by the time the first rest ends — registering it
 * asks the user nothing, it has no `fetch` handler, and it caches nothing.
 */
export function registerRestNotificationWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(WORKER_URL).catch((cause: unknown) => {
    console.warn("[rest-notify] could not register the worker", cause);
  });
}

async function activeWorkerRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
  try {
    const registration = await navigator.serviceWorker.getRegistration(WORKER_URL);
    return registration?.active === null ? undefined : registration;
  } catch {
    return undefined;
  }
}

const TITLE = "Rest is over";
const TAG = "repcoach-rest-timer";

function restBody(next: string | undefined): string {
  return next === undefined ? "Back to it when you're ready." : `Back to ${next} when you're ready.`;
}

/**
 * Hands the running timer's deadline to the worker, or clears it (`null`).
 * Called on every change of the pill's deadline — start, +30s, skip, the next
 * set replacing it, leaving the surface — so the worker is never holding a
 * deadline the pill no longer shows.
 */
export function scheduleRestNotificationInWorker(
  schedule: { readonly endsAt: number; readonly exercise: string } | null,
): void {
  void activeWorkerRegistration().then((registration) => {
    registration?.active?.postMessage(
      schedule === null
        ? { type: "rest-cancel" }
        : { type: "rest-schedule", endsAt: schedule.endsAt, title: TITLE, body: restBody(schedule.exercise) },
    );
  });
}

/**
 * Shows the rest-over notification now. Through the worker where there is
 * one — Android Chrome refuses the page-side constructor — and the plain
 * `Notification` constructor otherwise (desktop). Same tag either way, so a
 * page-side notice landing after the worker's replaces it rather than
 * stacking a second one.
 */
export async function showRestNotification(exercise?: string): Promise<void> {
  const options = { body: restBody(exercise), tag: TAG };
  try {
    const registration = await activeWorkerRegistration();
    if (registration !== undefined) {
      await registration.showNotification(TITLE, options);
      return;
    }
    // eslint-disable-next-line no-new -- fire-and-forget, no reference kept
    new Notification(TITLE, options);
  } catch (cause) {
    console.warn("[rest-notify] could not show the notification", cause);
  }
}

const browserNotifier = (exercise: string): Timer.RestCompletionNotifier => ({
  showNotification: () => {
    void showRestNotification(exercise);
  },
  vibrate: () => {
    try {
      navigator.vibrate?.(200);
    } catch (cause) {
      console.warn("[rest-notify] could not vibrate", cause);
    }
  },
});

/**
 * Reads the live browser state, decides, and acts — the one call site the
 * timer's tick loop needs (`Logging.tsx`) — the fallback for a page the
 * worker could not be handed the deadline by (no worker support, or a rest
 * longer than the worker may wait). `enabled` is the Settings toggle,
 * threaded in rather than read here, because it is React state the surface
 * already owns.
 */
export function notifyRestCompletionInBrowser(enabled: boolean, exercise: string): void {
  const decision = Timer.decideRestCompletionNotify({
    hidden: document.hidden,
    enabled,
    notificationPermission: readNotificationPermission(),
    vibrateSupported: vibrateSupported(),
  });
  Timer.notifyRestCompletion(decision, browserNotifier(exercise));
}
