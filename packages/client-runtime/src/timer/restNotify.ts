import type { RestTimerState } from "./rest.ts";

/**
 * Reaching the user when the rest timer ends off-tab (#116 part 2).
 *
 * Mid-workout the phone goes in a pocket or the tab loses focus, and the pill
 * that used to carry "rest is over" becomes invisible. This module is the
 * DECISION half of the fix — whether to show a Notification and/or vibrate —
 * kept pure and DOM-free so Rung 1 can assert it with no browser at all. The
 * browser calls themselves (`Notification`, `document.hidden`,
 * `navigator.vibrate`) are an injected seam (`RestCompletionNotifier`) for the
 * same reason: this module never touches a global.
 *
 * Scope is deliberately narrow — rest-timer completion only, no push. This
 * decision governs the page-side tick. UAT showed that path is not enough on
 * its own: a locked phone suspends the page outright, and Android Chrome
 * refuses a page-side `new Notification()`. So the page also hands the
 * deadline to a small service worker (`apps/web/public/rest-sw.js`), which
 * notifies through `showNotification` if no window is visible when the rest
 * ends. Both use the same notification tag, so whichever fires second
 * replaces the first instead of adding a duplicate.
 */

/**
 * The running→zero transition (#116's trigger), read off two consecutive
 * `RestTimerState`s rather than matched on `next` alone — `overrun` is also
 * the state ticking every second AFTER completion, and firing again on every
 * one of those ticks would be a notification storm, not a completion signal.
 * Only the tick where `previous` was still `running` is the actual moment the
 * timer ran out.
 */
export function restTimerJustCompleted(
  previous: RestTimerState,
  next: RestTimerState,
): boolean {
  return previous.status === "running" && next.status === "overrun";
}

/** Live inputs the decision reads, all supplied by the caller — nothing here reaches for a global. */
export interface RestCompletionNotifyEnv {
  /** `document.hidden` — a notification for a timer the user is watching is noise (#116). */
  readonly hidden: boolean;
  /** The Settings toggle (off by default until Notification permission is granted). */
  readonly enabled: boolean;
  /** `Notification.permission`, or `"denied"` for a browser with no `Notification` at all. */
  readonly notificationPermission: "granted" | "denied" | "default";
  /** Whether `navigator.vibrate` exists — absent on iOS Safari and desktop. */
  readonly vibrateSupported: boolean;
}

/** What the decision says to do. Both may be false — most ticks, at least one will be. */
export interface RestCompletionNotifyDecision {
  readonly showNotification: boolean;
  readonly vibrate: boolean;
}

/**
 * Whether completion should reach the user off-tab, and how.
 *
 * Off entirely unless the tab is hidden AND the toggle is on — a foreground
 * user already has the pill. From there, a Notification requires the OS
 * permission (granted, never `"default"` — that would mean requesting it
 * synchronously from a timer tick, which is not a user gesture and every
 * browser refuses); vibration needs no permission, so it fires independently
 * whenever it is supported, per the ticket's "cheap fallback" — the more
 * likely of the two to actually be felt with the phone in a pocket. Denied or
 * unsupported degrades silently: no error state, no retry, no nagging.
 */
export function decideRestCompletionNotify(
  env: RestCompletionNotifyEnv,
): RestCompletionNotifyDecision {
  if (!env.hidden || !env.enabled) {
    return { showNotification: false, vibrate: false };
  }
  return {
    showNotification: env.notificationPermission === "granted",
    vibrate: env.vibrateSupported,
  };
}

/** The two effects a decision can call for — the injectable seam over the real browser APIs. */
export interface RestCompletionNotifier {
  readonly showNotification: () => void;
  readonly vibrate: () => void;
}

/** Carries out a decision through the injected notifier. Pure dispatch — no policy lives here. */
export function notifyRestCompletion(
  decision: RestCompletionNotifyDecision,
  notifier: RestCompletionNotifier,
): void {
  if (decision.showNotification) notifier.showNotification();
  if (decision.vibrate) notifier.vibrate();
}
