import type { BodyweightEntry } from "@repcoach/contracts";

/**
 * The bodyweight trend: an exponentially smoothed moving average over daily
 * readings — the "Hacker's Diet" trend line — so a salty dinner reads as the
 * noise it is and a real change still shows within a week or two.
 *
 * Smoothing is per **day**, not per reading: a reading after a four-day gap
 * moves the trend as far as four days of readings would have, so weighing in
 * irregularly does not slow the line down.
 */
export const TREND_SMOOTHING = 0.1;

export interface BodyweightPoint {
  readonly date: string;
  readonly weightKg: number;
  readonly trendKg: number;
}

const dayNumber = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

export function bodyweightTrend(entries: ReadonlyArray<BodyweightEntry>): ReadonlyArray<BodyweightPoint> {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const points: Array<BodyweightPoint> = [];
  let trend: number | undefined;
  let lastDay: number | undefined;
  for (const entry of sorted) {
    const day = dayNumber(entry.date);
    if (trend === undefined || lastDay === undefined) {
      trend = entry.weightKg;
    } else {
      const gap = Math.max(1, day - lastDay);
      const alpha = 1 - (1 - TREND_SMOOTHING) ** gap;
      trend = trend + alpha * (entry.weightKg - trend);
    }
    lastDay = day;
    points.push({ date: entry.date, weightKg: entry.weightKg, trendKg: trend });
  }
  return points;
}

/**
 * How far the trend has moved over the last `days` days: the latest trend
 * minus the trend at the last reading at least `days` before it. `undefined`
 * when the log does not reach back that far — a two-day-old log has no
 * "30-day change", and inventing one from what is there would overstate it.
 */
export function trendChange(points: ReadonlyArray<BodyweightPoint>, days: number): number | undefined {
  const latest = points[points.length - 1];
  if (latest === undefined) return undefined;
  const cutoff = dayNumber(latest.date) - days;
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]!;
    if (dayNumber(point.date) <= cutoff) return latest.trendKg - point.trendKg;
  }
  return undefined;
}

/** A device-local calendar day as `YYYY-MM-DD`, for keying today's reading. */
export function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
