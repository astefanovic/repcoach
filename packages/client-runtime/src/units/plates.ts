import type { WeightUnit } from "./weight.ts";

/**
 * The plate calculator: which plates go on each side of the bar to make a
 * load. Pure arithmetic in the **display unit** — a lb user's bar is 45 and
 * their plates are 45/35/25/10/5/2.5, and converting those to kg and back
 * would only manufacture rounding errors on numbers that are exact in the
 * unit the user owns.
 *
 * Plates are assumed to come in unlimited pairs. That is true of every gym
 * and close enough for a home rack that a missing pair shows up as a
 * shortfall the user can see, rather than as a config screen they must fill.
 */
export interface PlateSetup {
  /** What the empty bar weighs. */
  readonly bar: number;
  /** The plate sizes on hand, any order. */
  readonly plates: ReadonlyArray<number>;
}

export const DEFAULT_PLATE_SETUP: Readonly<Record<WeightUnit, PlateSetup>> = {
  kg: { bar: 20, plates: [25, 20, 15, 10, 5, 2.5, 1.25] },
  lb: { bar: 45, plates: [45, 35, 25, 10, 5, 2.5] },
};

export type PlateLoadout =
  /** The target is at or below the empty bar: there is nothing to load. */
  | { readonly kind: "bar-only"; readonly bar: number }
  | {
      readonly kind: "plates";
      /** Heaviest first, one side's worth. */
      readonly perSide: ReadonlyArray<number>;
      /** What the bar will actually weigh loaded this way. */
      readonly total: number;
      /** `target − total`: how far short the nearest loadable weight falls. 0 when exact. */
      readonly shortBy: number;
    };

const EPSILON = 1e-6;
const tidy = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Greedy, heaviest plate first. For the plate sizes people actually own
 * (each one at least half the next), greedy is optimal; for an odd set it can
 * fall short of a loadable total, and says so in `shortBy` rather than
 * pretending.
 */
export function loadPlates(target: number, setup: PlateSetup): PlateLoadout {
  if (target <= setup.bar + EPSILON) return { kind: "bar-only", bar: setup.bar };
  const sizes = [...new Set(setup.plates.filter((plate) => plate > 0))].sort((a, b) => b - a);
  let remaining = (target - setup.bar) / 2;
  const perSide: Array<number> = [];
  for (const plate of sizes) {
    while (remaining + EPSILON >= plate) {
      perSide.push(plate);
      remaining -= plate;
    }
  }
  const total = tidy(setup.bar + 2 * perSide.reduce((sum, plate) => sum + plate, 0));
  return { kind: "plates", perSide, total, shortBy: tidy(target - total) };
}

/** `20 + 10 + 2.5` — one side's plates as a person would call them out. Repeats are spelled `2 × 20`. */
export function formatPerSide(perSide: ReadonlyArray<number>): string {
  const counts: Array<{ plate: number; count: number }> = [];
  for (const plate of perSide) {
    const last = counts[counts.length - 1];
    if (last !== undefined && last.plate === plate) last.count += 1;
    else counts.push({ plate, count: 1 });
  }
  return counts.map(({ plate, count }) => (count === 1 ? `${plate}` : `${count} × ${plate}`)).join(" + ");
}

/**
 * Parses a typed plate list (`25, 20, 15, 10, 5, 2.5`). Separated by commas,
 * semicolons or spaces; when the list is separated by spaces or semicolons,
 * a comma inside a number is read as the decimal mark (`20 10 2,5`).
 * Non-numbers and non-positive values are dropped.
 */
export function parsePlateList(text: string): ReadonlyArray<number> {
  const spaced = /[\s;]/.test(text.trim());
  const tokens = spaced ? text.split(/[\s;]+|,(?=\s)/) : text.split(",");
  return tokens
    .map((token) => Number(token.trim().replace(",", ".")))
    .filter((value) => Number.isFinite(value) && value > 0);
}
