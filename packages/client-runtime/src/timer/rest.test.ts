import { describe, expect, it } from "vitest";

import {
  extendRestTimer,
  isRestTimerActive,
  isRestTimerComplete,
  isRestTimerOverrun,
  isRestTimerRunning,
  restTimerForSet,
  restTimerReadout,
  shouldDismissRestTimerOnUnlog,
  skipRestTimer,
  startRestTimer,
  tickRestTimer,
  type ActiveRestTimerState,
  type Instant,
  type RestTimerState,
} from "./rest.ts";

/**
 * Task 7 (issue #21) Rung 1 — pure rest-timer logic, exercised with a fake
 * clock (no real timers / RPC / outbox involved).
 *
 * The clock is now an explicit parameter rather than an implied "one call =
 * one second", which is the whole point of the deadline rewrite: these tests
 * can put the clock anywhere, including a full minute later with no
 * intervening call at all, which is exactly what a suspended phone does.
 */

/** An arbitrary fixed epoch, so no assertion here depends on when it is run. */
const T0: Instant = Date.UTC(2026, 0, 1, 12, 0, 0);

/** `T0` plus some seconds — reads at the call site as "n seconds in". */
const at = (seconds: number): Instant => T0 + seconds * 1000;

/**
 * The pill's reading, for the states that are ON SCREEN. The narrowing is done
 * here rather than assumed — an absent or complete timer reaching a readout
 * would be a bug in the caller, not a reading to define.
 */
const reads = (state: RestTimerState, now: Instant) => {
  if (!isRestTimerActive(state)) throw new Error(`not on screen: ${state.status}`);
  return restTimerReadout(state as ActiveRestTimerState, now);
};

/** Just the clock face, which is what most assertions here are about. */
const clock = (state: RestTimerState, now: Instant): string => {
  const readout = reads(state, now);
  return `${readout.over ? "-" : ""}${String(readout.seconds)}`;
};

describe("startRestTimer", () => {
  it("absent prescribed rest yields the absent state (no timer)", () => {
    expect(startRestTimer(undefined, T0)).toEqual({ status: "absent" });
  });

  it("starts running, due the prescribed number of seconds from now", () => {
    const state = startRestTimer(90, T0);
    expect(state).toEqual({ status: "running", totalSec: 90, endsAt: at(90) });
    expect(isRestTimerRunning(state)).toBe(true);
    expect(clock(state, T0)).toBe("90");
  });

  it("a prescribed rest of 0 starts already complete", () => {
    expect(isRestTimerComplete(startRestTimer(0, T0))).toBe(true);
  });
});

describe("tickRestTimer", () => {
  it("counts down as the clock moves", () => {
    const state = startRestTimer(3, T0);
    expect(clock(tickRestTimer(state, at(1)), at(1))).toBe("2");
    expect(clock(tickRestTimer(state, at(2)), at(2))).toBe("1");
  });

  it("rests at a clean 0:00 for one whole second before it starts counting up", () => {
    const state = startRestTimer(2, T0);

    // Zero is a reading the user is meant to see, so it gets a whole second
    // like every other reading — from the deadline until a second past it.
    expect(clock(tickRestTimer(state, at(2)), at(2))).toBe("0");
    expect(clock(tickRestTimer(state, at(2.999)), at(2.999))).toBe("0");
    expect(isRestTimerRunning(tickRestTimer(state, at(2.999)))).toBe(true);

    // Only then does it start counting up, and the first thing it says is -0:01.
    expect(isRestTimerOverrun(tickRestTimer(state, at(3)))).toBe(true);
    expect(clock(tickRestTimer(state, at(3)), at(3))).toBe("-1");
  });

  it("ticking an absent timer stays absent", () => {
    expect(tickRestTimer(startRestTimer(undefined, T0), at(30))).toEqual({ status: "absent" });
  });

  it("ticking a complete timer stays complete", () => {
    const state = skipRestTimer(startRestTimer(1, T0));
    expect(tickRestTimer(state, at(600))).toEqual(state);
  });

  it("is pure logic independent of network/outbox — no RPC, no session, no I/O", () => {
    // No manager/session/commandId parameters exist on this API at all; this
    // test simply documents that the whole module surface is closed over
    // plain numbers.
    expect(clock(tickRestTimer(startRestTimer(10, T0), at(10)), at(10))).toBe("0");
  });
});

/* ============================ the timer measures time, not tick deliveries ==
 *
 * The defect these exist for: the state used to hold a `remainingSec` that the
 * surface's `setInterval` decremented by one per firing, so a page that was
 * not running did not count. Against the real app, a page suspended the way a
 * phone suspends it on screen-lock burned 62 seconds of wall time and moved
 * the pill by 2. Every case below would have failed then and is the reason the
 * clock is a parameter now.
 */
describe("a page that stops running", () => {
  it("comes back reading the time that actually passed, not the time it was awake for", () => {
    const started = startRestTimer(90, T0);

    // One tick, then the phone locks and nothing runs for a minute.
    const beforeSleep = tickRestTimer(started, at(1));
    expect(clock(beforeSleep, at(1))).toBe("89");

    const afterSleep = tickRestTimer(beforeSleep, at(61));
    expect(clock(afterSleep, at(61))).toBe("29");
  });

  it("crosses zero while nothing is running, and says so on the first tick back", () => {
    // The transition `restNotify.ts` watches for. Under the old model this
    // never happened at all: the timer resumed mid-countdown and the user was
    // never told their rest had ended.
    const running = tickRestTimer(startRestTimer(90, T0), at(1));
    const back = tickRestTimer(running, at(150));

    expect(isRestTimerRunning(running)).toBe(true);
    expect(isRestTimerOverrun(back)).toBe(true);
    expect(clock(back, at(150))).toBe("-60");
  });

  it("is unaffected by how many times it is asked — 90 ticks or 1 give the same answer", () => {
    const started = startRestTimer(120, T0);

    let ticked = started;
    for (let second = 1; second <= 90; second += 1) {
      ticked = tickRestTimer(ticked, at(second));
    }
    const jumped = tickRestTimer(started, at(90));

    expect(ticked).toEqual(jumped);
    expect(clock(ticked, at(90))).toBe("30");
  });

  it("keeps accumulating overrun across a gap, without bound", () => {
    const over = tickRestTimer(startRestTimer(1, T0), at(2));
    expect(clock(over, at(2))).toBe("-1");
    expect(clock(tickRestTimer(over, at(3600)), at(3600))).toBe("-3599");
  });
});

/* ------------------------------------------- #113 item 2: surviving zero === */

/**
 * The pill used to disappear at 0:00 — the exact moment the user looks at
 * their phone. It now survives zero and counts *up*, so "how far over am I"
 * is answerable, and it leaves the screen only on an explicit Skip (or when
 * the next confirmed set replaces it).
 */
describe("overrun", () => {
  it("keeps ticking past zero instead of terminating", () => {
    const state = tickRestTimer(startRestTimer(2, T0), at(3));
    expect(state).toEqual({ status: "overrun", totalSec: 2, endsAt: at(2) });
    expect(isRestTimerOverrun(state)).toBe(true);
    expect(isRestTimerComplete(state)).toBe(false);
  });

  it("stays on screen — an overrun timer is still active, a complete one is not", () => {
    const over = tickRestTimer(startRestTimer(1, T0), at(5));
    expect(isRestTimerActive(over)).toBe(true);
    expect(isRestTimerActive(skipRestTimer(over))).toBe(false);
    expect(isRestTimerActive(startRestTimer(undefined, T0))).toBe(false);
  });

  it("reads as a negative clock over an empty bar, never a negative width", () => {
    const running = startRestTimer(120, T0);
    expect(reads(running, T0)).toEqual({ seconds: 120, over: false, fraction: 1 });
    expect(reads(running, at(60))).toEqual({ seconds: 60, over: false, fraction: 0.5 });
    expect(reads(running, at(192))).toEqual({ seconds: 72, over: true, fraction: 0 });
  });

  it("Skip is the way out of an overrun timer, as it is of a running one", () => {
    const over = tickRestTimer(startRestTimer(30, T0), at(100));
    expect(skipRestTimer(over)).toEqual({ status: "complete", totalSec: 30 });
  });
});

describe("restTimerReadout", () => {
  it("holds each displayed second for a whole second, rather than flicking on the first millisecond", () => {
    const running = startRestTimer(120, T0);
    expect(reads(running, T0).seconds).toBe(120);
    expect(reads(running, at(0.999)).seconds).toBe(120);
    expect(reads(running, at(1)).seconds).toBe(119);
  });

  it("never shows a meaningless -0:00 — it goes straight from 0:00 to -0:01", () => {
    const started = startRestTimer(10, T0);
    expect(reads(tickRestTimer(started, at(10.999)), at(10.999))).toEqual({
      seconds: 0,
      over: false,
      fraction: 0,
    });
    expect(reads(tickRestTimer(started, at(11)), at(11))).toEqual({
      seconds: 1,
      over: true,
      fraction: 0,
    });
  });

  it("clamps the bar at full if the clock steps backwards underneath it", () => {
    // NTP correction, a timezone change, a user setting the clock. The bar
    // must not render wider than the pill.
    const running = startRestTimer(60, T0);
    expect(reads(running, at(-30)).fraction).toBe(1);
  });
});

/* --------------------------------------------------------- #72's additions */

describe("skipRestTimer", () => {
  it("ends a running timer as complete — rest was taken, just shorter", () => {
    const state = skipRestTimer(tickRestTimer(startRestTimer(120, T0), at(10)));
    expect(state).toEqual({ status: "complete", totalSec: 120 });
    expect(isRestTimerRunning(state)).toBe(false);
  });

  it("skipping an absent timer stays absent", () => {
    expect(skipRestTimer(startRestTimer(undefined, T0))).toEqual({ status: "absent" });
  });

  it("skipping a complete timer is a no-op", () => {
    const complete = startRestTimer(0, T0);
    expect(skipRestTimer(complete)).toEqual(complete);
  });
});

describe("extendRestTimer", () => {
  it("pushes out both the deadline and the total, so the bar never jumps past full", () => {
    const state = tickRestTimer(startRestTimer(90, T0), at(60));
    expect(clock(state, at(60))).toBe("30");

    const extended = extendRestTimer(state, 30, at(60));
    expect(extended).toEqual({ status: "running", totalSec: 120, endsAt: at(120) });
    expect(reads(extended, at(60))).toEqual({ seconds: 60, over: false, fraction: 0.5 });
  });

  it("restarts an overrun timer for the added time — +30s a beat after it ran out", () => {
    const over = tickRestTimer(startRestTimer(90, T0), at(100));
    expect(extendRestTimer(over, 30, at(100))).toEqual({
      status: "running",
      totalSec: 120,
      endsAt: at(130),
    });
  });

  it("does not resurrect a timer the user skipped — complete is terminal (#113 item 2)", () => {
    const skipped = skipRestTimer(startRestTimer(90, T0));
    expect(extendRestTimer(skipped, 30, T0)).toEqual(skipped);
    expect(extendRestTimer(startRestTimer(0, T0), 30, T0)).toEqual({
      status: "complete",
      totalSec: 0,
    });
  });

  it("never invents a timer where the Plan prescribed no rest", () => {
    expect(extendRestTimer(startRestTimer(undefined, T0), 30, T0)).toEqual({ status: "absent" });
  });

  it("ignores a non-positive extension", () => {
    const running = startRestTimer(60, T0);
    expect(extendRestTimer(running, 0, T0)).toEqual(running);
    expect(extendRestTimer(running, -30, T0)).toEqual(running);
  });
});

describe("restTimerForSet", () => {
  it("starts from the Set's own prescribed rest", () => {
    expect(restTimerForSet({ restSec: 180 }, { live: true, now: T0 })).toEqual({
      status: "running",
      totalSec: 180,
      endsAt: at(180),
    });
  });

  it("a Set with no prescribed rest gets no timer at all", () => {
    expect(restTimerForSet({}, { live: true, now: T0 })).toEqual({ status: "absent" });
  });

  it("backfilling a past session never starts a timer, even where rest is prescribed", () => {
    expect(restTimerForSet({ restSec: 180 }, { live: false, now: T0 })).toEqual({
      status: "absent",
    });
  });
});

/** #83, ADR 0019 — un-logging the Set that raised the pill dismisses it. */
describe("shouldDismissRestTimerOnUnlog", () => {
  it("dismisses a running timer", () => {
    expect(shouldDismissRestTimerOnUnlog(startRestTimer(90, T0))).toBe(true);
  });

  it("dismisses an overrun timer", () => {
    const overrun = tickRestTimer(startRestTimer(1, T0), at(5));
    expect(isRestTimerOverrun(overrun)).toBe(true);
    expect(shouldDismissRestTimerOnUnlog(overrun)).toBe(true);
  });

  it("does nothing to an already-complete timer — nothing left on screen to retract", () => {
    expect(shouldDismissRestTimerOnUnlog(skipRestTimer(startRestTimer(90, T0)))).toBe(false);
  });

  it("does nothing to an absent timer", () => {
    expect(shouldDismissRestTimerOnUnlog(startRestTimer(undefined, T0))).toBe(false);
  });
});
