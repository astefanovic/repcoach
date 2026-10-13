import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/**
 * "Stats" (issue #117) — the aggregate read behind the consistency heatmap.
 * There is no per-user timezone setting anywhere in this app (`Today.tsx`,
 * `History.tsx` all format dates with the browser's own locale), and
 * `applied_at` is written server-side as `new Date().toISOString()` (UTC) —
 * the server itself has no timezone. So the caller supplies its own local
 * UTC offset, in the conventional east-of-UTC-positive sign (what JS's
 * `-date.getTimezoneOffset()` yields), and the day-bucketing happens against
 * that: a set logged at 23:50 local must land on that local day, not the UTC
 * day it may have already rolled into.
 */
export const GetDailySetCountsInput = Schema.Struct({
  utcOffsetMinutes: Schema.Int,
});
export type GetDailySetCountsInput = typeof GetDailySetCountsInput.Type;

/** One calendar day's worth of sets logged, local to the caller's offset. */
export const DailySetCount = Schema.Struct({
  /** Local calendar day, `YYYY-MM-DD`. */
  date: Schema.String,
  setCount: NonNegativeInt,
});
export type DailySetCount = typeof DailySetCount.Type;

/**
 * Sparse — only days with at least one logged set appear. `cancelled`
 * sessions (#114) are excluded; `active`/`finished` both count, since a set
 * logged today during a still-open session is still today's training.
 */
export const GetDailySetCountsResult = Schema.Struct({
  days: Schema.Array(DailySetCount),
});
export type GetDailySetCountsResult = typeof GetDailySetCountsResult.Type;
