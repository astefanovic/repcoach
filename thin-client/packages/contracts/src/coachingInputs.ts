import * as Schema from "effect/Schema";

import { CommandId, EntryId, IsoDateTime, LoggedSessionId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Canonical shapes for the Deliberation seed's six store-backed inputs (ADR
 * 0011 §2, issue #34 — 2B slice "seed-input storage"). These shapes were
 * FIRST introduced as plain TS interfaces in `apps/dev-server/src/
 * seedContext.ts` (2B slice 2, issue #27) to type `SeedInputs`; this module
 * is where they now live as `effect/Schema` structs because they are also
 * needed on the RPC write path (this file) and the persistence row shapes
 * (`@repcoach/persistence`) — `seedContext.ts` re-exports these exact types
 * rather than redefining them, so there is exactly one canonical shape per
 * concept, never a parallel duplicate that can drift.
 *
 * Field shapes are kept IDENTICAL to the original seedContext.ts interfaces
 * (plain unbranded `string` ids) precisely so the already-merged, already
 * -adversarially-tested `seedContext.test.ts`/`seedContext.adversarial.test.ts`
 * literal object construction (`{ id: "c1", text: ..., severity: "hard" }`)
 * keeps compiling unchanged.
 *
 * `CheckIn` is the one deliberate exception: CONTEXT.md's Check-in is
 * structured (sleep/soreness/stress/energy), but the seed only ever needed a
 * rendered summary line (`seedContext.ts`'s `renderCheckIns`). So the
 * structured fields live on `AddCheckInInput`/the `check_in` table row (the
 * write path and persistence), while the canonical READ shape
 * (`CheckIn` — what `Store.listCheckIns`/`SeedInputsProviderLive` return) stays
 * the pre-existing `{ id, recordedAt, summary }` shape, with `summary`
 * computed from the stored structured fields.
 */

// --- Goal (CONTEXT `Goal`) ---------------------------------------------

export const GoalSummary = Schema.Struct({
  statement: TrimmedNonEmptyString,
  proxies: Schema.Array(TrimmedNonEmptyString),
});
export type GoalSummary = typeof GoalSummary.Type;

/** Sets/replaces the single current Goal (CONTEXT `Goal` is singular: "One current Goal"). */
export const SetGoalInput = Schema.Struct({
  statement: TrimmedNonEmptyString,
  proxies: Schema.Array(TrimmedNonEmptyString),
});
export type SetGoalInput = typeof SetGoalInput.Type;

export const SetGoalResult = Schema.Struct({
  goal: GoalSummary,
});
export type SetGoalResult = typeof SetGoalResult.Type;

// --- Standing constraint (CONTEXT `Standing constraint`) ---------------

export const StandingConstraintSeverity = Schema.Literals(["hard", "soft"]);
export type StandingConstraintSeverity = typeof StandingConstraintSeverity.Type;

export const StandingConstraint = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  severity: StandingConstraintSeverity,
});
export type StandingConstraint = typeof StandingConstraint.Type;

export const AddStandingConstraintInput = Schema.Struct({
  text: TrimmedNonEmptyString,
  severity: StandingConstraintSeverity,
});
export type AddStandingConstraintInput = typeof AddStandingConstraintInput.Type;

export const AddStandingConstraintResult = Schema.Struct({
  constraint: StandingConstraint,
});
export type AddStandingConstraintResult = typeof AddStandingConstraintResult.Type;

export const RemoveStandingConstraintInput = Schema.Struct({
  constraintId: TrimmedNonEmptyString,
});
export type RemoveStandingConstraintInput = typeof RemoveStandingConstraintInput.Type;

/** `removed: false` (not an error) when `constraintId` names no existing row — a no-op, mirroring the store's other idempotent-ish removals. */
export const RemoveStandingConstraintResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type RemoveStandingConstraintResult = typeof RemoveStandingConstraintResult.Type;

// --- Check-in (CONTEXT `Check-in`) --------------------------------------

/** A 1-5 self-report rating — sleep/soreness/stress/energy all share this scale. */
export const CheckInRating = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }));
export type CheckInRating = typeof CheckInRating.Type;

/** The canonical READ shape — a rendered summary line (see module doc). */
export const CheckIn = Schema.Struct({
  id: TrimmedNonEmptyString,
  recordedAt: IsoDateTime,
  summary: TrimmedNonEmptyString,
});
export type CheckIn = typeof CheckIn.Type;

/** The structured WRITE shape — what the user actually authors. */
export const AddCheckInInput = Schema.Struct({
  recordedAt: Schema.optionalKey(IsoDateTime),
  sleep: CheckInRating,
  soreness: CheckInRating,
  stress: CheckInRating,
  energy: CheckInRating,
});
export type AddCheckInInput = typeof AddCheckInInput.Type;

export const AddCheckInResult = Schema.Struct({
  checkIn: CheckIn,
});
export type AddCheckInResult = typeof AddCheckInResult.Type;

// --- Context note (CONTEXT `Context note`) ------------------------------

/**
 * `entryId`/`loggedSessionId` (issue #130): optional, and either both
 * present or both absent — an unanchored Context note is unscoped life
 * context (CONTEXT.md's original definition); an anchored one is the "Add a
 * note" sheet item, tied to a specific Entry in a specific Logged Session so
 * the coach can tell "my shoulder hurt today" from "my shoulder hurt on
 * overhead press". Both still render into the same
 * `## Recent Context notes` seed section (`seedContext.ts`) — #130
 * deliberately does not fork the delivery channel, only the write shape.
 */
export const ContextNote = Schema.Struct({
  id: TrimmedNonEmptyString,
  recordedAt: IsoDateTime,
  text: TrimmedNonEmptyString,
  entryId: Schema.optionalKey(EntryId),
  loggedSessionId: Schema.optionalKey(LoggedSessionId),
});
export type ContextNote = typeof ContextNote.Type;

export const AddContextNoteInput = Schema.Struct({
  text: TrimmedNonEmptyString,
  recordedAt: Schema.optionalKey(IsoDateTime),
  entryId: Schema.optionalKey(EntryId),
  loggedSessionId: Schema.optionalKey(LoggedSessionId),
  /**
   * Idempotency for outbox replay (migration `018`): when present, this
   * value IS the resulting `ContextNote.id` (mirrors a Set's client-minted
   * `setId`), so a replayed `commandId` is a no-op insert against the
   * table's own primary key — no separate dedupe column needed. Optional
   * because the pre-#130 unanchored write path (still used by a few
   * store-level tests) never minted one and gets a server-generated id
   * instead. Every outbox-originated note (the sheet's "Add a note") always
   * carries one.
   */
  commandId: Schema.optionalKey(CommandId),
});
export type AddContextNoteInput = typeof AddContextNoteInput.Type;

export const AddContextNoteResult = Schema.Struct({
  note: ContextNote,
});
export type AddContextNoteResult = typeof AddContextNoteResult.Type;

/**
 * `editContextNote` — rewriting a note that already exists, rather than
 * stacking a second one beside it. An Entry carries one running observation
 * ("left elbow twinged on set 3", later "…settled after the warmup"), so the
 * sheet's note item edits in place once there is a note to edit; UAT found
 * the append-only shape produced a pile of near-duplicate lines under the
 * exercise name.
 *
 * A **rewrite of one row, keyed by `noteId`** — deliberately not a new
 * `ContextNote` superseding the old one. The note's id is its original
 * `commandId` (migration `018`), and the Entry-anchored read path
 * (`getLoggedSession`, `seedContext`) has no notion of supersession to honour;
 * a tombstone shape would have to be taught to both for no gain the user can
 * see.
 *
 * Idempotent by construction rather than by dedupe: the command carries the
 * whole resulting text by value, so replaying it lands the same row in the
 * same state. Its own `commandId` is carried anyway, so a rejected replay is
 * still identifiable in the outbox — it is not used as a row id here.
 *
 * A `noteId` naming no row is a **no-op success**, not an error: the only way
 * to reach it is a store that lost the note (a reset dev DB), and failing the
 * command would poison the outbox queue behind it forever.
 */
export const EditContextNoteInput = Schema.Struct({
  commandId: CommandId,
  noteId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
});
export type EditContextNoteInput = typeof EditContextNoteInput.Type;

/** `note` is absent when `noteId` named no row — see `EditContextNoteInput`'s no-op-success rule. */
export const EditContextNoteResult = Schema.Struct({
  commandId: CommandId,
  note: Schema.optionalKey(ContextNote),
});
export type EditContextNoteResult = typeof EditContextNoteResult.Type;

// --- Evidence claim / Evidence base (CONTEXT `Evidence base`, ADR 0003) --

/**
 * Seed-corpus entries are always `corpus-verified` (ADR 0003 §1/§2) — a
 * retrieved-but-unpromoted citation never lives in this roster, only on a
 * Decision's value-snapshot `citations_json`. Narrower than the general
 * `Citation.trust` union (`deliberation.ts`) on purpose.
 */
export const EvidenceClaimTrust = Schema.Literals(["corpus-verified"]);
export type EvidenceClaimTrust = typeof EvidenceClaimTrust.Type;

export const EvidenceClaim = Schema.Struct({
  claim: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  applicability: TrimmedNonEmptyString,
  trust: EvidenceClaimTrust,
});
export type EvidenceClaim = typeof EvidenceClaim.Type;
