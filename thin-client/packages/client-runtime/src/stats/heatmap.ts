/**
 * "Stats" (issue #117) — the consistency heatmap's pure bucketing and
 * week-column layout, pulled out of the React layer so Rung 1 (vitest) can
 * exercise it directly, the same reason `timer/rest.ts` and `logging/grid.ts`
 * exist. `apps/web`'s `Stats.tsx` only wires this to the RPC result and
 * renders the resulting cells.
 *
 * `date` strings throughout are the server's local-calendar-day keys
 * (`YYYY-MM-DD`, `stats.getDailySetCounts`'s day-bucketing already resolved
 * the timezone — see `packages/persistence/src/store.ts`'s `localDateKey`).
 * This module never touches a timezone again: `today` is a plain
 * `{ year, month, day }` triple the caller reads off its own local clock, and
 * every date this module produces is built from calendar arithmetic on that
 * triple, never from a JS `Date`'s local getters (which would silently
 * reintroduce the machine's own timezone).
 */

/** A local calendar day, as the three integers that make it unambiguous. */
export interface CalendarDay {
  readonly year: number;
  /** 1-indexed (January = 1), matching `DailySetCount.date`'s `MM`. */
  readonly month: number;
  readonly day: number;
}

/** Bucket 0 is reserved for "no sets logged" — see `heatmapCellStyle`'s doc on why that must read as empty, not as the bottom of the confirm scale. */
export type HeatmapBucket = 0 | 1 | 2 | 3 | 4;

export interface HeatmapCell {
  readonly date: string;
  readonly setCount: number;
  readonly bucket: HeatmapBucket;
}

/** One calendar week, Sunday-first. `undefined` marks a day that has not happened yet (the tail of the current week) — never rendered as an empty-but-past cell. */
export type WeekColumn = ReadonlyArray<HeatmapCell | undefined>;

const toKey = (d: CalendarDay): string =>
  `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** Calendar-correct day arithmetic via `Date.UTC`, treated purely as an integer day-index calculator — never read back with local getters. */
const addDays = (d: CalendarDay, delta: number): CalendarDay => {
  const ms = Date.UTC(d.year, d.month - 1, d.day) + delta * 86_400_000;
  const shifted = new Date(ms);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};

/** Sunday = 0 .. Saturday = 6, via the same UTC-anchored arithmetic as `addDays`. */
const weekdayOf = (d: CalendarDay): number => new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();

const compareCalendarDay = (a: CalendarDay, b: CalendarDay): number => toKey(a).localeCompare(toKey(b));

/**
 * Bucket thresholds, derived from the user's OWN distribution of active days
 * rather than GitHub's fixed 1/10/20/30 (the ticket's explicit instruction —
 * a single leg day and a novice's first week look nothing alike, and hard
 * absolute cutoffs would leave one of them a flat colour forever). Zero-set
 * days never enter the distribution — bucket 0 is categorical ("did not
 * train"), not the bottom of a continuous scale.
 *
 * Ties and small samples (a brand-new user with two or three logged days)
 * collapse naturally: `Math.max` keeps thresholds non-decreasing, so a
 * repeated quantile just means fewer distinct buckets ever get used, not a
 * broken ordering.
 */
export function computeBucketThresholds(
  activeDaySetCounts: ReadonlyArray<number>,
): readonly [number, number, number] {
  if (activeDaySetCounts.length === 0) return [1, 2, 3];
  const sorted = [...activeDaySetCounts].sort((a, b) => a - b);
  const quantile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  const q1 = quantile(0.25);
  const q2 = Math.max(q1, quantile(0.5));
  const q3 = Math.max(q2, quantile(0.75));
  return [q1, q2, q3];
}

export function bucketFor(setCount: number, thresholds: readonly [number, number, number]): HeatmapBucket {
  if (setCount <= 0) return 0;
  const [t1, t2, t3] = thresholds;
  if (setCount <= t1) return 1;
  if (setCount <= t2) return 2;
  if (setCount <= t3) return 3;
  return 4;
}

/**
 * The week-column layout (#117: "pick one" of the two phone-vs-desktop
 * strategies the ticket offered — this repo picked horizontal scroll pinned
 * to most recent, over a responsive rolling window, because it needs no
 * container-query-driven branch in this pure function; the component decides
 * how much of it is visible without this function knowing). `weeksBack` is
 * the caller's window size — `Stats.tsx` uses a year (53) so a phone scrolls
 * and a wide desktop viewport simply shows more of the same array without
 * asking this function to recompute anything.
 *
 * Columns run oldest-first, ending on `today`'s own week (Sunday-first, to
 * match the day-of-week convention `weekdayOf` already uses). A day strictly
 * after `today` is `undefined` — GitHub's own heatmap renders those blank
 * rather than as a zero, and "no sets logged" and "hasn't happened yet" are
 * not the same fact.
 */
export function buildWeekColumns(
  days: ReadonlyArray<{ readonly date: string; readonly setCount: number }>,
  options: { readonly weeksBack: number; readonly today: CalendarDay },
): ReadonlyArray<WeekColumn> {
  const countByDate = new Map(days.map((d) => [d.date, d.setCount]));
  const thresholds = computeBucketThresholds(days.filter((d) => d.setCount > 0).map((d) => d.setCount));

  const todayWeekday = weekdayOf(options.today);
  const weekEnd = addDays(options.today, 6 - todayWeekday);
  const totalDays = (options.weeksBack + 1) * 7;
  const start = addDays(weekEnd, -(totalDays - 1));

  const columns: WeekColumn[] = [];
  let cursor = start;
  for (let week = 0; week <= options.weeksBack; week++) {
    const column: (HeatmapCell | undefined)[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      if (compareCalendarDay(cursor, options.today) > 0) {
        column.push(undefined);
      } else {
        const date = toKey(cursor);
        const setCount = countByDate.get(date) ?? 0;
        column.push({ date, setCount, bucket: bucketFor(setCount, thresholds) });
      }
      cursor = addDays(cursor, 1);
    }
    columns.push(column);
  }
  return columns;
}
