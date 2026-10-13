import { useMemo } from "react";

import { Plan as PlanRuntime } from "@repcoach/client-runtime";
import type { Proposal } from "@repcoach/contracts";

import { useExerciseCatalog } from "./useExerciseCatalog.ts";
import { planOf, usePlan } from "./usePlan.ts";
import { useWeightUnit } from "./weightUnit.ts";

/**
 * What accepting this Proposal would do to the Plan, as a diff (#86).
 *
 * The card gets to show the *change*, not just the coach's account of it,
 * because a Proposal now carries the ADR 0015 operations Accept applies. The
 * preview and the effect are one computation — the operations are folded here
 * by the same pure applier the server folds them with — so the card cannot
 * promise something acceptance would not do, and a Proposal that no longer
 * applies is visible as such *before* the tap rather than as an error after it.
 *
 * Rides the live Plan subscription, so a Proposal drafted before the user
 * edited the Plan re-diffs against what is standing now.
 */
export type ProposedChangeState =
  /** This Proposal proposes no Plan change (an Observation-shaped finding, or the Intake whole-Plan payload). */
  | { readonly status: "none" }
  /** The Plan has not arrived yet, so there is nothing to diff against. */
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly lines: ReadonlyArray<PlanRuntime.PlanDiffLine> }
  /**
   * The operations do not apply to the Plan as it now stands. Accepting will
   * be refused server-side and change nothing, and the card says so rather
   * than offering a button that cannot work.
   */
  | { readonly status: "rejected"; readonly reason: string };

export function useProposedChange(proposal: Proposal | undefined): ProposedChangeState {
  const planState = usePlan();
  // The catalog supplies the exercise NAMES the diff reads in ("Back Squat",
  // not "exercise-back-squat"). Only fetched when there is a change to render.
  const catalog = useExerciseCatalog(proposal?.planOperations !== undefined);
  const weightUnit = useWeightUnit();

  const plan = planOf(planState);
  const operations = proposal?.planOperations;
  const catalogExercises = proposal?.catalogExercises;

  return useMemo((): ProposedChangeState => {
    if (operations === undefined) return { status: "none" };
    if (plan === undefined) return { status: "loading" };
    // The Exercises this Proposal introduces (ADR 0016), folded in exactly as
    // the server folds them at Accept. Without this the preview diverges from
    // the effect in the worst direction: `addEntry` refuses an id with no
    // catalog row, so a Proposal that would accept cleanly would render here
    // as "cannot apply" — and the new exercise would show as a raw id in the
    // diff even if it did.
    const context = PlanRuntime.foldProposedExercises(
      { exercises: catalog.state.status === "ready" ? catalog.state.exercises : [] },
      catalogExercises,
    ).context;
    const result = PlanRuntime.applyPlanOperations(plan, operations, context);
    if (!result.ok) {
      return {
        status: "rejected",
        reason: `${result.reason} (${result.operation}, operation ${result.index + 1} of ${operations.length})`,
      };
    }
    return { status: "ready", lines: PlanRuntime.diffPlans(plan, result.plan, context, weightUnit) };
  }, [operations, catalogExercises, plan, catalog, weightUnit]);
}
