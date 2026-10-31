import type { IntakeTurn, StartIntakeInput } from "@repcoach/contracts";

/**
 * The Intake form (ADR 0014 §1) — its values, the gate on submit, the
 * collapsed one-line summary, and the "is there anything to lose" test the
 * abandonment confirm reads. Also the exchange's answer-submit gate, which is
 * the same shape of decision one screen later.
 *
 * All of it lives here rather than in the takeover's JSX because every line is
 * a decision the design settled and vitest runs with no DOM, so a decision
 * left in JSX is one no test can reach (#74).
 */

/** What §1 asks for, and nothing else: facts a model cannot guess. */
export interface IntakeFormValues {
  readonly goal: string;
  readonly daysPerWeek: number;
  /** A multi-select — "dumbbells and a rack" has to be expressible. */
  readonly equipment: ReadonlyArray<string>;
  /** §1's only heavy field, and the only skippable one. */
  readonly lifts: string;
}

/** The equipment chips. Copy, so it lives client-side (ADR 0014 §4's rule for the activity line, same reason). */
export const INTAKE_EQUIPMENT: ReadonlyArray<string> = [
  "Full gym",
  "Dumbbells",
  "Barbell + rack",
  "Machines",
  "Bodyweight only",
] as const;

/** The days-a-week chips. */
export const INTAKE_DAYS_PER_WEEK: ReadonlyArray<number> = [2, 3, 4, 5, 6] as const;

/** What a cold user actually opens Intake on. There is no seeded form in the shipped surface. */
export const emptyIntakeForm: IntakeFormValues = {
  goal: "",
  daysPerWeek: 4,
  equipment: [],
  lifts: "",
};

/**
 * §1: submit is gated on the goal and days **only**. Equipment and lifts are
 * visibly optional, because "I haven't been training" is a common and honest
 * answer and the surface whose pitch is "the coach does the thinking" must not
 * open by making the user think.
 */
export function isIntakeFormReady(values: IntakeFormValues): boolean {
  return values.goal.trim().length > 0 && values.daysPerWeek > 0;
}

/** Toggling one equipment chip, preserving selection order. */
export function toggleEquipment(
  values: IntakeFormValues,
  item: string,
): IntakeFormValues {
  return {
    ...values,
    equipment: values.equipment.includes(item)
      ? values.equipment.filter((each) => each !== item)
      : [...values.equipment, item],
  };
}

/**
 * §4's pinned one-line summary. The form **collapses into this** — it is not a
 * caption added above the draft — and it stays for the rest of the takeover as
 * the thing the plan is answering to, so an unanswered field has to read as an
 * explicit "you didn't say" rather than as a gap.
 *
 * The **goal leads**, because it is the one field §5/§6 make load-bearing —
 * "the plan is answering to" is answering to the goal first and the constraints
 * second, and a summary that opened on "4 days" left the vague goal the surface
 * insisted on accepting nowhere on screen for the rest of the takeover.
 *
 * Joined with `·` and not `+`, because two of the equipment chips are
 * themselves "X + Y" and the summary turns to soup the moment they are joined
 * with the same glyph.
 */
export function summariseIntakeForm(values: IntakeFormValues): string {
  return [
    values.goal.trim(),
    `${values.daysPerWeek} days`,
    values.equipment.length > 0
      ? values.equipment.join(", ").toLowerCase()
      : "equipment unstated",
    values.lifts.trim().length > 0 ? values.lifts.trim() : "no current lifts given",
  ].join(" · ");
}

/**
 * §8: the abandonment confirm fires only when there is something to lose, and
 * "untouched" means **unchanged since the screen opened** — not "equal to an
 * empty form". Comparing against a constant would make every exit confirm and
 * quietly delete the free-and-silent half of the rule.
 */
export function isIntakeFormDirty(
  values: IntakeFormValues,
  initial: IntakeFormValues,
): boolean {
  return (
    values.goal !== initial.goal ||
    values.daysPerWeek !== initial.daysPerWeek ||
    values.lifts !== initial.lifts ||
    values.equipment.length !== initial.equipment.length ||
    values.equipment.some((item, index) => item !== initial.equipment[index])
  );
}

/**
 * §8's full abandonment test — "is there anything to lose" — is wider than the
 * form: once a cold draft has landed, `turn` is defined and every exit loses a
 * running coach session and its ledger, whether or not any form FIELD was ever
 * touched again. `isIntakeFormDirty` alone answers only the first phase's half
 * of that question; this is the one the takeover's "Leave" affordance actually
 * needs.
 */
export function isIntakeTakeoverDirty(
  turn: IntakeTurn | undefined,
  values: IntakeFormValues,
  initial: IntakeFormValues,
): boolean {
  return turn !== undefined || isIntakeFormDirty(values, initial);
}

/** §2: an exchange answer is submittable exactly when it is not blank once trimmed. */
export function isIntakeAnswerSubmittable(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * The form as the RPC takes it. `lifts` is omitted rather than sent blank —
 * the field is optional on the contract precisely so "I haven't been training"
 * travels as an absence the coach can read, not as an empty string it has to
 * interpret.
 */
export function toStartIntakeInput(values: IntakeFormValues): StartIntakeInput {
  const lifts = values.lifts.trim();
  return {
    goal: values.goal.trim(),
    daysPerWeek: values.daysPerWeek,
    equipment: values.equipment,
    ...(lifts.length > 0 ? { lifts } : {}),
  };
}
