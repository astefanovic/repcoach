import type { PrescribedTargetInterval } from "@repcoach/contracts";

/**
 * Display units for load (kg / lb).
 *
 * **Kilograms are the only unit anything is stored in.** Every Plan target,
 * every logged actual, every number the coach reads or writes is kg, exactly
 * as it was before this module existed. A pound is a *presentation*: the
 * number on screen is converted from kg as it is drawn, and a number typed in
 * is converted back to kg before it goes anywhere. So switching the setting
 * rewrites nothing, and two devices on different settings agree on every fact.
 *
 * Rounding is where this can go wrong, so it is decided once, here:
 *
 * - **Shown** loads are rounded to 0.1 of the display unit, with a trailing
 *   `.0` dropped. A 60 kg prescription reads `132.3` lb, not `132.27735…`.
 * - **Stored** loads converted from lb are rounded to 3 decimal kg — fine
 *   enough that 135 lb reads back as exactly `135` (61.235 kg → 135.0007 lb →
 *   `135`), coarse enough that the Log does not fill with float noise.
 */
export type WeightUnit = "kg" | "lb";

export const WEIGHT_UNITS: ReadonlyArray<WeightUnit> = ["kg", "lb"];

/** Exact by definition (the international avoirdupois pound). */
export const KG_PER_LB = 0.45359237;

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** A stored kg value in the display unit, rounded for the screen. */
export function kgToDisplay(kg: number, unit: WeightUnit): number {
  return unit === "kg" ? round(kg, 2) : round(kg / KG_PER_LB, 1);
}

/** A typed value in the display unit, as the kg that gets stored. */
export function displayToKg(value: number, unit: WeightUnit): number {
  return unit === "kg" ? value : round(value * KG_PER_LB, 3);
}

/**
 * How far one tap of a load stepper moves, in the display unit: 2.5 kg (the
 * smallest common pair of plates) or 5 lb (two 2.5 lb plates). Plan authoring
 * and Logging share it, for the reason `METRIC_UI` gives.
 */
export function loadStep(unit: WeightUnit): number {
  return unit === "kg" ? 2.5 : 5;
}

/**
 * One stepper tap on a load, in the display unit, snapped to the step grid
 * when the unit is lb.
 *
 * In kg the grid is where prescriptions already live, so this is plain
 * addition — what the steppers always did. In lb almost every value starts
 * off-grid (80 kg is 176.4 lb), and adding 5 to that walks through numbers no
 * barbell can be loaded to. Snapping lands the first tap on the nearest
 * plate-able number in the direction pressed (176.4 → 180, or → 175).
 */
export function nudgeDisplayLoad(current: number, delta: number, unit: WeightUnit): number {
  if (unit === "kg") return Math.max(0, round(current + delta, 2));
  const step = Math.abs(delta);
  const units = current / step;
  const next =
    delta > 0 ? (Math.floor(units + 1e-9) + 1) * step : (Math.ceil(units - 1e-9) - 1) * step;
  return Math.max(0, round(next, 1));
}

/** A prescribed load interval, bounds converted for display. An open `{}` stays open. */
export function intervalToDisplay(
  interval: PrescribedTargetInterval,
  unit: WeightUnit,
): PrescribedTargetInterval {
  if (unit === "kg") return interval;
  return {
    ...(interval.min !== undefined ? { min: kgToDisplay(interval.min, unit) } : {}),
    ...(interval.max !== undefined ? { max: kgToDisplay(interval.max, unit) } : {}),
  };
}

/** `82.5 kg` / `180 lb` — a stored kg value as a person would read it. */
export function formatLoad(kg: number, unit: WeightUnit): string {
  return `${kgToDisplay(kg, unit)} ${unit}`;
}
