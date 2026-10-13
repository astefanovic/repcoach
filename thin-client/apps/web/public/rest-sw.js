/**
 * The rest timer's off-tab notifier (#116 part 2, UAT). Deliberately tiny: no
 * `fetch` handler, no caching, no push — it exists for two things the page
 * cannot do on its own.
 *
 * 1. **Show a notification on Android Chrome at all.** There `new
 *    Notification()` from a page throws ("Illegal constructor"); only
 *    `ServiceWorkerRegistration.showNotification` works.
 * 2. **Keep the deadline while the page is suspended.** A phone that locks its
 *    screen stops the page's timers outright, so the page-side tick only
 *    notices zero after the user has already come back. The page posts the
 *    deadline here instead, and the worker holds its `message` event open
 *    (`waitUntil`) until then. Browsers cap how long an event may stay open
 *    (Chrome: five minutes), which covers a normal rest; anything longer
 *    falls back to the page-side tick.
 *
 * Messages, from `platform/restNotifier.ts`:
 *   { type: "rest-schedule", endsAt: <epoch ms>, title, body }
 *   { type: "rest-cancel" }
 * A new schedule replaces the old one, which is what "the next set replaces
 * the pill" and "+30s" both need.
 */

const TAG = "repcoach-rest-timer";

/** Settles the currently-waiting schedule, if any — `true` = cancelled. */
let settlePending = null;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message === null || typeof message !== "object") return;

  if (settlePending !== null) {
    settlePending(true);
    settlePending = null;
  }
  if (message.type !== "rest-schedule") return;

  const waited = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), Math.max(0, message.endsAt - Date.now()));
    settlePending = (cancelled) => {
      clearTimeout(timeout);
      resolve(cancelled);
    };
  });

  event.waitUntil(
    waited.then(async (cancelled) => {
      if (cancelled) return;
      settlePending = null;
      if (self.Notification?.permission !== "granted") return;
      // Someone looking at the app already has the pill — a notification on
      // top of it is noise (#116).
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows.some((client) => client.visibilityState === "visible")) return;
      await self.registration.showNotification(message.title, {
        body: message.body,
        tag: TAG,
        vibrate: [200, 100, 200],
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows[0];
      if (open !== undefined) return open.focus();
      return self.clients.openWindow("/");
    }),
  );
});
