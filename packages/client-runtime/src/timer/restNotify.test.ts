import { describe, expect, it, vi } from "vitest";

import {
  decideRestCompletionNotify,
  notifyRestCompletion,
  restTimerJustCompleted,
  type RestCompletionNotifyEnv,
} from "./restNotify.ts";
import type { RestTimerState } from "./rest.ts";

/**
 * #116 part 2 Rung 1 — the decision logic behind the off-tab rest-timer
 * notification, exercised with no browser at all (`Notification`,
 * `document.hidden` and `navigator.vibrate` are all injected, never read).
 */

/**
 * One rest timer, read at four instants. The states carry a deadline rather
 * than a remainder, so "later in the overrun" is a different `now` against the
 * same `endsAt` — which is why the two overrun states below are identical, and
 * why `restTimerJustCompleted` has to look at the previous status rather than
 * at any number on the state.
 */
const ENDS_AT = Date.UTC(2026, 0, 1, 12, 1, 30);

const RUNNING: RestTimerState = { status: "running", totalSec: 90, endsAt: ENDS_AT };
const OVERRUN: RestTimerState = { status: "overrun", totalSec: 90, endsAt: ENDS_AT };
const OVERRUN_LATER: RestTimerState = { status: "overrun", totalSec: 90, endsAt: ENDS_AT };
const COMPLETE: RestTimerState = { status: "complete", totalSec: 90 };
const ABSENT: RestTimerState = { status: "absent" };

describe("restTimerJustCompleted", () => {
  it("fires exactly on the running -> overrun tick", () => {
    expect(restTimerJustCompleted(RUNNING, OVERRUN)).toBe(true);
  });

  it("does not fire again on later overrun ticks", () => {
    expect(restTimerJustCompleted(OVERRUN, OVERRUN_LATER)).toBe(false);
  });

  it("does not fire for Skip (running -> complete)", () => {
    expect(restTimerJustCompleted(RUNNING, COMPLETE)).toBe(false);
  });

  it("does not fire for an absent timer", () => {
    expect(restTimerJustCompleted(ABSENT, ABSENT)).toBe(false);
  });
});

const env = (over: Partial<RestCompletionNotifyEnv> = {}): RestCompletionNotifyEnv => ({
  hidden: true,
  enabled: true,
  notificationPermission: "granted",
  vibrateSupported: true,
  ...over,
});

describe("decideRestCompletionNotify", () => {
  it("does nothing when the tab is visible — the pill is enough", () => {
    expect(decideRestCompletionNotify(env({ hidden: false }))).toEqual({
      showNotification: false,
      vibrate: false,
    });
  });

  it("does nothing when the setting is off", () => {
    expect(decideRestCompletionNotify(env({ enabled: false }))).toEqual({
      showNotification: false,
      vibrate: false,
    });
  });

  it("shows a notification and vibrates when hidden, enabled, and both are available", () => {
    expect(decideRestCompletionNotify(env())).toEqual({ showNotification: true, vibrate: true });
  });

  it("degrades silently when permission was denied — vibrate still fires", () => {
    expect(decideRestCompletionNotify(env({ notificationPermission: "denied" }))).toEqual({
      showNotification: false,
      vibrate: true,
    });
  });

  it("never shows a notification for unrequested permission — no synchronous prompt from a timer tick", () => {
    expect(decideRestCompletionNotify(env({ notificationPermission: "default" }))).toEqual({
      showNotification: false,
      vibrate: true,
    });
  });

  it("degrades silently when vibrate is unsupported — notification still fires", () => {
    expect(decideRestCompletionNotify(env({ vibrateSupported: false }))).toEqual({
      showNotification: true,
      vibrate: false,
    });
  });
});

describe("notifyRestCompletion", () => {
  it("calls only what the decision says to", () => {
    const showNotification = vi.fn();
    const vibrate = vi.fn();
    notifyRestCompletion({ showNotification: true, vibrate: false }, { showNotification, vibrate });
    expect(showNotification).toHaveBeenCalledOnce();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("calls neither when the decision is all-false", () => {
    const showNotification = vi.fn();
    const vibrate = vi.fn();
    notifyRestCompletion({ showNotification: false, vibrate: false }, { showNotification, vibrate });
    expect(showNotification).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
  });
});
