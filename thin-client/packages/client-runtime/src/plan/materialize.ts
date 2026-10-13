import type {
  BlockId,
  EntryId,
  IntakeDraftPlan,
  PlanId,
  PlanSnapshot,
  PrescribedEntry,
  PrescribedSession,
  PrescribedSet,
  SessionId,
  SetId,
} from "@repcoach/contracts";

import type { ExerciseCatalogEntry, PlanAuthoringContext } from "./operations.ts";

/**
 * Materializing an accepted Intake draft into a real Plan (#75, ADR 0014 §6).
 *
 * Accept is the ONE place a Proposal mutates the Plan (ADR 0008), and at cold
 * start what it mutates it into is the whole drafted Plan rather than a diff —
 * §6's cold-start divergence. So this is a **replacement**, not a merge: the
 * seeded demo Plan is gone the moment a real one exists, and there is never an
 * ambiguity about which Plan is the user's.
 *
 * Pure, and shared by both `Store` layers exactly as `applyPlanOperation` is,
 * so the in-memory store and SQLite cannot disagree about what acceptance
 * means. Ids are minted through an injected `newId` because `IntakeDraftPlan`
 * carries none — the agent never sets machine fields (ADR 0011 §6) — and
 * injecting it keeps this function deterministic under test.
 */

export interface MaterializeDraftPlanResult {
  readonly plan: PlanSnapshot;
  /**
   * Every drafted `exerciseId` with no existing `exercise_catalog` row,
   * de-duplicated (first occurrence's `exerciseName`/`trackedMetrics` wins),
   * in draft order — the Exercise catalog is coach-authored (CONTEXT
   * `Exercise catalog`), so a name Intake invents is a new catalog Exercise,
   * not a refused Accept. The caller writes these rows alongside the Plan
   * itself.
   */
  readonly newCatalogEntries: ReadonlyArray<ExerciseCatalogEntry>;
}

export interface MaterializeDraftPlanOptions {
  /** The Plan row the drafted sessions replace the contents of — its id is preserved. */
  readonly planId: PlanId;
  readonly context: PlanAuthoringContext;
  /** Mints one fresh Session/Block/Entry/Set id per call. */
  readonly newId: () => string;
}

export const materializeDraftPlan = (
  draft: IntakeDraftPlan,
  options: MaterializeDraftPlanOptions,
): MaterializeDraftPlanResult => {
  const { planId, context, newId } = options;

  // `exerciseId` is the join to the catalog, and Intake is free to name an
  // Exercise the catalog does not have yet — that is the coach authoring a
  // new one (CONTEXT `Exercise catalog`), not an error. Each such id is
  // collected once, keyed by its FIRST occurrence's `exerciseName`/
  // `trackedMetrics`, and folded into `catalog` so the rest of THIS
  // materialization sees it exactly as if it had already existed.
  const catalog = new Map(context.exercises.map((exercise) => [exercise.id, exercise]));
  const newCatalogEntries: Array<ExerciseCatalogEntry> = [];
  for (const session of draft.sessions) {
    for (const entry of session.entries) {
      if (catalog.has(entry.exerciseId)) continue;
      const newEntry: ExerciseCatalogEntry = {
        id: entry.exerciseId,
        name: entry.exerciseName,
        ...(entry.trackedMetrics === undefined ? {} : { trackedMetrics: entry.trackedMetrics }),
      };
      newCatalogEntries.push(newEntry);
      catalog.set(newEntry.id, newEntry);
    }
  }

  const sessions = draft.sessions.map((draftSession): PrescribedSession => {
    const entries = draftSession.entries.map((draftEntry): PrescribedEntry => {
      const catalogEntry = catalog.get(draftEntry.exerciseId);
      // The catalog is canonical for `trackedMetrics` (CONTEXT `Exercise
      // catalog`: "a set row renders exactly the metrics the catalog
      // declares"); the drafted list is only a fallback for a catalog row that
      // declares none.
      const trackedMetrics = catalogEntry?.trackedMetrics ?? draftEntry.trackedMetrics;
      const sets = draftEntry.sets.map(
        (draftSet): PrescribedSet => ({
          id: newId() as unknown as SetId,
          setType: draftSet.setType,
          // Copied verbatim — intervals, one-sided bounds and an open `rpe: {}`
          // included. The sweep governs the justification, never the
          // prescription (ADR 0014 §5), and that has to hold all the way to
          // the database.
          target: draftSet.target,
          ...(draftSet.restSec === undefined ? {} : { restSec: draftSet.restSec }),
        }),
      );
      return {
        id: newId() as unknown as EntryId,
        exerciseId: draftEntry.exerciseId,
        sets,
        ...(trackedMetrics === undefined ? {} : { trackedMetrics }),
      };
    });

    // `IntakeDraftPlan` has no Block layer, but the Scaffold requires one (ADR
    // 0001): each drafted session's entries become a single `straight` Block.
    // A plain straight Block is a real node, never hidden at the schema level.
    // An entry-less drafted session gets no Block at all rather than an empty
    // one — the same shape `deleteEntry` collapses to (`operations.ts`).
    return {
      id: newId() as unknown as SessionId,
      name: draftSession.label,
      blocks:
        entries.length === 0
          ? []
          : [{ id: newId() as unknown as BlockId, format: "straight", entries }],
    };
  });

  return {
    plan: { id: planId, planModel: draft.planModel, sessions },
    newCatalogEntries,
  };
};
