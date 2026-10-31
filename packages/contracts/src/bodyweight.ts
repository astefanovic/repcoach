import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

/**
 * Bodyweight — one reading per local calendar day, in kg (the Progress
 * surface's "bodyweight trend", ui-surfaces.md).
 *
 * **One per day, and a second reading replaces the first.** Morning weight is
 * the convention every trend method assumes, and a day with two readings
 * would otherwise be averaged with itself or double-weighted in the trend;
 * the person who weighs twice almost always means "that first one was with
 * shoes on". So the day is the key, and logging is an upsert.
 *
 * `date` is the caller's local calendar day (`YYYY-MM-DD`), minted on the
 * device for the same reason `stats.getDailySetCounts` takes the caller's
 * offset: the server has no timezone, and a 07:00 weigh-in must land on the
 * day it was taken. Stored kg, like every load (`Units`): the display unit
 * converts it.
 */
const LocalDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

export const BodyweightEntry = Schema.Struct({
  date: LocalDate,
  weightKg: Schema.Number.check(Schema.isGreaterThan(0)),
  recordedAt: IsoDateTime,
});
export type BodyweightEntry = typeof BodyweightEntry.Type;

export const LogBodyweightInput = Schema.Struct({
  date: LocalDate,
  weightKg: Schema.Number.check(Schema.isGreaterThan(0)),
});
export type LogBodyweightInput = typeof LogBodyweightInput.Type;

export const RemoveBodyweightInput = Schema.Struct({
  date: LocalDate,
});
export type RemoveBodyweightInput = typeof RemoveBodyweightInput.Type;

/** Oldest first. No error channel: an empty log is a valid answer. */
export const ListBodyweightResult = Schema.Struct({
  entries: Schema.Array(BodyweightEntry),
});
export type ListBodyweightResult = typeof ListBodyweightResult.Type;
