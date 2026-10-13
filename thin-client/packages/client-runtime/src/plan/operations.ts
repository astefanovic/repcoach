import type {
  BlockFormat,
  BlockId,
  EntryId,
  ExerciseId,
  MetricName,
  PlanOperation,
  PlanOperationRejectionCode,
  PlanOperationTag,
  PlanSnapshot,
  PrescribedBlock,
  PrescribedEntry,
  PrescribedSession,
  SessionId,
} from "@repcoach/contracts";

import { formatSetRun } from "./format.ts";
import { coalesceSetRuns } from "./runs.ts";

/**
 * The Plan-authoring seam (#71): one pure function that takes a
 * `PlanSnapshot` and a `PlanOperation` and returns the next snapshot plus
 * the human-readable Change summary the operation earns.
 *
 * It is pure and total on purpose. Both `Store` layers apply operations
 * through it, so the in-memory store and the SQLite store cannot drift; the
 * client calls the same function to validate an edit before sending it and
 * to render optimistically; and every structural rule that matters — a Block
 * of one collapses, grouping is by adjacency, an Entry carries its catalog
 * metrics — is stated once, here, rather than three times.
 */

/** What the operations need to know about the Exercise catalog: the name that goes in a summary, and the metrics a new Entry inherits. */
export interface ExerciseCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly trackedMetrics?: ReadonlyArray<MetricName>;
  /** The Exercise library row this exercise was picked from, if any — see `LibraryExerciseId`. */
  readonly libraryId?: string;
}

export interface PlanAuthoringContext {
  readonly exercises: ReadonlyArray<ExerciseCatalogEntry>;
}

export const emptyAuthoringContext: PlanAuthoringContext = { exercises: [] };

/**
 * Folds a Proposal's `catalogExercises` (ADR 0016) into the authoring context
 * its operations are validated against, and returns the rows that actually
 * have to be written.
 *
 * Both `Store` layers call this for the same reason they share
 * `applyPlanOperation` itself: accepting a Proposal that introduces an
 * Exercise must mean the same thing in SQLite and in memory. It runs BEFORE
 * the first write, so a Proposal whose operations turn out not to validate is
 * refused having created nothing — the "everything refusable happens before
 * the first write" discipline `resolveProposal` already keeps.
 *
 * An id the catalog already holds is skipped rather than merged: the row is
 * idempotent on its id (`CreateExerciseInput`), and the standing row may carry
 * a name the user has since fixed or metadata a review has since enriched,
 * neither of which a Proposal drafted earlier should overwrite.
 */
export const foldProposedExercises = (
  context: PlanAuthoringContext,
  proposed: ReadonlyArray<{
    readonly exercise_id: string;
    readonly name: string;
    readonly tracked_metrics?: ReadonlyArray<MetricName>;
  }> = [],
): {
  readonly context: PlanAuthoringContext;
  readonly newCatalogEntries: ReadonlyArray<ExerciseCatalogEntry>;
} => {
  const known = new Set(context.exercises.map((exercise) => exercise.id));
  const newCatalogEntries: Array<ExerciseCatalogEntry> = [];
  for (const exercise of proposed) {
    if (known.has(exercise.exercise_id)) continue;
    known.add(exercise.exercise_id);
    newCatalogEntries.push({
      id: exercise.exercise_id,
      name: exercise.name,
      ...(exercise.tracked_metrics === undefined ? {} : { trackedMetrics: exercise.tracked_metrics }),
    });
  }
  return {
    context:
      newCatalogEntries.length === 0
        ? context
        : { ...context, exercises: [...context.exercises, ...newCatalogEntries] },
    newCatalogEntries,
  };
};

export type ApplyPlanOperationResult =
  | {
      readonly ok: true;
      readonly plan: PlanSnapshot;
      readonly summary: string;
      /**
       * Set by the three ordering operations, naming the container whose
       * order they rewrote (`plan`, `session:<id>`, `block:<id>`). The store
       * marks the previous un-superseded ordering Change on the SAME
       * container `superseded`, so a run of five reorder taps leaves one live
       * Change and the coach reads the net intent rather than the
       * intermediate states (ADR 0008's existing `superseded` status — no new
       * vocabulary).
       */
      readonly orderingContainer?: string;
    }
  | {
      readonly ok: false;
      readonly code: PlanOperationRejectionCode;
      readonly reason: string;
    };

const reject = (
  code: PlanOperationRejectionCode,
  reason: string,
): ApplyPlanOperationResult => ({ ok: false, code, reason });

// --- locating things in the tree ------------------------------------------

interface EntryLocation {
  readonly session: PrescribedSession;
  readonly block: PrescribedBlock;
  readonly entry: PrescribedEntry;
}

const findSession = (plan: PlanSnapshot, sessionId: SessionId): PrescribedSession | undefined =>
  plan.sessions.find((session) => session.id === sessionId);

const findBlock = (
  plan: PlanSnapshot,
  blockId: BlockId,
): { readonly session: PrescribedSession; readonly block: PrescribedBlock } | undefined => {
  for (const session of plan.sessions) {
    const block = session.blocks.find((candidate) => candidate.id === blockId);
    if (block !== undefined) return { session, block };
  }
  return undefined;
};

const findEntry = (plan: PlanSnapshot, entryId: EntryId): EntryLocation | undefined => {
  for (const session of plan.sessions) {
    for (const block of session.blocks) {
      const entry = block.entries.find((candidate) => candidate.id === entryId);
      if (entry !== undefined) return { session, block, entry };
    }
  }
  return undefined;
};

const sessionLabel = (session: PrescribedSession | undefined, plan: PlanSnapshot): string => {
  if (session === undefined) return "the session";
  if (session.name !== undefined) return `"${session.name}"`;
  const index = plan.sessions.findIndex((candidate) => candidate.id === session.id);
  return `"Session ${index + 1}"`;
};

const BLOCK_LABEL: Record<BlockFormat, string> = {
  straight: "block",
  superset: "superset",
  circuit: "circuit",
  emom: "EMOM",
  amrap: "AMRAP",
};

const exerciseName = (context: PlanAuthoringContext, exerciseId: ExerciseId): string =>
  context.exercises.find((exercise) => exercise.id === exerciseId)?.name ?? exerciseId;

const entryName = (context: PlanAuthoringContext, entry: PrescribedEntry): string =>
  exerciseName(context, entry.exerciseId);

/** Same members, no duplicates, in some order — the bar every whole-list reorder has to clear. */
const isPermutation = (next: ReadonlyArray<string>, current: ReadonlyArray<string>): boolean => {
  if (next.length !== current.length) return false;
  if (new Set(next).size !== next.length) return false;
  const currentSet = new Set(current);
  return next.every((id) => currentSet.has(id));
};

// --- structural invariants -------------------------------------------------

/**
 * The two rules a Block has to obey once an Entry has been taken OUT of it
 * (#45): an empty Block is not a node, and **a grouped Block left holding
 * one Entry collapses back to a plain straight Block** — the Plan never
 * carries a superset of one. Stated once so `removeEntry` and
 * `moveEntryToBlock` cannot each get it slightly wrong.
 *
 * It applies only to those two operations. A one-Entry Block that the user
 * *deliberately* set to a grouped or timed format is a real prescription —
 * "three rounds of this one carry" — and `setBlockParams` must not undo the
 * thing it was just asked to do.
 */
const collapseAfterRemoval = (block: PrescribedBlock): PrescribedBlock | undefined => {
  if (block.entries.length === 0) return undefined;
  if (block.entries.length > 1 || block.format === "straight") return block;
  const { params: _dropped, ...rest } = block;
  return { ...rest, format: "straight" };
};

const collapseSessionAfterRemoval = (session: PrescribedSession): PrescribedSession => ({
  ...session,
  blocks: session.blocks
    .map(collapseAfterRemoval)
    .filter((block): block is PrescribedBlock => block !== undefined),
});

const replaceSession = (plan: PlanSnapshot, next: PrescribedSession): PlanSnapshot => ({
  ...plan,
  sessions: plan.sessions.map((session) => (session.id === next.id ? next : session)),
});

// --- the operations --------------------------------------------------------

/* eslint-disable complexity -- one exhaustive switch over the operation union is the point. */
export function applyPlanOperation(
  plan: PlanSnapshot,
  operation: PlanOperation,
  context: PlanAuthoringContext = emptyAuthoringContext,
): ApplyPlanOperationResult {
  switch (operation._tag) {
    case "createSession": {
      if (findSession(plan, operation.sessionId) !== undefined) {
        return reject("invalid", `A Prescribed Session with id ${operation.sessionId} already exists`);
      }
      const session: PrescribedSession = {
        id: operation.sessionId,
        name: operation.name,
        blocks: [],
      };
      return {
        ok: true,
        plan: { ...plan, sessions: [...plan.sessions, session] },
        summary: `Created "${operation.name}"`,
      };
    }

    case "renameSession": {
      const session = findSession(plan, operation.sessionId);
      if (session === undefined) {
        return reject("not-found", `No Prescribed Session ${operation.sessionId}`);
      }
      const previous = sessionLabel(session, plan);
      return {
        ok: true,
        plan: replaceSession(plan, { ...session, name: operation.name }),
        summary: `Renamed ${previous} → "${operation.name}"`,
      };
    }

    case "deleteSession": {
      const session = findSession(plan, operation.sessionId);
      if (session === undefined) {
        return reject("not-found", `No Prescribed Session ${operation.sessionId}`);
      }
      const label = sessionLabel(session, plan);
      return {
        ok: true,
        plan: {
          ...plan,
          sessions: plan.sessions.filter((candidate) => candidate.id !== operation.sessionId),
        },
        summary: `Deleted ${label}`,
      };
    }

    case "orderSessions": {
      const currentIds = plan.sessions.map((session) => session.id as string);
      if (!isPermutation(operation.sessionIds as ReadonlyArray<string>, currentIds)) {
        return reject(
          "invalid",
          "orderSessions must list exactly the Plan's current Sessions, each once",
        );
      }
      const byId = new Map(plan.sessions.map((session) => [session.id as string, session]));
      return {
        ok: true,
        plan: { ...plan, sessions: operation.sessionIds.map((id) => byId.get(id as string)!) },
        summary: "Reordered the Plan's sessions",
        orderingContainer: "plan",
      };
    }

    case "orderBlocks": {
      const session = findSession(plan, operation.sessionId);
      if (session === undefined) {
        return reject("not-found", `No Prescribed Session ${operation.sessionId}`);
      }
      const currentIds = session.blocks.map((block) => block.id as string);
      if (!isPermutation(operation.blockIds as ReadonlyArray<string>, currentIds)) {
        return reject(
          "invalid",
          "orderBlocks must list exactly that Session's current Blocks, each once",
        );
      }
      const byId = new Map(session.blocks.map((block) => [block.id as string, block]));
      return {
        ok: true,
        plan: replaceSession(plan, {
          ...session,
          blocks: operation.blockIds.map((id) => byId.get(id as string)!),
        }),
        summary: `Reordered ${sessionLabel(session, plan)}`,
        orderingContainer: `session:${operation.sessionId}`,
      };
    }

    case "addEntry": {
      const session = findSession(plan, operation.sessionId);
      if (session === undefined) {
        return reject("not-found", `No Prescribed Session ${operation.sessionId}`);
      }
      if (findEntry(plan, operation.entryId) !== undefined) {
        return reject("invalid", `An Entry with id ${operation.entryId} already exists`);
      }
      const catalogEntry = context.exercises.find(
        (exercise) => exercise.id === operation.exerciseId,
      );
      // The Entry's `exerciseId` is the join to the catalog, and a join to a
      // row that does not exist fails OPEN if it is not checked here: the
      // Entry applies, the UI renders the raw id where the name should be
      // (`exerciseName` below falls back to it), the logging grid gets no
      // tracked metrics, and every per-muscle analytic silently counts the
      // work as zero. Worse, the orphan is invisible to ADR 0016's enrichment
      // roster, which reads the catalog table — so nothing ever repairs it.
      //
      // Creating the row is a separate write on BOTH paths that legitimately
      // add an Exercise (CONTEXT `User-authored exercise`: "adding a new
      // exercise to a Session is two writes") — the user's own edit calls
      // `createExercise` first, and a coach Proposal names the row in
      // `catalogExercises`, which `foldProposedExercises` puts into this
      // context before these operations are applied. So by the time any real
      // caller reaches here, a legitimate id resolves; an unresolvable one is
      // a mistake worth refusing loudly.
      if (catalogEntry === undefined) {
        return reject(
          "not-found",
          `No catalog Exercise ${operation.exerciseId} — it must be created before an Entry can reference it (ADR 0016)`,
        );
      }
      const entry: PrescribedEntry = {
        id: operation.entryId,
        exerciseId: operation.exerciseId,
        sets: [],
        ...(catalogEntry.trackedMetrics === undefined
          ? {}
          : { trackedMetrics: catalogEntry.trackedMetrics }),
      };
      const name = exerciseName(context, operation.exerciseId);
      const existing = session.blocks.find((block) => block.id === operation.blockId);
      if (existing !== undefined) {
        // Joining an existing Block — how a circuit grows past two exercises.
        return {
          ok: true,
          plan: replaceSession(plan, {
            ...session,
            blocks: session.blocks.map((block) =>
              block.id === operation.blockId
                ? { ...block, entries: [...block.entries, entry] }
                : block,
            ),
          }),
          summary: `Added ${name} to the ${BLOCK_LABEL[existing.format]}`,
        };
      }
      if (findBlock(plan, operation.blockId) !== undefined) {
        return reject("invalid", `Block ${operation.blockId} belongs to a different Session`);
      }
      const block: PrescribedBlock = { id: operation.blockId, format: "straight", entries: [entry] };
      const position = Math.min(operation.position ?? session.blocks.length, session.blocks.length);
      const blocks = [...session.blocks];
      blocks.splice(position, 0, block);
      return {
        ok: true,
        plan: replaceSession(plan, { ...session, blocks }),
        summary: `Added ${name}`,
      };
    }

    case "removeEntry": {
      const location = findEntry(plan, operation.entryId);
      if (location === undefined) {
        return reject("not-found", `No Entry ${operation.entryId}`);
      }
      const name = entryName(context, location.entry);
      return {
        ok: true,
        plan: replaceSession(
          plan,
          collapseSessionAfterRemoval({
            ...location.session,
            blocks: location.session.blocks.map((block) =>
              block.id === location.block.id
                ? {
                    ...block,
                    entries: block.entries.filter((entry) => entry.id !== operation.entryId),
                  }
                : block,
            ),
          }),
        ),
        summary: `Removed ${name}`,
      };
    }

    case "orderEntries": {
      const found = findBlock(plan, operation.blockId);
      if (found === undefined) {
        return reject("not-found", `No Block ${operation.blockId}`);
      }
      const currentIds = found.block.entries.map((entry) => entry.id as string);
      if (!isPermutation(operation.entryIds as ReadonlyArray<string>, currentIds)) {
        return reject(
          "invalid",
          "orderEntries must list exactly that Block's current Entries, each once",
        );
      }
      const byId = new Map(found.block.entries.map((entry) => [entry.id as string, entry]));
      return {
        ok: true,
        plan: replaceSession(plan, {
          ...found.session,
          blocks: found.session.blocks.map((block) =>
            block.id === operation.blockId
              ? { ...block, entries: operation.entryIds.map((id) => byId.get(id as string)!) }
              : block,
          ),
        }),
        summary: `Reordered the ${BLOCK_LABEL[found.block.format]}'s exercises`,
        orderingContainer: `block:${operation.blockId}`,
      };
    }

    case "groupEntries": {
      const session = findSession(plan, operation.sessionId);
      if (session === undefined) {
        return reject("not-found", `No Prescribed Session ${operation.sessionId}`);
      }
      if (operation.entryIds.length < 2) {
        return reject("invalid", "Grouping needs at least two Entries");
      }
      if (findBlock(plan, operation.blockId) !== undefined) {
        return reject("invalid", `A Block with id ${operation.blockId} already exists`);
      }
      // Grouping is by ADJACENCY, not selection (#45): the Entries must be
      // consecutive nodes of this Session, each alone in its own Block. That
      // is exactly what "group with the exercise below" produces; anything
      // else would be a multi-select feature this v1 does not have.
      const indices = operation.entryIds.map((entryId) =>
        session.blocks.findIndex(
          (block) => block.entries.length === 1 && block.entries[0]!.id === entryId,
        ),
      );
      if (indices.some((index) => index < 0)) {
        return reject(
          "invalid",
          "groupEntries can only group Entries that are each alone in their own Block in this Session",
        );
      }
      const adjacent = indices.every(
        (index, position) => position === 0 || index === indices[position - 1]! + 1,
      );
      if (!adjacent) {
        return reject("invalid", "groupEntries can only group adjacent nodes");
      }
      const first = indices[0]!;
      const entries = indices.map((index) => session.blocks[index]!.entries[0]!);
      const block: PrescribedBlock = { id: operation.blockId, format: operation.format, entries };
      const blocks = session.blocks.filter((_, index) => !indices.includes(index));
      blocks.splice(first, 0, block);
      const names = entries.map((entry) => entryName(context, entry)).join(" + ");
      return {
        ok: true,
        plan: replaceSession(plan, { ...session, blocks }),
        summary: `Grouped ${names} into a ${BLOCK_LABEL[operation.format]}`,
      };
    }

    case "ungroupBlock": {
      const found = findBlock(plan, operation.blockId);
      if (found === undefined) {
        return reject("not-found", `No Block ${operation.blockId}`);
      }
      const label = BLOCK_LABEL[found.block.format];
      const index = found.session.blocks.findIndex((block) => block.id === operation.blockId);
      const replacements: ReadonlyArray<PrescribedBlock> = found.block.entries.map((entry) => ({
        // The dissolved Block's own id is retained by its first Entry's
        // replacement so an undo (which regroups by id) has something stable
        // to name; the rest take their Entry's id as a Block id, which is
        // unique for the same reason Entry ids are.
        id: (entry.id === found.block.entries[0]?.id
          ? found.block.id
          : entry.id) as unknown as BlockId,
        format: "straight",
        entries: [entry],
      }));
      const blocks = [...found.session.blocks];
      blocks.splice(index, 1, ...replacements);
      return {
        ok: true,
        plan: replaceSession(plan, { ...found.session, blocks }),
        summary: `Ungrouped the ${label}`,
      };
    }

    case "moveEntryToBlock": {
      const location = findEntry(plan, operation.entryId);
      if (location === undefined) {
        return reject("not-found", `No Entry ${operation.entryId}`);
      }
      const destination = findBlock(plan, operation.blockId);
      if (destination === undefined) {
        return reject("not-found", `No Block ${operation.blockId}`);
      }
      if (destination.session.id !== location.session.id) {
        return reject("invalid", "An Entry cannot move to a Block in a different Session");
      }
      if (destination.block.id === location.block.id) {
        return reject("invalid", "Use orderEntries to move an Entry within its own Block");
      }
      const name = entryName(context, location.entry);
      const blocks = location.session.blocks.map((block) => {
        if (block.id === location.block.id) {
          return { ...block, entries: block.entries.filter((e) => e.id !== operation.entryId) };
        }
        if (block.id === operation.blockId) {
          const entries = [...block.entries];
          entries.splice(Math.min(operation.position, entries.length), 0, location.entry);
          return { ...block, entries };
        }
        return block;
      });
      return {
        ok: true,
        plan: replaceSession(
          plan,
          collapseSessionAfterRemoval({ ...location.session, blocks }),
        ),
        summary: `Moved ${name} into the ${BLOCK_LABEL[destination.block.format]}`,
      };
    }

    case "removeEntryFromBlock": {
      const location = findEntry(plan, operation.entryId);
      if (location === undefined) {
        return reject("not-found", `No Entry ${operation.entryId}`);
      }
      if (location.block.entries.length <= 1) {
        return reject(
          "invalid",
          "removeEntryFromBlock is a no-op — the Entry is already alone in its Block",
        );
      }
      if (findBlock(plan, operation.blockId) !== undefined) {
        return reject("invalid", `A Block with id ${operation.blockId} already exists`);
      }
      const name = entryName(context, location.entry);
      const sourceIndex = location.session.blocks.findIndex((block) => block.id === location.block.id);
      const newBlock: PrescribedBlock = { id: operation.blockId, format: "straight", entries: [location.entry] };
      const blocks = location.session.blocks.map((block) =>
        block.id === location.block.id
          ? { ...block, entries: block.entries.filter((e) => e.id !== operation.entryId) }
          : block,
      );
      blocks.splice(sourceIndex + 1, 0, newBlock);
      return {
        ok: true,
        plan: replaceSession(plan, collapseSessionAfterRemoval({ ...location.session, blocks })),
        summary: `Took ${name} out of the ${BLOCK_LABEL[location.block.format]}`,
      };
    }

    case "setBlockParams": {
      const found = findBlock(plan, operation.blockId);
      if (found === undefined) {
        return reject("not-found", `No Block ${operation.blockId}`);
      }
      const label = BLOCK_LABEL[operation.format];
      const rounds = operation.params.targetRounds;
      return {
        ok: true,
        plan: replaceSession(plan, {
          ...found.session,
          blocks: found.session.blocks.map((block) =>
            block.id === operation.blockId
              ? { ...block, format: operation.format, params: operation.params }
              : block,
          ),
        }),
        summary:
          rounds === undefined
            ? `Set the ${label}'s parameters`
            : `Set the ${label} to ${rounds} rounds`,
      };
    }

    case "replaceEntrySets": {
      const location = findEntry(plan, operation.entryId);
      if (location === undefined) {
        return reject("not-found", `No Entry ${operation.entryId}`);
      }
      const ids = operation.sets.map((set) => set.id as string);
      if (new Set(ids).size !== ids.length) {
        return reject("invalid", "replaceEntrySets carries a duplicate Set id");
      }
      const name = entryName(context, location.entry);
      const runs = coalesceSetRuns(operation.sets);
      return {
        ok: true,
        plan: replaceSession(plan, {
          ...location.session,
          blocks: location.session.blocks.map((block) =>
            block.id === location.block.id
              ? {
                  ...block,
                  entries: block.entries.map((entry) =>
                    entry.id === operation.entryId ? { ...entry, sets: operation.sets } : entry,
                  ),
                }
              : block,
          ),
        }),
        summary:
          runs.length === 0
            ? `Cleared ${name}'s sets`
            : `Set ${name} to ${runs.map((run) => formatSetRun(run)).join(", then ")}`,
      };
    }

    case "setEntryExercise": {
      const location = findEntry(plan, operation.entryId);
      if (location === undefined) {
        return reject("not-found", `No Entry ${operation.entryId}`);
      }
      if (location.entry.exerciseId === operation.exerciseId) {
        return reject("invalid", `Entry ${operation.entryId} already names ${operation.exerciseId}`);
      }
      // The same fail-open join `addEntry` refuses: an Entry pointing at a
      // catalog row that does not exist renders a raw id and logs nothing.
      const catalogEntry = context.exercises.find((exercise) => exercise.id === operation.exerciseId);
      if (catalogEntry === undefined) {
        return reject(
          "not-found",
          `No catalog Exercise ${operation.exerciseId} — it must be created before an Entry can reference it (ADR 0016)`,
        );
      }
      const { trackedMetrics: _previous, ...rest } = location.entry;
      const entry: PrescribedEntry = {
        ...rest,
        exerciseId: operation.exerciseId,
        ...(catalogEntry.trackedMetrics === undefined ? {} : { trackedMetrics: catalogEntry.trackedMetrics }),
      };
      return {
        ok: true,
        plan: replaceSession(plan, {
          ...location.session,
          blocks: location.session.blocks.map((block) =>
            block.id === location.block.id
              ? {
                  ...block,
                  entries: block.entries.map((candidate) =>
                    candidate.id === operation.entryId ? entry : candidate,
                  ),
                }
              : block,
          ),
        }),
        summary: `Swapped ${entryName(context, location.entry)} for ${exerciseName(context, operation.exerciseId)}`,
      };
    }
  }
}
/* eslint-enable complexity */

export type ApplyPlanOperationsResult =
  | {
      readonly ok: true;
      readonly plan: PlanSnapshot;
      /** One summary per operation, in order — the diff, in the applier's own words. */
      readonly summaries: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      /** Which operation in the sequence failed (0-based) — a rejection has to be locatable. */
      readonly index: number;
      readonly operation: PlanOperationTag;
      readonly code: PlanOperationRejectionCode;
      readonly reason: string;
    };

/**
 * Applies a SEQUENCE of operations, in order, **all or nothing** (#86): a
 * coach Proposal carries the Change it proposes as ADR 0015 operations, and
 * accepting it must either apply every one of them or change nothing at all —
 * a half-applied Proposal would leave the Plan in a shape neither the user nor
 * the coach ever agreed to.
 *
 * All-or-nothing is free here, and that is the point of keeping the applier
 * pure: each step folds onto the *previous step's* snapshot (so an operation
 * may legitimately depend on the one before it — create a Session, then add an
 * Entry to it), and a rejection simply means the caller discards the fold and
 * never writes. No transaction, no rollback path, no partially-mutated state
 * to reason about.
 *
 * The same fold is what the Proposal card renders as a diff against the
 * standing Plan before the user taps Accept, which is why it lives here rather
 * than inside either `Store`: the preview and the effect are one computation,
 * so the card cannot promise something acceptance would not do.
 */
export function applyPlanOperations(
  plan: PlanSnapshot,
  operations: ReadonlyArray<PlanOperation>,
  context: PlanAuthoringContext = emptyAuthoringContext,
): ApplyPlanOperationsResult {
  let next = plan;
  const summaries: Array<string> = [];
  for (const [index, operation] of operations.entries()) {
    const result = applyPlanOperation(next, operation, context);
    if (!result.ok) {
      return { ok: false, index, operation: operation._tag, code: result.code, reason: result.reason };
    }
    next = result.plan;
    summaries.push(result.summary);
  }
  return { ok: true, plan: next, summaries };
}

/**
 * Validation is just "would applying it be rejected" — there is deliberately
 * no second implementation of the rules for the client to drift from. A
 * client calls this before sending so a stale tap fails locally and
 * instantly rather than after a round trip.
 */
export function validatePlanOperation(
  plan: PlanSnapshot,
  operation: PlanOperation,
  context: PlanAuthoringContext = emptyAuthoringContext,
): { readonly ok: true } | { readonly ok: false; readonly code: PlanOperationRejectionCode; readonly reason: string } {
  const result = applyPlanOperation(plan, operation, context);
  return result.ok ? { ok: true } : { ok: false, code: result.code, reason: result.reason };
}

/**
 * The inverse of an operation against the Plan **as it stood before it** —
 * what undo sends (#71: undo is not a new primitive, it is the inverse
 * applied as a new `user-direct` Change, with the original marked
 * `superseded`). Because the operations are coarse and whole-value, the
 * inverse is almost always "the previous value", which the client already
 * holds.
 *
 * `undefined` means the operation has no expressible inverse in this
 * vocabulary — `deleteSession` is the one that matters: restoring a deleted
 * Session means re-creating it and everything under it, which is a
 * multi-operation restore rather than one inverse, so the UI must not offer
 * undo for it as though it were free.
 */
export function invertPlanOperation(
  planBefore: PlanSnapshot,
  operation: PlanOperation,
): PlanOperation | undefined {
  switch (operation._tag) {
    case "createSession":
      return { _tag: "deleteSession", sessionId: operation.sessionId };

    case "renameSession": {
      const session = findSession(planBefore, operation.sessionId);
      if (session?.name === undefined) return undefined;
      return { _tag: "renameSession", sessionId: operation.sessionId, name: session.name };
    }

    case "orderSessions":
      return {
        _tag: "orderSessions",
        sessionIds: planBefore.sessions.map((session) => session.id),
      };

    case "orderBlocks": {
      const session = findSession(planBefore, operation.sessionId);
      if (session === undefined) return undefined;
      return {
        _tag: "orderBlocks",
        sessionId: operation.sessionId,
        blockIds: session.blocks.map((block) => block.id),
      };
    }

    case "orderEntries": {
      const found = findBlock(planBefore, operation.blockId);
      if (found === undefined) return undefined;
      return {
        _tag: "orderEntries",
        blockId: operation.blockId,
        entryIds: found.block.entries.map((entry) => entry.id),
      };
    }

    case "addEntry":
      return { _tag: "removeEntry", entryId: operation.entryId };

    case "groupEntries":
      return { _tag: "ungroupBlock", blockId: operation.blockId };

    case "ungroupBlock": {
      const found = findBlock(planBefore, operation.blockId);
      if (found === undefined) return undefined;
      return {
        _tag: "groupEntries",
        sessionId: found.session.id,
        blockId: operation.blockId,
        entryIds: found.block.entries.map((entry) => entry.id),
        format: found.block.format,
      };
    }

    case "moveEntryToBlock": {
      const location = findEntry(planBefore, operation.entryId);
      if (location === undefined) return undefined;
      const position = location.block.entries.findIndex((entry) => entry.id === operation.entryId);
      return {
        _tag: "moveEntryToBlock",
        entryId: operation.entryId,
        blockId: location.block.id,
        position: position < 0 ? 0 : position,
      };
    }

    case "setBlockParams": {
      const found = findBlock(planBefore, operation.blockId);
      if (found === undefined) return undefined;
      return {
        _tag: "setBlockParams",
        blockId: operation.blockId,
        format: found.block.format,
        params: found.block.params ?? {},
      };
    }

    case "removeEntryFromBlock": {
      const location = findEntry(planBefore, operation.entryId);
      if (location === undefined) return undefined;
      const position = location.block.entries.findIndex((entry) => entry.id === operation.entryId);
      return {
        _tag: "moveEntryToBlock",
        entryId: operation.entryId,
        blockId: location.block.id,
        position: position < 0 ? 0 : position,
      };
    }

    case "replaceEntrySets": {
      const location = findEntry(planBefore, operation.entryId);
      if (location === undefined) return undefined;
      return { _tag: "replaceEntrySets", entryId: operation.entryId, sets: location.entry.sets };
    }

    case "setEntryExercise": {
      const location = findEntry(planBefore, operation.entryId);
      if (location === undefined) return undefined;
      return { _tag: "setEntryExercise", entryId: operation.entryId, exerciseId: location.entry.exerciseId };
    }

    // Restoring a deleted Session is not one operation — see the doc above.
    case "deleteSession":
      return undefined;
  }
}
