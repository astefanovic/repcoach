import * as Schema from "effect/Schema";

import {
  ActualMetricMap,
  CommandId,
  EntryId,
  ExerciseId,
  IsoDateTime,
  LoggedSessionId,
  PlanOperation,
  SessionId,
  SetId,
  SetType,
  TrimmedNonEmptyString,
} from "@repcoach/contracts";

/**
 * Task 4 (issue #18, G1) — the outbox's queued item, ported from t3code's
 * `QueuedThreadMessage`. Kept disciplines: schema-versioned persisted rows,
 * and an idempotent client-generated `commandId` that the server applies
 * exactly-once no matter how many times the outbox replays it after a
 * reconnect.
 *
 * v3 (Step 2A, task 2A.2) added `loggedSessionId` — a queued item attaches to
 * the real Logged Session `startSession` instantiated, not just the prescribed
 * `sessionId`. A pre-2A.2 (v1/v2) persisted row predates `startSession`
 * entirely and has no Logged Session to attach to, so it is NOT structurally
 * migratable — it decodes as unknown/corrupt (see `decodeQueuedCommand`'s
 * doc) and is dropped, same as any other unreadable row.
 *
 * ---
 *
 * **v4 (#80) is the reason this file stopped being about logging.** The outbox
 * carried exactly one command shape — `logSetActual` — which meant local-first
 * durability was a privilege of the logging path. Plan edits went out as a
 * direct RPC, so an edit made in a dead spot was applied optimistically,
 * failed to send, and was rolled back: the same class of loss the outbox
 * exists to prevent, on the other half of the app.
 *
 * So a row is now a `kind`-discriminated **command**, and `kind` is the only
 * thing the flusher branches on. The generalisation is deliberately shallow —
 * the manager, the storage seam and persist-before-reflect never knew what
 * they were carrying and still do not.
 *
 * What makes replaying a `PlanOperation` safe is not new machinery but the
 * operation union's own design (#71): the client supplies the id of anything
 * it creates, and the ordering/`replaceEntrySets` operations carry whole
 * values rather than positional deltas. Both are idempotent under replay. The
 * server half was already in place before this ticket — `applyUserPlanChange`
 * dedupes on `commandId` via `StoreData.planEditsByCommandId` — it simply
 * never fired, because the old direct-RPC path minted a fresh `commandId` on
 * every attempt. A queued command has exactly one, for its whole life.
 *
 * **v5 (#130)** added `addEntryNote` — the "Add a note" sheet item is not a
 * Set (it has no `setId`/`setType`), so it could not reuse `logSetActual`
 * the way #129's continuations did; it goes through the outbox as its own
 * kind, wrapping `contextNotes.add` the same way `applyPlanEdit` wraps
 * `applyUserPlanChange`.
 *
 * **v6 (#131, ADR 0019)** adds `swapExercise` — a fourth `kind`, following the
 * exact same recipe `applyPlanEdit` set: a queued command, idempotent by
 * `commandId`, with its own flusher branch and its own reject path
 * (`EntryAlreadyLoggedError`) for a permanent server refusal.
 *
 * **v7 (#83, ADR 0019)** adds `unlogSetActual` — a fifth `kind`, a
 * retraction. Unlike `swapExercise` it has no rejectable-error path (no
 * FK/lookup validation, migration `020`'s note), so its flusher arm is an
 * unconditional remove-on-success, shaped like `addEntryNote`'s rather than
 * `swapExercise`'s reject-not-remove.
 *
 * **v8 (UAT)** adds `editEntryNote` — the note item on an Entry that already
 * has a note rewrites it instead of stacking a second one. A sixth `kind`
 * rather than a re-sent `addEntryNote`, because a note's id IS its original
 * `commandId` and the server's add is `ON CONFLICT(id) DO NOTHING`: re-adding
 * under the same id is a no-op by design, which is exactly the property an
 * edit must not have. It carries the whole resulting text by value, so it is
 * idempotent under replay for the same reason `replaceEntrySets` is, and like
 * `addEntryNote` it has no rejectable-error arm.
 */
export const OUTBOX_SCHEMA_VERSION = 8;

const StoredSchema = Schema.Union([
  Schema.Struct({
    // v1 predates the explicit `schemaVersion` stamp (see
    // `withLegacyDefaults` below); v3 predates `kind`; v4/v5/v6 did not change
    // this arm's shape — listed explicitly (not `OUTBOX_SCHEMA_VERSION`
    // alone) so a v4- or v5-persisted row keeps decoding once the constant
    // moves on. Every write re-stamps the current version — mirrors t3code's
    // `QueuedThreadMessageSchema` migration discipline.
    schemaVersion: Schema.Literals([1, 3, 4, 5, 7, OUTBOX_SCHEMA_VERSION]),
    kind: Schema.Literal("logSetActual"),
    seq: Schema.Number,
    commandId: CommandId,
    loggedSessionId: LoggedSessionId,
    sessionId: SessionId,
    entryId: EntryId,
    setId: SetId,
    setType: SetType,
    actual: ActualMetricMap,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    // v4 onwards: `applyPlanEdit` did not exist before v4, and has not changed
    // shape since.
    schemaVersion: Schema.Literals([4, 5, 7, OUTBOX_SCHEMA_VERSION]),
    kind: Schema.Literal("applyPlanEdit"),
    seq: Schema.Number,
    commandId: CommandId,
    operation: PlanOperation,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    // v5 onwards: `addEntryNote` did not exist before v5, and has not changed
    // shape since.
    schemaVersion: Schema.Literals([5, 7, OUTBOX_SCHEMA_VERSION]),
    kind: Schema.Literal("addEntryNote"),
    seq: Schema.Number,
    commandId: CommandId,
    loggedSessionId: LoggedSessionId,
    entryId: EntryId,
    text: TrimmedNonEmptyString,
    recordedAt: IsoDateTime,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    // v6 onwards: `swapExercise` did not exist before v6, and has not
    // changed shape since v7 bumped the constant.
    schemaVersion: Schema.Literals([6, 7, OUTBOX_SCHEMA_VERSION]),
    kind: Schema.Literal("swapExercise"),
    seq: Schema.Number,
    commandId: CommandId,
    loggedSessionId: LoggedSessionId,
    entryId: EntryId,
    exerciseId: ExerciseId,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    // v7 onwards: `unlogSetActual` did not exist before v7.
    schemaVersion: Schema.Literals([7, OUTBOX_SCHEMA_VERSION]),
    kind: Schema.Literal("unlogSetActual"),
    seq: Schema.Number,
    commandId: CommandId,
    loggedSessionId: LoggedSessionId,
    entryId: EntryId,
    setId: SetId,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    // No legacy versions here: `editEntryNote` did not exist before v8.
    schemaVersion: Schema.Literal(OUTBOX_SCHEMA_VERSION),
    kind: Schema.Literal("editEntryNote"),
    seq: Schema.Number,
    commandId: CommandId,
    loggedSessionId: LoggedSessionId,
    entryId: EntryId,
    noteId: TrimmedNonEmptyString,
    text: TrimmedNonEmptyString,
    createdAt: IsoDateTime,
  }),
]);

/**
 * The enqueue-order key.
 *
 * `createdAt` cannot carry this on its own: it is millisecond ISO, and the
 * operations most dependent on order are the ones dispatched in the same tick
 * — "add exercise" is `addEntry` immediately followed by `replaceEntrySets`
 * naming the Entry the first one creates. Those two routinely share a
 * timestamp, and once they do, a `createdAt` sort is a tie broken by whatever
 * order the storage happened to hand rows back in. After a reload that is
 * IndexedDB key order, i.e. `commandId`, i.e. effectively random — so the
 * second operation could be delivered first and be permanently refused for
 * naming an Entry that does not exist yet.
 *
 * A monotonic counter makes the order total and survives the reload, which is
 * the only place the hazard actually bites.
 */
export interface QueuedSetActual {
  readonly kind: "logSetActual";
  readonly seq: number;
  readonly commandId: CommandId;
  readonly loggedSessionId: LoggedSessionId;
  readonly sessionId: SessionId;
  readonly entryId: EntryId;
  readonly setId: SetId;
  readonly setType: SetType;
  readonly actual: ActualMetricMap;
  readonly createdAt: string;
}

export interface QueuedPlanEdit {
  readonly kind: "applyPlanEdit";
  readonly seq: number;
  readonly commandId: CommandId;
  readonly operation: PlanOperation;
  readonly createdAt: string;
}

/** An "Add a note" sheet item (#130) queued for `contextNotes.add`. Not a Set — no `setId`/`setType`. */
export interface QueuedAddEntryNote {
  readonly kind: "addEntryNote";
  readonly seq: number;
  readonly commandId: CommandId;
  readonly loggedSessionId: LoggedSessionId;
  readonly entryId: EntryId;
  readonly text: string;
  readonly recordedAt: string;
  readonly createdAt: string;
}

/** A queued swap (#131, ADR 0019) — a pure actual-side annotation, never a Plan edit. */
export interface QueuedSwapExercise {
  readonly kind: "swapExercise";
  readonly seq: number;
  readonly commandId: CommandId;
  readonly loggedSessionId: LoggedSessionId;
  readonly entryId: EntryId;
  readonly exerciseId: ExerciseId;
  readonly createdAt: string;
}

/** A queued retraction (#83, ADR 0019) — "this Set was not performed after all". No metric map. */
export interface QueuedUnlogSetActual {
  readonly kind: "unlogSetActual";
  readonly seq: number;
  readonly commandId: CommandId;
  readonly loggedSessionId: LoggedSessionId;
  readonly entryId: EntryId;
  readonly setId: SetId;
  readonly createdAt: string;
}

/**
 * A queued note rewrite (UAT) — `noteId` names the note being rewritten (its
 * own original `commandId`); this command's `commandId` is its outbox
 * identity, never a row id. `loggedSessionId`/`entryId` are carried for the
 * same reason `addEntryNote` carries them: the surface's queued-notes
 * subscription filters on them, and neither reaches the server.
 */
export interface QueuedEditEntryNote {
  readonly kind: "editEntryNote";
  readonly seq: number;
  readonly commandId: CommandId;
  readonly loggedSessionId: LoggedSessionId;
  readonly entryId: EntryId;
  readonly noteId: string;
  readonly text: string;
  readonly createdAt: string;
}

/** Anything the outbox can carry. The flusher branches on `kind` and nothing else. */
export type QueuedCommand =
  | QueuedSetActual
  | QueuedPlanEdit
  | QueuedAddEntryNote
  | QueuedSwapExercise
  | QueuedUnlogSetActual
  | QueuedEditEntryNote;

/**
 * What a caller supplies. `seq` and `createdAt` are the manager's to assign —
 * a caller that could choose its own sequence number could reorder the queue,
 * which is the one thing the queue exists to decide.
 */
export type NewQueuedSetActual = Omit<QueuedSetActual, "createdAt" | "seq">;
export type NewQueuedPlanEdit = Omit<QueuedPlanEdit, "createdAt" | "seq">;
export type NewQueuedAddEntryNote = Omit<QueuedAddEntryNote, "createdAt" | "seq">;
export type NewQueuedSwapExercise = Omit<QueuedSwapExercise, "createdAt" | "seq">;
export type NewQueuedUnlogSetActual = Omit<QueuedUnlogSetActual, "createdAt" | "seq">;
export type NewQueuedEditEntryNote = Omit<QueuedEditEntryNote, "createdAt" | "seq">;
export type NewQueuedCommand =
  | NewQueuedSetActual
  | NewQueuedPlanEdit
  | NewQueuedAddEntryNote
  | NewQueuedSwapExercise
  | NewQueuedUnlogSetActual
  | NewQueuedEditEntryNote;

const decodeStored = Schema.decodeUnknownSync(StoredSchema);
const encodeStored = Schema.encodeUnknownSync(StoredSchema);

/**
 * Fills in what older persisted rows never wrote: v1 rows stamped no
 * `schemaVersion`, v1/v3 rows stamped no `kind`, and neither stamped `seq`.
 * Defaulting before validation is what keeps a legacy row readable instead of
 * failing every one of them — the migration path Rung 1 exercises.
 *
 * The `kind` default is unambiguous: `logSetActual` was the only command the
 * outbox could hold before v4, so a row without one is a logged Set and must
 * not be dropped — someone's set is in it. The `seq` default of 0 is likewise
 * safe rather than merely convenient: every legacy row is a logged Set, and
 * logged Sets are independent of one another, so their relative order carries
 * no meaning to preserve. They sort ahead of anything enqueued since, which is
 * also the order they were captured in.
 */
function withLegacyDefaults(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  return {
    ...row,
    ...("schemaVersion" in row ? {} : { schemaVersion: 1 }),
    ...("kind" in row ? {} : { kind: "logSetActual" }),
    ...("seq" in row ? {} : { seq: 0 }),
  };
}

/** Throws on an unknown/corrupt schema version — callers should ignore such rows. */
export function decodeQueuedCommand(value: unknown): QueuedCommand {
  const decoded = decodeStored(withLegacyDefaults(value));
  // Rebuilt per arm rather than destructured-and-cast: spreading the union
  // collapses it, and an `as` here would silently accept a future arm that
  // forgot a field.
  const { schemaVersion: _schemaVersion, ...rest } = decoded;
  if (rest.kind === "applyPlanEdit") {
    return {
      kind: "applyPlanEdit",
      seq: rest.seq,
      commandId: rest.commandId,
      operation: rest.operation,
      createdAt: rest.createdAt,
    };
  }
  if (rest.kind === "addEntryNote") {
    return {
      kind: "addEntryNote",
      seq: rest.seq,
      commandId: rest.commandId,
      loggedSessionId: rest.loggedSessionId,
      entryId: rest.entryId,
      text: rest.text,
      recordedAt: rest.recordedAt,
      createdAt: rest.createdAt,
    };
  }
  if (rest.kind === "swapExercise") {
    return {
      kind: "swapExercise",
      seq: rest.seq,
      commandId: rest.commandId,
      loggedSessionId: rest.loggedSessionId,
      entryId: rest.entryId,
      exerciseId: rest.exerciseId,
      createdAt: rest.createdAt,
    };
  }
  if (rest.kind === "editEntryNote") {
    return {
      kind: "editEntryNote",
      seq: rest.seq,
      commandId: rest.commandId,
      loggedSessionId: rest.loggedSessionId,
      entryId: rest.entryId,
      noteId: rest.noteId,
      text: rest.text,
      createdAt: rest.createdAt,
    };
  }
  if (rest.kind === "unlogSetActual") {
    return {
      kind: "unlogSetActual",
      seq: rest.seq,
      commandId: rest.commandId,
      loggedSessionId: rest.loggedSessionId,
      entryId: rest.entryId,
      setId: rest.setId,
      createdAt: rest.createdAt,
    };
  }
  return {
    kind: "logSetActual",
    seq: rest.seq,
    commandId: rest.commandId,
    loggedSessionId: rest.loggedSessionId,
    sessionId: rest.sessionId,
    entryId: rest.entryId,
    setId: rest.setId,
    setType: rest.setType,
    actual: rest.actual,
    createdAt: rest.createdAt,
  };
}

export function encodeQueuedCommand(item: QueuedCommand): unknown {
  return encodeStored({ schemaVersion: OUTBOX_SCHEMA_VERSION, ...item });
}

export function buildQueuedCommand(
  input: NewQueuedCommand,
  seq: number,
  createdAt: string = new Date().toISOString(),
): QueuedCommand {
  return { ...input, seq, createdAt };
}

/** Narrowing helpers, so callers read as a question about the command rather than a string compare. */
export const isQueuedSetActual = (item: QueuedCommand): item is QueuedSetActual =>
  item.kind === "logSetActual";
export const isQueuedPlanEdit = (item: QueuedCommand): item is QueuedPlanEdit =>
  item.kind === "applyPlanEdit";
export const isQueuedAddEntryNote = (item: QueuedCommand): item is QueuedAddEntryNote =>
  item.kind === "addEntryNote";
export const isQueuedSwapExercise = (item: QueuedCommand): item is QueuedSwapExercise =>
  item.kind === "swapExercise";
export const isQueuedUnlogSetActual = (item: QueuedCommand): item is QueuedUnlogSetActual =>
  item.kind === "unlogSetActual";
export const isQueuedEditEntryNote = (item: QueuedCommand): item is QueuedEditEntryNote =>
  item.kind === "editEntryNote";
