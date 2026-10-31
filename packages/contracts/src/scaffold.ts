import * as Schema from "effect/Schema";

import {
  BlockId,
  EntryId,
  ExerciseId,
  NonNegativeInt,
  SessionId,
  SetId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { MetricName, PrescribedMetricMap, SetType } from "./metrics.ts";

/**
 * Scaffold shape (ADR 0001): `Session -> Block -> Entry -> Set`,
 * **prescribed side only** — this is what the Plan stores and what
 * `getPrescribedSession` returns. A Logged Session (prescribed + actual) is
 * out of scope for Task 1's read-only contract.
 */

/** Block (CONTEXT.md): a plain straight Block is a real node, never hidden at the schema level — only in the UI. */
export const BlockFormat = Schema.Literals(["straight", "superset", "circuit", "emom", "amrap"]);
export type BlockFormat = typeof BlockFormat.Type;

/** Format-specific params (time cap, interval, target rounds) — all optional; a straight Block carries none. */
export const BlockParams = Schema.Struct({
  timeCapSec: Schema.optionalKey(NonNegativeInt),
  intervalSec: Schema.optionalKey(NonNegativeInt),
  targetRounds: Schema.optionalKey(NonNegativeInt),
});
export type BlockParams = typeof BlockParams.Type;

/**
 * A prescribed Set: target metric map + set-type tag, plus prescription-only
 * rest (CONTEXT `Set`: "Rest is not a Set metric" — absent means no rest
 * timer).
 */
export const PrescribedSet = Schema.Struct({
  id: SetId,
  setType: SetType,
  target: PrescribedMetricMap,
  restSec: Schema.optionalKey(NonNegativeInt),
});
export type PrescribedSet = typeof PrescribedSet.Type;

/**
 * An Entry: one Exercise (catalog reference) and its ordered prescribed Sets.
 * `trackedMetrics` (Step 2A, task 2A.3) is the Exercise catalog's declared
 * metric set for this Entry's exercise (CONTEXT `Exercise catalog`: "a set
 * row renders exactly the metrics the catalog declares") — optional so a
 * Set constructed without a catalog lookup (e.g. an existing test fixture)
 * still round-trips; the grid falls back to the Set's own target keys when
 * absent.
 */
export const PrescribedEntry = Schema.Struct({
  id: EntryId,
  exerciseId: ExerciseId,
  sets: Schema.Array(PrescribedSet),
  trackedMetrics: Schema.optionalKey(Schema.Array(MetricName)),
});
export type PrescribedEntry = typeof PrescribedEntry.Type;

/** A Block: format + params, grouping one or more prescribed Entries. */
export const PrescribedBlock = Schema.Struct({
  id: BlockId,
  format: BlockFormat,
  params: Schema.optionalKey(BlockParams),
  entries: Schema.Array(PrescribedEntry),
});
export type PrescribedBlock = typeof PrescribedBlock.Type;

/**
 * The Prescribed Session itself — the reusable blueprint the Plan holds.
 *
 * `name` is the user-authored label the Plan view lists and `renameSession`
 * edits (ui-surfaces.md → Plan: "an ordered list of **named** Prescribed
 * Sessions"). It is `optionalKey` rather than required because Sessions
 * predating Plan authoring (#71) — the seed, existing fixtures — carry no
 * label; a client renders a positional fallback ("Session 1") when absent.
 */
export const PrescribedSession = Schema.Struct({
  id: SessionId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  blocks: Schema.Array(PrescribedBlock),
});
export type PrescribedSession = typeof PrescribedSession.Type;

// --- getPrescribedSession -------------------------------------------------

export const GetPrescribedSessionInput = Schema.Struct({
  sessionId: SessionId,
});
export type GetPrescribedSessionInput = typeof GetPrescribedSessionInput.Type;

export class PrescribedSessionNotFoundError extends Schema.TaggedErrorClass<PrescribedSessionNotFoundError>()(
  "PrescribedSessionNotFoundError",
  {
    sessionId: SessionId,
  },
) {
  override get message(): string {
    return `No Prescribed Session found for id ${this.sessionId}`;
  }
}

// --- the Exercise catalog -------------------------------------------------

/**
 * An id in the vendored **Exercise library** — the upstream exercises dataset
 * the picker browses (`apps/web/src/exerciseLibrary`). A catalog row picked
 * from the library carries it so the client can show that exercise's
 * animation; a User-authored row typed by name has none.
 *
 * A pointer to reference material, not catalog metadata: it says which
 * animation depicts the exercise, and nothing about what it tracks or trains
 * — that stays the coach's to author (ADR 0016).
 */
export const LibraryExerciseId = TrimmedNonEmptyString;
export type LibraryExerciseId = typeof LibraryExerciseId.Type;

/**
 * One catalog Exercise as a client needs it (#72 user story 29: the Plan's
 * exercise picker states what logging will ask for *before* the exercise is
 * added, so nobody discovers mid-workout that a carry wanted a distance).
 *
 * `trackedMetrics` is the same catalog fact `PrescribedEntry` carries and
 * `deriveSetFields` renders from — declared once, in the catalog, and read
 * by both. It is required here, unlike on an Entry: an Entry may predate the
 * catalog join, but a catalog row that does not say what it tracks has
 * nothing to offer a picker.
 */
export const CatalogExercise = Schema.Struct({
  id: ExerciseId,
  name: TrimmedNonEmptyString,
  trackedMetrics: Schema.Array(MetricName),
  libraryId: Schema.optionalKey(LibraryExerciseId),
});
export type CatalogExercise = typeof CatalogExercise.Type;

export const ExerciseCatalog = Schema.Struct({
  exercises: Schema.Array(CatalogExercise),
});
export type ExerciseCatalog = typeof ExerciseCatalog.Type;

// --- authoring a catalog row (ADR 0016) -----------------------------------

/**
 * Minting a **User-authored exercise** (#102, ADR 0016): a catalog row
 * carrying only the name the user typed — no tracked metrics, no muscles, no
 * movement pattern. The coach fills the rest in later, so the row is born
 * with `trackedMetrics: []`, and *empty is the marker* that says un-enriched.
 *
 * The **client mints the id**, exactly as it does for every structural Plan
 * operation (#71): creating an exercise is its own write, outside the Plan
 * operation union and therefore outside the outbox's `commandId` dedupe (ADR
 * 0016 §3), so the id is the only thing standing between a retry and two
 * exercises. Applying the same id twice is consequently **not** an error —
 * it returns the row that is already there.
 */
export const CreateExerciseInput = Schema.Struct({
  exerciseId: ExerciseId,
  name: TrimmedNonEmptyString,
  /** Set when the row is picked from the Exercise library rather than typed. */
  libraryId: Schema.optionalKey(LibraryExerciseId),
});
export type CreateExerciseInput = typeof CreateExerciseInput.Type;

/**
 * Renaming a catalog row (#102, ADR 0016) — the pressure valve that makes
 * silent enrichment safe: a typo'd name would otherwise be enriched into
 * permanent nonsense.
 *
 * The **id does not move**, so the Plan, past Logged Sessions and every
 * derived analytic follow the row with no migration. The metadata does: a
 * renamed row is marked for re-enrichment by being emptied back to the
 * un-enriched state, because the metadata described the old name.
 */
export const RenameExerciseInput = Schema.Struct({
  exerciseId: ExerciseId,
  name: TrimmedNonEmptyString,
});
export type RenameExerciseInput = typeof RenameExerciseInput.Type;

export class ExerciseNotFoundError extends Schema.TaggedErrorClass<ExerciseNotFoundError>()(
  "ExerciseNotFoundError",
  {
    exerciseId: ExerciseId,
  },
) {
  override get message(): string {
    return `No catalog Exercise found for id ${this.exerciseId}`;
  }
}
