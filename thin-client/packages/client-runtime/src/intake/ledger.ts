import type { IntakeDraftPlan, IntakeDraftSession, IntakeTurn } from "@repcoach/contracts";

import { formatDraftSets } from "./draft.ts";

/**
 * The revision ledger (#64's central finding, written up in `ui-surfaces.md`).
 *
 * An answered turn does **not** become a message. It collapses into one line
 * saying what the answer did to the *plan*, with the user's own words kept
 * underneath it, subordinate. That inversion is the entire not-a-chat argument:
 * a thread is a record of speech, this is a record of edits.
 *
 * The prototype could hand-write those lines because its turns were canned. A
 * real `IntakeTurn` carries the draft it produced and nothing about how it
 * differs from the last one — so the ledger line is **derived here** by diffing
 * consecutive drafts. That derivation is the reason this module exists: get it
 * wrong in JSX and the surface silently degrades into a transcript with extra
 * steps.
 */

/** One answered turn: what the user sent, and the coach turn it produced. */
export interface AnsweredIntakeTurn {
  readonly answer: string;
  readonly turn: IntakeTurn;
}

/** One row of the folded history. */
export interface IntakeLedgerEntry {
  readonly revision: number;
  /** What changed about the plan — the row's headline. */
  readonly changed: string;
  /** What the user actually said — kept, quietly, beneath it. */
  readonly answer: string;
}

const sessionByLabel = (plan: IntakeDraftPlan): ReadonlyMap<string, IntakeDraftSession> =>
  new Map(plan.sessions.map((session) => [session.label, session]));

const entryByName = (session: IntakeDraftSession): ReadonlyMap<string, string> =>
  new Map(session.entries.map((entry) => [entry.exerciseName, formatDraftSets(entry)]));

/** The clauses one session contributes, or none when it is untouched. */
function describeSessionChange(
  before: IntakeDraftSession,
  after: IntakeDraftSession,
): string | undefined {
  const was = entryByName(before);
  const now = entryByName(after);

  const dropped = [...was.keys()].filter((name) => !now.has(name));
  const added = [...now.keys()].filter((name) => !was.has(name));
  const edited = [...now.keys()].filter((name) => was.has(name) && was.get(name) !== now.get(name));

  const parts: Array<string> = [];
  // A one-for-one swap is by far the commonest edit and the one that reads
  // worst as "+X, -Y", so it gets the arrow it deserves.
  if (dropped.length === 1 && added.length === 1) {
    parts.push(`${dropped[0]} → ${added[0]}`);
  } else {
    for (const name of added) parts.push(`${name} in`);
    for (const name of dropped) parts.push(`${name} out`);
  }
  for (const name of edited) parts.push(`${name} now ${now.get(name)!}`);

  return parts.length === 0 ? undefined : `${after.label}: ${parts.join(", ")}`;
}

/**
 * What the second draft changed about the first, as one sentence. Falls back to
 * a plain statement rather than an empty string when the drafts are identical —
 * a turn that changed nothing is a real outcome ("noted, no change"), and a
 * blank ledger row would read as a bug.
 */
export function describeDraftChange(before: IntakeDraftPlan, after: IntakeDraftPlan): string {
  const clauses: Array<string> = [];
  if (before.headline !== after.headline) {
    clauses.push(`Now “${after.headline}”`);
  }

  const was = sessionByLabel(before);
  const now = sessionByLabel(after);
  for (const label of now.keys()) {
    if (!was.has(label)) {
      clauses.push(`${label} added`);
      continue;
    }
    const change = describeSessionChange(was.get(label)!, now.get(label)!);
    if (change !== undefined) clauses.push(change);
  }
  for (const label of was.keys()) {
    if (!now.has(label)) clauses.push(`${label} dropped`);
  }

  if (clauses.length === 0) {
    return "Noted — the plan is unchanged.";
  }
  return clauses.join("; ");
}

/**
 * The ledger, newest first, derived from the cold draft and every answered turn
 * in order. Newest first because the collapsed header shows the most recent
 * line, and the most recent change is the one a user is checking.
 */
export function deriveIntakeLedger(
  coldDraft: IntakeTurn,
  answered: ReadonlyArray<AnsweredIntakeTurn>,
): ReadonlyArray<IntakeLedgerEntry> {
  const entries: Array<IntakeLedgerEntry> = [];
  let previous = coldDraft.draftPlan;
  for (const { answer, turn } of answered) {
    entries.push({
      revision: turn.revision,
      changed: describeDraftChange(previous, turn.draftPlan),
      answer,
    });
    previous = turn.draftPlan;
  }
  return entries.reverse();
}
