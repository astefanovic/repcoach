import * as Schema from "effect/Schema";

import {
  BlockId,
  CommandId,
  DecisionId,
  EntryId,
  ExerciseId,
  NonNegativeInt,
  SessionId,
  SetId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PrescribedMetricMap } from "./metrics.ts";
import { BlockFormat, BlockParams, PrescribedSet } from "./scaffold.ts";

/**
 * User-direct Plan edits (CONTEXT `Change`): a user editing the Plan outside
 * a workout is auto-applied without approval — born `applied` — and recorded
 * so the coach can later read it as a revealed-preference signal, never
 * blocked pending review (ADR 0008). This is a **prod-safe** RPC
 * (`plan.applyUserChange`, `rpc.ts`), not a `/__test__` lever: editing the
 * Plan is a real, always-available client capability and, per ADR 0007, the
 * ONLY Plan-authoring path.
 *
 * The whole authoring surface sits on **one seam** (#71): a single RPC
 * carrying a discriminated union of structural operations, so there is one
 * place to validate, one Change per accepted call, and one thing #72's UI
 * has to learn.
 */

// --- the narrow, original form (retained) ---------------------------------

/**
 * Edits one prescribed Set's target metric map. Predates the operation union
 * and is kept as a first-class member of the payload so everything already
 * built against it (the logging-side "nudge the target" path, existing
 * tests) keeps working verbatim. `ReplaceEntrySets` subsumes it for the
 * authoring surface.
 */
export const SetTargetChangeInput = Schema.Struct({
  setId: SetId,
  target: PrescribedMetricMap,
});
export type SetTargetChangeInput = typeof SetTargetChangeInput.Type;

// --- the structural operation union ---------------------------------------

/**
 * Every structural Plan edit, as one tagged union (#71). Two conventions run
 * through it:
 *
 * 1. **The client supplies the id of anything it creates** (`sessionId` on
 *    `CreateSession`, `entryId`/`blockId` on `AddEntry`, `blockId` on
 *    `GroupEntries`, `id` on every Set of `ReplaceEntrySets`). The same
 *    local-first discipline as the outbox's `commandId`: a retry replays the
 *    identical ids, so a flaky link cannot duplicate a Session, and the
 *    caller can render the result optimistically without waiting for the
 *    server to hand an id back.
 *
 * 2. **Whole-value beats positional.** `OrderSessions`/`OrderEntries`/
 *    `OrderBlocks` carry the entire ordered id list, and
 *    `ReplaceEntrySets` carries an Entry's entire ordered Set list, rather
 *    than "move item at index 3 to index 1" or "insert a Set after this
 *    one". Whole-value operations are idempotent and last-write-wins, which
 *    is what makes replay after a dead spot safe and eliminates the whole
 *    index-drift class of bug.
 */
export const PlanOperation = Schema.TaggedUnion({
  /** Creates an empty Prescribed Session at the end of the Plan's ordered list. */
  createSession: { sessionId: SessionId, name: TrimmedNonEmptyString },
  renameSession: { sessionId: SessionId, name: TrimmedNonEmptyString },
  /** Removes a Prescribed Session and everything under it. Logged Sessions already instantiated from it are copies and are untouched (ADR 0006/0007). */
  deleteSession: { sessionId: SessionId },
  /** The Plan's whole ordered Session list. Must name exactly the Plan's current Sessions. */
  orderSessions: { sessionIds: Schema.Array(SessionId) },

  /**
   * Adds an Exercise from the catalog to a Session. `blockId` is always
   * supplied: naming an existing Block in that Session **joins** it (how a
   * circuit grows past two exercises, #45's adjacency rule); naming a fresh
   * id **creates** a straight Block to hold the new Entry, placed at
   * `position` among the Session's Blocks (appended when absent). The new
   * Entry carries the catalog's declared `trackedMetrics` so logging renders
   * the right fields with no second lookup.
   */
  addEntry: {
    sessionId: SessionId,
    blockId: BlockId,
    entryId: EntryId,
    exerciseId: ExerciseId,
    position: Schema.optionalKey(NonNegativeInt),
  },
  /** Removes an Entry. A Block left empty is removed with it; a grouped Block left holding one Entry collapses to `straight` (#45: "a Block of one collapses back to a plain Entry"). */
  removeEntry: { entryId: EntryId },
  /** One Block's whole ordered Entry list — A1/A2 order inside a superset is prescription, not presentation. */
  orderEntries: { blockId: BlockId, entryIds: Schema.Array(EntryId) },

  /**
   * Groups adjacent Entries into a new Block of `format` (superset/circuit),
   * placed where the first of them sat. The Entries must be adjacent nodes of
   * the named Session — grouping is by adjacency, not selection (#45).
   */
  groupEntries: {
    sessionId: SessionId,
    blockId: BlockId,
    entryIds: Schema.Array(EntryId),
    format: BlockFormat,
  },
  /** Dissolves a Block: each Entry becomes its own straight Block, in place, in order. */
  ungroupBlock: { blockId: BlockId },
  /** Takes an Entry out of its Block and into another existing one, at `position`. The vacated Block collapses per `removeEntry`'s rules. */
  moveEntryToBlock: { entryId: EntryId, blockId: BlockId, position: NonNegativeInt },
  /**
   * Takes an Entry out of its Block and into a brand-new straight Block of its
   * own, placed right after the vacated one. `blockId` is the client-minted id
   * of that new Block (the same client-supplies-the-id discipline as every
   * creating operation). The vacated Block collapses per `removeEntry`'s
   * rules. Rejected when the Entry is already alone in its Block — that is a
   * no-op, not an edit.
   */
  removeEntryFromBlock: { entryId: EntryId, blockId: BlockId },
  /** Sets a Block's format and format-specific params (a circuit's target rounds, etc.). */
  setBlockParams: { blockId: BlockId, format: BlockFormat, params: BlockParams },

  /**
   * Replaces an Entry's entire ordered Set list. Deliberately coarse: the
   * editor authors **runs** ("4 × 5–8 @ 80 kg") and a run expands to N Sets,
   * so the natural write is the whole list. It subsumes add-set, remove-set,
   * change-count, change-target, change-rest and change-set-type into one
   * idempotent operation — including the Entry-level "rest default", which
   * is written as per-Set `restSec` across the list because CONTEXT's `Set`
   * puts rest on the Set and nowhere else.
   */
  replaceEntrySets: { entryId: EntryId, sets: Schema.Array(PrescribedSet) },
  /**
   * Points an existing Entry at a different catalog Exercise, keeping its id,
   * its place, and its Sets. What "swap this in the plan" writes after a
   * workout in which the Entry was swapped (CONTEXT `Swap` is the logging
   * fact; this is the separate, user-chosen Plan edit). The Entry's
   * `trackedMetrics` follow the new catalog row, as `addEntry`'s do.
   */
  setEntryExercise: { entryId: EntryId, exerciseId: ExerciseId },
  /** One Session's whole ordered Block list — the outer reorder unit is the node, and a Block moves as one, carrying its Entries (#45). */
  orderBlocks: { sessionId: SessionId, blockIds: Schema.Array(BlockId) },
});
export type PlanOperation = typeof PlanOperation.Type;

/** The `_tag` of a `PlanOperation` — the ubiquitous name of a structural Plan edit. */
export type PlanOperationTag = PlanOperation["_tag"];

/**
 * A structural edit as it travels: the operation plus the two envelope
 * fields the *record* needs.
 *
 * `commandId` is the outbox's exactly-once key (ADR 0006), reused verbatim:
 * a replayed command is applied once and returns the same Plan, so a retry
 * over a flaky link cannot duplicate the user's Sets.
 *
 * `undoesChangeId` names the Change this operation reverses. Undo is not a
 * new primitive (#71): the client sends the *inverse* operation — which,
 * because the operations are whole-value, is just "the previous value" it
 * already holds — as a new `user-direct` Change, and the server marks the
 * named original `superseded`. No special-cased rollback path, and the
 * applied history stays linear.
 */
export const PlanEditCommand = Schema.Struct({
  operation: PlanOperation,
  commandId: Schema.optionalKey(CommandId),
  undoesChangeId: Schema.optionalKey(DecisionId),
});
export type PlanEditCommand = typeof PlanEditCommand.Type;

/**
 * `plan.applyUserChange`'s payload: either the original narrow Set-target
 * edit, or a structural `PlanEditCommand`. The two are unambiguous — only
 * the latter carries `operation`.
 */
export const ApplyUserChangeInput = Schema.Union([SetTargetChangeInput, PlanEditCommand]);
export type ApplyUserChangeInput = typeof ApplyUserChangeInput.Type;

/** Narrows the payload union without reaching for the schema at runtime. */
export const isPlanEditCommand = (input: ApplyUserChangeInput): input is PlanEditCommand =>
  "operation" in input;

// --- errors ----------------------------------------------------------------

export class PrescribedSetNotFoundError extends Schema.TaggedErrorClass<PrescribedSetNotFoundError>()(
  "PrescribedSetNotFoundError",
  {
    setId: SetId,
  },
) {
  override get message(): string {
    return `No prescribed Set found for id ${this.setId}`;
  }
}

/**
 * Why a structural operation could not be applied. A stale client naming
 * something that no longer exists must fail cleanly and change nothing —
 * silent partial application would corrupt the Plan, and the Plan is the
 * thing the user owns.
 */
export const PlanOperationRejectionCode = Schema.Literals([
  /** The operation names a Session/Block/Entry/Set that is not in the Plan. */
  "not-found",
  /** The operation is well-formed but not valid against the current Plan (a reorder that drops or invents members, grouping non-adjacent Entries, ...). */
  "invalid",
]);
export type PlanOperationRejectionCode = typeof PlanOperationRejectionCode.Type;

export class PlanOperationRejectedError extends Schema.TaggedErrorClass<PlanOperationRejectedError>()(
  "PlanOperationRejectedError",
  {
    operation: Schema.String,
    code: PlanOperationRejectionCode,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Plan operation ${this.operation} rejected (${this.code}): ${this.reason}`;
  }
}
