/**
 * Task 7 (issue #21) — the rest timer's pure state/tick logic, pulled out of
 * the React layer so Rung 1 (vitest) can exercise it directly with a fake
 * clock. `apps/web` (excluded from vitest's DOM-less environment) only wires
 * this to a `setInterval` and renders the resulting state.
 *
 * CONTEXT `Set`: rest is a prescription-only attribute set per Set, and may
 * be absent entirely (absent = no rest timer). This module never touches the
 * network or the outbox — it is driven entirely by the prescribed `restSec`
 * value already sitting in the caller's prefetched-and-cached
 * `PrescribedSession` (Task 5), and it never records rest as a logged actual
 * (ADR 0006).
 *
 * **The timer is a deadline, not a countdown.** Every function here takes the
 * current instant and derives the clock from it; nothing accumulates. That is
 * the fix for the defect where a rest timer only advanced while the page was
 * running: the state used to hold a `remainingSec` that a `setInterval`
 * decremented by one per firing, so the timer measured *interval firings*
 * rather than time. A phone that locks its screen or switches apps suspends
 * the page outright — measured against the real app, 62 seconds of wall time
 * produced 2 seconds of countdown, and the timer then resumed from where it
 * had been rather than from where it should be. Worse, the `running` →
 * `overrun` transition is what fires the off-tab notification (`restNotify.ts`),
 * so a timer that never crossed zero never told the user anything either.
 *
 * Holding an absolute `endsAt` makes all of that a non-question. Ticks become
 * a repaint schedule rather than the source of truth, a missed tick costs
 * nothing, and the very first tick after the page wakes reports the correct
 * time and the correct status.
 */

/** Epoch milliseconds — `Date.now()`, injected rather than read, so Rung 1 owns the clock. */
export type Instant = number;

/**
 * **Overrun is its own status, not a negative remainder (#113 item 2).**
 *
 * The pill used to vanish at 0:00 — exactly the moment the user looks at their
 * phone — so the timer now survives zero and counts *up*, and the only way it
 * leaves the screen is an explicit Skip or the next set replacing it.
 *
 * The alternative was to let `running` carry a negative remainder. That is
 * fewer lines and worse: every existing consumer of `running` does arithmetic
 * with it and would keep compiling while going quietly wrong — the pill's
 * drain bar is literally `remaining / total`, which at -72s is a negative
 * width. A distinct status makes the compiler ask each of them what overrun
 * means for it, and the answers differ (the bar empties, the clock gains a
 * minus sign, `extendRestTimer` restarts rather than adds).
 *
 * Both active statuses carry the same `endsAt` and differ only in which side
 * of it the current instant falls on, so the status is **recomputed on every
 * tick** rather than latched. A stored status could otherwise outlive its own
 * truth — which is precisely what a suspended page produces.
 */
export type RestTimerState =
  | { readonly status: "absent" }
  | { readonly status: "running"; readonly totalSec: number; readonly endsAt: Instant }
  | { readonly status: "overrun"; readonly totalSec: number; readonly endsAt: Instant }
  | { readonly status: "complete"; readonly totalSec: number };

/** The two states that put a pill on screen — see `isRestTimerActive`. */
export type ActiveRestTimerState = Extract<RestTimerState, { status: "running" | "overrun" }>;

/**
 * The one second a timer spends reading a clean `0:00` before it starts
 * counting up (#113 item 2). Zero is a reading the user is meant to *see*, so
 * it gets a whole second like every other reading; without this the deadline
 * would be crossed instantaneously and `0:00` would exist for a millisecond.
 *
 * It is spent on the running side of the boundary rather than the overrun
 * side, which is why a 2:00 rest reads `-0:01` at 2:01 and not at 2:00.
 */
const ZERO_BEAT_MS = 1000;

/**
 * Which side of the deadline `now` falls on. The single place the
 * running/overrun boundary is decided, so `startRestTimer`, `tickRestTimer`
 * and `extendRestTimer` cannot drift apart on where zero is.
 */
function atDeadline(totalSec: number, endsAt: Instant, now: Instant): RestTimerState {
  return now < endsAt + ZERO_BEAT_MS
    ? { status: "running", totalSec, endsAt }
    : { status: "overrun", totalSec, endsAt };
}

/**
 * Starts a rest timer from a prescribed `restSec`, due `restSec` seconds
 * after `now`. `undefined` (no prescribed rest for this Set) yields
 * `"absent"` — the caller renders no timer at all. A prescribed `0` starts
 * already-complete rather than "running" with nothing left to count down.
 */
export function startRestTimer(restSec: number | undefined, now: Instant): RestTimerState {
  if (restSec === undefined) {
    return { status: "absent" };
  }
  if (restSec <= 0) {
    return { status: "complete", totalSec: restSec };
  }
  return { status: "running", totalSec: restSec, endsAt: now + restSec * 1000 };
}

/**
 * Re-reads the timer against the clock. Named a "tick" because that is how the
 * surface schedules it, but it advances nothing: the answer depends only on
 * `now` and the stored deadline, so calling it once a second, once a minute,
 * or once after five minutes of the page being frozen all give the same —
 * correct — result.
 *
 * Only `absent` and `complete` are terminal; ticking either leaves it alone,
 * never fabricating a countdown.
 */
export function tickRestTimer(state: RestTimerState, now: Instant): RestTimerState {
  if (state.status !== "running" && state.status !== "overrun") {
    return state;
  }
  return atDeadline(state.totalSec, state.endsAt, now);
}

/**
 * Skip (#72 user story 17): the user is done resting early. Skipping is
 * *completion*, not cancellation — the rest was taken, it was just shorter —
 * so the pill leaves the same way it would have on its own. Skipping a timer
 * that never existed stays absent.
 *
 * Since #113 item 2 this is also the only way rest ends *late*: an overrun
 * timer keeps counting until the user dismisses it (or confirms the next set,
 * which replaces it), so Skip is the single explicit exit from the pill in
 * both directions.
 */
export function skipRestTimer(state: RestTimerState): RestTimerState {
  if (state.status !== "running" && state.status !== "overrun") {
    return state;
  }
  return { status: "complete", totalSec: state.totalSec };
}

/**
 * Extend (#72 user story 17): "+30s". The total grows with the deadline so
 * the pill's draining bar keeps meaning "how much of this rest is left"
 * rather than jumping backwards past full.
 *
 * Extending an *overrun* timer restarts it for the added time — the case
 * where the user reaches for +30s a beat after it ran out, which is when they
 * most want it. Before #113 item 2 that branch sat on `complete`, because
 * `complete` was where a timer landed the instant it hit zero; it was a
 * workaround for the pill dismissing itself. Now that overrun is a state of
 * its own the branch has moved to where the case actually lives, and
 * `complete` is terminal: it is reachable only by Skip (or a prescribed 0),
 * i.e. by the user having said they are done, and resurrecting a pill they
 * dismissed would be the app arguing with them.
 *
 * An absent timer stays absent: there is no rest prescribed here and the app
 * does not invent one (story 16).
 */
export function extendRestTimer(
  state: RestTimerState,
  addSec: number,
  now: Instant,
): RestTimerState {
  if (addSec <= 0 || state.status === "absent" || state.status === "complete") {
    return state;
  }
  if (state.status === "overrun") {
    return { status: "running", totalSec: state.totalSec + addSec, endsAt: now + addSec * 1000 };
  }
  return {
    status: "running",
    totalSec: state.totalSec + addSec,
    endsAt: state.endsAt + addSec * 1000,
  };
}

/**
 * Whether a confirmed Set prescribes rest at all, and for how long — the
 * resolution #72 moves out of the React layer. Rest is prescription-only and
 * lives on the Set and nowhere else (CONTEXT `Set`), so this is the whole
 * rule: the Set's own `restSec`, or no timer.
 *
 * `live` is the second half of it. Backfilling a past session must start no
 * timer (story 23) — the app is not pretending the user is mid-workout — and
 * that is a property of the session being logged, not of the row rendering
 * it.
 */
export function restTimerForSet(
  set: { readonly restSec?: number },
  options: { readonly live: boolean; readonly now: Instant },
): RestTimerState {
  if (!options.live) {
    return { status: "absent" };
  }
  return startRestTimer(set.restSec, options.now);
}

export function isRestTimerRunning(state: RestTimerState): boolean {
  return state.status === "running";
}

export function isRestTimerComplete(state: RestTimerState): boolean {
  return state.status === "complete";
}

export function isRestTimerOverrun(state: RestTimerState): boolean {
  return state.status === "overrun";
}

/**
 * Whether the pill is on screen at all, and whether the clock is still
 * ticking — since #113 item 2 those are the same question, because an overrun
 * timer keeps counting *and* keeps rendering. The surface asks this rather
 * than matching on `status` itself, so "which states are visible" stays a
 * decision Rung 1 can drive with a fake clock rather than one buried in JSX.
 */
export function isRestTimerActive(state: RestTimerState): state is ActiveRestTimerState {
  return state.status === "running" || state.status === "overrun";
}

/**
 * Un-logging a Set (#83, ADR 0019) dismisses the rest timer the confirm it
 * retracts raised — the same decision Skip already makes, reused rather than
 * a second dismissal path. This is a runtime predicate, not a component one
 * (ADR 0019's Consequences, #118's rule): only an active timer needs
 * dismissing, since `complete`/`absent` already have nothing on screen to
 * retract. The caller (the row rendering the pill) is responsible for
 * knowing WHICH Set's retraction this is — matching that against the timer's
 * owning `setId` is component-level plumbing, not a decision.
 */
export function shouldDismissRestTimerOnUnlog(state: RestTimerState): boolean {
  return isRestTimerActive(state);
}

/** Everything the pill renders, derived from the state rather than from `status`. */
export interface RestTimerReadout {
  /** Seconds to put through a `m:ss` formatter — never negative. */
  readonly seconds: number;
  /** Past the prescribed rest: the clock reads `-1:12` rather than `1:12`. */
  readonly over: boolean;
  /**
   * How full the draining bar is, 0..1. Overrun reads empty rather than
   * negative — a bar cannot be less than empty, and the minus sign on the
   * clock is where "you are over" is said.
   */
  readonly fraction: number;
}

/**
 * The pill's reading at `now`, derived rather than stored — the same instant
 * that decided the status has to decide the digits, or the two could disagree
 * across a tick boundary.
 *
 * The rounding is what makes each displayed value occupy a full second rather
 * than flicker. Remaining time **ceils**, so a 2:00 rest reads `2:00` for its
 * whole first second instead of dropping to `1:59` a millisecond in, and
 * `0:00` covers the `ZERO_BEAT_MS` window on either side of the deadline.
 * Overrun **floors** the distance past that window, so `-0:01` likewise gets a
 * full second and no reading is ever a meaningless `-0:00`.
 */
export function restTimerReadout(state: ActiveRestTimerState, now: Instant): RestTimerReadout {
  const remainingMs = state.endsAt - now;
  if (remainingMs <= -ZERO_BEAT_MS) {
    return { seconds: Math.floor(-remainingMs / 1000), over: true, fraction: 0 };
  }
  const totalMs = state.totalSec * 1000;
  return {
    // `max` because the zero beat runs a second past the deadline, where the
    // remainder is already negative and the clock must still read 0:00.
    seconds: Math.max(0, Math.ceil(remainingMs / 1000)),
    over: false,
    // Clamped at both ends: below because of that same negative tail, above
    // because a clock that steps backwards (NTP, a phone crossing a timezone,
    // a user setting the time) would otherwise render a bar wider than the
    // pill.
    fraction: totalMs <= 0 ? 0 : Math.min(1, Math.max(0, remainingMs / totalMs)),
  };
}
