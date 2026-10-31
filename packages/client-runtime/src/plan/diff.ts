import type { PlanSnapshot, PrescribedEntry, PrescribedSession } from "@repcoach/contracts";

import type { WeightUnit } from "../units/weight.ts";
import { formatSetRun } from "./format.ts";
import { emptyAuthoringContext, type PlanAuthoringContext } from "./operations.ts";
import { coalesceSetRuns } from "./runs.ts";
import { planSessionTitle } from "./summary.ts";

/**
 * What a coach Proposal actually does to the Plan, as the card renders it
 * (#86): a **diff against the standing Plan**, not a restatement of the
 * coach's prose.
 *
 * The prose and the operations are two different things, and the whole point
 * of #86 is that the second one is what Accept applies. So the card must show
 * the second one. Rendering the operations' own summaries would be closer, but
 * still not the diff — `replaceEntrySets` says "Set Back Squat to 2 × 5 @
 * 102.5 kg" and says nothing about what it was before, which is exactly the
 * comparison the user is being asked to make.
 *
 * Computed by diffing two whole snapshots rather than by interpreting the
 * operations one at a time. That is deliberate: the operations are coarse and
 * whole-value, several of them can touch the same Entry, and a sequence's *net*
 * effect is the only thing the user is agreeing to. Diffing before-and-after
 * cannot drift from what acceptance does, because the "after" snapshot IS the
 * one the shared applier produced.
 */

/** One line of the diff, at the granularity a person reads a Plan in. */
export interface PlanDiffLine {
  readonly kind: "added" | "removed" | "changed";
  /** Where it happened — a Session title, or "Session · Exercise". */
  readonly subject: string;
  /** How it reads now. Absent for something newly added. */
  readonly before?: string;
  /** How it would read. Absent for something removed. */
  readonly after?: string;
}

const entryLabel = (context: PlanAuthoringContext, entry: PrescribedEntry): string =>
  context.exercises.find((exercise) => exercise.id === entry.exerciseId)?.name ?? entry.exerciseId;

/** An Entry's prescription as one sentence — the same run vocabulary the Plan view reads in. */
const entryPrescription = (entry: PrescribedEntry, weightUnit: WeightUnit): string => {
  const runs = coalesceSetRuns(entry.sets);
  return runs.length === 0 ? "no sets" : runs.map((run) => formatSetRun(run, weightUnit)).join(", then ");
};

interface LocatedEntry {
  readonly session: PrescribedSession;
  readonly sessionTitle: string;
  readonly entry: PrescribedEntry;
}

const indexEntries = (plan: PlanSnapshot): Map<string, LocatedEntry> => {
  const index = new Map<string, LocatedEntry>();
  plan.sessions.forEach((session, position) => {
    const sessionTitle = planSessionTitle(session, position);
    for (const block of session.blocks) {
      for (const entry of block.entries) {
        index.set(entry.id as string, { session, sessionTitle, entry });
      }
    }
  });
  return index;
};

/**
 * The diff, ordered as the Plan is: Session-level changes first, then the
 * Entry-level ones under them. An empty result means the two snapshots are the
 * same Plan — which is a real answer, and one the card states plainly rather
 * than leaving the block blank.
 *
 * Scoped to structure and prescription. It does not report a reorder that moves
 * nothing else, because "these are in a different order" is not something the
 * line format can say honestly and a Proposal that only reorders is not a case
 * that exists yet; when one does, it earns its own line rather than a
 * misleading one here.
 */
export function diffPlans(
  before: PlanSnapshot,
  after: PlanSnapshot,
  context: PlanAuthoringContext = emptyAuthoringContext,
  /** Loads are compared in kg and only *rendered* in this unit. */
  weightUnit: WeightUnit = "kg",
): ReadonlyArray<PlanDiffLine> {
  const lines: Array<PlanDiffLine> = [];

  const beforeSessions = new Map(before.sessions.map((session) => [session.id as string, session]));
  const afterSessions = new Map(after.sessions.map((session) => [session.id as string, session]));

  after.sessions.forEach((session, position) => {
    const previous = beforeSessions.get(session.id as string);
    if (previous === undefined) {
      lines.push({ kind: "added", subject: planSessionTitle(session, position), after: "new session" });
      return;
    }
    if (previous.name !== session.name) {
      lines.push({
        kind: "changed",
        subject: planSessionTitle(session, position),
        before: previous.name ?? "(unnamed)",
        after: session.name ?? "(unnamed)",
      });
    }
  });
  before.sessions.forEach((session, position) => {
    if (!afterSessions.has(session.id as string)) {
      lines.push({
        kind: "removed",
        subject: planSessionTitle(session, position),
        before: "removed, with everything under it",
      });
    }
  });

  const beforeEntries = indexEntries(before);
  const afterEntries = indexEntries(after);

  for (const [entryId, located] of afterEntries) {
    const previous = beforeEntries.get(entryId);
    const subject = `${located.sessionTitle} · ${entryLabel(context, located.entry)}`;
    if (previous === undefined) {
      lines.push({ kind: "added", subject, after: entryPrescription(located.entry, weightUnit) });
      continue;
    }
    if (previous.entry.exerciseId !== located.entry.exerciseId) {
      lines.push({
        kind: "changed",
        subject: located.sessionTitle,
        before: entryLabel(context, previous.entry),
        after: entryLabel(context, located.entry),
      });
    }
    const from = entryPrescription(previous.entry, weightUnit);
    const to = entryPrescription(located.entry, weightUnit);
    if (from !== to) {
      lines.push({ kind: "changed", subject, before: from, after: to });
    }
  }
  for (const [entryId, located] of beforeEntries) {
    if (afterEntries.has(entryId)) continue;
    // A Session that went away already has its own line; listing each Entry
    // under it again would report one deletion as many.
    if (!afterSessions.has(located.session.id as string)) continue;
    lines.push({
      kind: "removed",
      subject: `${located.sessionTitle} · ${entryLabel(context, located.entry)}`,
      before: entryPrescription(located.entry, weightUnit),
    });
  }

  return lines;
}
