import type { Units } from "@repcoach/client-runtime";

import { devicePreference } from "./devicePreference.ts";

/**
 * Which unit loads are SHOWN in (kg / lb) — a per-device display preference,
 * deliberately `localStorage` rather than a server-persisted Setting.
 *
 * Every stored load stays kg whatever this says (`Units` in
 * `@repcoach/client-runtime`), so the choice is pure presentation: nothing
 * the coach reads, and nothing another device shows, changes with it. That is
 * the same line `restNotifyPreference.ts` draws — a fact about how this
 * screen draws, not a fact about the training — and it means the setting
 * works offline and needs no migration.
 */
const weightUnit = devicePreference<Units.WeightUnit>({
  key: "repcoach.weightUnit",
  fallback: "kg",
  parse: (stored) => (stored === "lb" || stored === "kg" ? stored : undefined),
  serialize: (unit) => unit,
});

/** The unit loads are shown in on this device. Defaults to kg. */
export const useWeightUnit = weightUnit.use;
export const setWeightUnit = weightUnit.set;
