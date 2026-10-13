import { randomUUID } from "node:crypto";

import { NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { MigrationError } from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  applyPlanOperation,
  applyPlanOperations,
  foldProposedExercises,
  materializeDraftPlan,
  type ExerciseCatalogEntry,
  type PlanAuthoringContext,
} from "@repcoach/client-runtime/plan";
import {
  DEFAULT_RPE_CAPTURE_MODE,
  ExerciseNotFoundError,
  isPlanEditCommand,
  PlanOperationRejectedError,
  PrescribedSessionNotFoundError,
  PrescribedSetNotFoundError,
  ProposalAlreadyResolvedError,
  ProposalNotFoundError,
  type AddCheckInInput,
  type AddContextNoteInput,
  type EditContextNoteInput,
  type AddStandingConstraintInput,
  type ApplyUserChangeInput,
  type CadenceModelSetting,
  type ChangeStatus,
  type CheckIn,
  type CoachingFeedEntry,
  type CommitDeliberationOutputInput,
  type CommitDeliberationOutputResult,
  type ContextNote,
  type CatalogEnrichment,
  type CatalogExercise,
  type CreateExerciseInput,
  type DeliberationCadence,
  type DeliberationDataWindow,
  type DeliberationRunRecord,
  type DeliberationRunStage,
  type EvidenceClaim,
  type GoalSummary,
  type IntakeDraftPlan,
  type PlanOperation,
  type ProposedCatalogExercise,
  type CancelSessionResult,
  type GetDailySetCountsInput,
  type GetDailySetCountsResult,
  type ExportDataResult,
  type GetExerciseProgressResult,
  type BodyweightEntry,
  type ListBodyweightResult,
  type ImportWorkoutsResult,
  type LastActualForExerciseResult,
  type ActiveLoggedSessionSummary,
  type ListActiveSessionsResult,
  type ListSessionsResult,
  type LoggedSession,
  type LoggedSessionId,
  LoggedSessionHasActualsError,
  type LoggedSessionStatus,
  type LoggedSessionReviewStatus,
  type LoggedSessionSummary,
  type LogSetActualInput,
  type LogSetActualResult,
  EntryAlreadyLoggedError,
  type SwapEntryExerciseInput,
  type SwapEntryExerciseResult,
  type UnlogSetActualInput,
  type UnlogSetActualResult,
  type MetricName,
  type PlanSnapshot,
  type PrescribedBlock,
  type PrescribedEntry,
  type PrescribedMetricMap,
  type PrescribedSession,
  type PrescribedSet,
  type PrescribedTargetInterval,
  type Proposal,
  type ProposalExchange,
  type RemoveStandingConstraintInput,
  type RenameExerciseInput,
  type ResolveProposalInput,
  type ResolveProposalResult,
  type RpeCaptureMode,
  type SetGoalInput,
  type StandingConstraint,
  type StartSessionResult,
  type TokenUsage,
  type UnenrichedExercise,
} from "@repcoach/contracts";

import { summarizeRunLedger, type RunLedgerRecord } from "./store.ts";

import {
  assembleDeliberationRuns,
  type DeliberationRunDecisionInput,
  type DeliberationRunRecordInput,
} from "./deliberationRunRecord.ts";

import { seedExerciseCatalog } from "./exerciseCatalogSeed.ts";
import { importedSessionRows } from "./importedSessions.ts";
import {
  resolveLastActualForExercise,
  resolveBestE1rm,
  resolveExerciseProgress,
  resolveLastSetsForExercise,
  type FinishedSessionView,
} from "./lastActualForExercise.ts";
import { makeSqlitePersistenceLive } from "./sqlitePersistence.ts";
import {
  buildProposalExchange,
  deriveDigestHistory,
  renderCheckInSummary,
  seedCoachingFeed,
  seedDeliberationRuns,
  seedEvidenceRoster,
  seedObservationDecision,
  seedPlan,
  seedProposals,
  SEEDED_REVIEW_RUN_ID,
  testProposalRun,
  isUnenrichedExercise,
  Store,
  toCatalogExercise,
  toExerciseCatalog,
  type DecisionRecord,
  type PlanChangeWindow,
} from "./store.ts";

/**
 * `SqlStore` — a `Store` layer backed by real `node:sqlite` (Step 2A, task
 * 2A.1), satisfying the exact same `Store` `Context.Service` tag as the
 * in-memory `Store.layer` (`store.ts`). This is the persistence half of the
 * seam described in the Step 2A handoff: the dev-server's `server.ts` swaps
 * `Store.layer` for `SqlStore.layer({ filename })` and nothing else in the
 * tree — `rpcHandlers.ts`, the contracts, every thin-client task 0–8 —
 * changes.
 *
 * Durability comes from the SQL data alone: `logSetActual`/mutations write
 * straight to the SQLite file, and the seed only ever runs once (guarded by
 * `seedIfEmpty`) — reopening `SqlStore.layer` over the SAME file must NOT
 * wipe whatever landed in a prior process's lifetime, or the durability
 * story this task exists to prove would be a lie.
 */

// --- DB row shapes (snake_case columns, faithful to the migration) --------

interface PlanRow {
  readonly id: string;
  readonly plan_model: string;
  readonly created_at: string;
}

interface PrescribedSessionRow {
  readonly id: string;
  readonly plan_id: string;
  readonly order_index: number;
  readonly label: string | null;
}

interface BlockRow {
  readonly id: string;
  readonly prescribed_session_id: string;
  readonly order_index: number;
  readonly format: string;
  readonly params_json: string | null;
}

interface EntryRow {
  readonly id: string;
  readonly block_id: string;
  readonly order_index: number;
  readonly exercise_id: string;
}

/**
 * `entry` LEFT JOINed onto `exercise_catalog` (Step 2A, task 2A.3):
 * `tracked_metrics_json` is NULL when the Entry's `exercise_id` has no
 * catalog row (e.g. a test fixture inserted without seeding the catalog) —
 * `loadEntriesForBlock` treats that as "no catalog data", falling back to
 * the grid's target-key-derived field layout (back-compat).
 */
interface EntryWithCatalogRow extends EntryRow {
  readonly tracked_metrics_json: string | null;
}

interface PrescribedSetRow {
  readonly id: string;
  readonly entry_id: string;
  readonly order_index: number;
  readonly set_type: string;
  readonly target_json: string;
  readonly rest_sec: number | null;
}

interface DecisionRow {
  readonly id: string;
  readonly kind: string;
  readonly origin: string;
  readonly status: string;
  readonly summary: string;
  readonly rationale: string;
  readonly citations_json: string | null;
  readonly data_window_json: string | null;
  readonly created_at: string;
  /** Proposal lineage (ADR 0013 §9) — the Decision a Revision run answered; `null` for unprompted rows. */
  readonly in_response_to_id: string | null;
  /** The user's Revise prose that produced this run (ADR 0013 §1/§9, migration 007); `null` for unprompted rows. */
  readonly revise_prose: string | null;
  /** The Intake marker (ADR 0014 §6) — the drafted Plan on the one Decision an Intake produces; `null` elsewhere. */
  readonly intake_plan_json: string | null;
  /** The Change a Proposal proposes (#86, migration 009) — ADR 0015 operations; `null` when it proposes no Plan change. */
  readonly plan_operations_json: string | null;
  /** The catalog rows those operations need created first (ADR 0016, migration 015); `null` when the Proposal introduces no new Exercise. */
  readonly catalog_exercises_json: string | null;
  /** The working (#79, migration 008) — `null` wherever the run emitted nothing; never back-filled. */
  readonly measurements_json: string | null;
  readonly rule: string | null;
  readonly uncertainty: string | null;
  /**
   * The `deliberation_run` this row was committed by (migration 020); `null`
   * for every row written before run rows existed, and for the `kind='change'`
   * rows an accept or a direct Plan edit writes. Nullable permanently — see
   * the migration's note on why history without one is history, not an error.
   */
  readonly run_id: string | null;
}

/** One `deliberation_run` row (migration 020) — the record of a run, not of its output. */
interface DeliberationRunRow {
  readonly id: string;
  readonly cadence: string;
  /** `running` | `committed` | `failed` — see `DeliberationRunOutcome`. */
  readonly status: string;
  readonly failure_reason: string | null;
  /** The provenance envelope, assembled at commit; `null` while the run is still in flight. */
  readonly data_window_json: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

interface CoachingFeedRow {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly created_at: string;
  readonly proposal_id: string | null;
  /** The row this entry was minted from (#79, migration 008); `null` only on pre-008 Observation entries. */
  readonly decision_id: string | null;
}

interface LoggedSetActualRow {
  readonly id: string;
  readonly logged_session_id: string | null;
  readonly session_id: string | null;
  readonly entry_id: string;
  readonly set_id: string;
  readonly set_type: string;
  readonly actual_json: string;
  readonly command_id: string;
  readonly applied_at: string;
  /** Migration `020` (#83, ADR 0019) — 1 marks this row a retraction tombstone, 0 an ordinary logged actual. */
  readonly retraction: number;
}

/** `logged_entry_swap` row (#131, ADR 0019) — see migration `018`. */
interface LoggedEntrySwapRow {
  readonly id: string;
  readonly logged_session_id: string;
  readonly entry_id: string;
  readonly exercise_id: string;
  readonly command_id: string;
  readonly swapped_at: string;
}

/**
 * `logged_session` row (Step 2A, task 2A.2): `snapshot_json` is the frozen
 * deep copy of the Prescribed Session at instantiation time
 * (copy-on-instantiate, ADR 0006/0007) — see migration `002`.
 */
interface LoggedSessionRow {
  readonly id: string;
  readonly prescribed_session_id: string;
  readonly started_at: string;
  readonly status: string;
  readonly snapshot_json: string;
  readonly finished_at: string | null;
  /** Migration `017` (#132) — NULL for `active`/`cancelled` rows, which owe no review. */
  readonly review_status: string | null;
}

// --- seed-input storage row shapes (ADR 0011 §2, issue #34) ---------------

interface GoalRow {
  readonly id: string;
  readonly statement: string;
  readonly proxies_json: string;
  readonly updated_at: string;
}

interface StandingConstraintRow {
  readonly id: string;
  readonly text: string;
  readonly severity: string;
  readonly created_at: string;
}

interface CheckInRow {
  readonly id: string;
  readonly recorded_at: string;
  readonly sleep: number;
  readonly soreness: number;
  readonly stress: number;
  readonly energy: number;
}

interface ContextNoteRow {
  readonly id: string;
  readonly recorded_at: string;
  readonly text: string;
  readonly entry_id: string | null;
  readonly logged_session_id: string | null;
}

interface EvidenceClaimRow {
  readonly id: string;
  readonly claim: string;
  readonly source: string;
  readonly applicability: string;
  readonly trust: string;
}

/** An export row with its parseable `*_json` columns inlined as the JSON they hold (`exportData`). */
const inlineJsonColumns = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([column, value]) => {
      if (!column.endsWith("_json") || typeof value !== "string") return [column, value];
      try {
        return [column, JSON.parse(value) as unknown];
      } catch {
        return [column, value];
      }
    }),
  );

const toGoalSummary = (row: GoalRow): GoalSummary => ({
  statement: row.statement,
  proxies: JSON.parse(row.proxies_json) as ReadonlyArray<string>,
});

const toStandingConstraint = (row: StandingConstraintRow): StandingConstraint => ({
  id: row.id,
  text: row.text,
  severity: row.severity as StandingConstraint["severity"],
});

const toCheckIn = (row: CheckInRow): CheckIn => ({
  id: row.id,
  recordedAt: row.recorded_at,
  summary: renderCheckInSummary(row),
});

const toContextNote = (row: ContextNoteRow): ContextNote => ({
  id: row.id,
  recordedAt: row.recorded_at,
  text: row.text,
  ...(row.entry_id === null ? {} : { entryId: row.entry_id as never }),
  ...(row.logged_session_id === null ? {} : { loggedSessionId: row.logged_session_id as never }),
});

const toEvidenceClaim = (row: EvidenceClaimRow): EvidenceClaim => ({
  claim: row.claim,
  source: row.source,
  applicability: row.applicability,
  trust: row.trust as EvidenceClaim["trust"],
});

interface CommandSlot {
  readonly deferred: Deferred.Deferred<LogSetActualResult, never>;
}

// --- row <-> contract mapping ----------------------------------------------

const toCoachingFeedEntry = (row: CoachingFeedRow): CoachingFeedEntry => ({
  id: row.id as never,
  kind: row.kind as never,
  summary: row.summary,
  createdAt: row.created_at,
  ...(row.decision_id === null ? {} : { decisionId: row.decision_id as never }),
  ...(row.proposal_id === null ? {} : { proposalId: row.proposal_id as never }),
});

const toProposal = (row: DecisionRow): Proposal => ({
  id: row.id as never,
  origin: row.origin as never,
  status: row.status as never,
  summary: row.summary,
  rationale: row.rationale,
  createdAt: row.created_at,
  ...(row.intake_plan_json === null
    ? {}
    : { draftPlan: JSON.parse(row.intake_plan_json) as IntakeDraftPlan }),
  ...(row.plan_operations_json === null
    ? {}
    : { planOperations: JSON.parse(row.plan_operations_json) as ReadonlyArray<PlanOperation> }),
  ...(row.catalog_exercises_json === null
    ? {}
    : {
        catalogExercises: JSON.parse(
          row.catalog_exercises_json,
        ) as ReadonlyArray<ProposedCatalogExercise>,
      }),
  ...(row.in_response_to_id === null ? {} : { inResponseToId: row.in_response_to_id as never }),
});

const toDecisionRecord = (row: DecisionRow): DecisionRecord => ({
  id: row.id,
  kind: row.kind,
  origin: row.origin,
  /**
   * Asserted, not decoded. The column is plain `TEXT` (no `CHECK`), so a row
   * written by an older build could in principle carry a status this build's
   * union has never heard of — and refusing to read it here would turn that
   * into a dead store rather than one odd label. The guard that matters sits
   * on the WRITE side, where `DecisionRecord.status` is the contract's union
   * and the compiler enforces it.
   */
  status: row.status as DecisionRecord["status"],
  summary: row.summary,
  rationale: row.rationale,
  citationsJson: row.citations_json,
  dataWindowJson: row.data_window_json,
  createdAt: row.created_at,
  inResponseToId: row.in_response_to_id,
  runId: row.run_id,
  revisionProse: row.revise_prose,
  intakePlanJson: row.intake_plan_json,
  planOperationsJson: row.plan_operations_json,
  catalogExercisesJson: row.catalog_exercises_json,
  measurementsJson: row.measurements_json,
  rule: row.rule,
  uncertainty: row.uncertainty,
});

const toLogSetActualResult = (row: LoggedSetActualRow): LogSetActualResult => ({
  commandId: row.command_id as never,
  // `logged_session_id` is populated for real starting task 2A.2's
  // `startSession` + `logSetActual` threading; `session_id` (the
  // *prescribed* SessionId) is kept alongside for backward-compat display.
  loggedSessionId: (row.logged_session_id ?? "") as never,
  sessionId: (row.session_id ?? "") as never,
  entryId: row.entry_id as never,
  setId: row.set_id as never,
  setType: row.set_type as never,
  actual: JSON.parse(row.actual_json) as never,
  appliedAt: row.applied_at,
  retraction: false,
});

const toUnlogSetActualResult = (row: LoggedSetActualRow): UnlogSetActualResult => ({
  commandId: row.command_id as never,
  loggedSessionId: (row.logged_session_id ?? "") as never,
  entryId: row.entry_id as never,
  setId: row.set_id as never,
  appliedAt: row.applied_at,
  retraction: true,
});

/**
 * `actuals` is one ordered stream of logs and retractions (ADR 0019) — this
 * is the single place a raw `logged_set_actual` row becomes the discriminated
 * union `LoggedSession.actuals` carries, so the two arms cannot drift.
 */
const toActualResult = (row: LoggedSetActualRow): LogSetActualResult | UnlogSetActualResult =>
  row.retraction === 1 ? toUnlogSetActualResult(row) : toLogSetActualResult(row);

const toSwapResult = (row: LoggedEntrySwapRow): SwapEntryExerciseResult => ({
  commandId: row.command_id as never,
  loggedSessionId: row.logged_session_id as never,
  entryId: row.entry_id as never,
  exerciseId: row.exercise_id as never,
  swappedAt: row.swapped_at,
});

const toLoggedSession = (
  row: LoggedSessionRow,
  actuals: ReadonlyArray<LogSetActualResult | UnlogSetActualResult>,
  notes: ReadonlyArray<ContextNote>,
  swaps: ReadonlyArray<SwapEntryExerciseResult>,
): LoggedSession => ({
  loggedSessionId: row.id as never,
  prescribedSessionId: row.prescribed_session_id as never,
  startedAt: row.started_at,
  status: row.status as never,
  // Never mutated by a swap (ADR 0019) — the prescribed exercise here and the
  // performed exercise in `swaps` are read from this one response.
  session: JSON.parse(row.snapshot_json) as PrescribedSession,
  actuals,
  notes,
  swaps,
});

/**
 * Bumps a Set's `target.load` upper bound by 5kg, min untouched — the
 * frozen-in-flight test lever (Task 5, issue #19, G3), mirrored exactly
 * from the in-memory store's `mutatePrescribedSessionForTest`.
 */
const bumpLoadForTest = (target: PrescribedMetricMap): PrescribedMetricMap => {
  const { load, ...rest } = target;
  if (load === undefined) return target;
  const bumped: PrescribedTargetInterval = {
    ...(load.min === undefined ? {} : { min: load.min }),
    max: (load.max ?? 0) + 5,
  };
  return { ...rest, load: bumped };
};

const makeStoreLive = (options: { readonly seedDemoFixtures: boolean }) =>
  Layer.effect(Store)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // --- reconstructing the Scaffold tree from relational rows -----------

    const loadSetsForEntry = (entryId: string): Effect.Effect<ReadonlyArray<PrescribedSet>> =>
      sql<PrescribedSetRow>`
        SELECT * FROM prescribed_set WHERE entry_id = ${entryId} ORDER BY order_index
      `.pipe(
        Effect.map((rows) =>
          rows.map(
            (row): PrescribedSet => ({
              id: row.id as never,
              setType: row.set_type as never,
              target: JSON.parse(row.target_json) as PrescribedMetricMap,
              ...(row.rest_sec === null ? {} : { restSec: row.rest_sec }),
            }),
          ),
        ),
        Effect.orDie,
      );

    /**
     * `trackedMetrics` (Step 2A, task 2A.3, CONTEXT `Exercise catalog`: "a
     * set row renders exactly the metrics the catalog declares") is joined
     * in from `exercise_catalog` here rather than left for the client to
     * look up separately — because prescriptions are prefetched/cached
     * client-side, this travels offline automatically with the rest of the
     * Prescribed Session, no extra network call.
     */
    const loadEntriesForBlock = (blockId: string): Effect.Effect<ReadonlyArray<PrescribedEntry>> =>
      sql<EntryWithCatalogRow>`
        SELECT e.*, ec.tracked_metrics_json AS tracked_metrics_json
        FROM entry e
        LEFT JOIN exercise_catalog ec ON ec.id = e.exercise_id
        WHERE e.block_id = ${blockId}
        ORDER BY e.order_index
      `.pipe(
        Effect.orDie,
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            loadSetsForEntry(row.id).pipe(
              Effect.map(
                (sets): PrescribedEntry => ({
                  id: row.id as never,
                  exerciseId: row.exercise_id as never,
                  sets,
                  ...(row.tracked_metrics_json === null
                    ? {}
                    : { trackedMetrics: JSON.parse(row.tracked_metrics_json) as ReadonlyArray<MetricName> }),
                }),
              ),
            ),
          ),
        ),
      );

    const loadBlocksForSession = (sessionId: string): Effect.Effect<ReadonlyArray<PrescribedBlock>> =>
      sql<BlockRow>`
        SELECT * FROM block WHERE prescribed_session_id = ${sessionId} ORDER BY order_index
      `.pipe(
        Effect.orDie,
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            loadEntriesForBlock(row.id).pipe(
              Effect.map(
                (entries): PrescribedBlock => ({
                  id: row.id as never,
                  format: row.format as never,
                  ...(row.params_json === null ? {} : { params: JSON.parse(row.params_json) }),
                  entries,
                }),
              ),
            ),
          ),
        ),
      );

    const loadPrescribedSession = (sessionId: string): Effect.Effect<Option.Option<PrescribedSession>> =>
      sql<PrescribedSessionRow>`
        SELECT * FROM prescribed_session WHERE id = ${sessionId}
      `.pipe(
        Effect.orDie,
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (row === undefined) return Effect.succeed(Option.none<PrescribedSession>());
          return loadBlocksForSession(row.id).pipe(
            Effect.map((blocks) =>
              Option.some<PrescribedSession>({
                id: row.id as never,
                ...(row.label === null ? {} : { name: row.label }),
                blocks,
              }),
            ),
          );
        }),
      );

    const loadPlan = (): Effect.Effect<PlanSnapshot> =>
      sql<PlanRow>`SELECT * FROM plan LIMIT 1`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (row === undefined) {
            // One active Plan for the single user (schema comment) — this
            // should be unreachable once `seedIfEmpty` has run.
            return Effect.die(new Error("SqlStore: no plan row found — persistence was not seeded"));
          }
          return sql<PrescribedSessionRow>`
            SELECT * FROM prescribed_session WHERE plan_id = ${row.id} ORDER BY order_index
          `.pipe(
            Effect.orDie,
            Effect.flatMap((sessionRows) =>
              Effect.forEach(sessionRows, (sessionRow) =>
                loadBlocksForSession(sessionRow.id).pipe(
                  Effect.map(
                    (blocks): PrescribedSession => ({
                      id: sessionRow.id as never,
                      ...(sessionRow.label === null ? {} : { name: sessionRow.label }),
                      blocks,
                    }),
                  ),
                ),
              ),
            ),
            Effect.map(
              (sessions): PlanSnapshot => ({ id: row.id as never, planModel: row.plan_model, sessions }),
            ),
          );
        }),
      );

    // Both surfaces below withhold the **live Intake artifact** — the Intake
    // Proposal while it is still `pending` (ADR 0014 §6: "never pending on
    // Today, never in the Coach badge"). It is decided in place inside the
    // takeover, before Today is ever populated, so offering it here would ask
    // the user to decide twice on something they already decided. The moment it
    // is resolved it is an ordinary historical Decision and hides from nothing,
    // which is what keeps the calibration note permanently readable beside the
    // plan it qualifies (§7).
    //
    // Enforced in the store rather than by filtering at the call sites: the
    // store is the trust boundary, so the rule holds for every reader.
    const loadCoachingFeed = (): Effect.Effect<ReadonlyArray<CoachingFeedEntry>> =>
      sql<CoachingFeedRow>`
        SELECT f.* FROM coaching_feed_entry f
        LEFT JOIN decision d ON d.id = f.proposal_id
        WHERE d.id IS NULL OR d.intake_plan_json IS NULL OR d.status <> 'pending'
        ORDER BY f.created_at, f.id
      `.pipe(
        Effect.map((rows) => rows.map(toCoachingFeedEntry)),
        Effect.orDie,
      );

    const loadProposals = (): Effect.Effect<ReadonlyArray<Proposal>> =>
      sql<DecisionRow>`
        SELECT * FROM decision
        WHERE kind = 'proposal' AND NOT (intake_plan_json IS NOT NULL AND status = 'pending')
        ORDER BY created_at, id
      `.pipe(
        Effect.map((rows) => rows.map(toProposal)),
        Effect.orDie,
      );


    /**
     * The Coach record's run history (ADR 0011 §8) — three reads, joined in
     * memory by `assembleDeliberationRuns`.
     *
     * Three queries rather than one join, deliberately. The grouping has to
     * hold a run with NO decisions (the silent run this whole surface exists
     * for) and a decision with NO run (everything committed before run rows),
     * which is a full outer join between two tables plus an aggregate over a
     * third. At single-user scale (ADR 0005) three small selects and a map is
     * both cheaper to read and impossible to get subtly wrong in SQL.
     *
     * `kind <> 'change'` is the one filter that matters: an applied Change is
     * the *effect* of accepting a Proposal (ADR 0008), written by
     * `resolveProposal` and by direct Plan edits, not something a Deliberation
     * run emitted. It carries a `data_window_json` that is a command marker
     * rather than a provenance envelope, so leaving it in would mint a
     * reconstructed "run" per Plan edit.
     */
    const loadDeliberationRuns = (): Effect.Effect<ReadonlyArray<DeliberationRunRecord>> =>
      Effect.gen(function* () {
        const runRows = yield* sql<DeliberationRunRow>`
          SELECT * FROM deliberation_run ORDER BY started_at DESC, id DESC
        `;
        // `kind <> 'change'` is the filter that matters most: an applied
        // Change is the EFFECT of accepting a Proposal (ADR 0008), written by
        // `resolveProposal` and by direct Plan edits, not something a
        // Deliberation run emitted. Its `data_window_json` is a command marker
        // rather than a provenance envelope, so leaving it in would mint a
        // reconstructed "run" for every Plan edit the user ever made.
        //
        // The second clause withholds the **live Intake artifact** — the Intake
        // Proposal while it is still `pending` (ADR 0014 §6: "never pending on
        // Today, never in the Coach badge"), exactly as `loadCoachingFeed` and
        // `loadProposals` above do. It is decided in place inside the takeover,
        // and the record must not offer it back before that has happened. The
        // moment it resolves it is ordinary history and hides from nothing.
        const decisionRows = yield* sql<DecisionRow>`
          SELECT * FROM decision
          WHERE kind <> 'change'
            AND NOT (intake_plan_json IS NOT NULL AND kind = 'proposal' AND status = 'pending')
          ORDER BY created_at, id
        `;
        const ledgerRows = yield* sql<{ readonly run_id: string; readonly stage: string }>`
          SELECT DISTINCT run_id, stage FROM deliberation_run_ledger
        `;

        const ledgerStagesByRun = new Map<string, Set<string>>();
        for (const row of ledgerRows) {
          const existing = ledgerStagesByRun.get(row.run_id);
          if (existing === undefined) ledgerStagesByRun.set(row.run_id, new Set([row.stage]));
          else existing.add(row.stage);
        }

        const runs: ReadonlyArray<DeliberationRunRecordInput> = runRows.map((row) => ({
          runId: row.id,
          cadence: row.cadence as DeliberationCadence,
          status: row.status as "running" | "committed" | "failed",
          failureReason: row.failure_reason ?? undefined,
          dataWindowJson: row.data_window_json ?? undefined,
          startedAt: row.started_at,
          finishedAt: row.finished_at ?? undefined,
        }));

        const decisions: ReadonlyArray<DeliberationRunDecisionInput> = decisionRows.map((row) => ({
          decisionId: row.id,
          kind: row.kind,
          status: row.status,
          summary: row.summary,
          createdAt: row.created_at,
          runId: row.run_id ?? undefined,
          dataWindowJson: row.data_window_json ?? undefined,
          reviseProse: row.revise_prose ?? undefined,
        }));

        return assembleDeliberationRuns(runs, decisions, ledgerStagesByRun);
      }).pipe(Effect.orDie);

    /**
     * Every `decision` row, keyed by id — the shared input `buildProposalExchange`
     * (`store.ts`) needs to walk a lineage chain. At single-user scale (ADR
     * 0005) a full-table load per exchange read is cheap; a chain-scoped
     * recursive query would earn nothing yet.
     */
    const loadAllDecisions = (): Effect.Effect<ReadonlyMap<string, DecisionRecord>> =>
      sql<DecisionRow>`SELECT * FROM decision`.pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.id, toDecisionRecord(row)] as const))),
        Effect.orDie,
      );

    const loadLoggedSession = (loggedSessionId: string): Effect.Effect<Option.Option<LoggedSession>> =>
      Effect.gen(function* () {
        const rows = yield* sql<LoggedSessionRow>`
          SELECT * FROM logged_session WHERE id = ${loggedSessionId}
        `;
        const row = rows[0];
        if (row === undefined) return Option.none<LoggedSession>();
        const actualRows = yield* sql<LoggedSetActualRow>`
          SELECT * FROM logged_set_actual WHERE logged_session_id = ${loggedSessionId} ORDER BY applied_at, rowid
        `;
        const noteRows = yield* sql<ContextNoteRow>`
          SELECT * FROM context_note WHERE logged_session_id = ${loggedSessionId} ORDER BY recorded_at, id
        `;
        const swapRows = yield* sql<LoggedEntrySwapRow>`
          SELECT * FROM logged_entry_swap WHERE logged_session_id = ${loggedSessionId} ORDER BY swapped_at, id
        `;
        return Option.some(
          toLoggedSession(
            row,
            actualRows.map(toActualResult),
            noteRows.map(toContextNote),
            swapRows.map(toSwapResult),
          ),
        );
      }).pipe(Effect.orDie);

    // --- seeding (once — see `seedIfEmpty` below) --------------------------

    const insertPrescribedSessionTree = (
      session: PrescribedSession,
      planId: string,
      orderIndex: number,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO prescribed_session (id, plan_id, order_index, label)
          VALUES (${session.id}, ${planId}, ${orderIndex}, ${session.name ?? null})
        `;
        yield* Effect.forEach(
          session.blocks,
          (block, blockIndex) =>
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO block (id, prescribed_session_id, order_index, format, params_json)
                VALUES (
                  ${block.id}, ${session.id}, ${blockIndex}, ${block.format},
                  ${block.params === undefined ? null : JSON.stringify(block.params)}
                )
              `;
              yield* Effect.forEach(
                block.entries,
                (entry, entryIndex) =>
                  Effect.gen(function* () {
                    yield* sql`
                      INSERT INTO entry (id, block_id, order_index, exercise_id)
                      VALUES (${entry.id}, ${block.id}, ${entryIndex}, ${entry.exerciseId})
                    `;
                    yield* Effect.forEach(
                      entry.sets,
                      (set, setIndex) =>
                        sql`
                          INSERT INTO prescribed_set (id, entry_id, order_index, set_type, target_json, rest_sec)
                          VALUES (
                            ${set.id}, ${entry.id}, ${setIndex}, ${set.setType},
                            ${JSON.stringify(set.target)}, ${set.restSec ?? null}
                          )
                        `,
                      { discard: true },
                    );
                  }),
                { discard: true },
              );
            }),
          { discard: true },
        );
      });

    /**
     * Writes a whole `PlanSnapshot` back over the Plan's relational rows
     * (#71). Structural edits are applied by the pure `applyPlanOperation`
     * against the loaded snapshot and then persisted wholesale, rather than
     * hand-written as a dozen bespoke UPDATE/INSERT/DELETE paths. At
     * single-user scale (ADR 0005) the rewrite is a handful of rows, and the
     * payoff is that the SQLite store and the in-memory store cannot
     * disagree about what an operation means — there is exactly one
     * implementation of the rules, and it is unit-tested on its own.
     *
     * A structural edit preserves ids across the rewrite (the snapshot
     * carries them), so `logged_set_actual.set_id` and every other by-value
     * reference still resolves. Accepting a drafted Plan (#75) is the one
     * caller that does NOT: the draft carries no ids, so materialization
     * mints them and every prior Prescribed Session ceases to exist. That is
     * survivable for the same reason the rewrite is safe at all — Logged
     * Sessions hold frozen JSON snapshots (copy-on-instantiate, ADR
     * 0006/0007) and are not touched here, so an in-flight workout keeps
     * logging against its own copy.
     */
    const rewritePlanTree = (plan: PlanSnapshot): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM prescribed_set WHERE entry_id IN (
            SELECT e.id FROM entry e
            JOIN block b ON b.id = e.block_id
            JOIN prescribed_session s ON s.id = b.prescribed_session_id
            WHERE s.plan_id = ${plan.id}
          )
        `;
        yield* sql`
          DELETE FROM entry WHERE block_id IN (
            SELECT b.id FROM block b
            JOIN prescribed_session s ON s.id = b.prescribed_session_id
            WHERE s.plan_id = ${plan.id}
          )
        `;
        yield* sql`
          DELETE FROM block WHERE prescribed_session_id IN (
            SELECT id FROM prescribed_session WHERE plan_id = ${plan.id}
          )
        `;
        yield* sql`DELETE FROM prescribed_session WHERE plan_id = ${plan.id}`;
        yield* Effect.forEach(
          plan.sessions,
          (session, index) => insertPrescribedSessionTree(session, plan.id, index),
          { discard: true },
        );
      });

    /**
     * The Exercise catalog as the authoring operations need it: the name a
     * Change summary reads ("Added Face Pull") and the `trackedMetrics` a
     * newly added Entry inherits, so logging renders the right fields for it
     * without a second lookup (CONTEXT `Exercise catalog`).
     */
    interface CatalogRow {
      readonly id: string;
      readonly name: string;
      readonly tracked_metrics_json: string | null;
      readonly library_id: string | null;
    }

    const toCatalogEntry = (row: CatalogRow): ExerciseCatalogEntry => ({
      id: row.id,
      name: row.name,
      ...(row.tracked_metrics_json === null
        ? {}
        : { trackedMetrics: JSON.parse(row.tracked_metrics_json) as ReadonlyArray<MetricName> }),
      ...(row.library_id === null ? {} : { libraryId: row.library_id }),
    });

    const loadAuthoringContext = (): Effect.Effect<PlanAuthoringContext> =>
      sql<CatalogRow>`SELECT id, name, tracked_metrics_json, library_id FROM exercise_catalog`.pipe(
        Effect.map((rows) => ({ exercises: rows.map(toCatalogEntry) })),
        Effect.orDie,
      );

    /** One catalog row in the wire shape a picker reads (#102) — `None` when the id is unknown. */
    const loadCatalogExercise = (
      exerciseId: string,
    ): Effect.Effect<Option.Option<CatalogExercise>, SqlError> =>
      sql<CatalogRow>`SELECT id, name, tracked_metrics_json, library_id FROM exercise_catalog WHERE id = ${exerciseId}`.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          return row === undefined ? Option.none() : Option.some(toCatalogExercise(toCatalogEntry(row)));
        }),
      );

    /**
     * One catalog row with BOTH halves of its metadata (#104) — the tracked
     * metrics a picker and the logging grid read, and the muscles/movement
     * pattern only the coach's own analytics queries do. `loadAuthoringContext`
     * deliberately does not select these two columns (Plan authoring has no
     * use for them); enrichment is the one path that needs the whole row.
     */
    interface CatalogMetadataRow {
      readonly id: string;
      readonly name: string;
      readonly trackedMetrics: ReadonlyArray<MetricName>;
      readonly muscles: ReadonlyArray<string> | undefined;
      readonly movementPattern: string | undefined;
    }

    const loadCatalogMetadata = (): Effect.Effect<ReadonlyArray<CatalogMetadataRow>, SqlError> =>
      sql<{
        readonly id: string;
        readonly name: string;
        readonly tracked_metrics_json: string | null;
        readonly muscles_json: string | null;
        readonly movement_pattern: string | null;
      }>`SELECT id, name, tracked_metrics_json, muscles_json, movement_pattern FROM exercise_catalog`.pipe(
        Effect.map((found) =>
          found.map((row) => ({
            id: row.id,
            name: row.name,
            trackedMetrics:
              row.tracked_metrics_json === null
                ? []
                : (JSON.parse(row.tracked_metrics_json) as ReadonlyArray<MetricName>),
            muscles:
              row.muscles_json === null
                ? undefined
                : (JSON.parse(row.muscles_json) as ReadonlyArray<string>),
            movementPattern: row.movement_pattern ?? undefined,
          })),
        ),
      );

    // Dev/e2e demo fixtures ONLY — a seeded plan, its matching Exercise
    // catalog rows, proposals, and coaching feed entries so the app has
    // something to show without a real intake. Production must NOT run this:
    // a real user's Exercise catalog starts empty and is coach-authored
    // through Intake/Deliberation (CONTEXT `Exercise catalog`), never
    // pre-filled with these demo rows.
    const seedDemoFixtures = (): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const plan = seedPlan();
        yield* sql`
          INSERT INTO plan (id, plan_model, created_at)
          VALUES (${plan.id}, ${plan.planModel}, ${new Date().toISOString()})
        `;
        yield* Effect.forEach(
          plan.sessions,
          (session, index) => insertPrescribedSessionTree(session, plan.id, index),
          { discard: true },
        );

        yield* Effect.forEach(
          seedExerciseCatalog(),
          (exercise) =>
            sql`
              INSERT INTO exercise_catalog (id, name, tracked_metrics_json, muscles_json, movement_pattern)
              VALUES (${exercise.id}, ${exercise.name}, ${JSON.stringify(exercise.trackedMetrics)}, NULL, NULL)
            `,
          { discard: true },
        );

        // The runs, before the Decisions that name them: the seeded
        // Observation and Proposal both came out of one Session review, and
        // two of the three seeded runs exist precisely to carry states that
        // emit no Decision at all (see `seedDeliberationRuns`).
        yield* Effect.forEach(
          seedDeliberationRuns(),
          (run) =>
            sql`
              INSERT INTO deliberation_run (id, cadence, status, failure_reason, data_window_json, started_at, finished_at)
              VALUES (
                ${run.runId}, ${run.cadence}, ${run.status}, ${run.failureReason ?? null},
                ${run.dataWindowJson ?? null}, ${run.startedAt}, ${run.finishedAt ?? null}
              )
            `,
          { discard: true },
        );

        yield* Effect.forEach(
          seedProposals(),
          (proposal) =>
            sql`
              INSERT INTO decision
                (id, kind, origin, status, summary, rationale, citations_json, data_window_json, created_at, plan_operations_json, run_id)
              VALUES (
                ${proposal.id}, 'proposal', ${proposal.origin}, ${proposal.status},
                ${proposal.summary}, ${proposal.rationale}, NULL, NULL, ${proposal.createdAt},
                ${proposal.planOperations === undefined ? null : JSON.stringify(proposal.planOperations)},
                ${SEEDED_REVIEW_RUN_ID}
              )
            `,
          { discard: true },
        );

        // The Observation the seeded feed's first entry points at (#79) — the
        // one seeded row carrying a full set of working, so the Coach surface
        // has something real to expand in dev and in e2e. Kept in `store.ts`
        // beside the rest of the seed so the two layers cannot drift.
        {
          const observation = seedObservationDecision();
          yield* sql`
            INSERT INTO decision
              (id, kind, origin, status, summary, rationale, citations_json, data_window_json, created_at, measurements_json, rule, uncertainty, run_id)
            VALUES (
              ${observation.id}, ${observation.kind}, ${observation.origin}, ${observation.status},
              ${observation.summary}, ${observation.rationale}, ${observation.citationsJson},
              ${observation.dataWindowJson}, ${observation.createdAt},
              ${observation.measurementsJson}, ${observation.rule}, ${observation.uncertainty},
              ${observation.runId}
            )
          `;
        }

        // After the decisions, not before: `coaching_feed_entry.proposal_id`
        // is a foreign key, so an entry naming a Proposal cannot be written
        // until that Proposal's row exists (#79 added the entry that does).
        yield* Effect.forEach(
          seedCoachingFeed(),
          (entry) =>
            sql`
              INSERT INTO coaching_feed_entry (id, kind, summary, created_at, proposal_id, decision_id)
              VALUES (
                ${entry.id}, ${entry.kind}, ${entry.summary}, ${entry.createdAt},
                ${entry.proposalId ?? null}, ${entry.decisionId ?? null}
              )
            `,
          { discard: true },
        );
      });

    // Production's bootstrap: the schema keeps exactly one `plan` row (the
    // single user's Plan — `loadPlan` dies without one), but with none of the
    // demo Sessions/Exercise-catalog rows above. Sessions and catalog entries
    // arrive for real once Intake accepts a drafted Plan (`resolveProposal`
    // authors any new Exercise the draft names — see `materializeDraftPlan`).
    const seedEmptyPlan = (): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO plan (id, plan_model, created_at)
          VALUES (${randomUUID()}, ${"unconfigured"}, ${new Date().toISOString()})
        `;
      });

    // Evidence-base roster (ADR 0003 §5) — server-seeded, not user-authored;
    // the vetted corpus read from the seed document (#87). Real production
    // data (unlike `seedDemoFixtures` above), so it seeds regardless of
    // whether demo fixtures are enabled. Guarded by its own emptiness check
    // — not the Plan-count gate below, which stays empty forever when demo
    // fixtures are off — and mutually exclusive with migration 010's
    // reseat-if-already-populated writer on the same table.
    const seedEvidenceRosterIfEmpty = (): Effect.Effect<void, SqlError> =>
      sql<{ readonly count: number }>`SELECT COUNT(*) as count FROM evidence_claim`.pipe(
        Effect.flatMap((rows) =>
          (rows[0]?.count ?? 0) > 0
            ? Effect.void
            : Effect.forEach(
                seedEvidenceRoster(),
                (entry) =>
                  sql`
                    INSERT INTO evidence_claim (id, claim, source, applicability, trust, created_at)
                    VALUES (
                      ${entry.id}, ${entry.claim}, ${entry.source}, ${entry.applicability}, ${entry.trust},
                      ${new Date().toISOString()}
                    )
                  `,
                { discard: true },
              ),
        ),
      );

    const clearAllTables = (): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM logged_set_actual`;
        yield* sql`DELETE FROM logged_entry_swap`;
        yield* sql`DELETE FROM logged_session`;
        yield* sql`DELETE FROM prescribed_set`;
        yield* sql`DELETE FROM entry`;
        yield* sql`DELETE FROM block`;
        yield* sql`DELETE FROM prescribed_session`;
        yield* sql`DELETE FROM plan`;
        yield* sql`DELETE FROM exercise_catalog`;
        yield* sql`DELETE FROM coaching_feed_entry`;
        yield* sql`DELETE FROM decision`;
        yield* sql`DELETE FROM goal`;
        yield* sql`DELETE FROM standing_constraint`;
        yield* sql`DELETE FROM check_in`;
        yield* sql`DELETE FROM context_note`;
        yield* sql`DELETE FROM evidence_claim`;
        yield* sql`DELETE FROM cadence_model_setting`;
        yield* sql`DELETE FROM cycle_review_schedule`;
        yield* sql`DELETE FROM deliberation_run_ledger`;
        yield* sql`DELETE FROM deliberation_run`;
        yield* sql`DELETE FROM rpe_capture_setting`;
        yield* sql`DELETE FROM bodyweight_entry`;
      });

    // Seed exactly once, guarded by "is the DB empty". A durability run
    // deliberately reopens `SqlStore.layer` over the SAME file (the whole
    // point of task 2A.1's rung-1 test) — re-seeding on every layer build
    // would silently erase whatever `logSetActual`/mutation history had
    // landed in a prior process's lifetime.
    yield* sql<{ readonly count: number }>`SELECT COUNT(*) as count FROM plan`.pipe(
      Effect.flatMap((rows) =>
        (rows[0]?.count ?? 0) > 0
          ? Effect.void
          : options.seedDemoFixtures
            ? seedDemoFixtures()
            : seedEmptyPlan(),
      ),
      Effect.orDie,
    );
    yield* seedEvidenceRosterIfEmpty().pipe(Effect.orDie);

    // --- change notification for subscribe* --------------------------------
    //
    // SQLite has no native change-feed, so a single in-process tick stands
    // in for it: every mutating operation below bumps it. This reproduces
    // the in-memory store's observable behavior exactly — there, ALL of
    // `subscribeCoachingFeed`/`subscribeProposals`/`subscribePlan` are
    // derived from the same `dataRef`, so any store mutation re-emits all
    // three.
    const changeTick = yield* SubscriptionRef.make(0);
    const bumpChangeTick = SubscriptionRef.update(changeTick, (n) => n + 1);

    // Every finished Logged Session in the shape the swap-aware, net-state
    // resolvers read (`lastActualForExercise.ts`). Sessions hold frozen JSON
    // snapshots rather than normalised entry/set rows, so the rows are pulled
    // with plain SELECTs and the resolution runs in JS, in one place for both
    // `Store` layers.
    const loadFinishedSessionViews: Effect.Effect<ReadonlyArray<FinishedSessionView>, SqlError> = Effect.gen(
      function* () {
        const rows = yield* sql<LoggedSessionRow>`
          SELECT * FROM logged_session WHERE status = 'finished'
        `;
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const actualRows = yield* sql<LoggedSetActualRow>`
              SELECT * FROM logged_set_actual WHERE logged_session_id = ${row.id} ORDER BY applied_at, rowid
            `;
            const swapRows = yield* sql<LoggedEntrySwapRow>`
              SELECT * FROM logged_entry_swap WHERE logged_session_id = ${row.id} ORDER BY swapped_at, id
            `;
            const view: FinishedSessionView = {
              loggedSessionId: row.id,
              finishedAt: row.finished_at ?? undefined,
              startedAt: row.started_at,
              snapshot: JSON.parse(row.snapshot_json) as PrescribedSession,
              actuals: actualRows.map(toActualResult),
              swaps: swapRows.map((swapRow) => ({
                entryId: swapRow.entry_id,
                exerciseId: swapRow.exercise_id,
                swappedAt: swapRow.swapped_at,
              })),
            };
            return view;
          }),
        );
      },
    );

    // --- logSetActual: idempotent by the DB's UNIQUE(command_id) constraint,
    // with the same in-process Deferred/pause-gate layered on top as the
    // in-memory store (`store.ts`) for the half-open-link semantics -------

    const inFlightRef = yield* Ref.make<ReadonlyMap<string, CommandSlot>>(new Map());
    const pauseGateRef = yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none());

    const currentPauseGate = Ref.get(pauseGateRef).pipe(
      Effect.flatMap((gate) => (Option.isSome(gate) ? Deferred.await(gate.value) : Effect.void)),
    );

    const applyNow = (input: LogSetActualInput): Effect.Effect<LogSetActualResult> =>
      Effect.gen(function* () {
        const id = randomUUID();
        const appliedAt = new Date().toISOString();
        // Write lands immediately regardless of the pause gate (see
        // `pauseAcks` below) — `ON CONFLICT(command_id) DO NOTHING` makes a
        // replayed commandId a no-op insert; the read-back after always
        // returns the one canonical stored row (task 2A.1's idempotency
        // guarantee, now enforced at the DB layer instead of only in Refs).
        yield* sql`
          INSERT INTO logged_set_actual
            (id, logged_session_id, session_id, entry_id, set_id, set_type, actual_json, command_id, applied_at)
          VALUES (
            ${id}, ${input.loggedSessionId}, ${input.sessionId}, ${input.entryId}, ${input.setId}, ${input.setType},
            ${JSON.stringify(input.actual)}, ${input.commandId}, ${appliedAt}
          )
          ON CONFLICT(command_id) DO NOTHING
        `;
        const rows = yield* sql<LoggedSetActualRow>`
          SELECT * FROM logged_set_actual WHERE command_id = ${input.commandId}
        `;
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.die(
            new Error(`SqlStore: logged_set_actual row missing for commandId ${input.commandId}`),
          );
        }
        yield* bumpChangeTick;
        return toLogSetActualResult(row);
      }).pipe(Effect.orDie);

    const logSetActual = (input: LogSetActualInput): Effect.Effect<LogSetActualResult> =>
      Effect.gen(function* () {
        const commandId = input.commandId as string;

        const { slot, isNew }: { readonly slot: CommandSlot; readonly isNew: boolean } =
          yield* Ref.modify(inFlightRef, (map) => {
            const existing = map.get(commandId);
            if (existing !== undefined) {
              return [{ slot: existing, isNew: false }, map];
            }
            const deferred = Deferred.makeUnsafe<LogSetActualResult, never>();
            const nextSlot: CommandSlot = { deferred };
            return [{ slot: nextSlot, isNew: true }, new Map(map).set(commandId, nextSlot)];
          });

        if (isNew) {
          const result = yield* applyNow(input);
          // Withhold the ack while paused; the write above already landed
          // in the DB, so a concurrent duplicate observes it too.
          //
          // The wait — and only the wait — must stay interruptible: the RPC
          // server interrupts every in-flight request fiber when its
          // connection dies (`RpcServer.ts`'s per-client fiber teardown), and
          // a command whose ack dies with the socket is exactly #84's bug.
          // `result` is already durable at this point, so completing the
          // slot unconditionally via `Effect.ensuring` — even when the wait
          // above is what got interrupted — is what lets a replay landing on
          // a *new* connection observe it instead of awaiting a `Deferred`
          // nothing will ever complete.
          yield* currentPauseGate.pipe(Effect.ensuring(Deferred.succeed(slot.deferred, result)));
          return result;
        }

        return yield* Deferred.await(slot.deferred);
      });

    // Swap (#131, ADR 0019): idempotent by the DB's UNIQUE(command_id)
    // constraint, exactly like `logSetActual`'s `applyNow` above, but with
    // no pause-gate/Deferred machinery — a swap has no half-open-link
    // semantics to model. The already-logged-Sets guard runs only for a
    // genuinely new `commandId` (checked via a read-back before the guard),
    // so a replay of a swap that already landed is never re-evaluated
    // against Sets logged since.
    const swapEntryExercise = (
      input: SwapEntryExerciseInput,
    ): Effect.Effect<SwapEntryExerciseResult, EntryAlreadyLoggedError> =>
      Effect.gen(function* () {
        const already = yield* sql<LoggedEntrySwapRow>`
          SELECT * FROM logged_entry_swap WHERE command_id = ${input.commandId}
        `;
        if (already[0] !== undefined) {
          return toSwapResult(already[0]);
        }
        // Net state, not a raw row count (#148). A retraction (migration `021`)
        // is a row in `logged_set_actual` too, so `COUNT(*)` counts a Set that
        // was logged then un-logged and refuses the swap forever. The guard has
        // to ask the same question `Grid.canSwapEntry` asks on the client —
        // "is any Set on this Entry logged in NET state" — i.e. the last row
        // per `set_id` in application order (`applied_at, rowid`, the same order
        // `getLoggedSession` reads them back in), counting only the ones whose
        // latest row is a log. This is the SQL twin of `foldNetActuals`
        // (`@repcoach/contracts`); `sqlStore.test.ts` pins the two together.
        const actualRows = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM (
            SELECT retraction,
              ROW_NUMBER() OVER (
                PARTITION BY set_id ORDER BY applied_at DESC, rowid DESC
              ) AS rn
            FROM logged_set_actual
            WHERE logged_session_id = ${input.loggedSessionId} AND entry_id = ${input.entryId}
          ) latest
          WHERE rn = 1 AND retraction = 0
        `;
        if (Number(actualRows[0]?.n ?? 0) > 0) {
          return yield* Effect.fail(
            new EntryAlreadyLoggedError({
              commandId: input.commandId,
              loggedSessionId: input.loggedSessionId,
              entryId: input.entryId,
            }),
          );
        }
        const id = randomUUID();
        const swappedAt = new Date().toISOString();
        yield* sql`
          INSERT INTO logged_entry_swap (id, logged_session_id, entry_id, exercise_id, command_id, swapped_at)
          VALUES (
            ${id}, ${input.loggedSessionId}, ${input.entryId}, ${input.exerciseId}, ${input.commandId}, ${swappedAt}
          )
          ON CONFLICT(command_id) DO NOTHING
        `;
        const rows = yield* sql<LoggedEntrySwapRow>`
          SELECT * FROM logged_entry_swap WHERE command_id = ${input.commandId}
        `;
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.die(
            new Error(`SqlStore: logged_entry_swap row missing for commandId ${input.commandId}`),
          );
        }
        yield* bumpChangeTick;
        return toSwapResult(row);
      }).pipe(
        // Only the SQL layer's own failures become defects — the typed
        // `EntryAlreadyLoggedError` above must reach the RPC error channel,
        // not die.
        Effect.catchTag("SqlError", (error) => Effect.die(error)),
      );

    // Retraction (#83, ADR 0019): idempotent by the DB's UNIQUE(command_id)
    // constraint, exactly like `swapEntryExercise`'s `applyNow`-equivalent —
    // no pause-gate/Deferred machinery (a retraction has no half-open-link
    // semantics to model) and no rejectable-error arm (no FK/lookup
    // validation, migration `020`'s note). `set_type`/`actual_json` carry
    // placeholder values (`''`/`'{}'`) rather than the input's real ones,
    // because there ARE none — `UnlogSetActualInput` carries no metric map or
    // `setType` — and `toUnlogSetActualResult` never reads either column back
    // off a retraction row, so the placeholder is inert.
    const unlogSetActual = (input: UnlogSetActualInput): Effect.Effect<UnlogSetActualResult> =>
      Effect.gen(function* () {
        const id = randomUUID();
        const appliedAt = new Date().toISOString();
        yield* sql`
          INSERT INTO logged_set_actual
            (id, logged_session_id, session_id, entry_id, set_id, set_type, actual_json, command_id, applied_at, retraction)
          VALUES (
            ${id}, ${input.loggedSessionId}, NULL, ${input.entryId}, ${input.setId}, '', '{}', ${input.commandId}, ${appliedAt}, 1
          )
          ON CONFLICT(command_id) DO NOTHING
        `;
        const rows = yield* sql<LoggedSetActualRow>`
          SELECT * FROM logged_set_actual WHERE command_id = ${input.commandId}
        `;
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.die(
            new Error(`SqlStore: logged_set_actual retraction row missing for commandId ${input.commandId}`),
          );
        }
        yield* bumpChangeTick;
        return toUnlogSetActualResult(row);
      }).pipe(Effect.orDie);

    return Store.of({
      getPrescribedSession: (sessionId) => loadPrescribedSession(sessionId),

      startSession: (prescribedSessionId) =>
        Effect.gen(function* () {
          const sessionOption = yield* loadPrescribedSession(prescribedSessionId);
          if (Option.isNone(sessionOption)) {
            return yield* Effect.fail(
              new PrescribedSessionNotFoundError({ sessionId: prescribedSessionId }),
            );
          }
          // Deep copy on instantiate (ADR 0006/0007): the snapshot is
          // frozen as JSON on the new row — later Plan edits (relational
          // UPDATEs against `prescribed_set` etc.) never reach it.
          const snapshotJson = JSON.stringify(sessionOption.value);
          const loggedSessionId = randomUUID();
          const startedAt = new Date().toISOString();
          yield* sql`
            INSERT INTO logged_session (id, prescribed_session_id, started_at, status, snapshot_json)
            VALUES (${loggedSessionId}, ${prescribedSessionId}, ${startedAt}, 'active', ${snapshotJson})
          `.pipe(Effect.orDie);
          yield* bumpChangeTick;
          const result: StartSessionResult = { loggedSessionId: loggedSessionId as never };
          return result;
        }),

      getLoggedSession: (loggedSessionId) => loadLoggedSession(loggedSessionId),

      finalizeSession: (loggedSessionId: LoggedSessionId) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly id: string;
            readonly status: string;
            readonly review_status: string | null;
          }>`
            SELECT id, status, review_status FROM logged_session WHERE id = ${loggedSessionId}
          `;
          if (rows[0] === undefined) {
            return Option.none<{
              readonly loggedSessionId: LoggedSessionId;
              readonly status: LoggedSessionStatus;
              readonly transitioned: boolean;
              readonly reviewStatus: LoggedSessionReviewStatus;
            }>();
          }
          // Idempotent: only flip an `active` session; a re-finish is a no-op
          // on the status. It reports the EXISTING review marker (issue #132)
          // rather than claiming `reviewed` — a re-finish of a session whose
          // review never ran must keep saying `pending` so the drain can still
          // pick it up. A NULL marker on a `finished` row means the row
          // predates migration `017`'s backfill and is treated as `pending`
          // for the same reason.
          if (rows[0].status === "finished") {
            return Option.some({
              loggedSessionId: rows[0].id as never,
              status: "finished" as const,
              transitioned: false,
              reviewStatus: (rows[0].review_status === "reviewed" ? "reviewed" : "pending") as never,
            });
          }
          const finishedAt = new Date().toISOString();
          // ONE statement: the status flip and the review marker cannot
          // diverge (issue #132). A crash between two separate UPDATEs would
          // leave a `finished` row invisible to the drain — the original bug
          // in a new shape.
          yield* sql`
            UPDATE logged_session
            SET status = 'finished', finished_at = ${finishedAt}, review_status = 'pending'
            WHERE id = ${loggedSessionId}
          `;
          yield* bumpChangeTick;
          return Option.some({
            loggedSessionId: rows[0].id as never,
            status: "finished" as const,
            transitioned: true,
            reviewStatus: "pending" as never,
          });
        }).pipe(Effect.orDie),

      // The drain's work list (#132) — re-derived from durable rows on every
      // tick rather than held in a queue that a restart would drop. Oldest
      // finish first; `finished_at IS NULL` (pre-migration-`016` rows) sorts
      // first, matching `listSessions`' "NULL is oldest" rule.
      listSessionsPendingReview: Effect.gen(function* () {
        const rows = yield* sql<{ readonly id: string }>`
          SELECT id FROM logged_session
          WHERE status = 'finished' AND review_status = 'pending'
          ORDER BY finished_at IS NOT NULL, finished_at ASC
        `;
        return rows.map((row) => row.id as LoggedSessionId);
      }).pipe(Effect.orDie),

      // Idempotent and total (#132): the WHERE clause is the guard, so an
      // unknown / `active` / `cancelled` / already-`reviewed` session updates
      // zero rows rather than erroring. Called only AFTER a review has
      // committed — marking before the run would reintroduce the bug.
      markSessionReviewed: (loggedSessionId: LoggedSessionId) =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE logged_session SET review_status = 'reviewed'
            WHERE id = ${loggedSessionId} AND status = 'finished' AND review_status = 'pending'
          `;
          yield* bumpChangeTick;
        }).pipe(Effect.orDie),

      // "Cancel session" (issue #114 Part 1): unmakes an accidentally-started
      // session. Idempotent for already-resolved rows; fails loudly with
      // `LoggedSessionHasActualsError` for the one case that would otherwise
      // look like silent data loss — an `active` row that already has a
      // logged actual. Never routes through `finalizeSession`/`finishWorkout`
      // — a cancelled session must trigger no Session-review Deliberation.
      cancelSession: (loggedSessionId: LoggedSessionId) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string; readonly status: string }>`
            SELECT id, status FROM logged_session WHERE id = ${loggedSessionId}
          `;
          if (rows[0] === undefined) {
            return Option.none<CancelSessionResult>();
          }
          if (rows[0].status === "cancelled") {
            return Option.some<CancelSessionResult>({
              loggedSessionId: rows[0].id as never,
              status: "cancelled",
              cancelled: false,
            });
          }
          // Net state (ADR 0019): a Set logged and then retracted (a
          // mis-tap) must not permanently block cancelling the session — the
          // guard counts what is STILL logged (the last row per `set_id`,
          // when that row is not itself a retraction), not raw row presence.
          const actualRows = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM (
              SELECT retraction,
                ROW_NUMBER() OVER (PARTITION BY set_id ORDER BY applied_at DESC, rowid DESC) AS rn
              FROM logged_set_actual WHERE logged_session_id = ${loggedSessionId}
            ) WHERE rn = 1 AND retraction = 0
          `;
          if (Number(actualRows[0]?.n ?? 0) > 0) {
            return yield* Effect.fail(new LoggedSessionHasActualsError({ loggedSessionId }));
          }
          if (rows[0].status !== "active") {
            // `finished` with zero actuals (an edge case `finishWorkout`
            // does not itself guard against): already resolved, nothing to
            // cancel — idempotent, not an error.
            return Option.some<CancelSessionResult>({
              loggedSessionId: rows[0].id as never,
              status: rows[0].status as never,
              cancelled: false,
            });
          }
          yield* sql`UPDATE logged_session SET status = 'cancelled' WHERE id = ${loggedSessionId}`;
          yield* bumpChangeTick;
          return Option.some<CancelSessionResult>({
            loggedSessionId: rows[0].id as never,
            status: "cancelled",
            cancelled: true,
          });
        }).pipe(Effect.orDie),

      // "History" (issue #114 Part 2): a reverse-chronological, `before`-paged
      // list of finished sessions. Excludes `active` and `cancelled` at the
      // SQL level rather than filtering client-side, since the list "grows
      // forever" and must stay boundable.
      listSessions: (input) =>
        Effect.gen(function* () {
          const limit = input.limit ?? 20;
          const rows = input.before
            ? yield* sql<LoggedSessionRow>`
                SELECT * FROM logged_session
                WHERE status = 'finished' AND finished_at IS NOT NULL AND finished_at < ${input.before}
                ORDER BY finished_at DESC
                LIMIT ${limit}
              `
            : yield* sql<LoggedSessionRow>`
                SELECT * FROM logged_session
                WHERE status = 'finished' AND finished_at IS NOT NULL
                ORDER BY finished_at DESC
                LIMIT ${limit}
              `;
          const sessions = yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              const snapshot = JSON.parse(row.snapshot_json) as PrescribedSession;
              const totalSetCount = snapshot.blocks.reduce(
                (sum, block) => sum + block.entries.reduce((entrySum, entry) => entrySum + entry.sets.length, 0),
                0,
              );
              const loggedRows = yield* sql<{ readonly n: number }>`
                SELECT COUNT(DISTINCT set_id) AS n FROM logged_set_actual WHERE logged_session_id = ${row.id}
              `;
              const summary: LoggedSessionSummary = {
                loggedSessionId: row.id as never,
                prescribedSessionId: row.prescribed_session_id as never,
                ...(snapshot.name !== undefined ? { name: snapshot.name } : {}),
                startedAt: row.started_at as never,
                finishedAt: row.finished_at as never,
                loggedSetCount: Number(loggedRows[0]?.n ?? 0) as never,
                totalSetCount: totalSetCount as never,
              };
              return summary;
            }),
          );
          const result: ListSessionsResult = { sessions };
          return result;
        }).pipe(Effect.orDie),

      // "Which Logged Sessions are still in flight" (issue #147) — only
      // `active` rows, newest `started_at` first. The mirror image of
      // `listSessions` above, which excludes `active`. `loggedSetCount` is the
      // NET count (the last row per `set_id`, when it is not a retraction) —
      // the same fold `cancelSession`'s guard uses — so a mis-tapped
      // log-then-unlog does not make the Resume hero overstate the work done.
      listActiveSessions: Effect.gen(function* () {
        const rows = yield* sql<LoggedSessionRow>`
          SELECT * FROM logged_session
          WHERE status = 'active'
          ORDER BY started_at DESC
        `;
        const sessions = yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const snapshot = JSON.parse(row.snapshot_json) as PrescribedSession;
            const netRows = yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM (
                SELECT retraction,
                  ROW_NUMBER() OVER (PARTITION BY set_id ORDER BY applied_at DESC, rowid DESC) AS rn
                FROM logged_set_actual WHERE logged_session_id = ${row.id}
              ) WHERE rn = 1 AND retraction = 0
            `;
            const summary: ActiveLoggedSessionSummary = {
              loggedSessionId: row.id as never,
              prescribedSessionId: row.prescribed_session_id as never,
              ...(snapshot.name !== undefined ? { name: snapshot.name } : {}),
              startedAt: row.started_at as never,
              loggedSetCount: Number(netRows[0]?.n ?? 0) as never,
            };
            return summary;
          }),
        );
        const result: ListActiveSessionsResult = { sessions };
        return result;
      }).pipe(Effect.orDie),

      // "Stats" (issue #117): the aggregation happens in SQL rather than by
      // shipping every actual to the client. `date(applied_at, printf('%+d
      // minutes', offset))` shifts the stored UTC timestamp by the caller's
      // local offset BEFORE reading off the calendar date — the same rule
      // `localDateKey` (store.ts) applies in JS for the in-memory layer, so a
      // set logged at 23:50 local lands on that local day on both layers.
      // `logged_session_id || '|' || set_id` dedupes rather than bare
      // `set_id`: set ids are per-session (template-derived), so two
      // different sessions reuse "set-1" and would otherwise collapse.
      // "Export my data": every table in the file, in name order, with
      // SQLite's own bookkeeping (`sqlite_*`) left out. A `*_json` column
      // whose text parses is inlined as the value it holds; one that does
      // not parse is exported as the text it is, never dropped.
      // Imported history (`workoutImport.ts`): one transaction per workout,
      // skipped when its derived id is already here, so a re-import is a
      // no-op rather than a duplicate.
      importWorkouts: (input) =>
        Effect.gen(function* () {
          let imported = 0;
          let skipped = 0;
          for (const workout of input.workouts) {
            const rows = importedSessionRows(workout);
            const existing = yield* sql<{ readonly id: string }>`
              SELECT id FROM logged_session WHERE id = ${rows.loggedSessionId}
            `;
            if (existing.length > 0) {
              skipped++;
              continue;
            }
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  INSERT INTO logged_session
                    (id, prescribed_session_id, started_at, status, snapshot_json, finished_at, review_status)
                  VALUES (
                    ${rows.loggedSessionId}, ${rows.loggedSessionId}, ${workout.startedAt}, 'finished',
                    ${JSON.stringify(rows.snapshot)}, ${workout.finishedAt}, 'reviewed'
                  )
                `;
                for (const actual of rows.actuals) {
                  yield* sql`
                    INSERT INTO logged_set_actual
                      (id, logged_session_id, session_id, entry_id, set_id, set_type, actual_json, command_id, applied_at)
                    VALUES (
                      ${randomUUID()}, ${actual.loggedSessionId}, ${actual.sessionId}, ${actual.entryId}, ${actual.setId},
                      ${actual.setType}, ${JSON.stringify(actual.actual)}, ${actual.commandId}, ${actual.appliedAt}
                    )
                  `;
                }
              }),
            );
            imported++;
          }
          if (imported > 0) yield* bumpChangeTick;
          const result: ImportWorkoutsResult = { imported, skipped };
          return result;
        }).pipe(Effect.orDie),

      exportData: Effect.gen(function* () {
        const tableRows = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `;
        const tables: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
        for (const { name } of tableRows) {
          const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
          tables[name] = rows.map(inlineJsonColumns);
        }
        const result: ExportDataResult = {
          format: "repcoach-export",
          version: 1,
          exportedAt: new Date().toISOString(),
          tables,
        };
        return result;
      }).pipe(Effect.orDie),

      getDailySetCounts: (input) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly day: string; readonly n: number }>`
            SELECT
              date(lsa.applied_at, printf('%+d minutes', ${input.utcOffsetMinutes})) AS day,
              COUNT(DISTINCT lsa.logged_session_id || '|' || lsa.set_id) AS n
            FROM logged_set_actual lsa
            JOIN logged_session ls ON ls.id = lsa.logged_session_id
            WHERE ls.status != 'cancelled'
            GROUP BY day
            ORDER BY day
          `;
          const result: GetDailySetCountsResult = {
            days: rows.map((row) => ({ date: row.day, setCount: Number(row.n) as never })),
          };
          return result;
        }).pipe(Effect.orDie),

      // Tier-2 one-tap ✓ seed (issue #149). Sessions hold frozen JSON
      // snapshots rather than normalised entry/set rows, so — exactly as
      // `listSessions` above does — the finished rows and their
      // actual/swap rows are pulled with plain SELECTs and the swap-aware,
      // net-state resolution runs in `resolveLastActualForExercise`, the
      // one place that rule lives for both `Store` layers.
      lastActualForExercise: (input) =>
        Effect.gen(function* () {
          const finished = yield* loadFinishedSessionViews;
          const catalogRows = yield* sql<{ readonly tracked_metrics_json: string | null }>`
            SELECT tracked_metrics_json FROM exercise_catalog WHERE id = ${input.exerciseId}
          `;
          const trackedMetrics =
            catalogRows[0]?.tracked_metrics_json == null
              ? undefined
              : (JSON.parse(catalogRows[0].tracked_metrics_json) as ReadonlyArray<MetricName>);
          const result: LastActualForExerciseResult = {
            exerciseId: input.exerciseId,
            perMetric: resolveLastActualForExercise(finished, input.exerciseId, trackedMetrics),
            sets: resolveLastSetsForExercise(finished, input.exerciseId, trackedMetrics),
          };
          const bestE1rm = resolveBestE1rm(finished, input.exerciseId);
          return bestE1rm === undefined ? result : { ...result, bestE1rm };
        }).pipe(Effect.orDie),

      // Bodyweight — the day is the primary key, so a second reading for a
      // day replaces the first (`bodyweight.ts`).
      logBodyweight: (input) =>
        Effect.gen(function* () {
          const entry: BodyweightEntry = {
            date: input.date,
            weightKg: input.weightKg,
            recordedAt: new Date().toISOString(),
          };
          yield* sql`
            INSERT INTO bodyweight_entry (date, weight_kg, recorded_at)
            VALUES (${entry.date}, ${entry.weightKg}, ${entry.recordedAt})
            ON CONFLICT(date) DO UPDATE SET weight_kg = excluded.weight_kg, recorded_at = excluded.recorded_at
          `;
          return entry;
        }).pipe(Effect.orDie),

      removeBodyweight: (input) =>
        sql`DELETE FROM bodyweight_entry WHERE date = ${input.date}`.pipe(Effect.as({}), Effect.orDie),

      listBodyweight: Effect.gen(function* () {
        const rows = yield* sql<{ readonly date: string; readonly weight_kg: number; readonly recorded_at: string }>`
          SELECT date, weight_kg, recorded_at FROM bodyweight_entry ORDER BY date
        `;
        const result: ListBodyweightResult = {
          entries: rows.map((row) => ({ date: row.date, weightKg: Number(row.weight_kg), recordedAt: row.recorded_at })),
        };
        return result;
      }).pipe(Effect.orDie),

      getExerciseProgress: loadFinishedSessionViews.pipe(
        Effect.map((finished): GetExerciseProgressResult => ({ exercises: resolveExerciseProgress(finished) })),
        Effect.orDie,
      ),

      // Test-only seam — see the `Store` interface doc on
      // `logSetActualAtForTest`. Deliberately skips the idempotency/pause-gate
      // machinery `applyNow` above carries; it exists to seed a specific
      // `applied_at`, not to exercise the outbox path.
      logSetActualAtForTest: (input, appliedAt) =>
        Effect.gen(function* () {
          const id = randomUUID();
          yield* sql`
            INSERT INTO logged_set_actual
              (id, logged_session_id, session_id, entry_id, set_id, set_type, actual_json, command_id, applied_at)
            VALUES (
              ${id}, ${input.loggedSessionId}, ${input.sessionId}, ${input.entryId}, ${input.setId}, ${input.setType},
              ${JSON.stringify(input.actual)}, ${input.commandId}, ${appliedAt}
            )
          `;
          yield* bumpChangeTick;
          const result: LogSetActualResult = { ...input, appliedAt, retraction: false };
          return result;
        }).pipe(Effect.orDie),

      mutatePrescribedSessionForTest: (sessionId) =>
        Effect.gen(function* () {
          const setRows = yield* sql<{ readonly id: string; readonly target_json: string }>`
            SELECT ps.id AS id, ps.target_json AS target_json
            FROM prescribed_set ps
            JOIN entry e ON e.id = ps.entry_id
            JOIN block b ON b.id = e.block_id
            WHERE b.prescribed_session_id = ${sessionId}
          `;
          yield* Effect.forEach(
            setRows,
            (row) => {
              const bumped = bumpLoadForTest(JSON.parse(row.target_json) as PrescribedMetricMap);
              return sql`UPDATE prescribed_set SET target_json = ${JSON.stringify(bumped)} WHERE id = ${row.id}`;
            },
            { discard: true },
          );
          yield* bumpChangeTick;
          return yield* loadPrescribedSession(sessionId);
        }).pipe(Effect.orDie),

      shortenPrescribedRestForTest: (sessionId, restSec) =>
        Effect.gen(function* () {
          // `rest_sec IS NOT NULL` is the whole of the "leave the unprescribed
          // sets alone" rule — see the interface comment on the in-memory
          // store, which this mirrors.
          yield* sql`
            UPDATE prescribed_set SET rest_sec = ${restSec}
            WHERE rest_sec IS NOT NULL AND entry_id IN (
              SELECT e.id FROM entry e
              JOIN block b ON b.id = e.block_id
              WHERE b.prescribed_session_id = ${sessionId}
            )
          `;
          yield* bumpChangeTick;
          return yield* loadPrescribedSession(sessionId);
        }).pipe(Effect.orDie),

      openPrescribedLoadForTest: (sessionId) =>
        Effect.gen(function* () {
          const setRows = yield* sql<{ readonly id: string; readonly target_json: string }>`
            SELECT ps.id AS id, ps.target_json AS target_json
            FROM prescribed_set ps
            JOIN entry e ON e.id = ps.entry_id
            JOIN block b ON b.id = e.block_id
            WHERE b.prescribed_session_id = ${sessionId}
          `;
          yield* Effect.forEach(
            setRows,
            (row) =>
              Effect.gen(function* () {
                const target = JSON.parse(row.target_json) as PrescribedMetricMap;
                if (target.load === undefined) return;
                const opened = { ...target, load: {} };
                yield* sql`UPDATE prescribed_set SET target_json = ${JSON.stringify(opened)} WHERE id = ${row.id}`;
              }),
            { discard: true },
          );
          yield* bumpChangeTick;
          return yield* loadPrescribedSession(sessionId);
        }).pipe(Effect.orDie),

      getCoachingFeed: loadCoachingFeed(),
      getProposals: loadProposals(),
      getDecision: (id) =>
        sql<DecisionRow>`SELECT * FROM decision WHERE id = ${id}`.pipe(
          Effect.map((rows) => (rows[0] === undefined ? Option.none() : Option.some(toDecisionRecord(rows[0])))),
          Effect.orDie,
        ),
      getProposalExchange: (proposalId) =>
        loadAllDecisions().pipe(Effect.map((decisions) => buildProposalExchange(proposalId, decisions))),
      subscribeProposalExchanges: SubscriptionRef.changes(changeTick).pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const decisions = yield* loadAllDecisions();
            const proposals = yield* loadProposals();
            return proposals.flatMap((proposal) => {
              const exchange = buildProposalExchange(proposal.id, decisions);
              return Option.isSome(exchange) ? [exchange.value] : [];
            });
          }),
        ),
        Stream.flattenIterable,
      ),
      getPlan: loadPlan(),
      getExerciseCatalog: loadAuthoringContext().pipe(Effect.map(toExerciseCatalog)),

      createExercise: (input: CreateExerciseInput) =>
        Effect.gen(function* () {
          // `DO NOTHING` rather than an upsert: the client-minted id is the
          // idempotency key (ADR 0016 §3 — this write is outside the outbox,
          // so there is no `commandId`), and a replay must return the row the
          // first attempt minted rather than overwrite a name since fixed by
          // a rename.
          yield* sql`
            INSERT INTO exercise_catalog (id, name, tracked_metrics_json, muscles_json, movement_pattern, library_id)
            VALUES (${input.exerciseId}, ${input.name}, '[]', NULL, NULL, ${input.libraryId ?? null})
            ON CONFLICT (id) DO NOTHING
          `;
          yield* bumpChangeTick;
          const stored = yield* loadCatalogExercise(input.exerciseId);
          // Only `None` if the row vanished between the two statements, which
          // nothing can do — the catalog has no delete (ADR 0016).
          return yield* Option.match(stored, {
            onNone: () =>
              Effect.die(new Error(`exercise ${input.exerciseId} vanished after insert`)),
            onSome: (exercise: CatalogExercise) => Effect.succeed(exercise),
          });
        }).pipe(Effect.orDie),

      renameExercise: (input: RenameExerciseInput) =>
        Effect.gen(function* () {
          const existing = yield* loadCatalogExercise(input.exerciseId).pipe(Effect.orDie);
          if (Option.isNone(existing)) {
            return yield* Effect.fail(new ExerciseNotFoundError({ exerciseId: input.exerciseId }));
          }
          // The id stays; the metadata goes. It described the old name, and
          // emptying it is also what marks the row for re-enrichment. The
          // library link is not metadata and stays put.
          yield* sql`
            UPDATE exercise_catalog
            SET name = ${input.name}, tracked_metrics_json = '[]', muscles_json = NULL, movement_pattern = NULL
            WHERE id = ${input.exerciseId}
          `.pipe(Effect.orDie);
          yield* bumpChangeTick.pipe(Effect.orDie);
          return toCatalogExercise({
            id: input.exerciseId,
            name: input.name,
            trackedMetrics: [],
            ...(existing.value.libraryId === undefined ? {} : { libraryId: existing.value.libraryId }),
          });
        }),

      listUnenrichedExercises: loadCatalogMetadata().pipe(
        Effect.map((rows) =>
          rows
            .filter(isUnenrichedExercise)
            .map((row): UnenrichedExercise => ({ id: row.id as UnenrichedExercise["id"], name: row.name })),
        ),
        Effect.orDie,
      ),

      enrichExercises: (input: { readonly enrichments: ReadonlyArray<CatalogEnrichment> }) =>
        Effect.gen(function* () {
          const rows = yield* loadCatalogMetadata();
          const byId = new Map(rows.map((row) => [row.id, row] as const));
          const written: Array<string> = [];

          for (const enrichment of input.enrichments) {
            const row = byId.get(enrichment.exercise_id);
            // Unknown id, or a row already filled in: a no-op. Never a
            // failure (this write rides a review whose real work is done)
            // and never an overwrite of good metadata.
            if (row === undefined || !isUnenrichedExercise(row)) continue;

            // Column by column, so an absent field is left as it stands
            // rather than overwritten with emptiness — a partial answer
            // lands its half. `id` and `name` appear in no SET clause here:
            // the user owns the name (ADR 0016).
            let touched = false;
            if (enrichment.tracked_metrics !== undefined) {
              yield* sql`
                UPDATE exercise_catalog SET tracked_metrics_json = ${JSON.stringify(enrichment.tracked_metrics)}
                WHERE id = ${row.id}
              `;
              touched = true;
            }
            if (enrichment.muscles !== undefined) {
              yield* sql`
                UPDATE exercise_catalog SET muscles_json = ${JSON.stringify(enrichment.muscles)}
                WHERE id = ${row.id}
              `;
              touched = true;
            }
            if (enrichment.movement_pattern !== undefined) {
              yield* sql`
                UPDATE exercise_catalog SET movement_pattern = ${enrichment.movement_pattern}
                WHERE id = ${row.id}
              `;
              touched = true;
            }
            if (touched) written.push(row.id);
          }

          // The picker and the logging grid read `trackedMetrics`, so an
          // enrichment that landed has to reach an attached client the same
          // way a create does.
          if (written.length > 0) yield* bumpChangeTick;
          return written as ReadonlyArray<string>;
        }).pipe(Effect.orDie),

      getExerciseEnrichmentForTest: (exerciseId: string) =>
        loadCatalogMetadata().pipe(
          Effect.map((rows) => {
            const row = rows.find((candidate) => candidate.id === exerciseId);
            return row === undefined
              ? Option.none()
              : Option.some({
                  trackedMetrics: row.trackedMetrics,
                  muscles: row.muscles,
                  movementPattern: row.movementPattern,
                });
          }),
          Effect.orDie,
        ),


      // --- the run record (ADR 0011 §8, the Coach run history) --------------
      //
      // Every one of these bumps the change tick, so the rail redraws the
      // moment a run opens, and again when it closes. That is what makes the
      // live node at the top of the record a real subscription rather than a
      // thing the user has to reload to see move.

      startDeliberationRun: (input) =>
        sql`
          INSERT INTO deliberation_run (id, cadence, status, failure_reason, data_window_json, started_at, finished_at)
          VALUES (${input.runId}, ${input.cadence}, 'running', NULL, NULL, ${input.startedAt}, NULL)
          ON CONFLICT(id) DO NOTHING
        `.pipe(Effect.andThen(bumpChangeTick), Effect.orDie),

      finishDeliberationRun: (input) =>
        sql`
          UPDATE deliberation_run
          SET status = ${input.outcome},
              failure_reason = ${input.failureReason ?? null},
              data_window_json = ${input.dataWindow === undefined ? null : JSON.stringify(input.dataWindow)},
              finished_at = ${input.finishedAt}
          WHERE id = ${input.runId}
        `.pipe(Effect.andThen(bumpChangeTick), Effect.orDie),

      discardDeliberationRun: (runId) =>
        sql`DELETE FROM deliberation_run WHERE id = ${runId}`.pipe(
          Effect.andThen(bumpChangeTick),
          Effect.orDie,
        ),

      failRunsInterruptedByRestart: Effect.gen(function* () {
        const stranded = yield* sql<{ readonly id: string }>`
          SELECT id FROM deliberation_run WHERE status = 'running'
        `;
        if (stranded.length === 0) return { failed: 0 };
        yield* sql`
          UPDATE deliberation_run
          SET status = 'failed',
              failure_reason = ${"the home server restarted while this run was in flight"},
              finished_at = ${new Date().toISOString()}
          WHERE status = 'running'
        `;
        yield* bumpChangeTick;
        return { failed: stranded.length };
      }).pipe(Effect.orDie),

      getDeliberationRuns: loadDeliberationRuns(),

      subscribeDeliberationRuns: SubscriptionRef.changes(changeTick).pipe(
        Stream.mapEffect(() => loadDeliberationRuns()),
        Stream.flattenIterable,
      ),

      subscribeCoachingFeed: SubscriptionRef.changes(changeTick).pipe(
        Stream.mapEffect(() => loadCoachingFeed()),
        Stream.flattenIterable,
      ),
      subscribeProposals: SubscriptionRef.changes(changeTick).pipe(
        Stream.mapEffect(() => loadProposals()),
        Stream.flattenIterable,
      ),
      subscribePlan: SubscriptionRef.changes(changeTick).pipe(Stream.mapEffect(() => loadPlan())),

      resolveProposal: (input: ResolveProposalInput) =>
        Effect.gen(function* () {
          const rows = yield* sql<DecisionRow>`
            SELECT * FROM decision WHERE id = ${input.proposalId} AND kind = 'proposal'
          `.pipe(Effect.orDie);
          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.fail(new ProposalNotFoundError({ proposalId: input.proposalId }));
          }
          if (row.status !== "pending") {
            return yield* Effect.fail(
              new ProposalAlreadyResolvedError({
                proposalId: input.proposalId,
                status: row.status as ChangeStatus,
              }),
            );
          }

          // --- what `accepted` mutates the Plan into ----------------------
          //
          // What the Proposal SAYS, in one of two payload shapes, and never a
          // stand-in. `planOperations` (#86) is the ordinary review-cadence
          // case: ADR 0015 operations folded over the standing Plan by the
          // same pure applier `applyUserPlanChange` uses. `draftPlan` (#75) is
          // the Intake cold-start case (ADR 0014 §6): no prior Plan to diff
          // against, so accepting REPLACES the Plan, seeded demo sessions
          // included. A Proposal carrying neither proposes no Plan change and
          // resolves cleanly, mutating nothing.
          //
          // Everything that can be REFUSED happens before the first write: an
          // unrenderable draft, or an operation that does not validate against
          // the Plan as it now stands, leaves the Proposal pending and the
          // Plan untouched — nothing half-applied. (Past that point the writes
          // are sequential, not transactional — the same discipline
          // `applyUserPlanChange` below already runs on.)
          const proposal = toProposal(row);
          const draftPlan = proposal.draftPlan;
          const accepting = input.decision === "accepted";
          const materialized =
            accepting && draftPlan !== undefined
              ? materializeDraftPlan(draftPlan, {
                  planId: (yield* loadPlan()).id,
                  context: yield* loadAuthoringContext(),
                  newId: randomUUID,
                })
              : undefined;

          // The Exercises the operations are allowed to assume exist (ADR
          // 0016): folded into the context they VALIDATE against, and written
          // only once they have. `addEntry` refuses an `exerciseId` with no
          // catalog row, so a Proposal that introduces a movement has to name
          // it here — and doing the fold before the fold-over-the-Plan keeps
          // the refusal ahead of the first write, exactly as above.
          const proposedExercises =
            accepting && proposal.planOperations !== undefined
              ? foldProposedExercises(yield* loadAuthoringContext(), proposal.catalogExercises)
              : undefined;

          const operations = proposal.planOperations;
          const proposed =
            accepting && operations !== undefined
              ? applyPlanOperations(
                  yield* loadPlan(),
                  operations,
                  proposedExercises?.context ?? (yield* loadAuthoringContext()),
                )
              : undefined;
          if (proposed !== undefined && !proposed.ok) {
            // The Proposal stays `pending`, so a Proposal drafted against a
            // Plan the user has since edited can be revised or dismissed
            // rather than silently applied to a shape it was never about.
            return yield* Effect.fail(
              new PlanOperationRejectedError({
                operation: proposed.operation,
                code: proposed.code,
                reason: `operation ${proposed.index + 1} of ${operations?.length ?? 0}: ${proposed.reason}`,
              }),
            );
          }

          yield* sql`UPDATE decision SET status = ${input.decision} WHERE id = ${input.proposalId}`.pipe(
            Effect.orDie,
          );

          if (materialized !== undefined) {
            // Before the Plan itself: an Exercise the draft named but the
            // catalog didn't have is the coach authoring a new one (CONTEXT
            // `Exercise catalog`), not a refused Accept — write it first so
            // the Entries `rewritePlanTree` inserts below can reference it.
            yield* Effect.forEach(
              materialized.newCatalogEntries,
              (exercise) =>
                sql`
                  INSERT INTO exercise_catalog (id, name, tracked_metrics_json, muscles_json, movement_pattern)
                  VALUES (
                    ${exercise.id}, ${exercise.name},
                    ${exercise.trackedMetrics === undefined ? null : JSON.stringify(exercise.trackedMetrics)},
                    NULL, NULL
                  )
                `,
              { discard: true },
            ).pipe(Effect.orDie);
            // Accepting a plan accepts the model it was drafted under, so the
            // Plan row's `plan_model` moves with its sessions.
            yield* sql`
              UPDATE plan SET plan_model = ${materialized.plan.planModel} WHERE id = ${materialized.plan.id}
            `.pipe(Effect.orDie);
            yield* rewritePlanTree(materialized.plan).pipe(Effect.orDie);
          } else if (proposed !== undefined && proposed.ok) {
            // The catalog rows the operations named (ADR 0016) — written here,
            // on Accept, and never when the run committed: a catalog row is
            // permanent (renameable, never deleted, because past Logged
            // Sessions reference it), so a rejected Proposal must leave none
            // behind. `DO NOTHING` for the same reason `createExercise` uses
            // it — the id is the idempotency key, and a row the user has since
            // renamed is not this Proposal's to overwrite.
            yield* Effect.forEach(
              proposedExercises?.newCatalogEntries ?? [],
              (exercise) =>
                sql`
                  INSERT INTO exercise_catalog (id, name, tracked_metrics_json, muscles_json, movement_pattern)
                  VALUES (
                    ${exercise.id}, ${exercise.name},
                    ${JSON.stringify(exercise.trackedMetrics ?? [])},
                    NULL, NULL
                  )
                  ON CONFLICT (id) DO NOTHING
                `,
              { discard: true },
            ).pipe(Effect.orDie);
            yield* rewritePlanTree(proposed.plan).pipe(Effect.orDie);
            // The applied Change (ADR 0008): origin `coach-proposal`, born
            // `applied`. The Proposal row carries the DECISION (`accepted`),
            // this row carries the EFFECT — exactly as a user-direct edit
            // writes one, so the Plan's history reads the same whoever
            // authored the change.
            yield* sql`
              INSERT INTO decision
                (id, kind, origin, status, summary, rationale, citations_json, data_window_json, created_at, in_response_to_id, plan_operations_json)
              VALUES (
                ${randomUUID()}, 'change', 'coach-proposal', 'applied',
                ${proposed.summaries.join("; ")},
                ${`Applied by accepting Proposal ${input.proposalId} (ADR 0008).`},
                NULL, ${JSON.stringify({ acceptedProposalId: input.proposalId })},
                ${new Date().toISOString()}, ${input.proposalId}, ${JSON.stringify(operations)}
              )
            `.pipe(Effect.orDie);
          }

          yield* bumpChangeTick;

          const resolvedRows = yield* sql<DecisionRow>`
            SELECT * FROM decision WHERE id = ${input.proposalId}
          `.pipe(Effect.orDie);
          const resolvedRow = resolvedRows[0];
          if (resolvedRow === undefined) {
            return yield* Effect.die(
              new Error(`SqlStore: decision row vanished for proposalId ${input.proposalId}`),
            );
          }
          const result: ResolveProposalResult = { proposal: toProposal(resolvedRow) };
          return result;
        }),

      applyUserPlanChange: (input: ApplyUserChangeInput) =>
        Effect.gen(function* () {
          // --- the structural seam (#71) ---------------------------------
          if (isPlanEditCommand(input)) {
            const commandId = input.commandId as string | undefined;
            if (commandId !== undefined) {
              // Exactly-once by `commandId` (ADR 0006), the same discipline
              // `logSetActual` uses: a replay after a dead spot re-reads the
              // Plan instead of applying the operation a second time.
              const applied = yield* sql<{ readonly id: string }>`
                SELECT id FROM decision
                WHERE kind = 'change' AND json_extract(data_window_json, '$.commandId') = ${commandId}
              `.pipe(Effect.orDie);
              if (applied[0] !== undefined) {
                return yield* loadPlan();
              }
            }

            const currentPlan = yield* loadPlan();
            const context = yield* loadAuthoringContext();
            const result = applyPlanOperation(currentPlan, input.operation, context);
            if (!result.ok) {
              // Nothing has been written yet, so a rejected operation leaves
              // the Plan exactly as it was — a stale client cannot silently
              // corrupt it.
              return yield* Effect.fail(
                new PlanOperationRejectedError({
                  operation: input.operation._tag,
                  code: result.code,
                  reason: result.reason,
                }),
              );
            }

            yield* rewritePlanTree(result.plan).pipe(Effect.orDie);

            // A new ordering Change supersedes the previous live one on the
            // same container (ADR 0008's existing status — no new
            // vocabulary), so a run of reorder taps leaves ONE live Change
            // and the coach reads the net intent, not five intermediate
            // states.
            if (result.orderingContainer !== undefined) {
              yield* sql`
                UPDATE decision SET status = 'superseded'
                WHERE kind = 'change' AND origin = 'user-direct' AND status = 'applied'
                  AND json_extract(data_window_json, '$.orderingContainer') = ${result.orderingContainer}
              `.pipe(Effect.orDie);
            }
            // Undo is the inverse operation applied as a NEW Change, with the
            // original marked superseded — no special-cased rollback path,
            // and the applied history stays linear (#71).
            if (input.undoesChangeId !== undefined) {
              yield* sql`
                UPDATE decision SET status = 'superseded'
                WHERE id = ${input.undoesChangeId} AND kind = 'change' AND status = 'applied'
              `.pipe(Effect.orDie);
            }

            const window: PlanChangeWindow = {
              operation: input.operation._tag,
              ...(commandId === undefined ? {} : { commandId }),
              ...(result.orderingContainer === undefined
                ? {}
                : { orderingContainer: result.orderingContainer }),
            };
            yield* sql`
              INSERT INTO decision
                (id, kind, origin, status, summary, rationale, citations_json, data_window_json, created_at)
              VALUES (
                ${randomUUID()}, 'change', 'user-direct', 'applied',
                ${result.summary},
                'Direct Plan edit — auto-applied without review (ADR 0008).',
                NULL, ${JSON.stringify(window)}, ${new Date().toISOString()}
              )
            `.pipe(Effect.orDie);

            yield* bumpChangeTick;
            return result.plan;
          }

          const rows = yield* sql<{ readonly id: string }>`
            SELECT id FROM prescribed_set WHERE id = ${input.setId}
          `.pipe(Effect.orDie);
          if (rows[0] === undefined) {
            return yield* Effect.fail(new PrescribedSetNotFoundError({ setId: input.setId }));
          }

          yield* sql`
            UPDATE prescribed_set SET target_json = ${JSON.stringify(input.target)}
            WHERE id = ${input.setId}
          `.pipe(Effect.orDie);

          // Record the user-direct Change as an append-only Decision (ADR
          // 0008): born `applied`, origin `user-direct`, kind `change` — a
          // revealed-preference signal the coach (2B) can later read. The
          // `kind = 'change'` tag keeps it out of `loadProposals` (which
          // filters `kind = 'proposal'`) and out of `coaching_feed_entry`,
          // so a direct edit never surfaces as a Proposal or a feed item.
          yield* sql`
            INSERT INTO decision
              (id, kind, origin, status, summary, rationale, citations_json, data_window_json, created_at)
            VALUES (
              ${randomUUID()}, 'change', 'user-direct', 'applied',
              ${`User edited the target for set ${input.setId}`},
              'Direct Plan edit — auto-applied without review (ADR 0008).',
              NULL, ${JSON.stringify({ setId: input.setId, target: input.target })},
              ${new Date().toISOString()}
            )
          `.pipe(Effect.orDie);

          yield* bumpChangeTick;
          return yield* loadPlan();
        }),

      // #82: writes the `coaching_feed_entry` row as well as the `decision`
      // one. See the in-memory `Store`'s note — a lever that puts a Proposal on
      // Today but not on the permanent record means two different things on two
      // surfaces, and the dev-server runs on this implementation, so the e2e
      // flows see this one.
      pushProposalForTest: (proposal) =>
        // The run first — see `testProposalRun`'s note on why a lever-injected
        // Proposal needs one now that the record is a list of runs.
        sql`
          INSERT INTO deliberation_run (id, cadence, status, failure_reason, data_window_json, started_at, finished_at)
          VALUES (
            ${testProposalRun(proposal).runId}, ${testProposalRun(proposal).cadence}, 'committed', NULL,
            ${testProposalRun(proposal).dataWindowJson ?? null},
            ${proposal.createdAt}, ${proposal.createdAt}
          )
          ON CONFLICT(id) DO NOTHING
        `.pipe(
          Effect.flatMap(
            () => sql`
          INSERT INTO decision
            (id, kind, origin, status, summary, rationale, citations_json, data_window_json, created_at, plan_operations_json, catalog_exercises_json, run_id)
          VALUES (
            ${proposal.id}, 'proposal', ${proposal.origin}, ${proposal.status},
            ${proposal.summary}, ${proposal.rationale}, NULL, NULL, ${proposal.createdAt},
            ${proposal.planOperations === undefined ? null : JSON.stringify(proposal.planOperations)},
            ${proposal.catalogExercises === undefined ? null : JSON.stringify(proposal.catalogExercises)},
            ${testProposalRun(proposal).runId}
          )
        `,
          ),
          Effect.flatMap(
            () => sql`
              INSERT INTO coaching_feed_entry
                (id, kind, summary, created_at, decision_id, proposal_id)
              VALUES (
                ${`feed-${proposal.id}`}, 'proposal', ${proposal.summary},
                ${proposal.createdAt}, ${proposal.id}, ${proposal.id}
              )
            `,
          ),
          Effect.orDie,
          Effect.flatMap(() => bumpChangeTick),
        ),

      // The Deliberation runner's ONLY write-back (ADR 0011 §3/§6, issue
      // #26): maps a run-output object to `decision`/`coaching_feed_entry`
      // rows in one pass. `getProposals`/`subscribeProposals` above already
      // read `kind = 'proposal'` straight off the `decision` table, so a
      // committed Proposal is visible through them with no extra wiring.
      commitDeliberationOutput: (input: CommitDeliberationOutputInput) =>
        Effect.gen(function* () {
          const decisionIds: Array<string> = [];
          const feedEntryIds: Array<string> = [];
          const dataWindowJson = JSON.stringify(input.dataWindow);
          // Present only on a Revision run (ADR 0013). Every row this run
          // commits joins the pushed-back Proposal's lineage, and it is the
          // only id a `supersede` directive may name (see the guard below).
          const reviseTargetId = input.reviseTargetProposalId ?? null;
          const isRevisionRun = reviseTargetId !== null;
          // The Intake marker (ADR 0014 §6) — supplied by the runner alone and
          // absent from the agent's output contract, so an agent reasoning slip
          // cannot mint an Intake-scoped row. It carries the drafted Plan, and
          // its presence is what the three §6 rules key off (see `loadProposals`
          // / `loadCoachingFeed` above and the `supersede` guard below).
          const intakePlanJson =
            input.intakeRun === undefined ? null : JSON.stringify(input.intakeRun.draftPlan);
          const isIntakeRun = intakePlanJson !== null;
          // ADR 0013 §7 — a Revision run is user-invoked and has a SUBJECT, so
          // its emissions are scoped (unlike a review cadence, ADR 0011 §4).
          // The user asked one question about one Decision; a run that digs
          // through the Log to answer it will notice unrelated things, and
          // answering must not change the subject. At most ONE revised
          // Proposal survives — anything further the next Session review will
          // find again through the Observation mechanism.
          let proposalCommitted = false;

          for (const draft of input.runOutput.decisions) {
            // "One Decision, written once" (ADR 0014 §2) is what keeps Intake's
            // store contract trivial — no interim rows, nothing to clean up on
            // abandonment — so the store holds that bar itself rather than
            // trusting the runner to.
            if ((isRevisionRun || isIntakeRun) && draft.kind === "proposal") {
              if (proposalCommitted) continue;
              proposalCommitted = true;
            }
            const id = randomUUID();
            const createdAt = new Date().toISOString();
            // An Answer is born terminal: it proposes no Change, so there is
            // nothing to accept and no accumulation to sit in (ADR 0013 §2).
            const status = draft.kind === "observation" ? "open" : draft.kind === "answer" ? "answered" : "pending";
            yield* sql`
              INSERT INTO decision
                (id, kind, origin, status, summary, rationale, citations_json, data_window_json, created_at, in_response_to_id, revise_prose, intake_plan_json, plan_operations_json, catalog_exercises_json, measurements_json, rule, uncertainty, run_id)
              VALUES (
                ${id}, ${draft.kind}, 'coach-proposal', ${status},
                ${draft.summary}, ${draft.rationale}, ${JSON.stringify(draft.citations)},
                ${dataWindowJson}, ${createdAt}, ${reviseTargetId}, ${input.revisionProse ?? null},
                ${draft.kind === "proposal" ? intakePlanJson : null},
                ${
                  // The Change the Proposal proposes (#86). Only a Proposal
                  // may carry one — only a Proposal is a Change awaiting a
                  // decision — so operations on an Observation or an Answer are
                  // dropped here rather than stored where nothing applies them.
                  draft.kind === "proposal" && draft.plan_operations !== undefined
                    ? JSON.stringify(draft.plan_operations)
                    : null
                },
                ${
                  // The catalog rows those operations need (ADR 0016). Scoped
                  // to a Proposal for the same reason and dropped on anything
                  // else — an Observation applies nothing, so a row it asked
                  // for would be created by an Accept that never comes. Also
                  // dropped when there are no operations at all: rows nothing
                  // references are how an orphan catalog grows.
                  draft.kind === "proposal" &&
                  draft.plan_operations !== undefined &&
                  draft.catalog_exercises !== undefined &&
                  draft.catalog_exercises.length > 0
                    ? JSON.stringify(draft.catalog_exercises)
                    : null
                },
                ${draft.measurements === undefined ? null : JSON.stringify(draft.measurements)},
                ${draft.rule ?? null}, ${draft.uncertainty ?? null},
                ${input.runId ?? null}
              )
            `;
            decisionIds.push(id);

            // Every Proposal gets a feed entry; an Observation only when
            // the agent marked it `surface: true` (ADR 0011 §6). An Answer
            // NEVER gets one (ADR 0013 §7): it is already on the card the
            // user is looking at, and asking a question must not manufacture
            // an unread feed item. Nor does an Observation a Revision run
            // happened to notice: it is kept as evidence for future runs
            // (`open`, in the log) but forced unsurfaced (ADR 0013 §7), so
            // asking a question never produces unread notifications.
            if (
              draft.kind === "proposal" ||
              (draft.kind === "observation" && draft.surface && !isRevisionRun && !isIntakeRun)
            ) {
              const feedId = randomUUID();
              yield* sql`
                INSERT INTO coaching_feed_entry (id, kind, summary, created_at, proposal_id, decision_id)
                VALUES (
                  ${feedId}, ${draft.kind}, ${draft.summary}, ${createdAt},
                  ${draft.kind === "proposal" ? id : null}, ${id}
                )
              `;
              feedEntryIds.push(feedId);
            }
          }

          // Status-only flips against EXISTING, still-OPEN Observation rows
          // (ADR 0011 §5) — rationale/citations/data_window_json columns are
          // never touched by this UPDATE. The `kind = 'observation' AND
          // status = 'open'` guard keeps a directive naming a non-Observation
          // (e.g. a Proposal), an unknown id, OR an already-terminal
          // Observation (`escalated`/`expired`) a no-op: directives act only
          // on the OPEN Observations a run read as priors, and §5 maps each
          // action to exactly one terminal status. Re-flipping a terminal row
          // — resurrecting a closed one or contradicting an `escalated` one a
          // Proposal already references — would corrupt the log, so the store
          // (the trust boundary over an untrusted agent output) forbids it.
          //
          // `supersede` (ADR 0013 §3) is the one action that names a
          // PROPOSAL, and it is scoped twice over: the id must equal the
          // Proposal this Revision run was invoked against, and that row must
          // still be `pending`. So the agent supplies the *judgment* ("my
          // revision replaces it") while the runner supplies the *subject* —
          // a reasoning slip cannot reach past the run's own Proposal to kill
          // an unrelated pending row or flip an already-`accepted` one, which
          // would desync the Plan from its own audit trail. A `supersede` on
          // any other id, or from a run with no target at all, is a no-op,
          // exactly like an out-of-scope Observation directive.
          yield* Effect.forEach(
            input.runOutput.observation_directives,
            (directive) =>
              Effect.gen(function* () {
                if (directive.action === "supersede") {
                  // Under the Intake marker (ADR 0014 §5) the subject is a
                  // property of the row rather than an id the runner passes:
                  // re-converging after reopening the exchange may supersede
                  // the prior INTAKE Proposal, while it is still pending, and
                  // nothing else. Every other id is a no-op.
                  if (isIntakeRun) {
                    yield* sql`UPDATE decision SET status = 'superseded' WHERE id = ${directive.id} AND kind = 'proposal' AND status = 'pending' AND intake_plan_json IS NOT NULL`;
                    return;
                  }
                  if (reviseTargetId === null || directive.id !== reviseTargetId) return;
                  yield* sql`UPDATE decision SET status = 'superseded' WHERE id = ${directive.id} AND kind = 'proposal' AND status = 'pending'`;
                  return;
                }
                // In a Revision run every Observation is by definition off-
                // subject — the run's subject is a Proposal — so escalate/
                // close are discarded wholesale (ADR 0013 §7). Escalation
                // belongs to the review cadences that survey. Same for Intake:
                // at cold start the database is empty by definition, so there
                // are no prior Observations to escalate or close.
                if (isRevisionRun || isIntakeRun) return;
                const nextStatus = directive.action === "escalate" ? "escalated" : "expired";
                yield* sql`UPDATE decision SET status = ${nextStatus} WHERE id = ${directive.id} AND kind = 'observation' AND status = 'open'`;
              }),
            { discard: true },
          );

          yield* bumpChangeTick;

          const result: CommitDeliberationOutputResult = {
            decisionIds: decisionIds as never,
            feedEntryIds: feedEntryIds as never,
          };
          return result;
        }).pipe(Effect.orDie),

      listDecisionsForTest: sql<DecisionRow>`SELECT * FROM decision ORDER BY created_at, id`.pipe(
        Effect.map((rows) => rows.map(toDecisionRecord)),
        Effect.orDie,
      ),

      // --- seed-input storage (ADR 0011 §2, issue #34) --------------------

      getGoal: sql<GoalRow>`SELECT * FROM goal WHERE id = 'current'`.pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : toGoalSummary(rows[0]))),
        Effect.orDie,
      ),

      setGoal: (input: SetGoalInput) =>
        Effect.gen(function* () {
          // Singleton, fixed id — a delete-then-insert replace, never an
          // accumulating history (CONTEXT `Goal`: "One current Goal").
          yield* sql`DELETE FROM goal WHERE id = 'current'`;
          yield* sql`
            INSERT INTO goal (id, statement, proxies_json, updated_at)
            VALUES ('current', ${input.statement}, ${JSON.stringify(input.proxies)}, ${new Date().toISOString()})
          `;
          yield* bumpChangeTick;
          const goal: GoalSummary = { statement: input.statement, proxies: input.proxies };
          return goal;
        }).pipe(Effect.orDie),

      listStandingConstraints: sql<StandingConstraintRow>`
        SELECT * FROM standing_constraint ORDER BY created_at, id
      `.pipe(
        Effect.map((rows) => rows.map(toStandingConstraint)),
        Effect.orDie,
      ),

      addStandingConstraint: (input: AddStandingConstraintInput) =>
        Effect.gen(function* () {
          const id = randomUUID();
          yield* sql`
            INSERT INTO standing_constraint (id, text, severity, created_at)
            VALUES (${id}, ${input.text}, ${input.severity}, ${new Date().toISOString()})
          `;
          yield* bumpChangeTick;
          const constraint: StandingConstraint = { id, text: input.text, severity: input.severity };
          return constraint;
        }).pipe(Effect.orDie),

      removeStandingConstraint: (input: RemoveStandingConstraintInput) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string }>`
            SELECT id FROM standing_constraint WHERE id = ${input.constraintId}
          `;
          if (rows[0] === undefined) {
            return { removed: false };
          }
          yield* sql`DELETE FROM standing_constraint WHERE id = ${input.constraintId}`;
          yield* bumpChangeTick;
          return { removed: true };
        }).pipe(Effect.orDie),

      listCheckIns: sql<CheckInRow>`SELECT * FROM check_in ORDER BY recorded_at, id`.pipe(
        Effect.map((rows) => rows.map(toCheckIn)),
        Effect.orDie,
      ),

      addCheckIn: (input: AddCheckInInput) =>
        Effect.gen(function* () {
          const id = randomUUID();
          const recordedAt = input.recordedAt ?? new Date().toISOString();
          yield* sql`
            INSERT INTO check_in (id, recorded_at, sleep, soreness, stress, energy)
            VALUES (${id}, ${recordedAt}, ${input.sleep}, ${input.soreness}, ${input.stress}, ${input.energy})
          `;
          yield* bumpChangeTick;
          return toCheckIn({
            id,
            recorded_at: recordedAt,
            sleep: input.sleep,
            soreness: input.soreness,
            stress: input.stress,
            energy: input.energy,
          });
        }).pipe(Effect.orDie),

      listContextNotes: sql<ContextNoteRow>`SELECT * FROM context_note ORDER BY recorded_at, id`.pipe(
        Effect.map((rows) => rows.map(toContextNote)),
        Effect.orDie,
      ),

      addContextNote: (input: AddContextNoteInput) =>
        Effect.gen(function* () {
          const recordedAt = input.recordedAt ?? new Date().toISOString();
          const entryId = input.entryId ?? null;
          const loggedSessionId = input.loggedSessionId ?? null;
          // A supplied `commandId` doubles as the row's `id` (migration
          // `018`'s doc) — replaying it lands on the table's own PRIMARY KEY,
          // so `ON CONFLICT(id) DO NOTHING` + read-back is exactly-once with
          // no extra column, mirroring an unplanned Set's client-minted
          // `setId`. Without one (the pre-#130 unanchored write path) a fresh
          // id is minted and there is nothing to dedupe.
          const id = input.commandId ?? randomUUID();
          yield* sql`
            INSERT INTO context_note (id, recorded_at, text, entry_id, logged_session_id)
            VALUES (${id}, ${recordedAt}, ${input.text}, ${entryId}, ${loggedSessionId})
            ON CONFLICT(id) DO NOTHING
          `;
          const rows = yield* sql<ContextNoteRow>`SELECT * FROM context_note WHERE id = ${id}`;
          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.die(new Error(`SqlStore: context_note row missing for id ${id}`));
          }
          yield* bumpChangeTick;
          return toContextNote(row);
        }).pipe(Effect.orDie),

      editContextNote: (input: EditContextNoteInput) =>
        Effect.gen(function* () {
          // `recorded_at` is deliberately untouched — see the in-memory
          // store's note: an edit sharpens the observation, it does not move
          // it in the Session's timeline. An `UPDATE` that matches no row is
          // the no-op success `EditContextNoteInput` specifies, so the
          // read-back (not `rowsAffected`) is what decides the answer.
          yield* sql`UPDATE context_note SET text = ${input.text} WHERE id = ${input.noteId}`;
          const rows = yield* sql<ContextNoteRow>`SELECT * FROM context_note WHERE id = ${input.noteId}`;
          const row = rows[0];
          if (row === undefined) return undefined;
          yield* bumpChangeTick;
          return toContextNote(row);
        }).pipe(Effect.orDie),

      listEvidenceRoster: sql<EvidenceClaimRow>`SELECT * FROM evidence_claim ORDER BY created_at, id`.pipe(
        Effect.map((rows) => rows.map(toEvidenceClaim)),
        Effect.orDie,
      ),

      getPointerDigestHistory: Effect.gen(function* () {
        const decisionRows = yield* sql<{ readonly created_at: string; readonly data_window_json: string | null }>`
          SELECT created_at, data_window_json FROM decision WHERE data_window_json IS NOT NULL
        `;
        const sessionRows = yield* sql<{ readonly started_at: string }>`
          SELECT started_at FROM logged_session
        `;
        return deriveDigestHistory(
          decisionRows.map((r) => ({ createdAt: r.created_at, dataWindowJson: r.data_window_json })),
          sessionRows.map((r) => r.started_at),
        );
      }).pipe(Effect.orDie),

      // --- per-cadence model settings (ADR 0011 §4, issue #31 — 2B slice 6) --

      getCadenceModel: (cadence: DeliberationCadence) =>
        sql<{ readonly model: string; readonly effort: string | null }>`
          SELECT model, effort FROM cadence_model_setting WHERE cadence = ${cadence}
        `.pipe(
          Effect.map((rows) =>
            rows[0] === undefined
              ? { model: undefined, effort: undefined }
              : { model: rows[0].model, effort: rows[0].effort ?? undefined },
          ),
          Effect.orDie,
        ),

      setCadenceModel: (input: CadenceModelSetting) =>
        Effect.gen(function* () {
          // Per-cadence singleton (keyed by `cadence`) — upsert so a repeated
          // set replaces the choice rather than accumulating history.
          const effort = input.effort ?? null;
          yield* sql`
            INSERT INTO cadence_model_setting (cadence, model, effort, updated_at)
            VALUES (${input.cadence}, ${input.model}, ${effort}, ${new Date().toISOString()})
            ON CONFLICT(cadence) DO UPDATE SET model = ${input.model}, effort = ${effort}, updated_at = ${new Date().toISOString()}
          `;
          yield* bumpChangeTick;
          const setting: CadenceModelSetting = {
            cadence: input.cadence,
            model: input.model,
            ...(input.effort === undefined ? {} : { effort: input.effort }),
          };
          return setting;
        }).pipe(Effect.orDie),

      // --- the run ledger (ADR 0011 §8 amendment, issue #81) ---------------

      recordRunLedgerRow: (row: {
        readonly runId: string;
        readonly cadence: DeliberationCadence;
        readonly stage: DeliberationRunStage;
        readonly model: string | undefined;
        readonly usage: TokenUsage;
        readonly costUsd: number;
      }) =>
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO deliberation_run_ledger
              (id, run_id, cadence, stage, model, input, output, cache_read, cache_creation, cost_usd, ran_at)
            VALUES (
              ${randomUUID()}, ${row.runId}, ${row.cadence}, ${row.stage}, ${row.model ?? null},
              ${row.usage.input}, ${row.usage.output}, ${row.usage.cacheRead}, ${row.usage.cacheCreation},
              ${row.costUsd}, ${new Date().toISOString()}
            )
          `;
        }).pipe(Effect.orDie),

      getSpendSummary: sql<{
        readonly run_id: string;
        readonly cadence: DeliberationCadence;
        readonly stage: DeliberationRunStage;
        readonly model: string | null;
        readonly input: number;
        readonly output: number;
        readonly cache_read: number;
        readonly cache_creation: number;
        readonly cost_usd: number;
        readonly ran_at: string;
      }>`
        SELECT run_id, cadence, stage, model, input, output, cache_read, cache_creation, cost_usd, ran_at
        FROM deliberation_run_ledger
        ORDER BY ran_at
      `.pipe(
        Effect.map((rows) =>
          summarizeRunLedger(
            rows.map(
              (row): RunLedgerRecord => ({
                id: row.run_id,
                runId: row.run_id,
                cadence: row.cadence,
                stage: row.stage,
                model: row.model ?? undefined,
                usage: {
                  input: row.input,
                  output: row.output,
                  cacheRead: row.cache_read,
                  cacheCreation: row.cache_creation,
                },
                costUsd: row.cost_usd,
                ranAt: row.ran_at,
              }),
            ),
          ),
        ),
        Effect.orDie,
      ),

      // --- the RPE capture control (#63, issue #81) -------------------------

      getRpeCaptureMode: sql<{ readonly mode: RpeCaptureMode }>`
        SELECT mode FROM rpe_capture_setting WHERE id = 1
      `.pipe(
        Effect.map((rows) => rows[0]?.mode ?? DEFAULT_RPE_CAPTURE_MODE),
        Effect.orDie,
      ),

      setRpeCaptureMode: (mode: RpeCaptureMode) =>
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO rpe_capture_setting (id, mode, updated_at)
            VALUES (1, ${mode}, ${new Date().toISOString()})
            ON CONFLICT(id) DO UPDATE SET mode = ${mode}, updated_at = ${new Date().toISOString()}
          `;
          yield* bumpChangeTick;
          return mode;
        }).pipe(Effect.orDie),

      // --- the monthly Cycle-review schedule (ADR 0011 §4, issue #91) --------

      claimDueCycleReview: (params) =>
        Effect.gen(function* () {
          // Bootstrap: a fresh DB starts the clock at `now` and claims
          // nothing, so standing a server up does not immediately spend
          // subscription quota reviewing a history that does not exist yet.
          // `OR IGNORE` makes this a no-op once the row exists, so it costs
          // one cheap statement per poll rather than needing its own read.
          yield* sql`
            INSERT OR IGNORE INTO cycle_review_schedule (id, last_run_at) VALUES (1, ${params.now})
          `;

          // The claim, as ONE conditional statement: the row moves to `now`
          // only if it is still at the value that made this window due. Two
          // pollers racing (or a poll racing a restart's first tick) means one
          // UPDATE matches and the other matches nothing — a due window cannot
          // be claimed twice, so two Cycle reviews cannot double-fire from it.
          const cutoff = new Date(Date.parse(params.now) - params.intervalMillis).toISOString();
          const claimedRows = yield* sql<{ readonly last_run_at: string }>`
            UPDATE cycle_review_schedule
            SET last_run_at = ${params.now}
            WHERE id = 1 AND last_run_at <= ${cutoff}
            RETURNING last_run_at
          `;
          if (claimedRows.length > 0) return { claimed: true, lastRunAt: params.now };

          const rows = yield* sql<{ readonly last_run_at: string }>`
            SELECT last_run_at FROM cycle_review_schedule WHERE id = 1
          `;
          return { claimed: false, lastRunAt: rows[0]?.last_run_at ?? params.now };
        }).pipe(Effect.orDie),

      logSetActual,
      unlogSetActual,
      swapEntryExercise,

      pauseAcks: Effect.gen(function* () {
        const existing = yield* Ref.get(pauseGateRef);
        if (Option.isSome(existing)) return;
        const gate = Deferred.makeUnsafe<void, never>();
        yield* Ref.set(pauseGateRef, Option.some(gate));
      }),

      resumeAcks: Effect.gen(function* () {
        const gate = yield* Ref.get(pauseGateRef);
        if (Option.isSome(gate)) {
          yield* Deferred.succeed(gate.value, undefined);
        }
        yield* Ref.set(pauseGateRef, Option.none());
      }),

      reset: Effect.gen(function* () {
        const gate = yield* Ref.get(pauseGateRef);
        if (Option.isSome(gate)) {
          yield* Deferred.succeed(gate.value, undefined);
        }
        yield* Ref.set(pauseGateRef, Option.none());
        yield* Ref.set(inFlightRef, new Map());
        yield* clearAllTables().pipe(Effect.orDie);
        // `/__test__/reset` is dev/e2e-only (never mounted on the production
        // server), so it always restores the full demo fixture set regardless
        // of this `SqlStore`'s own `seedDemoFixtures` option.
        yield* seedDemoFixtures().pipe(Effect.orDie);
        yield* seedEvidenceRosterIfEmpty().pipe(Effect.orDie);
        yield* bumpChangeTick;
      }),

      appliedCount: sql<{ readonly count: number }>`SELECT COUNT(*) as count FROM logged_set_actual`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.orDie,
      ),

      listActuals: sql<LoggedSetActualRow>`
        SELECT * FROM logged_set_actual ORDER BY applied_at, rowid
      `.pipe(
        Effect.map((rows) => rows.map(toActualResult)),
        Effect.orDie,
      ),

      listEntrySwaps: sql<LoggedEntrySwapRow>`
        SELECT * FROM logged_entry_swap ORDER BY swapped_at, id
      `.pipe(
        Effect.map((rows) => rows.map(toSwapResult)),
        Effect.orDie,
      ),
    });
  }),
  );

export interface SqlStoreConfig {
  /** The `node:sqlite` database file path, or `:memory:`. */
  readonly filename: string;
  /**
   * Seed the dev/e2e demo fixtures (a demo Plan, its matching Exercise
   * catalog rows, proposals, and coaching feed entries) on a fresh database.
   * Defaults to `true` — every dev-server and test caller relies on this demo
   * state being there. Production passes `false`: a real user's Exercise
   * catalog and Plan must start empty and be built through Intake/
   * Deliberation, never pre-filled with these fixtures (CONTEXT `Exercise
   * catalog`).
   */
  readonly seedDemoFixtures?: boolean;
}

export const SqlStore = {
  /**
   * A `Store` layer over a fully-migrated, seeded-once `node:sqlite`
   * database. Provide this in place of `Store.layer` to make persistence
   * real (Step 2A, task 2A.1) — every RPC handler and thin-client task
   * keeps working unchanged because both layers satisfy the identical
   * `Store` tag.
   */
  layer: (config: SqlStoreConfig): Layer.Layer<Store, SqlError | MigrationError | PlatformError, never> =>
    makeStoreLive({ seedDemoFixtures: config.seedDemoFixtures ?? true }).pipe(
      Layer.provide(
        makeSqlitePersistenceLive(config.filename).pipe(
          Layer.provide([NodeFileSystem.layer, NodePath.layer]),
        ),
      ),
    ),
};
