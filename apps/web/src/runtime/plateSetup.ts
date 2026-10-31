import { Units } from "@repcoach/client-runtime";

import { devicePreference } from "./devicePreference.ts";

/**
 * The bar and plates the plate calculator loads from — per device and per
 * unit. A lb user owns a 45 lb bar and 45/35/25/10/5/2.5 plates, a kg user a
 * 20 kg bar and 25…1.25 plates, and a user who switches units mid-life owns
 * whichever set of iron is in their gym, so each unit keeps its own setup and
 * neither is converted into the other.
 *
 * Device-local for the same reason the unit is (`weightUnit.ts`): the coach
 * never reads it, and the calculator must work in a dead spot.
 */
type PlateSetups = Readonly<Record<Units.WeightUnit, Units.PlateSetup>>;

const isSetup = (value: unknown): value is Units.PlateSetup =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Units.PlateSetup).bar === "number" &&
  Array.isArray((value as Units.PlateSetup).plates) &&
  (value as Units.PlateSetup).plates.every((plate) => typeof plate === "number");

const plateSetups = devicePreference<PlateSetups>({
  key: "repcoach.plateSetup",
  fallback: Units.DEFAULT_PLATE_SETUP,
  parse: (stored) => {
    try {
      const parsed = JSON.parse(stored) as Partial<Record<Units.WeightUnit, unknown>>;
      return {
        kg: isSetup(parsed.kg) ? parsed.kg : Units.DEFAULT_PLATE_SETUP.kg,
        lb: isSetup(parsed.lb) ? parsed.lb : Units.DEFAULT_PLATE_SETUP.lb,
      };
    } catch {
      return undefined;
    }
  },
  serialize: (setups) => JSON.stringify(setups),
});

/** The setup for `unit` on this device. */
export function usePlateSetup(unit: Units.WeightUnit): Units.PlateSetup {
  return plateSetups.use()[unit];
}

export function setPlateSetup(unit: Units.WeightUnit, setup: Units.PlateSetup): void {
  plateSetups.set({ ...plateSetups.get(), [unit]: setup });
}
