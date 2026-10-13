import { randomUUID } from "node:crypto";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  applyPlanOperation,
  applyPlanOperations,
  foldProposedExercises,
  materializeDraftPlan,
  type ExerciseCatalogEntry,
  type PlanAuthoringContext,
} from "@repcoach/client-runtime/plan";
import {
  addTokenUsage,
  DEFAULT_RPE_CAPTURE_MODE,
  ExerciseNotFoundError,
  isPlanEditCommand,
  PlanOperationRejectedError,
  PrescribedSessionNotFoundError,
  PrescribedSetNotFoundError,
  ProposalAlreadyResolvedError,
  ProposalNotFoundError,
  RECENT_RUNS_LIMIT,
  ZERO_TOKEN_USAGE,
  type AddCheckInInput,
  type AddContextNoteInput,
  type EditContextNoteInput,
  type AddStandingConstraintInput,
  type ApplyUserChangeInput,
  type CheckIn,
  type CadenceModelSetting,
  type CadenceSpendBreakdown,
  type CatalogEnrichment,
  type CatalogExercise,
  type CoachingFeedEntry,
  type CommitDeliberationOutputInput,
  type CreateExerciseInput,
  type CommitDeliberationOutputResult,
  type ContextNote,
  type DecisionStatus,
  type DeliberationCadence,
  type DeliberationDataWindow,
  type DeliberationRunRecord,
  type DeliberationRunStage,
  type EvidenceClaim,
  type ExerciseCatalog,
  type GetSpendSummaryResult,
  type GoalSummary,
  type IntakeDraftPlan,
  type ActiveLoggedSessionSummary,
  type CancelSessionResult,
  type GetDailySetCountsInput,
  type GetDailySetCountsResult,
  type ExportDataResult,
  type GetExerciseProgressResult,
  type BodyweightEntry,
  type ListBodyweightResult,
  type LogBodyweightInput,
  type RemoveBodyweightInput,
  type ImportWorkoutsInput,
  type ImportWorkoutsResult,
  type LastActualForExerciseInput,
  type LastActualForExerciseResult,
  type ListActiveSessionsResult,
  type ListSessionsInput,
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
  foldNetActuals,
  type SwapEntryExerciseInput,
  type SwapEntryExerciseResult,
  type UnlogSetActualInput,
  type UnlogSetActualResult,
  type MetricName,
  type PlanOperation,
  type ProposedCatalogExercise,
  type PlanSnapshot,
  type PrescribedEntry,
  type PrescribedSession,
  type PrescribedTargetInterval,
  type Proposal,
  type ProposalExchange,
  type ProposalExchangeEntry,
  type RecentRunSummary,
  type RemoveStandingConstraintInput,
  type RenameExerciseInput,
  type ResolveProposalInput,
  type ResolveProposalResult,
  type RpeCaptureMode,
  type SessionId,
  type SetGoalInput,
  type StandingConstraint,
  type StartSessionResult,
  type TokenUsage,
  type UnenrichedExercise,
} from "@repcoach/contracts";

import {
  assembleDeliberationRuns,
  type DeliberationRunRecordInput,
} from "./deliberationRunRecord.ts";
import { loadVettedEvidenceSeed } from "./evidenceSeed.ts";
import { seedExerciseCatalog } from "./exerciseCatalogSeed.ts";
import { importedSessionRows } from "./importedSessions.ts";
import {
  resolveLastActualForExercise,
  resolveBestE1rm,
  resolveExerciseProgress,
  resolveLastSetsForExercise,
  type FinishedSessionView,
} from "./lastActualForExercise.ts";

/**
 * `Store` — the Effect `Context.Service` seam the dev-server (Task 2) and
 * now `@repcoach/persistence`'s `SqlStore` (Step 2A, task 2A.1) both
 * satisfy. Moved here verbatim from `apps/dev-server/src/store.ts` (which
 * now just re-exports it) so both the in-memory layer below AND the SQLite
 * `SqlStore` layer (`sqlStore.ts`) live behind one shared interface —
 * `rpcHandlers.ts` and every thin-client task 0–8 import stayed unchanged.
 *
 * The in-memory `Store.layer` below is kept (not deleted): `rpcHandlers.
 * test.ts` still runs its rung-1 suite against it directly (fast, no SQL),
 * and `SqlStore.layer` (a second, separate `Layer` satisfying the same
 * `Store` tag) is what the dev-server's `server.ts` now provides instead
 * for the real (parity) e2e run.
 */

export const SEEDED_SESSION_ID = "session-seed-1";

/**
 * "Stats" (issue #117) — the local-day bucketing rule, shared by the
 * in-memory `Store` below and mirrored in raw SQL by `SqlStore`
 * (`date(applied_at, printf('%+d minutes', offset))`). `appliedAt` is a UTC
 * ISO timestamp (`new Date().toISOString()`, written at `logSetActual` time);
 * shifting it by the caller's local offset *before* reading off the calendar
 * date is what makes a set logged at 23:50 local land on that local day
 * rather than the UTC day it may have already rolled into. `getUTC*` on the
 * shifted instant (not `getFullYear`/`getDate`) is deliberate: this process's
 * own machine timezone must never enter the calculation a second time.
 */
export const localDateKey = (appliedAtIso: string, utcOffsetMinutes: number): string => {
  const shifted = new Date(Date.parse(appliedAtIso) + utcOffsetMinutes * 60_000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/**
 * Exercise-catalog lookup for the in-memory seed (Step 2A, task 2A.3):
 * mirrors `SqlStore`'s `exercise_catalog` JOIN so both `Store` layers attach
 * the identical `trackedMetrics` to a seeded Entry — one source of truth
 * (`exerciseCatalogSeed.ts`), no drift between the SQL and in-memory seeds.
 */
const trackedMetricsByExerciseId = new Map(
  seedExerciseCatalog().map((exercise) => [exercise.id, exercise.trackedMetrics]),
);

/** Attaches each Entry's catalog-declared `trackedMetrics`, when the catalog has a row for its exercise. */
const attachTrackedMetricsFrom = (
  session: PrescribedSession,
  catalog: ReadonlyMap<string, ReadonlyArray<MetricName> | undefined>,
): PrescribedSession => ({
  ...session,
  blocks: session.blocks.map((block) => ({
    ...block,
    entries: block.entries.map((entry): PrescribedEntry => {
      const trackedMetrics = catalog.get(entry.exerciseId);
      return trackedMetrics === undefined ? entry : { ...entry, trackedMetrics };
    }),
  })),
});

const attachTrackedMetrics = (session: PrescribedSession): PrescribedSession =>
  attachTrackedMetricsFrom(session, trackedMetricsByExerciseId);

/**
 * Re-attaches `trackedMetrics` from the catalog **as it stands now**, which
 * is what `SqlStore`'s `LEFT JOIN exercise_catalog` does on every read.
 *
 * The in-memory layer used to answer with whatever the Entry was given when
 * it was authored, and the difference was invisible while the catalog was
 * write-once. Enrichment (#104) makes it visible: the metrics an Entry is
 * born with are the un-enriched row's (none), and if the read never re-joins,
 * the exercise still logs through the target-key fallback long after the
 * coach has said what it tracks — on one `Store` layer but not the other.
 */
const rejoinTrackedMetrics = (
  session: PrescribedSession,
  exerciseCatalog: ReadonlyMap<string, ExerciseCatalogEntry>,
): PrescribedSession =>
  attachTrackedMetricsFrom(
    session,
    new Map(Array.from(exerciseCatalog.values()).map((row) => [row.id, row.trackedMetrics])),
  );

/**
 * Task 6 (issue #20) enriched the seed beyond the original single
 * single-exercise straight Block so the real logging grid has real cases to
 * exercise: `block-1` stays exactly as Tasks 4/5 left it (straight,
 * `entry-1`/`set-1`/`set-2`, reps+load) so nothing that already depended on
 * those ids breaks; `block-2` adds a superset (multiple exercises, one of
 * which — the plank — only tracks `duration`, proving field layout is
 * metric-driven, not a fixed reps/load shape); `block-3` adds a straight
 * Block whose Entry carries a drop-set continuation of its working Set.
 *
 * Exported (Step 2A) so `SqlStore`'s seeding flattens this exact same tree
 * into relational rows — one source of truth, no drift between the
 * in-memory seed and the SQLite seed.
 */
export const seedPrescribedSession = (): PrescribedSession =>
  attachTrackedMetrics({
    id: SEEDED_SESSION_ID as PrescribedSession["id"],
    blocks: [
      {
        id: "block-1" as never,
        format: "straight",
        entries: [
          {
            id: "entry-1" as never,
            exerciseId: "exercise-back-squat" as never,
            sets: [
              {
                id: "set-1" as never,
                setType: "working",
                target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } },
                restSec: 120,
              },
              {
                id: "set-2" as never,
                setType: "working",
                target: { reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } },
                restSec: 120,
              },
            ],
          },
        ],
      },
      {
        id: "block-2" as never,
        format: "superset",
        entries: [
          {
            id: "entry-2" as never,
            exerciseId: "exercise-bench-press" as never,
            sets: [
              {
                id: "set-3" as never,
                setType: "working",
                target: { reps: { min: 8, max: 10 }, load: { min: 60, max: 60 } },
                restSec: 90,
              },
            ],
          },
          {
            id: "entry-3" as never,
            exerciseId: "exercise-plank" as never,
            sets: [
              {
                id: "set-4" as never,
                setType: "working",
                target: { duration: { min: 30, max: 45 } },
                restSec: 60,
              },
            ],
          },
        ],
      },
      {
        id: "block-3" as never,
        format: "straight",
        entries: [
          {
            id: "entry-4" as never,
            exerciseId: "exercise-leg-press" as never,
            sets: [
              {
                id: "set-5" as never,
                setType: "working",
                target: { reps: { min: 10, max: 10 }, load: { min: 80, max: 80 } },
                restSec: 90,
              },
              {
                id: "set-6" as never,
                setType: "drop",
                // A drop set is read as a continuation of the preceding working
                // Set (CONTEXT `Set`): no reps target, just a reduced-load cap.
                target: { load: { max: 60 } },
              },
            ],
          },
        ],
      },
    ],
  });

/** The seeded Observation the feed's first entry points at (#79). */
const SEEDED_OBSERVATION_ID = "observation-1";

/** The seeded Session review that emitted both seeded Decisions (ADR 0011 §8). */
export const SEEDED_REVIEW_RUN_ID = "run-seed-review";
/** The seeded Session review that ran, judged, and emitted nothing — see `seedDeliberationRuns`. */
export const SEEDED_QUIET_RUN_ID = "run-seed-quiet";
/** The seeded Session review that died before committing — see `seedDeliberationRuns`. */
export const SEEDED_FAILED_RUN_ID = "run-seed-failed";

/**
 * Two entries, one of each kind — and the Proposal one is new (#79). The seed
 * previously carried only the Observation, which quietly contradicted the
 * rule `commitDeliberationOutput` enforces on every real run: *every* Proposal
 * gets a feed entry, an Observation only when the agent surfaces it. The Coach
 * surface is the permanent record of both, so the seed has to obey the rule it
 * demonstrates.
 */
export const seedCoachingFeed = (): ReadonlyArray<CoachingFeedEntry> => [
  {
    id: "feed-1" as never,
    kind: "observation",
    summary: "Squat load has held steady for 3 sessions.",
    createdAt: "2026-07-01T00:00:00.000Z",
    decisionId: SEEDED_OBSERVATION_ID as never,
  },
  {
    id: "feed-2" as never,
    kind: "proposal",
    summary: "Increase back squat working load by 2.5kg.",
    createdAt: "2026-07-01T00:00:00.000Z",
    decisionId: "proposal-1" as never,
    proposalId: "proposal-1" as never,
  },
];

export const seedProposals = (): ReadonlyArray<Proposal> => [
  {
    id: "proposal-1" as never,
    origin: "coach-proposal",
    status: "pending",
    summary: "Increase back squat working load by 2.5kg.",
    rationale: "Squat load has held steady for 3 sessions at the current target.",
    createdAt: "2026-07-01T00:00:00.000Z",
    // The Change it proposes, in the ADR 0015 operation union (#86). The
    // seeded Proposal SAYS "the back squat working load, +2.5kg", so what
    // Accept applies is exactly that and nothing else — before #86 it applied
    // a stand-in that raised every load in the whole Plan, which made the
    // seeded card a demo of prose that did not match its own effect.
    planOperations: [
      {
        _tag: "replaceEntrySets",
        entryId: "entry-1" as never,
        sets: [
          {
            id: "set-1" as never,
            setType: "working",
            target: { reps: { min: 5, max: 5 }, load: { min: 102.5, max: 102.5 } },
            restSec: 120,
          },
          {
            id: "set-2" as never,
            setType: "working",
            target: { reps: { min: 5, max: 5 }, load: { min: 102.5, max: 102.5 } },
            restSec: 120,
          },
        ],
      },
    ],
  },
];

export const seedPlan = (): PlanSnapshot => ({
  id: "plan-1" as never,
  planModel: "linear-progression",
  sessions: [seedPrescribedSession()],
});

/**
 * The Evidence-base roster seed (ADR 0003 §1/§5, issues #34 and #87): the real
 * vetted corpus, read from `docs/evidence/evidence-base-seed.json`. Issue #34
 * built storage + retrieval against two placeholder entries whose `source` said
 * so in as many words; #87 loaded the content task's actual output and deleted
 * them. Exported so `SqlStore`'s seeding flattens this exact same list (one
 * source of truth, no drift between the in-memory and SQLite seeds — mirrors
 * `seedExerciseCatalog`/`seedPlan`'s pattern); see `evidenceSeed.ts` for why
 * the entries are not retyped into TypeScript.
 */
export const seedEvidenceRoster = (): ReadonlyArray<EvidenceClaim & { readonly id: string }> =>
  loadVettedEvidenceSeed();

/**
 * One row of the run ledger (ADR 0011 §8 amendment, issue #81) — an agent
 * SESSION's cost, grouped by `runId` and discriminated by `stage`. See
 * `migrations/012_RunLedger.ts` for the column shapes this mirrors.
 */
export interface RunLedgerRecord {
  readonly id: string;
  readonly runId: string;
  readonly cadence: DeliberationCadence;
  readonly stage: DeliberationRunStage;
  readonly model: string | undefined;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly ranAt: string;
}

/**
 * Groups raw ledger rows into the `GetSpendSummaryResult` shape (issue #81):
 * a per-cadence breakdown (`runCount` is DISTINCT run ids, not row count — a
 * run is a deliberator session plus a sweep session, and counting rows would
 * double-count it) plus a recent-runs list, newest first, capped at
 * `RECENT_RUNS_LIMIT`.
 *
 * One function, used by BOTH `Store` layers (in-memory and SQL) rather than
 * each re-deriving the grouping, so the runtime-level behaviour the issue's
 * Testing Decisions call out — "the grouping happens server-side so the
 * runtime-level test has something worth testing" — has exactly one
 * implementation to test.
 *
 * A run's `model` is read off its `deliberator`/`intake-draft` stage (the
 * session whose model choice actually drove the run) — the `sweep`/
 * `intake-turn` stages can in principle run under a different model
 * (Revision runs deliberately reuse Session review's, ADR 0013 §6) but the
 * run-level summary reports the one that matters for "which model produced
 * this", with the full per-stage breakdown available in `stages` for anyone
 * who wants more.
 */
export const summarizeRunLedger = (rows: ReadonlyArray<RunLedgerRecord>): GetSpendSummaryResult => {
  const cadenceRunIds = new Map<DeliberationCadence, Set<string>>();
  const cadenceUsage = new Map<DeliberationCadence, TokenUsage>();
  for (const row of rows) {
    const runIds = cadenceRunIds.get(row.cadence) ?? new Set<string>();
    runIds.add(row.runId);
    cadenceRunIds.set(row.cadence, runIds);
    cadenceUsage.set(row.cadence, addTokenUsage(cadenceUsage.get(row.cadence) ?? ZERO_TOKEN_USAGE, row.usage));
  }
  const perCadence: ReadonlyArray<CadenceSpendBreakdown> = Array.from(cadenceUsage.entries())
    .map(([cadence, usage]) => ({
      cadence,
      runCount: cadenceRunIds.get(cadence)?.size ?? 0,
      usage,
    }))
    .sort((a, b) => a.cadence.localeCompare(b.cadence));

  interface RunAccumulator {
    cadence: DeliberationCadence;
    ranAt: string;
    usage: TokenUsage;
    stages: Map<DeliberationRunStage, { model: string | undefined; usage: TokenUsage }>;
    primaryModel: string | undefined;
  }
  const runs = new Map<string, RunAccumulator>();
  for (const row of rows) {
    const isPrimaryStage = row.stage === "deliberator" || row.stage === "intake-draft";
    const existing = runs.get(row.runId);
    if (existing === undefined) {
      runs.set(row.runId, {
        cadence: row.cadence,
        ranAt: row.ranAt,
        usage: row.usage,
        stages: new Map([[row.stage, { model: row.model, usage: row.usage }]]),
        primaryModel: isPrimaryStage ? row.model : undefined,
      });
      continue;
    }
    existing.usage = addTokenUsage(existing.usage, row.usage);
    existing.ranAt = row.ranAt > existing.ranAt ? row.ranAt : existing.ranAt;
    const stageEntry = existing.stages.get(row.stage);
    existing.stages.set(row.stage, {
      model: row.model ?? stageEntry?.model,
      usage: addTokenUsage(stageEntry?.usage ?? ZERO_TOKEN_USAGE, row.usage),
    });
    if (existing.primaryModel === undefined && isPrimaryStage) {
      existing.primaryModel = row.model;
    }
  }

  // Reversed before the stable sort below: `runs` iterates in first-seen
  // (oldest-first) insertion order, and two rows can share a `ranAt` down to
  // the millisecond (rapid successive runs, or a test). A stable sort leaves
  // same-`ranAt` entries in their pre-sort order, so without this reversal a
  // tie would resolve oldest-first — the opposite of "newest first".
  const recentRuns: ReadonlyArray<RecentRunSummary> = Array.from(runs.entries())
    .reverse()
    .map(([runId, acc]) => ({
      runId,
      cadence: acc.cadence,
      model: acc.primaryModel ?? null,
      ranAt: acc.ranAt,
      usage: acc.usage,
      stages: Array.from(acc.stages.entries()).map(([stage, s]) => ({
        stage,
        model: s.model ?? null,
        usage: s.usage,
      })),
    }))
    .sort((a, b) => (a.ranAt < b.ranAt ? 1 : a.ranAt > b.ranAt ? -1 : 0))
    .slice(0, RECENT_RUNS_LIMIT);

  return { perCadence, recentRuns };
};

/** Internal `check_in` record — the structured fields the summary line is rendered from (see module doc, `coachingInputs.ts`). */
export interface CheckInRecord {
  readonly id: string;
  readonly recordedAt: string;
  readonly sleep: number;
  readonly soreness: number;
  readonly stress: number;
  readonly energy: number;
}

/** Renders the canonical `CheckIn.summary` line from stored structured fields — one source of truth, used by both `Store` layers. */
export const renderCheckInSummary = (record: {
  readonly sleep: number;
  readonly soreness: number;
  readonly stress: number;
  readonly energy: number;
}): string =>
  `Sleep ${record.sleep}/5, Soreness ${record.soreness}/5, Stress ${record.stress}/5, Energy ${record.energy}/5`;

const toCheckIn = (record: CheckInRecord): CheckIn => ({
  id: record.id,
  recordedAt: record.recordedAt,
  summary: renderCheckInSummary(record),
});

/**
 * Derives the pointer-digest's `sessionsSinceLastReview`/`lastCycleReviewAt`
 * (ADR 0011 §2, issue #34) from existing `logged_session`/`decision` rows
 * rather than a new table — a "review-kind decision" is any `decision` row
 * whose `data_window_json.cadence` is `'session-review'` or `'cycle-review'`
 * (i.e. a real scheduled/on-demand-but-review-framed run, as opposed to a
 * `user-direct` Change or a run with no data window). No-prior-review is an
 * explicit edge case: `sessionsSinceLastReview` falls back to ALL logged
 * sessions ever, `lastCycleReviewAt` stays `undefined`.
 */
export interface PointerDigestHistory {
  readonly sessionsSinceLastReview: number;
  readonly lastCycleReviewAt: string | undefined;
}

export const deriveDigestHistory = (
  decisions: ReadonlyArray<{ readonly createdAt: string; readonly dataWindowJson: string | null }>,
  sessionStartedAts: ReadonlyArray<string>,
): PointerDigestHistory => {
  const reviewRuns = decisions
    .map((d) => {
      if (d.dataWindowJson === null) return undefined;
      let parsed: { readonly cadence?: unknown };
      try {
        parsed = JSON.parse(d.dataWindowJson) as { readonly cadence?: unknown };
      } catch {
        return undefined;
      }
      if (parsed.cadence !== "session-review" && parsed.cadence !== "cycle-review") return undefined;
      return { cadence: parsed.cadence, createdAt: d.createdAt };
    })
    .filter((x): x is { cadence: "session-review" | "cycle-review"; createdAt: string } => x !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const lastReview = reviewRuns[reviewRuns.length - 1];
  const lastCycleReview = [...reviewRuns].reverse().find((r) => r.cadence === "cycle-review");

  const sessionsSinceLastReview =
    lastReview === undefined
      ? sessionStartedAts.length
      : sessionStartedAts.filter((startedAt) => startedAt > lastReview.createdAt).length;

  return {
    sessionsSinceLastReview,
    lastCycleReviewAt: lastCycleReview?.createdAt,
  };
};

interface CommandSlot {
  readonly deferred: Deferred.Deferred<LogSetActualResult, never>;
}

/**
 * Net state (ADR 0019, issue #83): folds an ordered stream of logs and
 * retractions down to the logged actuals that are STILL logged — the last
 * row per `(loggedSessionId, setId)` wins, and a retraction in that position
 * drops the Set. `actuals` must already be in application order; the last
 * `.set()` for a key is what survives, mirroring the client's `new Map(...)`
 * fold in `useLoggedSession.ts`.
 *
 * Shared by both `Store` layers' `cancelSession` — the guard reads net state
 * rather than raw row count, so a mis-tap logged and immediately un-logged
 * does not permanently block cancelling the session.
 */
export const netLoggedActuals = (
  actuals: ReadonlyArray<LogSetActualResult | UnlogSetActualResult>,
): ReadonlyArray<LogSetActualResult> => {
  const bySetKey = new Map<string, LogSetActualResult | UnlogSetActualResult>();
  for (const actual of actuals) {
    bySetKey.set(`${actual.loggedSessionId}|${actual.setId}`, actual);
  }
  return Array.from(bySetKey.values()).filter(
    (actual): actual is LogSetActualResult => !actual.retraction,
  );
};

/**
 * A Logged Session record (Step 2A, task 2A.2): the frozen copy created by
 * `startSession` (copy-on-instantiate, ADR 0006/0007). `snapshot` is a
 * plain-data deep copy of the Prescribed Session at instantiation time —
 * never a reference back into `prescribedSessions`, so a later
 * `mutatePrescribedSessionForTest`/Plan edit can't reach it.
 */
interface LoggedSessionRecord {
  readonly loggedSessionId: string;
  readonly prescribedSessionId: string;
  readonly startedAt: string;
  readonly status: LoggedSessionStatus;
  readonly snapshot: PrescribedSession;
  readonly finishedAt?: string;
  /**
   * The in-memory twin of migration `017`'s nullable `review_status` (#132).
   * `undefined` for `active` and `cancelled` rows — neither owes a review.
   */
  readonly reviewStatus?: LoggedSessionReviewStatus;
}

/**
 * A `decision` row (CONTEXT `Decision`), mirrored exactly from `SqlStore`'s
 * `DecisionRow` (Step 2A `decision` table) so both `Store` layers share one
 * mental model — the in-memory layer is not a second source of truth. A
 * `pending`, `kind: 'proposal'` row *is* a Proposal (`getProposals`/
 * `subscribeProposals` filter this map by `kind`), exactly like `SqlStore`'s
 * `SELECT * FROM decision WHERE kind = 'proposal'`.
 */
export interface DecisionRecord {
  readonly id: string;
  readonly kind: string;
  readonly origin: string;
  /**
   * The contract's union, not `string`. This row is the WRITER of the status
   * the Coach record later decodes, so the two must agree by construction:
   * the store wrote `escalated`/`expired` for five weeks before the contract
   * listed them, and nothing failed until a live escalation made the whole
   * record undecodable. Typed this way, that drift is a compile error here
   * rather than a `Die` on the surface.
   */
  readonly status: DecisionStatus;
  readonly summary: string;
  readonly rationale: string;
  readonly citationsJson: string | null;
  readonly dataWindowJson: string | null;
  readonly createdAt: string;
  /** Proposal lineage (ADR 0013 §9) — the Decision a Revision run answered; `null` for unprompted rows. */
  readonly inResponseToId: string | null;
  /**
   * The user's Revise prose that produced this run (ADR 0013 §1/§9, issue #66
   * slice 1, migration 007) — stamped on every row a Revision run commits,
   * exactly like `inResponseToId`. `null` on every unprompted row.
   */
  readonly revisionProse: string | null;
  /**
   * The `deliberation_run` this row was committed by (ADR 0011 §8, the Coach
   * run history). `null` on every row written before run rows existed, on the
   * `kind='change'` rows an accept or a direct Plan edit writes, and on a row
   * whose run's own best-effort bookkeeping write was dropped — all three are
   * history the record reconstructs from `dataWindowJson` instead.
   */
  readonly runId: string | null;
  /**
   * The **Intake marker** (ADR 0014 §6): the drafted Plan, as structured data,
   * on the one Decision an Intake produces. `null` on every other row, so its
   * presence is both the marker and the payload — there is no second boolean
   * column that could disagree with it.
   */
  readonly intakePlanJson: string | null;
  /**
   * **The Change a Proposal proposes** (#86, migration 009): the ADR 0015
   * operations, verbatim, that accepting it applies through the shared pure
   * applier. `null` on a Decision that proposes no Plan change — an
   * Observation, an Answer, or a Proposal whose finding is not a prescription
   * change — and nothing may substitute `'[]'`, which would read as the coach
   * proposing "change nothing".
   */
  readonly planOperationsJson: string | null;
  /**
   * **The catalog rows those operations need created first** (ADR 0016,
   * migration 015): the Exercises a Proposal introduces, written on Accept
   * immediately before the operations that reference them. `null` on every
   * Decision that introduces no new Exercise, which is nearly all of them —
   * and nothing may substitute `'[]'`, which would read as "this Proposal
   * deliberately introduces none".
   */
  readonly catalogExercisesJson: string | null;
  /**
   * The working (#79, migration 008) — the three optional parts of the
   * layered explanation a card expands into, exactly as the agent emitted
   * them. `null` means the run said nothing there and the surface renders one
   * fewer block; nothing may substitute `[]` or `""`, because that would make
   * "said nothing" and "said nothing useful" indistinguishable.
   */
  readonly measurementsJson: string | null;
  readonly rule: string | null;
  readonly uncertainty: string | null;
}

/**
 * Is this row the live Intake artifact — the Intake Proposal, still undecided?
 * That is the exact window ADR 0014 §6 withholds it from the pending-Proposal
 * surface and the Coaching feed for: it is decided in place inside the
 * takeover, before Today is ever populated, so surfacing it there would ask the
 * user to decide twice on something they already decided. Once resolved it is
 * an ordinary historical Decision and hides from nothing.
 */
export const isLiveIntakeArtifact = (decision: DecisionRecord): boolean =>
  decision.intakePlanJson !== null && decision.kind === "proposal" && decision.status === "pending";

const toProposalFromDecision = (decision: DecisionRecord): Proposal => ({
  id: decision.id as never,
  origin: decision.origin as never,
  status: decision.status as never,
  summary: decision.summary,
  rationale: decision.rationale,
  createdAt: decision.createdAt,
  ...(decision.intakePlanJson === null
    ? {}
    : { draftPlan: JSON.parse(decision.intakePlanJson) as IntakeDraftPlan }),
  ...(decision.planOperationsJson === null
    ? {}
    : { planOperations: JSON.parse(decision.planOperationsJson) as ReadonlyArray<PlanOperation> }),
  ...(decision.catalogExercisesJson === null
    ? {}
    : {
        catalogExercises: JSON.parse(
          decision.catalogExercisesJson,
        ) as ReadonlyArray<ProposedCatalogExercise>,
      }),
  ...(decision.inResponseToId === null ? {} : { inResponseToId: decision.inResponseToId as never }),
});

/**
 * Walks a Proposal's lineage back through `inResponseToId` (ADR 0013 §9) to
 * build the read model a Proposal card renders — oldest-first turns of [the
 * user's Revise prose, the coach's Answer, the prior Proposal it superseded]
 * for every Revision run behind the given Proposal, including answer-only
 * turns that left the SAME Proposal `pending` (ADR 0013 §2's "asked a
 * question, nothing changed" case — those hang directly off the head, not an
 * ancestor).
 *
 * `None` when `proposalId` names no `kind: 'proposal'` row. Shared by BOTH
 * `Store` layers (`getProposalExchange`/`subscribeProposalExchanges` in
 * `store.ts`, and `sqlStore.ts`'s equivalents over a freshly-loaded decision
 * map) so the two cannot drift on the walk itself, only on how they fetch the
 * rows.
 *
 * `revisionStatus` is always `"idle"` here — the store has no visibility into
 * the deferral queue (ADR 0011 §8's `RunState` lives in the runner); slice 2's
 * runner layer overlays the live queued/running value before this reaches the
 * wire (see `ProposalRevisionStatus`'s doc in `feed.ts`).
 */
export const buildProposalExchange = (
  proposalId: string,
  decisions: ReadonlyMap<string, DecisionRecord>,
): Option.Option<ProposalExchange> => {
  const head = decisions.get(proposalId);
  if (head === undefined || head.kind !== "proposal") {
    return Option.none();
  }

  // The chain of Proposal ids this Proposal descends from, HEAD FIRST —
  // reversed below so the per-id loop runs oldest-first, matching how the
  // card renders (current Proposal, then history, oldest to newest).
  const chainNewestFirst: Array<string> = [proposalId];
  let cursor = head.inResponseToId;
  while (cursor !== null) {
    chainNewestFirst.push(cursor);
    const row: DecisionRecord | undefined = decisions.get(cursor);
    cursor = row?.inResponseToId ?? null;
  }
  const chainOldestFirst = [...chainNewestFirst].reverse();

  const entries: Array<ProposalExchangeEntry> = [];
  for (const id of chainOldestFirst) {
    // EVERY row that responded to this id, not just the Answers. The user's
    // prose is read off whatever the run committed, because ADR 0013 §9 makes
    // rendering that prose a trust obligation and it must not be contingent on
    // the agent having also produced an Answer. §2 says an Answer is emitted
    // "always", but an agent that fails to is exactly the case where the user
    // most needs to see their own words still attached to the card — deriving
    // the turn from the Answer row alone would silently drop them.
    const respondents = Array.from(decisions.values())
      .filter((d) => d.inResponseToId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // Dedupe the prose to one `revise` entry per run: a run stamps
    // `revisionProse` on EVERY row it commits (the Answer and the revised
    // Proposal both), but it is ONE user turn. Keyed by the prose text within
    // this target id — two runs against the same Proposal carrying byte-identical
    // prose would collapse into one turn, which is the acceptable failure mode
    // for not having a run id on the row.
    const seenProse = new Set<string>();
    for (const row of respondents) {
      if (row.revisionProse !== null && !seenProse.has(row.revisionProse)) {
        seenProse.add(row.revisionProse);
        entries.push({ kind: "revise", text: row.revisionProse as never, createdAt: row.createdAt });
      }
      if (row.kind !== "answer") continue;
      entries.push({
        kind: "answer",
        id: row.id as never,
        summary: row.summary as never,
        rationale: row.rationale as never,
        citations: row.citationsJson === null ? [] : JSON.parse(row.citationsJson),
        createdAt: row.createdAt,
      });
    }
    // The current head is never itself a "collapsed prior version" — only
    // an ancestor in the chain is rendered as a superseded-proposal entry.
    if (id !== proposalId) {
      const targetRow = decisions.get(id);
      if (targetRow !== undefined) {
        entries.push({
          kind: "superseded-proposal",
          id: targetRow.id as never,
          summary: targetRow.summary as never,
          rationale: targetRow.rationale as never,
          createdAt: targetRow.createdAt,
        });
      }
    }
  }

  return Option.some({
    proposalId: proposalId as never,
    revisionStatus: "idle",
    entries,
  });
};

/**
 * The pending-Proposal surface, with the live Intake artifact withheld (ADR
 * 0014 §6). Enforced HERE rather than in the runner: the store is the trust
 * boundary, so "the Intake Proposal is never pending on Today" holds no matter
 * which caller reads the surface.
 */
const visibleProposals = (decisions: ReadonlyMap<string, DecisionRecord>): ReadonlyArray<Proposal> =>
  Array.from(decisions.values())
    .filter((decision) => decision.kind === "proposal" && !isLiveIntakeArtifact(decision))
    .map(toProposalFromDecision);

/**
 * The Coaching feed, with the live Intake artifact's entry withheld — ADR 0014
 * §6's "never in the Coach badge". Filtered by walking back to the Proposal the
 * entry points at rather than stamping the feed row too, so there is one fact
 * ("is this Intake Proposal still undecided?") stored in one place.
 */
const visibleCoachingFeed = (
  feed: ReadonlyArray<CoachingFeedEntry>,
  decisions: ReadonlyMap<string, DecisionRecord>,
): ReadonlyArray<CoachingFeedEntry> =>
  feed.filter((entry) => {
    if (entry.proposalId === undefined) return true;
    const proposal = decisions.get(entry.proposalId);
    return proposal === undefined || !isLiveIntakeArtifact(proposal);
  });

/**
 * The Observation `feed-1` points at (#79). It exists so the seeded feed is a
 * coherent record rather than a summary with nothing behind it — the Coach
 * surface expands an entry into its Decision, and an entry whose Decision is
 * missing can only ever demonstrate the degraded path.
 *
 * It carries a full set of working, because the seed is also what dev and e2e
 * look at: a row with every optional field populated is the only way to see
 * that the surface renders them, and `proposal-1` below deliberately carries
 * none, so both paths are visible side by side on one screen.
 */
export const seedObservationDecision = (): DecisionRecord => ({
  id: SEEDED_OBSERVATION_ID,
  kind: "observation",
  origin: "coach-proposal",
  status: "open",
  summary: "Squat load has held steady for 3 sessions.",
  rationale:
    "Three consecutive sessions at 100 kg with every top set at the range ceiling. That is the double-progression trigger, not a plateau — the load has not been asked to move yet.",
  citationsJson: JSON.stringify([
    {
      claim:
        "Double progression: advance load once the top of the rep range is reached across all working sets.",
      source_url: "https://pubmed.ncbi.nlm.nih.gov/33555822/",
      trust: "corpus-verified",
    },
  ]),
  dataWindowJson: JSON.stringify({
    cadence: "session-review",
    ran_at: "2026-07-01T00:00:00.000Z",
    window_from: "2026-06-21T00:00:00.000Z",
    window_to: "2026-07-01T00:00:00.000Z",
    session_ids_considered: ["session-1", "session-2", "session-3"],
    evidence_roster_version: "seed-1",
  }),
  createdAt: "2026-07-01T00:00:00.000Z",
  inResponseToId: null,
  revisionProse: null,
  runId: SEEDED_REVIEW_RUN_ID,
  intakePlanJson: null,
  // An Observation proposes no Plan change (#86) — absent, not an empty list.
  planOperationsJson: null,
  catalogExercisesJson: null,
  measurementsJson: JSON.stringify([
    { label: "Back squat, top-set load", series: "100 → 100 → 100 kg", delta: "±0" },
    { label: "Top-set reps at range ceiling", series: "8, 8, 8 of 8", delta: "3/3" },
    { label: "Sessions since last load change", series: "3", delta: "—" },
  ]),
  rule: "Double progression — advance load once every working set reaches the top of the prescribed rep range.",
  uncertainty:
    "Only three sessions, and none of them followed a deload. If the third was your first session back, the steadiness is the taper rather than a signal.",
});


/**
 * The three seeded Deliberation runs (ADR 0011 §8, the Coach run history).
 *
 * The seed is what dev and e2e look at, and the run history is a surface whose
 * whole argument is about states the coach reaches *rarely* — so the seed has
 * to contain them, or the only run anyone ever sees while building is the easy
 * one. `seedObservationDecision` makes the same argument about the working, and
 * for the same reason: one row with every optional field filled and one with
 * none, side by side, is the only way to see that absence renders as absence.
 *
 * - **The review that said something** — the run that emitted both seeded
 *   Decisions. The ordinary case.
 * - **The review that said nothing.** Both stages ran, nothing cleared the
 *   bar, and it wrote no Decision rows at all. Before runs had rows this run
 *   left no trace whatsoever, which made a restrained coach (ADR 0011 §4)
 *   indistinguishable from a coach that never ran — the failure mode this
 *   whole feature exists to close.
 * - **The review that failed.** Its reason used to live only in the runner's
 *   memory and die on restart, so "quiet" and "crashing" read identically the
 *   next morning.
 *
 * No in-flight run is seeded. A `running` row nothing is running would be a lie
 * the surface tells on every cold start — and the runner closes stranded rows
 * at boot anyway (`failRunsInterruptedByRestart`), so a seeded one would flip
 * to `failed` the moment the server came up.
 */
export const seedDeliberationRuns = (): ReadonlyArray<DeliberationRunRecordInput> => [
  {
    runId: SEEDED_REVIEW_RUN_ID,
    cadence: "session-review",
    status: "committed",
    failureReason: undefined,
    // The same envelope the Observation carries, because it is the same run:
    // the run's window and the window stamped on what it emitted cannot
    // disagree without one of them being wrong.
    dataWindowJson: JSON.stringify({
      cadence: "session-review",
      ran_at: "2026-07-01T00:00:00.000Z",
      window_from: "2026-06-21T00:00:00.000Z",
      window_to: "2026-07-01T00:00:00.000Z",
      session_ids_considered: ["session-1", "session-2", "session-3"],
      evidence_roster_version: "seed-1",
    }),
    startedAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:03:00.000Z",
  },
  {
    runId: SEEDED_FAILED_RUN_ID,
    cadence: "session-review",
    status: "failed",
    failureReason: "the deliberator hit its turn cap before producing output",
    // No envelope: the run never reached the point where one is assembled.
    // Absent rather than empty, exactly as the working's optional fields are.
    dataWindowJson: undefined,
    startedAt: "2026-07-05T18:02:00.000Z",
    finishedAt: "2026-07-05T18:09:00.000Z",
  },
  {
    runId: SEEDED_QUIET_RUN_ID,
    cadence: "session-review",
    status: "committed",
    failureReason: undefined,
    dataWindowJson: JSON.stringify({
      cadence: "session-review",
      ran_at: "2026-07-08T18:20:00.000Z",
      window_from: "2026-07-01T00:00:00.000Z",
      window_to: "2026-07-08T18:20:00.000Z",
      session_ids_considered: ["session-4"],
      evidence_roster_version: "seed-1",
    }),
    startedAt: "2026-07-08T18:20:00.000Z",
    finishedAt: "2026-07-08T18:24:00.000Z",
  },
];

/**
 * The run row `pushProposalForTest` mints alongside its Proposal.
 *
 * Same argument #82 made when the lever grew a coaching-feed entry: the Coach
 * surface is now a list of RUNS, so a lever that injects a Decision belonging
 * to no run puts something on Today that the record cannot show at all — and a
 * flow asserting the record updates live would be asserting against a lever
 * that never wrote to the surface it is testing. Every real Decision comes out
 * of a run, so the lever's does too.
 *
 * `on-demand` because that is what it honestly is: a run somebody asked for,
 * outside any schedule.
 */
export const testProposalRun = (proposal: {
  readonly id: string;
  readonly createdAt: string;
}): DeliberationRunRecordInput => ({
  runId: `run-${proposal.id}`,
  cadence: "on-demand",
  status: "committed",
  failureReason: undefined,
  dataWindowJson: JSON.stringify({
    cadence: "on-demand",
    ran_at: proposal.createdAt,
    session_ids_considered: [],
    evidence_roster_version: "seed-1",
  }),
  startedAt: proposal.createdAt,
  finishedAt: proposal.createdAt,
});

const seedDecisions = (): ReadonlyMap<string, DecisionRecord> =>
  new Map<string, DecisionRecord>([
    [SEEDED_OBSERVATION_ID, seedObservationDecision()],
    ...seedProposals().map(
      (proposal) =>
        [
          proposal.id,
          {
            id: proposal.id,
            kind: "proposal",
            origin: proposal.origin,
            status: proposal.status,
            summary: proposal.summary,
            rationale: proposal.rationale,
            citationsJson: null,
            dataWindowJson: null,
            createdAt: proposal.createdAt,
            inResponseToId: null,
            revisionProse: null,
            // The same run the seeded Observation came out of: one Session
            // review that noticed something and proposed something.
            runId: SEEDED_REVIEW_RUN_ID,
            intakePlanJson: null,
            planOperationsJson:
              proposal.planOperations === undefined ? null : JSON.stringify(proposal.planOperations),
            catalogExercisesJson:
              proposal.catalogExercises === undefined
                ? null
                : JSON.stringify(proposal.catalogExercises),
            measurementsJson: null,
            rule: null,
            uncertainty: null,
          } satisfies DecisionRecord,
        ] as const,
    ),
  ]);

/**
 * Every finished Logged Session in the shape the swap-aware, net-state
 * resolvers read (`lastActualForExercise.ts`) — the in-memory twin of the
 * SqlStore's `loadFinishedSessionViews`.
 */
function finishedSessionViews(data: StoreData): ReadonlyArray<FinishedSessionView> {
  return Array.from(data.loggedSessions.values())
    .filter((record) => record.status === "finished")
    .map((record) => ({
      loggedSessionId: record.loggedSessionId,
      finishedAt: record.finishedAt,
      startedAt: record.startedAt,
      snapshot: record.snapshot,
      actuals: Array.from(data.actualsByCommandId.values())
        .filter((actual) => actual.loggedSessionId === record.loggedSessionId)
        .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt)),
      swaps: Array.from(data.entrySwapsByCommandId.values())
        .filter((swap) => swap.loggedSessionId === record.loggedSessionId)
        .map((swap) => ({
          entryId: swap.entryId,
          exerciseId: swap.exerciseId,
          swappedAt: swap.swappedAt,
        })),
    }));
}

interface StoreData {
  readonly prescribedSessions: ReadonlyMap<string, PrescribedSession>;
  readonly coachingFeed: ReadonlyArray<CoachingFeedEntry>;
  readonly decisions: ReadonlyMap<string, DecisionRecord>;
  readonly plan: PlanSnapshot;
  readonly actualsByCommandId: ReadonlyMap<string, LogSetActualResult | UnlogSetActualResult>;
  /** Entry swaps (#131, ADR 0019), keyed by `commandId` for the same idempotent-replay reason `actualsByCommandId` is. */
  readonly entrySwapsByCommandId: ReadonlyMap<string, SwapEntryExerciseResult>;
  readonly loggedSessions: ReadonlyMap<string, LoggedSessionRecord>;
  /** User-authored, singleton (CONTEXT `Goal`: "One current Goal") — `undefined` until `setGoal` is called. */
  readonly goal: GoalSummary | undefined;
  readonly standingConstraints: ReadonlyMap<string, StandingConstraint>;
  readonly checkIns: ReadonlyMap<string, CheckInRecord>;
  readonly contextNotes: ReadonlyMap<string, ContextNote>;
  /** Server-seeded (ADR 0003), not user-authored — fixed at seed time, no write path. */
  readonly evidenceRoster: ReadonlyArray<EvidenceClaim & { readonly id: string }>;
  /** Per-cadence model choice (ADR 0011 §4, issue #31; effort added issue #81) — `cadence` → model id + optional reasoning-effort override. Empty until a setting is written. */
  readonly cadenceModels: ReadonlyMap<DeliberationCadence, { readonly model: string; readonly effort: string | undefined }>;
  /** The Cycle-review schedule's only state (#91): when a due window was last claimed. `undefined` until the first claim attempt starts the clock. */
  readonly cycleReviewLastRunAt: string | undefined;
  /**
   * Exactly-once for structural Plan edits (#71), keyed by the outbox's
   * `commandId` (ADR 0006): a replay returns the Plan the first application
   * produced instead of applying the operation twice.
   */
  readonly planEditsByCommandId: ReadonlyMap<string, PlanSnapshot>;
  /**
   * Coach-authored (CONTEXT `Exercise catalog`), keyed by id. Grows at accept
   * time — `materializeDraftPlan` names any new exercise a drafted Plan
   * introduces (#75) — never pre-filled beyond what the seed itself needs to
   * render.
   */
  readonly exerciseCatalog: ReadonlyMap<string, ExerciseCatalogEntry>;
  /**
   * The half of a catalog row's metadata Plan authoring has no use for (#104,
   * ADR 0016): the muscles it trains and its movement pattern, keyed by
   * exercise id.
   *
   * Kept beside `exerciseCatalog` rather than on `ExerciseCatalogEntry`,
   * which is `@repcoach/client-runtime`'s *authoring* shape — an operation
   * needs the name and the tracked metrics, and widening it with anatomy
   * would put the coach's analytics join into a type whose whole job is
   * validating Plan edits. The SQLite layer stores all three on one row
   * (`muscles_json`/`movement_pattern`), which is the same fact recorded in
   * the shape each layer can hold honestly.
   */
  readonly exerciseAnatomy: ReadonlyMap<
    string,
    { readonly muscles?: ReadonlyArray<string>; readonly movementPattern?: string }
  >;
  /** The run ledger (ADR 0011 §8 amendment, issue #81) — append-only, insertion order. */
  readonly runLedger: ReadonlyArray<RunLedgerRecord>;
  /**
   * The run record (ADR 0011 §8, the Coach run history) — one entry per
   * Deliberation run, keyed by `runId`, opened `running` before the run's
   * first agent session and closed `committed`/`failed` after it.
   */
  readonly deliberationRuns: ReadonlyMap<string, DeliberationRunRecordInput>;
  /** The RPE capture control (#63, issue #81) — server-side singleton, defaults to `flagged-only`. */
  readonly rpeCaptureMode: RpeCaptureMode;
  /** Bodyweight readings keyed by local day (`YYYY-MM-DD`) — one per day. */
  readonly bodyweight: ReadonlyMap<string, BodyweightEntry>;
}

/**
 * The outcome of one `Store.claimDueCycleReview` attempt (issue #91).
 *
 * `lastRunAt` is the schedule's post-claim state — the timestamp the NEXT due
 * window is measured from — so a caller that claimed and a caller that found
 * nothing due can both log where the schedule stands without a second read.
 */
export interface CycleReviewClaim {
  /** `true` when this caller now owns a due window and must run the Cycle review. */
  readonly claimed: boolean;
  /** The schedule's `last_run_at` AFTER this attempt (the claim's timestamp when `claimed`). */
  readonly lastRunAt: string;
}

/**
 * The Cycle review's cadence: a plain month (ADR 0011 §4 — Plan-model-defined
 * cycle boundaries are explicitly deferred, since today's only Plan model is
 * Manual and has no cyclicity). 30 days rather than calendar-month arithmetic:
 * the review's framing is "take the longer history into account", which is
 * indifferent to whether it lands on the 28th or the 31st, and a fixed
 * interval has no month-length or DST edge cases to get wrong.
 */
export const MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS = 30 * 24 * 60 * 60 * 1000;


/**
 * The in-memory store's half of the run history — the same
 * `assembleDeliberationRuns` the SQL store feeds, over the same three inputs
 * read out of `StoreData` instead of three tables.
 *
 * `kind !== "change"` mirrors the SQL loader's `WHERE kind <> 'change'`, for
 * the reason given there: an applied Change is what accepting a Proposal did,
 * not something a Deliberation run emitted, and its `dataWindowJson` is a
 * command marker rather than a provenance envelope.
 */
const assembleInMemoryRuns = (data: StoreData): ReadonlyArray<DeliberationRunRecord> => {
  const ledgerStagesByRun = new Map<string, Set<string>>();
  for (const row of data.runLedger) {
    const existing = ledgerStagesByRun.get(row.runId);
    if (existing === undefined) ledgerStagesByRun.set(row.runId, new Set([row.stage]));
    else existing.add(row.stage);
  }
  return assembleDeliberationRuns(
    Array.from(data.deliberationRuns.values()),
    Array.from(data.decisions.values())
      // `isLiveIntakeArtifact` for ADR 0014 §6, mirroring `visibleProposals`
      // and `visibleCoachingFeed` above — the record does not show the Intake
      // Proposal back to the user while the takeover still owns it.
      .filter((decision) => decision.kind !== "change" && !isLiveIntakeArtifact(decision))
      .map((decision) => ({
        decisionId: decision.id,
        kind: decision.kind,
        status: decision.status,
        summary: decision.summary,
        createdAt: decision.createdAt,
        runId: decision.runId ?? undefined,
        dataWindowJson: decision.dataWindowJson ?? undefined,
        reviseProse: decision.revisionProse ?? undefined,
      })),
    ledgerStagesByRun,
  );
};

const seedData = (): StoreData => ({
  prescribedSessions: new Map([[SEEDED_SESSION_ID, seedPrescribedSession()]]),
  coachingFeed: seedCoachingFeed(),
  decisions: seedDecisions(),
  plan: seedPlan(),
  actualsByCommandId: new Map(),
  entrySwapsByCommandId: new Map(),
  loggedSessions: new Map(),
  goal: undefined,
  standingConstraints: new Map(),
  checkIns: new Map(),
  contextNotes: new Map(),
  evidenceRoster: seedEvidenceRoster(),
  cadenceModels: new Map(),
  cycleReviewLastRunAt: undefined,
  planEditsByCommandId: new Map(),
  exerciseCatalog: new Map(seedExerciseCatalog().map((exercise) => [exercise.id, exercise])),
  // Empty, matching the SQL seed's `muscles_json NULL` — the demo rows say
  // what they track and nothing about what they train, so they are genuinely
  // un-enriched and the first Session review is expected to fill them in.
  exerciseAnatomy: new Map(),
  runLedger: [],
  deliberationRuns: new Map(seedDeliberationRuns().map((run) => [run.runId, run] as const)),
  rpeCaptureMode: DEFAULT_RPE_CAPTURE_MODE,
  bodyweight: new Map(),
});

/**
 * The Exercise catalog as the Plan-authoring operations need it (#71): the
 * name that goes in a Change summary, and the `trackedMetrics` a newly added
 * Entry inherits so logging renders the right fields with no second lookup.
 * Takes the CURRENT catalog off `StoreData` (not the seed) — an accepted
 * Intake draft can have grown it since (#75) — so the two `Store` layers
 * cannot drift on what the coach has authored so far.
 */
export const inMemoryAuthoringContext = (
  exerciseCatalog: ReadonlyMap<string, ExerciseCatalogEntry>,
): PlanAuthoringContext => ({
  exercises: Array.from(exerciseCatalog.values()),
});

/**
 * The same catalog as the wire shape a client picker reads. `trackedMetrics`
 * is optional on the authoring context (an operation can name an exercise
 * whose metrics nobody declared) but required on the wire: a picker that
 * cannot say what an exercise records has nothing to show, so an
 * undeclared row offers an empty list rather than being dropped.
 */
export const toCatalogExercise = (exercise: ExerciseCatalogEntry): CatalogExercise => ({
  id: exercise.id as CatalogExercise["id"],
  name: exercise.name,
  trackedMetrics: exercise.trackedMetrics ?? [],
  ...(exercise.libraryId === undefined ? {} : { libraryId: exercise.libraryId }),
});

export const toExerciseCatalog = (context: PlanAuthoringContext): ExerciseCatalog => ({
  exercises: context.exercises.map(toCatalogExercise),
});

/**
 * Whether a catalog row still needs the coach (#104, ADR 0016) — the ONE
 * definition of un-enriched, shared by both `Store` layers so the roster the
 * seed carries and the rows `enrichExercises` will actually write cannot
 * disagree with each other.
 *
 * Emptiness is the marker; there is no flag column (see
 * `Store.listUnenrichedExercises`). Either half missing counts, because
 * either half missing is a real hole: no tracked metrics and logging falls
 * back to the Set's target keys, no muscles and the row joins to nothing so
 * everything trained through it reads as zero volume.
 */
export const isUnenrichedExercise = (row: {
  readonly trackedMetrics?: ReadonlyArray<MetricName> | undefined;
  readonly muscles?: ReadonlyArray<string> | undefined;
}): boolean =>
  row.trackedMetrics === undefined ||
  row.trackedMetrics.length === 0 ||
  row.muscles === undefined ||
  row.muscles.length === 0;

/** The `data_window_json` payload a user-direct Plan Change carries — see `applyUserPlanChange`. */
export interface PlanChangeWindow {
  readonly operation: string;
  readonly commandId?: string;
  /**
   * Set by the ordering operations only. A new ordering Change on the same
   * container supersedes the previous one, so five reorder taps leave one
   * live Change and the coach reads the net intent (ADR 0008's existing
   * `superseded` status).
   */
  readonly orderingContainer?: string;
}

export class Store extends Context.Service<
  Store,
  {
    readonly getPrescribedSession: (sessionId: string) => Effect.Effect<Option.Option<PrescribedSession>>;
    /**
     * Real Logged Session instantiation (Step 2A, task 2A.2): deep-copies
     * the current Prescribed Session tree into a Logged Session
     * (copy-on-instantiate, ADR 0006/0007) so later Plan edits never reach
     * an already-instantiated Logged Session. The natural client call site
     * is "Start workout" while connected.
     *
     * **Not idempotent** — every call mints a fresh Logged Session row, by
     * design (a re-`startSession` of the same Prescribed Session is a fresh
     * copy of the current Plan, ADR 0006/0007). The "one intended workout,
     * one `active` row" guard for issue #147 lives in the client's
     * `startWorkout` command, which adopts an existing `active` session via
     * `listActiveSessions` rather than minting a duplicate.
     */
    readonly startSession: (
      prescribedSessionId: SessionId,
    ) => Effect.Effect<StartSessionResult, PrescribedSessionNotFoundError>;
    /**
     * Prod-safe black-box read lever for a Logged Session (Step 2A, task
     * 2A.2) — the snapshot Prescribed Session plus every actual applied
     * against it so far, ordered by `appliedAt`.
     */
    readonly getLoggedSession: (
      loggedSessionId: LoggedSessionId,
    ) => Effect.Effect<Option.Option<LoggedSession>>;
    /**
     * "Finish Workout" session finalization (ADR 0011 §4, 2B slice 4 —
     * issue #29): flips `logged_session.status` from `active` to
     * `finished` AND marks it `pending` review in the same write.
     * `Option.none()` when `loggedSessionId` names no row —
     * `rpcHandlers.ts` maps that to `LoggedSessionNotFoundError`. This is
     * the ONLY status transition in the store; `logSetActual` never calls
     * it (mid-workout set-syncs must not finalize a session).
     *
     * **The two writes are one write** (issue #132). If the status flip and
     * the review marker could land separately, a crash between them would
     * leave a `finished` session with no marker — invisible to the drain, and
     * the original bug back in a new shape.
     *
     * **Idempotent**: only an `active → finished` transition returns
     * `transitioned: true`; finalizing an already-`finished` session is a
     * no-op returning `transitioned: false`.
     *
     * **`transitioned` no longer gates the review** (issue #132). It used to,
     * and that is precisely what lost three sessions' reviews: it answers
     * "did this call finish the session", not "has this session been
     * reviewed", and when the synchronous run failed after the transition had
     * committed, every retry read `transitioned: false` and skipped the run
     * forever. `reviewStatus` answers the second question durably, and it is
     * the only thing that decides whether a review is owed. `transitioned` is
     * now reportable detail — useful for logging a genuine double-tap, load-
     * bearing for nothing.
     */
    readonly finalizeSession: (
      loggedSessionId: LoggedSessionId,
    ) => Effect.Effect<
      Option.Option<{
        readonly loggedSessionId: LoggedSessionId;
        readonly status: LoggedSessionStatus;
        readonly transitioned: boolean;
        /** `pending` whenever a review is still owed — including on a re-finish of a session whose review never ran. */
        readonly reviewStatus: LoggedSessionReviewStatus;
      }>
    >;
    /**
     * Every finished session that still owes a Session review, oldest finish
     * first (issue #132) — the drain's work list.
     *
     * **This re-derives the queue instead of persisting one.** The runner's
     * deferral queue is in-memory, so a restart mid-deferral used to lose the
     * run with the session already `finished`. Reading the durable marker on
     * every tick makes a restart free: the work is wherever the rows say it
     * is. Same reasoning migration `011` applied to the Cycle-review schedule.
     *
     * Oldest first so a backlog is worked in the order it happened — a coach
     * reviewing three stranded sessions should see them chronologically, since
     * each review's framing is "what happened recently". `finished_at IS NULL`
     * rows (pre-migration-`016`) sort first for the same reason `listSessions`
     * sorts them as oldest.
     */
    readonly listSessionsPendingReview: Effect.Effect<ReadonlyArray<LoggedSessionId>>;
    /**
     * Marks a finished session's Session review as done (issue #132) — called
     * only after the review has actually COMMITTED, never before.
     *
     * The ordering is the whole point. A marker written before the run would
     * reintroduce the bug (a failed run, permanently unreviewed); a marker
     * written after a committed run means the worst case is a *duplicate*
     * review rather than a *lost* one, and duplicates are recoverable by a
     * human reading the feed while losses are not.
     *
     * Idempotent and total: marking an unknown, `active`, `cancelled`, or
     * already-`reviewed` session is a no-op, so a drain racing a re-finish
     * cannot corrupt anything.
     */
    readonly markSessionReviewed: (loggedSessionId: LoggedSessionId) => Effect.Effect<void>;
    /**
     * "Cancel session" (issue #114 Part 1) — unmakes an accidentally-started
     * session. `None` when `loggedSessionId` names no row (mapped to
     * `LoggedSessionNotFoundError` by `rpcHandlers.ts`, mirroring
     * `finalizeSession`). Idempotent — `cancelled: false` — for a session
     * already `cancelled`, or already `finished` with zero actuals; fails
     * with `LoggedSessionHasActualsError` for the one case that must NOT
     * silently no-op: an `active` session that already has a logged actual.
     * Never touches `finalizeSession`'s status transition, so it never
     * triggers a Session-review Deliberation.
     */
    readonly cancelSession: (
      loggedSessionId: LoggedSessionId,
    ) => Effect.Effect<Option.Option<CancelSessionResult>, LoggedSessionHasActualsError>;
    /**
     * "History" (issue #114 Part 2) — a reverse-chronological, `before`-paged
     * list of finished sessions, excluding `active` and `cancelled`.
     */
    readonly listSessions: (input: ListSessionsInput) => Effect.Effect<ListSessionsResult>;
    /**
     * "Which Logged Sessions are still in flight" (issue #147) — the `active`
     * rows, newest `startedAt` first, each with its net still-logged Set count.
     * The server-side source of truth the client reconciles its device-local
     * Resume pointer against. No `active`/`cancelled` exclusion here — the
     * opposite of `listSessions`: this one is *only* `active`.
     */
    readonly listActiveSessions: Effect.Effect<ListActiveSessionsResult>;
    /**
     * "Stats" (issue #117) — sets logged per local calendar day, across every
     * non-`cancelled` Logged Session. See `localDateKey`'s doc for the
     * timezone rule.
     */
    readonly getDailySetCounts: (input: GetDailySetCountsInput) => Effect.Effect<GetDailySetCountsResult>;
    /**
     * "Export my data" (`dataExport.ts`): every table, every row. The SQL
     * layer dumps the database itself; this in-memory twin dumps its own
     * collections under the table names they stand in for.
     */
    readonly exportData: Effect.Effect<ExportDataResult>;
    /**
     * The Progress surface's read: per performed Exercise, every finished
     * session that performed it with its net Sets' load and reps
     * (`resolveExerciseProgress`). No error channel.
     */
    readonly getExerciseProgress: Effect.Effect<GetExerciseProgressResult>;
    /** Bodyweight: one reading per local day; logging a day again replaces it. */
    readonly logBodyweight: (input: LogBodyweightInput) => Effect.Effect<BodyweightEntry>;
    /** Idempotent: a day with no reading is a no-op. */
    readonly removeBodyweight: (input: RemoveBodyweightInput) => Effect.Effect<{}>;
    /** Every reading, oldest first. */
    readonly listBodyweight: Effect.Effect<ListBodyweightResult>;
    /**
     * Imported history (`workoutImport.ts`) as finished, already-reviewed
     * Logged Sessions. Idempotent per workout: one whose derived id is
     * already here is skipped and counted, not rewritten.
     */
    readonly importWorkouts: (input: ImportWorkoutsInput) => Effect.Effect<ImportWorkoutsResult>;
    /**
     * Tier-2 one-tap ✓ seed (issue #149): the most recent actual per metric
     * the last time this Exercise was **performed** (swap-aware, ADR 0019),
     * across finished Logged Sessions, folded to net state and bounded by the
     * catalog's `trackedMetrics`. No error channel — a never-performed
     * Exercise is `perMetric: {}`.
     */
    readonly lastActualForExercise: (
      input: LastActualForExerciseInput,
    ) => Effect.Effect<LastActualForExerciseResult>;
    /**
     * Test-only seam (mirrors `mutatePrescribedSessionForTest`): logs an
     * actual with an explicit `appliedAt` instead of "now", which is the only
     * way a test can put a set on a specific calendar day without sleeping
     * real time. Bypasses `logSetActual`'s idempotency/pause-gate machinery
     * entirely — it exists to seed data, not to exercise the outbox path.
     */
    readonly logSetActualAtForTest: (
      input: LogSetActualInput,
      appliedAt: string,
    ) => Effect.Effect<LogSetActualResult>;
    readonly getCoachingFeed: Effect.Effect<ReadonlyArray<CoachingFeedEntry>>;
    readonly getProposals: Effect.Effect<ReadonlyArray<Proposal>>;
    /**
     * The full `decision` row for `id` (ADR 0013 §6, issue #66 slice 1): the
     * Revision runner's seed needs the target Decision **in full**
     * (summary/rationale/citations/Data window), not the narrower `Proposal`
     * wire shape — `getProposals` only surfaces `pending`, `kind: 'proposal'`
     * rows, and strips citations/data window entirely.
     */
    readonly getDecision: (id: string) => Effect.Effect<Option.Option<DecisionRecord>>;
    /**
     * The Proposal-exchange read model for one Proposal (ADR 0013 §9, issue
     * #66 slice 1) — see `buildProposalExchange`'s doc for the chain-walk
     * rule. `None` when `id` names no `kind: 'proposal'` row.
     */
    readonly getProposalExchange: (proposalId: string) => Effect.Effect<Option.Option<ProposalExchange>>;
    /**
     * One `ProposalExchange` per live chain head, replayed on attach exactly
     * like `subscribeProposals` (ADR 0013 §9) — the card's exchange view over
     * the live subscription channel rather than a one-shot read.
     */
    readonly subscribeProposalExchanges: Stream.Stream<ProposalExchange>;
    readonly getPlan: Effect.Effect<PlanSnapshot>;
    /**
     * The Exercise catalog, for the Plan view's picker (#72 user story 29).
     * The same rows `PlanAuthoringContext` is built from — a picker that
     * names different exercises from the ones `addEntry` accepts would be a
     * bug waiting to happen, so both read one source.
     */
    readonly getExerciseCatalog: Effect.Effect<ExerciseCatalog>;
    /**
     * Mints a **User-authored exercise** (#102, ADR 0016) — a name-only row,
     * born `trackedMetrics: []` because empty is what marks a row as
     * un-enriched. No Change, no Decision: no Plan changed.
     *
     * **Idempotent on the client-minted `exerciseId`**: an id already in the
     * catalog returns that row untouched rather than failing or overwriting
     * it, so a retried create cannot mint two exercises and cannot clobber a
     * name the user has since fixed.
     */
    readonly createExercise: (input: CreateExerciseInput) => Effect.Effect<CatalogExercise>;
    /**
     * Renames a catalog row (#102, ADR 0016), keeping the id — the Plan, past
     * Logged Sessions and analytics reference the row by id, so they follow it
     * with no migration.
     *
     * The enrichable metadata is **cleared**, not carried across: it described
     * the old name, and the whole point of rename is that `Zercer Squat` was
     * enriched into nonsense. Emptying it is also how the row is marked for
     * re-enrichment, since un-enriched *is* "no tracked metrics". Until that
     * sweep lands the logging grid renders it through the existing target-key
     * fallback, exactly as a freshly created row does.
     */
    readonly renameExercise: (
      input: RenameExerciseInput,
    ) => Effect.Effect<CatalogExercise, ExerciseNotFoundError>;
    /**
     * The roster of catalog rows the coach has not filled in yet (#104, ADR
     * 0016) — what the Session-review seed carries, and only that.
     *
     * **Un-enriched is "no tracked metrics OR no muscles"**, not a flag
     * column. There is no `enriched` bit to set, and there deliberately isn't
     * one: emptiness IS the marker (`createExercise` mints a row with none,
     * `renameExercise` empties what described the old name), so the roster is
     * derived from the metadata itself and can never disagree with it. The
     * two clauses are an OR because either half missing leaves a real hole —
     * no metrics means logging falls back to target keys, no muscles means
     * the row joins to nothing and its volume reads as zero.
     */
    readonly listUnenrichedExercises: Effect.Effect<ReadonlyArray<UnenrichedExercise>>;
    /**
     * Fills in catalog metadata (#104, ADR 0016) — the coach's **plain
     * write**, and the second instance of ADR 0011's widened write contract:
     * "the coach writes a Decision when it exercises judgment about the
     * user's training, and a plain write when it states a fact about the
     * world." Nothing here touches the Decision log, the Coaching feed, or
     * Today.
     *
     * The **id and the user's name are never written** — the user owns the
     * name, the coach owns everything else — and only rows that are still
     * un-enriched are touched, so a run naming an id it was never offered
     * (or one already filled in) writes nothing rather than overwriting good
     * metadata. An unknown id is likewise a no-op, not a failure: this write
     * rides a review whose real work is already done, and losing that review
     * to a hallucinated exercise id would be a bad trade.
     *
     * Absent fields on an enrichment are left as they are rather than
     * overwritten with emptiness, so a partial answer lands its half instead
     * of erasing the row back to name-only.
     *
     * Returns the ids actually written, which is also the honest answer to
     * "did anything happen" for a caller that wants to log it.
     */
    readonly enrichExercises: (input: {
      readonly enrichments: ReadonlyArray<CatalogEnrichment>;
    }) => Effect.Effect<ReadonlyArray<string>>;
    /**
     * The enriched metadata of one row, INCLUDING the two halves no client
     * reads today (`muscles`/`movementPattern`). Test-only, like
     * `listDecisionsForTest`: per-muscle volume is derived by the coach
     * querying the snapshot database directly (ADR 0011 §2), so there is no
     * production read path to assert enrichment through, and inventing an RPC
     * nothing calls would be worse than naming this what it is.
     */
    readonly getExerciseEnrichmentForTest: (exerciseId: string) => Effect.Effect<
      Option.Option<{
        readonly trackedMetrics: ReadonlyArray<MetricName>;
        readonly muscles: ReadonlyArray<string> | undefined;
        readonly movementPattern: string | undefined;
      }>
    >;
    /**
     * Live streams backing `subscribe*` (Task 8, issue #22): each replays the
     * current snapshot as its first emission (so a fresh subscription after
     * a reconnect re-populates without a manual refresh — "subscribe and
     * replay", thin-client-implementation-plan.md "Task 8") and then emits
     * again on every subsequent store mutation, for as long as the RPC
     * subscription stays attached.
     */
    readonly subscribeCoachingFeed: Stream.Stream<CoachingFeedEntry>;
    readonly subscribeProposals: Stream.Stream<Proposal>;
    readonly subscribePlan: Stream.Stream<PlanSnapshot>;
    /**
     * Resolves a pending Proposal (ADR 0008) — the ONE place a Proposal
     * mutates the Plan. `rejected` only flips the Proposal's status, the Plan
     * is untouched. Either way the Proposal is retained (never deleted) —
     * CONTEXT `Change` — it just leaves the pending set.
     *
     * `accepted` applies **what the Proposal says**, in one of two payload
     * shapes, and never a stand-in:
     *
     * - **`planOperations`** (#86, every review cadence): the ADR 0015
     *   operations folded over the standing Plan by the same pure
     *   `applyPlanOperation` a user-direct edit goes through — all of them or
     *   none. A sequence that does not validate against the Plan as it stands
     *   fails with `PlanOperationRejectedError`, writing nothing and leaving
     *   the Proposal `pending`. A successful acceptance also writes a
     *   `coach-proposal` Change, born `applied` (ADR 0008), recording the
     *   effect beside the Proposal that carries the decision.
     * - **`draftPlan`** (#75, the Intake cold-start case, ADR 0014 §6): the
     *   drafted Plan REPLACES the Plan, because at cold start the payload is
     *   the whole Plan rather than a diff — the seeded demo Plan is gone,
     *   `subscribePlan` emits the accepted sessions, and "Start workout"
     *   instantiates from them. An Exercise the draft names that the catalog
     *   doesn't have yet is the coach authoring a new one (CONTEXT `Exercise
     *   catalog`), not a refusal — the new catalog row is written alongside
     *   the Plan.
     *
     * **Neither** is a legitimate, common outcome, not a hole: a Proposal
     * whose finding is Observation-shaped resolves cleanly and mutates
     * nothing.
     */
    readonly resolveProposal: (
      input: ResolveProposalInput,
    ) => Effect.Effect<
      ResolveProposalResult,
      ProposalNotFoundError | ProposalAlreadyResolvedError | PlanOperationRejectedError
    >;
    /**
     * User-direct Plan edit (Step 2A, task 2A.3; CONTEXT `Change`): the user
     * editing the Plan outside a workout is auto-applied without approval —
     * born `applied` (ADR 0008) — and recorded as a revealed-preference
     * signal for the coach, never surfaced as a Proposal or a coaching feed
     * entry. Recorded as a `decision` row (`kind: 'change'`, `origin:
     * 'user-direct'`, `status: 'applied'`) carrying a generated human
     * summary.
     *
     * This is the WHOLE Plan-authoring surface (#71): the input is either
     * the original narrow Set-target edit or a `PlanEditCommand` carrying
     * one structural operation. Both layers apply operations through the
     * same pure `applyPlanOperation`, so the in-memory store and SQLite
     * cannot disagree about what an edit means.
     */
    readonly applyUserPlanChange: (
      input: ApplyUserChangeInput,
    ) => Effect.Effect<PlanSnapshot, PrescribedSetNotFoundError | PlanOperationRejectedError>;
    /**
     * The Deliberation runner's ONLY write-back (ADR 0011 §3/§6, issue #26
     * — 2B slice 1): maps a run-output object to `decision`/
     * `coaching_feed_entry` rows atomically. The runner assigns
     * `id`/`created_at`, sets `status` (`observation`→`open`,
     * `proposal`→`pending`) and `origin: 'coach-proposal'` on every row —
     * the agent never sets machine fields. Writes a `coaching_feed_entry`
     * for every Proposal and for Observations only when `surface: true`.
     * Applies `observation_directives` as `status` flips on EXISTING,
     * still-`open` Observation rows (`escalate`→`escalated`,
     * `close`→`expired`) — only `status` moves, `rationale`/`citations`/
     * `data_window` stay immutable; a directive naming a non-Observation
     * (e.g. a Proposal) id, an unknown id, OR an already-terminal
     * (`escalated`/`expired`) Observation is a no-op.
     */
    readonly commitDeliberationOutput: (
      input: CommitDeliberationOutputInput,
    ) => Effect.Effect<CommitDeliberationOutputResult>;
    /** Test-only lever (Task 8): injects a new pending Proposal at runtime. */
    readonly pushProposalForTest: (proposal: Proposal) => Effect.Effect<void>;
    /**
     * Applies `logSetActual` exactly-once by `commandId` (ADR 0006 / issue
     * #16). Concurrent calls with the same `commandId` collapse onto the
     * single in-flight `Deferred`; a later replay reads the already-resolved
     * `Deferred` instead of re-applying. When acks are paused, the write to
     * the store happens immediately but resolution of the returned Effect
     * (and thus the RPC response) blocks until `/reset` (or a future
     * `resume-acks`) lifts the pause — modeling a half-open link that
     * accepted the write but withheld the ack.
     */
    readonly logSetActual: (input: LogSetActualInput) => Effect.Effect<LogSetActualResult>;
    /**
     * A retraction (#83, ADR 0019) — "this Set was not performed after all",
     * appended as its own tombstone row rather than deleting or mutating the
     * `logSetActual` row it retracts. Idempotent by `commandId`, exactly like
     * `logSetActual`: a replayed `commandId` returns the row the first
     * attempt wrote. No rejectable-error arm and no lookup validation against
     * the prescribed tree — a retraction has nothing to fail against.
     */
    readonly unlogSetActual: (input: UnlogSetActualInput) => Effect.Effect<UnlogSetActualResult>;
    /**
     * Records a swap (#131, ADR 0019) — a pure actual-side annotation, never
     * an edit to the Logged Session's frozen prescribed copy. Idempotent by
     * `commandId`, exactly like `logSetActual`: a replayed `commandId`
     * returns the row the first attempt wrote, with no re-check of the
     * already-logged-Sets guard below.
     *
     * Fails with `EntryAlreadyLoggedError` when the Entry already has a
     * logged Set — the server-side half of "a swap is offered only before
     * any Set on the Entry is logged" (`Logging.canSwapEntry` is the
     * client-side half). This is checked only for a genuinely new
     * `commandId`, so a legitimate swap that landed before any Set was
     * logged is never retroactively undone by a later Set arriving out of
     * order in an outbox replay.
     */
    readonly swapEntryExercise: (
      input: SwapEntryExerciseInput,
    ) => Effect.Effect<SwapEntryExerciseResult, EntryAlreadyLoggedError>;
    /**
     * Test-only lever for Task 5's (issue #19, G3) frozen-in-flight rung-1
     * test: mutates the seeded Prescribed Session's load target in place
     * (bumping every Set's `target.load` upper bound by 5kg) so a test can
     * prove a client that already prefetched-and-cached the session does
     * NOT see this change reach its in-flight copy — only a fresh
     * `getPrescribedSession` call (i.e. the client's next connected "Start
     * workout") does.
     */
    readonly mutatePrescribedSessionForTest: (
      sessionId: string,
    ) => Effect.Effect<Option.Option<PrescribedSession>>;
    /**
     * Test-only lever for the rest timer (#113 item 2): rewrites `restSec` on
     * every Set of a Prescribed Session that prescribes rest at all, so a
     * browser can watch a countdown reach zero and keep going without idling
     * for the seeded two minutes.
     *
     * Sets that prescribe NO rest are left alone — the negative case (no
     * prescription, no pill) is a flow of its own and a lever that invented
     * rest would erase it.
     *
     * The rung-2 author is forbidden client hooks (docs/agents/testing.md), so
     * the knob lives here for the same reason `hold-deliberation` does: that
     * one exists because the canned deliberator was too *fast* to observe, and
     * this is the same problem pointing the other way.
     */
    readonly shortenPrescribedRestForTest: (
      sessionId: string,
      restSec: number,
    ) => Effect.Effect<Option.Option<PrescribedSession>>;
    /**
     * Test-only lever for the one-tap ✓ seed (issue #149): opens the `load`
     * interval to `{}` ("report, no target") on every Set of a Prescribed
     * Session that prescribes a load. The seed only ever fills a metric the
     * prescription leaves open, and the seed fixture bounds every load — so a
     * rung-2 flow needs this to reach the behaviour at all. Same rationale as
     * `shortenPrescribedRestForTest`: the author is forbidden client hooks.
     */
    readonly openPrescribedLoadForTest: (
      sessionId: string,
    ) => Effect.Effect<Option.Option<PrescribedSession>>;
    readonly pauseAcks: Effect.Effect<void>;
    /**
     * Lifts a `pauseAcks` gate WITHOUT wiping the store (unlike `reset`,
     * which also clears back to the seed). Task 4's half-open-link rung-1
     * test (issue #18) needs to resume acks and then observe the
     * previously-withheld response land on an unmodified store — `reset`'s
     * atomic wipe would race the in-flight response against the seed
     * reset. Test-only, alongside `reset`.
     */
    readonly resumeAcks: Effect.Effect<void>;
    readonly reset: Effect.Effect<void>;
    /** Test-only: number of distinct commandIds ever applied. */
    readonly appliedCount: Effect.Effect<number>;
    /**
     * Test-only: every applied `logSetActual`/`unlogSetActual` result, for
     * server-side G1 assertions. Retractions are included, not collapsed
     * out (#83, ADR 0019) — this is a durability lever, not a UI one, and
     * `retraction` is the discriminator a caller reads to tell them apart.
     */
    readonly listActuals: Effect.Effect<ReadonlyArray<LogSetActualResult | UnlogSetActualResult>>;
    /** Test-only: every applied swap (#131), for the `/__test__/entry-swaps` lever. */
    readonly listEntrySwaps: Effect.Effect<ReadonlyArray<SwapEntryExerciseResult>>;
    /**
     * Test-only: every `decision` row (all kinds/statuses), for black-box
     * `commitDeliberationOutput` assertions (issue #26) that need to see
     * Observation rows too, not just Proposals (`getProposals` filters to
     * `kind: 'proposal'` only).
     */
    readonly listDecisionsForTest: Effect.Effect<ReadonlyArray<DecisionRecord>>;

    // --- seed-input storage (ADR 0011 §2, issue #34) ----------------------

    /** `undefined` when no Goal has ever been set (CONTEXT `Goal`). */
    readonly getGoal: Effect.Effect<GoalSummary | undefined>;
    /** Sets/replaces the single current Goal — never accumulates a history. */
    readonly setGoal: (input: SetGoalInput) => Effect.Effect<GoalSummary>;
    /** ALL Standing constraints (hard + soft) — `SeedInputsProviderLive` injects every one, never a subset (ADR 0011 §2). */
    readonly listStandingConstraints: Effect.Effect<ReadonlyArray<StandingConstraint>>;
    readonly addStandingConstraint: (input: AddStandingConstraintInput) => Effect.Effect<StandingConstraint>;
    /** `removed: false` (not a failure) when `constraintId` names no existing row. */
    readonly removeStandingConstraint: (
      input: RemoveStandingConstraintInput,
    ) => Effect.Effect<{ readonly removed: boolean }>;
    /** All stored Check-ins, oldest first — callers slice the recent window they want (ADR 0011 §2: "recent Check-ins"). */
    readonly listCheckIns: Effect.Effect<ReadonlyArray<CheckIn>>;
    readonly addCheckIn: (input: AddCheckInInput) => Effect.Effect<CheckIn>;
    /** All stored Context notes, oldest first — callers slice the recent window they want. */
    readonly listContextNotes: Effect.Effect<ReadonlyArray<ContextNote>>;
    readonly addContextNote: (input: AddContextNoteInput) => Effect.Effect<ContextNote>;
    /**
     * Rewrites one note's text in place. `undefined` (not a failure) when
     * `noteId` names no row — same "say what happened, do not throw" shape as
     * `removeStandingConstraint`'s `removed: false`, and for the same reason:
     * the caller is an outbox command that must not be able to wedge the queue.
     */
    readonly editContextNote: (
      input: EditContextNoteInput,
    ) => Effect.Effect<ContextNote | undefined>;
    /** The full-inject Evidence-base roster (ADR 0003 §5) — server-seeded, no write path here. */
    readonly listEvidenceRoster: Effect.Effect<ReadonlyArray<EvidenceClaim>>;
    /** Derived pointer-digest history (`sessionsSinceLastReview`/`lastCycleReviewAt`) — see `deriveDigestHistory`. */
    readonly getPointerDigestHistory: Effect.Effect<PointerDigestHistory>;

    // --- per-cadence model settings (ADR 0011 §4, issue #31 — 2B slice 6) --

    /**
     * The model configured for a cadence, or `undefined` when none has been
     * set (the runner then falls back to the injected agent's default model).
     * `DeliberationRunner` reads this per run and passes it to that cadence's
     * deliberator so Session review and Cycle review can run on different
     * models (ADR 0011 §4).
     */
    readonly getCadenceModel: (
      cadence: DeliberationCadence,
    ) => Effect.Effect<{ readonly model: string | undefined; readonly effort: string | undefined }>;
    /** Sets/replaces the model for one cadence — a per-cadence singleton keyed by `cadence`, never an accumulating history. */
    readonly setCadenceModel: (input: CadenceModelSetting) => Effect.Effect<CadenceModelSetting>;

    // --- the run ledger (ADR 0011 §8 amendment, issue #81) ------------------

    /**
     * Appends one agent-session row to the run ledger. The runner's ONE
     * write-through helper is the only caller (ADR 0011 §3 — "the runner owns
     * the only write"); this method itself does not enforce best-effort —
     * that is the CALLER's job (the runner swallows a failed write rather
     * than failing the run it is trying to record), matching how `runState`
     * updates already swallow failures.
     */
    readonly recordRunLedgerRow: (row: {
      readonly runId: string;
      readonly cadence: DeliberationCadence;
      readonly stage: DeliberationRunStage;
      readonly model: string | undefined;
      readonly usage: TokenUsage;
      readonly costUsd: number;
    }) => Effect.Effect<void>;

    /** The Settings spend section's one read: per-cadence breakdown + recent runs, grouped server-side (`summarizeRunLedger`). */
    readonly getSpendSummary: Effect.Effect<GetSpendSummaryResult>;

    // --- the run record (ADR 0011 §8, the Coach run history) ----------------
    //
    // Three writes and two reads around one table. The writes are the runner's
    // alone (ADR 0011 §3/§6) and none of them enforces best-effort here — that
    // is the CALLER's job, exactly as `recordRunLedgerRow` above leaves it, so
    // a store method still fails loudly when something is genuinely wrong with
    // the DB while the runner declines to let that failure reach the run.

    /**
     * Opens a run's row, `running`, before its first agent session starts.
     *
     * Written at the START rather than at the end, and that is the whole
     * mechanism: a run that never reaches an end — it failed, it was killed,
     * the server went down under it — has already said that it existed. A row
     * written only on success could never record anything but success.
     */
    readonly startDeliberationRun: (input: {
      readonly runId: string;
      readonly cadence: DeliberationCadence;
      readonly startedAt: string;
    }) => Effect.Effect<void>;
    /**
     * Closes a run's row: `committed` with the provenance envelope it read
     * over, or `failed` with the reason it died.
     *
     * A no-op for a `runId` with no row — which is the state a run reaches
     * when its own `startDeliberationRun` was swallowed as best-effort. The
     * alternative, minting the row here, would resurrect a run with a start
     * time nobody observed.
     */
    readonly finishDeliberationRun: (input: {
      readonly runId: string;
      readonly outcome: "committed" | "failed";
      readonly finishedAt: string;
      readonly failureReason?: string | undefined;
      readonly dataWindow?: DeliberationDataWindow | undefined;
    }) => Effect.Effect<void>;
    /**
     * Removes a run's row entirely — the cancelled-Revision path, and nothing
     * else.
     *
     * ADR 0013 §5 is unambiguous that a cancelled Revision writes no rows,
     * either way it is cancelled, and this surface has to mean it. A cancelled
     * run recorded as `failed` would put a red node on the record for something
     * the user themselves called off, which reads as the coach breaking rather
     * than the coach obeying; recorded as `committed` it would claim an output
     * that was deliberately never written. The only honest record of a run the
     * user cancelled is no record.
     */
    readonly discardDeliberationRun: (runId: string) => Effect.Effect<void>;
    /**
     * Closes out every run still marked `running` — called once, by the runner,
     * at startup.
     *
     * Nothing survives a restart: the deliberator session, the deferral queue
     * and `runStateRef` are all in-process, so a row left `running` by a killed
     * process describes a run that cannot still be going. Without this the
     * record would show a permanently pulsing live node at the top of the rail,
     * which is worse than showing nothing — it is the surface asserting the
     * coach is working when it is not. Returns how many it closed so a caller
     * can log it.
     */
    readonly failRunsInterruptedByRestart: Effect.Effect<{ readonly failed: number }>;
    /** Every run, newest first, with the Decisions each emitted — see `DeliberationRunRecord`. */
    readonly getDeliberationRuns: Effect.Effect<ReadonlyArray<DeliberationRunRecord>>;
    /** `getDeliberationRuns` as a subscription, one run per element — the Coach record's feed. */
    readonly subscribeDeliberationRuns: Stream.Stream<DeliberationRunRecord>;

    // --- the RPE capture control (#63, issue #81) ---------------------------

    /** The current RPE capture mode — always present (defaults to `flagged-only`, migration `013`). */
    readonly getRpeCaptureMode: Effect.Effect<RpeCaptureMode>;
    /** Sets/replaces the RPE capture mode — a singleton, never an accumulating history. */
    readonly setRpeCaptureMode: (mode: RpeCaptureMode) => Effect.Effect<RpeCaptureMode>;

    // --- the monthly Cycle-review schedule (ADR 0011 §4, issue #91) --------

    /**
     * Atomically claims the Cycle review's due window, if one is due.
     *
     * The schedule's whole state is a persisted "last claimed at" timestamp
     * (migration `011`), so due-ness is derived from the clock and the store
     * rather than from process uptime: a home server that reboots does not
     * reset the interval, and a boot after a missed window finds the window
     * still due and runs the review instead of skipping it.
     *
     * `claimed: true` means the caller — and no one else — owns this window
     * and must run the review. The read-and-write is ONE conditional
     * statement, which is what makes two pollers (or a poll racing a restart)
     * unable to both claim one due window. Claiming BEFORE running, not after,
     * is deliberate: a run that dies mid-flight costs one skipped month, while
     * claiming after would let a crash-loop fire a review on every boot.
     *
     * First call against a fresh store CLAIMS NOTHING — it just records "the
     * clock starts now", so standing a server up does not immediately spend
     * subscription quota on a review of no history.
     */
    readonly claimDueCycleReview: (params: {
      /** ISO timestamp treated as "now" — injected so tests need no clock control. */
      readonly now: string;
      /** The cadence, in milliseconds (production: `MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS`). */
      readonly intervalMillis: number;
    }) => Effect.Effect<CycleReviewClaim>;
  }
>()("@repcoach/dev-server/Store") {
  static readonly layer = Layer.effect(Store)(
    Effect.gen(function* () {
      const dataRef = yield* SubscriptionRef.make<StoreData>(seedData());
      const inFlightRef = yield* Ref.make<ReadonlyMap<string, CommandSlot>>(new Map());
      const pauseGateRef = yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none());

      const currentPauseGate = Ref.get(pauseGateRef).pipe(
        Effect.flatMap((gate) => (Option.isSome(gate) ? Deferred.await(gate.value) : Effect.void)),
      );

      const applyNow = (input: LogSetActualInput): Effect.Effect<LogSetActualResult> =>
        Effect.gen(function* () {
          const appliedAt = new Date().toISOString();
          const result: LogSetActualResult = {
            commandId: input.commandId,
            loggedSessionId: input.loggedSessionId,
            sessionId: input.sessionId,
            entryId: input.entryId,
            setId: input.setId,
            setType: input.setType,
            actual: input.actual,
            appliedAt,
            retraction: false,
          };
          // Persist the write immediately — a paused link still accepts
          // writes, it only withholds the ack (see `pauseAcks` above).
          yield* SubscriptionRef.update(dataRef, (data) => ({
            ...data,
            actualsByCommandId: new Map(data.actualsByCommandId).set(input.commandId, result),
          }));
          return result;
        });

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
              const nextMap = new Map(map).set(commandId, nextSlot);
              return [{ slot: nextSlot, isNew: true }, nextMap];
            });

          if (isNew) {
            const result = yield* applyNow(input);
            // Withhold the ack while paused; the write above already
            // landed, so a concurrent duplicate observes it too.
            //
            // The wait — and only the wait — must stay interruptible: the
            // RPC server interrupts every in-flight request fiber when its
            // connection dies (`RpcServer.ts`'s per-client fiber teardown),
            // and a command whose ack dies with the socket is exactly #84's
            // bug. `result` is already durable at this point, so completing
            // the slot unconditionally via `Effect.ensuring` — even when the
            // wait above is what got interrupted — is what lets a replay
            // landing on a *new* connection observe it instead of awaiting a
            // `Deferred` nothing will ever complete.
            yield* currentPauseGate.pipe(Effect.ensuring(Deferred.succeed(slot.deferred, result)));
            return result;
          }

          return yield* Deferred.await(slot.deferred);
        });

      // Swap (#131, ADR 0019). Idempotent on `commandId` via a plain map
      // lookup — unlike `logSetActual` this needs no in-flight
      // Deferred/pause-gate machinery, because nothing here models a
      // half-open link; a genuinely concurrent duplicate racing the guard
      // check below is not a case this in-memory layer needs to defend
      // against (the drain is strictly one-at-a-time, ADR/outbox flusher
      // doc — only one swap for a given commandId is ever in flight).
      const swapEntryExercise = (
        input: SwapEntryExerciseInput,
      ): Effect.Effect<SwapEntryExerciseResult, EntryAlreadyLoggedError> =>
        Effect.gen(function* () {
          const data = yield* SubscriptionRef.get(dataRef);
          const existing = data.entrySwapsByCommandId.get(input.commandId as string);
          if (existing !== undefined) {
            // A replayed commandId returns the row the first attempt wrote,
            // with no re-check of the guard below (ADR 0019).
            return existing;
          }
          // Net state, not "has any row ever been written" (#148): a
          // retraction is stored in `actualsByCommandId` too, so a Set that was
          // logged then un-logged must not still count as logged. `foldNetActuals`
          // (`@repcoach/contracts`) is the same fold `Grid.canSwapEntry` and the
          // SqlStore guard use — the map's insertion order is application order.
          const onThisEntry = Array.from(data.actualsByCommandId.values()).filter(
            (actual) =>
              actual.loggedSessionId === input.loggedSessionId && actual.entryId === input.entryId,
          );
          const alreadyLogged = foldNetActuals(onThisEntry).size > 0;
          if (alreadyLogged) {
            return yield* Effect.fail(
              new EntryAlreadyLoggedError({
                commandId: input.commandId,
                loggedSessionId: input.loggedSessionId,
                entryId: input.entryId,
              }),
            );
          }
          const result: SwapEntryExerciseResult = {
            commandId: input.commandId,
            loggedSessionId: input.loggedSessionId,
            entryId: input.entryId,
            exerciseId: input.exerciseId,
            swappedAt: new Date().toISOString(),
          };
          yield* SubscriptionRef.update(dataRef, (current) => ({
            ...current,
            entrySwapsByCommandId: new Map(current.entrySwapsByCommandId).set(
              input.commandId as string,
              result,
            ),
          }));
          return result;
        });

      // Retraction (#83, ADR 0019): idempotent on `commandId` via a plain
      // map lookup, exactly like `swapEntryExercise` above — no in-flight
      // Deferred/pause-gate machinery, because a retraction models no
      // half-open-link semantics (mirrors `logSetActual`'s shape being about
      // the same table, but a retraction is unconditional — no rejectable
      // error, no lookup validation, per migration `020`'s note).
      const unlogSetActual = (input: UnlogSetActualInput): Effect.Effect<UnlogSetActualResult> =>
        Effect.gen(function* () {
          const data = yield* SubscriptionRef.get(dataRef);
          const commandId = input.commandId as string;
          const existing = data.actualsByCommandId.get(commandId);
          if (existing !== undefined) {
            // A replayed commandId returns the row the first attempt wrote.
            // `commandId` is client-minted fresh per intent, so a hit here is
            // always this same retraction, never a `logSetActual` row.
            return existing as UnlogSetActualResult;
          }
          const result: UnlogSetActualResult = {
            commandId: input.commandId,
            loggedSessionId: input.loggedSessionId,
            entryId: input.entryId,
            setId: input.setId,
            appliedAt: new Date().toISOString(),
            retraction: true,
          };
          yield* SubscriptionRef.update(dataRef, (current) => ({
            ...current,
            actualsByCommandId: new Map(current.actualsByCommandId).set(commandId, result),
          }));
          return result;
        });

      return Store.of({
        getPrescribedSession: (sessionId) =>
          SubscriptionRef.get(dataRef).pipe(
            Effect.map((data) => {
              const session = data.prescribedSessions.get(sessionId);
              return session === undefined
                ? Option.none()
                : Option.some(rejoinTrackedMetrics(session, data.exerciseCatalog));
            }),
          ),
        startSession: (prescribedSessionId) =>
          Effect.gen(function* () {
            const data = yield* SubscriptionRef.get(dataRef);
            const prescribed = data.prescribedSessions.get(prescribedSessionId);
            if (prescribed === undefined) {
              return yield* Effect.fail(
                new PrescribedSessionNotFoundError({ sessionId: prescribedSessionId }),
              );
            }
            // Deep copy on instantiate (ADR 0006/0007) — plain-data clone,
            // never a live reference back into `prescribedSessions`, so a
            // later Plan/test-lever mutation can't reach this snapshot.
            const snapshot: PrescribedSession = JSON.parse(JSON.stringify(prescribed));
            const loggedSessionId = randomUUID();
            const record: LoggedSessionRecord = {
              loggedSessionId,
              prescribedSessionId,
              startedAt: new Date().toISOString(),
              status: "active",
              snapshot,
            };
            yield* SubscriptionRef.update(dataRef, (current) => ({
              ...current,
              loggedSessions: new Map(current.loggedSessions).set(loggedSessionId, record),
            }));
            const result: StartSessionResult = { loggedSessionId: loggedSessionId as never };
            return result;
          }),
        getLoggedSession: (loggedSessionId) =>
          SubscriptionRef.get(dataRef).pipe(
            Effect.map((data) => {
              const record = data.loggedSessions.get(loggedSessionId);
              if (record === undefined) {
                return Option.none();
              }
              const actuals = Array.from(data.actualsByCommandId.values())
                .filter((actual) => actual.loggedSessionId === loggedSessionId)
                .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));
              const notes = Array.from(data.contextNotes.values())
                .filter((note) => note.loggedSessionId === loggedSessionId)
                .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
              // Disjoint from `record.snapshot`: a swap never touches the
              // frozen prescribed copy (ADR 0019), so the prescribed
              // exercise inside `session` and the performed exercise here
              // are both readable from this one response.
              const swaps = Array.from(data.entrySwapsByCommandId.values())
                .filter((swap) => swap.loggedSessionId === loggedSessionId)
                .sort((a, b) => a.swappedAt.localeCompare(b.swappedAt));
              const loggedSession: LoggedSession = {
                loggedSessionId: record.loggedSessionId as never,
                prescribedSessionId: record.prescribedSessionId as never,
                startedAt: record.startedAt,
                status: record.status,
                session: record.snapshot,
                actuals,
                notes,
                swaps,
              };
              return Option.some(loggedSession);
            }),
          ),
        finalizeSession: (loggedSessionId) =>
          SubscriptionRef.modify(dataRef, (data) => {
            const id = loggedSessionId as string;
            const existing = data.loggedSessions.get(id);
            if (existing === undefined) {
              return [Option.none(), data];
            }
            // Idempotent: an already-`finished` session is a no-op on the
            // status. It reports its EXISTING review marker rather than
            // asserting `reviewed` (issue #132) — a re-finish of a session
            // whose review never ran must keep saying `pending`, which is what
            // lets the drain still pick it up. Defaulting an absent marker to
            // `pending` covers a `finished` row written before migration
            // `017`; the migration backfills those, and this makes the
            // in-memory layer agree without a second backfill.
            if (existing.status === "finished") {
              return [
                Option.some({
                  loggedSessionId: existing.loggedSessionId as never,
                  status: "finished" as const,
                  transitioned: false,
                  reviewStatus: existing.reviewStatus ?? ("pending" as const),
                }),
                data,
              ];
            }
            // One write: the status flip and the review marker land together
            // or not at all (issue #132).
            const updated: LoggedSessionRecord = {
              ...existing,
              status: "finished",
              finishedAt: new Date().toISOString(),
              reviewStatus: "pending",
            };
            const result = Option.some({
              loggedSessionId: existing.loggedSessionId as never,
              status: "finished" as const,
              transitioned: true,
              reviewStatus: "pending" as const,
            });
            return [
              result,
              { ...data, loggedSessions: new Map(data.loggedSessions).set(id, updated) },
            ];
          }),

        // The in-memory twin of the `review_status = 'pending'` query (#132).
        // Oldest finish first, with a missing `finishedAt` sorting first — the
        // same "NULL is oldest" rule `listSessions` uses.
        listSessionsPendingReview: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) =>
            Array.from(data.loggedSessions.values())
              .filter((record) => record.status === "finished" && record.reviewStatus === "pending")
              .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""))
              .map((record) => record.loggedSessionId as LoggedSessionId),
          ),
        ),

        // Idempotent and total (#132): only a `finished`, `pending` row moves.
        // An unknown / `active` / `cancelled` / already-`reviewed` session is a
        // no-op, so a drain racing a re-finish cannot corrupt anything.
        markSessionReviewed: (loggedSessionId) =>
          SubscriptionRef.update(dataRef, (data) => {
            const id = loggedSessionId as string;
            const existing = data.loggedSessions.get(id);
            if (existing === undefined) return data;
            if (existing.status !== "finished" || existing.reviewStatus !== "pending") return data;
            const updated: LoggedSessionRecord = { ...existing, reviewStatus: "reviewed" };
            return { ...data, loggedSessions: new Map(data.loggedSessions).set(id, updated) };
          }),
        cancelSession: (loggedSessionId) =>
          Effect.gen(function* () {
            const data = yield* SubscriptionRef.get(dataRef);
            const id = loggedSessionId as string;
            const existing = data.loggedSessions.get(id);
            if (existing === undefined) {
              return Option.none<CancelSessionResult>();
            }
            if (existing.status === "cancelled") {
              return Option.some<CancelSessionResult>({
                loggedSessionId: existing.loggedSessionId as never,
                status: "cancelled",
                cancelled: false,
              });
            }
            // Net state (ADR 0019): a Set logged and then retracted (a
            // mis-tap) must not permanently block cancelling the session —
            // the guard reads what is STILL logged, not raw row presence.
            const hasActuals =
              netLoggedActuals(
                Array.from(data.actualsByCommandId.values()).filter(
                  (actual) => actual.loggedSessionId === id,
                ),
              ).length > 0;
            if (hasActuals) {
              return yield* Effect.fail(new LoggedSessionHasActualsError({ loggedSessionId }));
            }
            if (existing.status !== "active") {
              // `finished` with zero actuals: already resolved, nothing to
              // cancel — idempotent, not an error.
              return Option.some<CancelSessionResult>({
                loggedSessionId: existing.loggedSessionId as never,
                status: existing.status,
                cancelled: false,
              });
            }
            const updated: LoggedSessionRecord = { ...existing, status: "cancelled" };
            yield* SubscriptionRef.update(dataRef, (current) => ({
              ...current,
              loggedSessions: new Map(current.loggedSessions).set(id, updated),
            }));
            return Option.some<CancelSessionResult>({
              loggedSessionId: existing.loggedSessionId as never,
              status: "cancelled",
              cancelled: true,
            });
          }),
        listSessions: (input) =>
          Effect.gen(function* () {
            const data = yield* SubscriptionRef.get(dataRef);
            const limit = input.limit ?? 20;
            const finished = Array.from(data.loggedSessions.values())
              .filter(
                (record): record is LoggedSessionRecord & { readonly finishedAt: string } =>
                  record.status === "finished" && record.finishedAt !== undefined,
              )
              .filter((record) => (input.before === undefined ? true : record.finishedAt < input.before))
              .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
              .slice(0, limit);
            const sessions: ReadonlyArray<LoggedSessionSummary> = finished.map((record) => {
              const totalSetCount = record.snapshot.blocks.reduce(
                (sum, block) => sum + block.entries.reduce((entrySum, entry) => entrySum + entry.sets.length, 0),
                0,
              );
              const loggedSetIds = new Set(
                Array.from(data.actualsByCommandId.values())
                  .filter((actual) => actual.loggedSessionId === record.loggedSessionId)
                  .map((actual) => actual.setId),
              );
              return {
                loggedSessionId: record.loggedSessionId as never,
                prescribedSessionId: record.prescribedSessionId as never,
                ...(record.snapshot.name !== undefined ? { name: record.snapshot.name } : {}),
                startedAt: record.startedAt,
                finishedAt: record.finishedAt,
                loggedSetCount: loggedSetIds.size as never,
                totalSetCount: totalSetCount as never,
              };
            });
            const result: ListSessionsResult = { sessions };
            return result;
          }),
        // The in-memory twin of the `status = 'active'` query (issue #147) —
        // newest `startedAt` first, `loggedSetCount` the NET still-logged count
        // via the same `netLoggedActuals` fold `cancelSession` uses.
        listActiveSessions: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) => {
            const sessions: ReadonlyArray<ActiveLoggedSessionSummary> = Array.from(
              data.loggedSessions.values(),
            )
              .filter((record) => record.status === "active")
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
              .map((record) => {
                const netCount = netLoggedActuals(
                  Array.from(data.actualsByCommandId.values()).filter(
                    (actual) => actual.loggedSessionId === record.loggedSessionId,
                  ),
                ).length;
                return {
                  loggedSessionId: record.loggedSessionId as never,
                  prescribedSessionId: record.prescribedSessionId as never,
                  ...(record.snapshot.name !== undefined ? { name: record.snapshot.name } : {}),
                  startedAt: record.startedAt,
                  loggedSetCount: netCount as never,
                };
              });
            const result: ListActiveSessionsResult = { sessions };
            return result;
          }),
        ),
        exportData: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data): ExportDataResult => {
            const rows = (values: Iterable<unknown>) =>
              Array.from(values) as ReadonlyArray<Record<string, unknown>>;
            return {
              format: "repcoach-export",
              version: 1,
              exportedAt: new Date().toISOString(),
              tables: {
                plan: rows([data.plan]),
                logged_session: rows(data.loggedSessions.values()),
                logged_set_actual: rows(data.actualsByCommandId.values()),
                logged_entry_swap: rows(data.entrySwapsByCommandId.values()),
                context_note: rows(data.contextNotes.values()),
                exercise_catalog: rows(data.exerciseCatalog.values()),
                decision: rows(data.decisions.values()),
                coaching_feed_entry: rows(data.coachingFeed),
                goal: rows(data.goal === undefined ? [] : [data.goal]),
                standing_constraint: rows(data.standingConstraints.values()),
                check_in: rows(data.checkIns.values()),
                run_ledger: rows(data.runLedger),
                deliberation_run: rows(data.deliberationRuns.values()),
                bodyweight_entry: rows(data.bodyweight.values()),
              },
            };
          }),
        ),
        getDailySetCounts: (input) =>
          Effect.gen(function* () {
            const data = yield* SubscriptionRef.get(dataRef);
            // `${loggedSessionId}|${setId}` rather than bare `setId`: set ids
            // are per-session (template-derived), not globally unique, so two
            // different sessions logged on the same day can and do reuse
            // "set-1" — deduping on `setId` alone would silently collapse them.
            const idsByDay = new Map<string, Set<string>>();
            for (const actual of data.actualsByCommandId.values()) {
              const session = data.loggedSessions.get(actual.loggedSessionId);
              if (session?.status === "cancelled") continue;
              const day = localDateKey(actual.appliedAt, input.utcOffsetMinutes);
              const ids = idsByDay.get(day) ?? new Set<string>();
              ids.add(`${actual.loggedSessionId}|${actual.setId}`);
              idsByDay.set(day, ids);
            }
            const days = Array.from(idsByDay.entries())
              .map(([date, ids]) => ({ date, setCount: ids.size as never }))
              .sort((a, b) => a.date.localeCompare(b.date));
            const result: GetDailySetCountsResult = { days };
            return result;
          }),
        lastActualForExercise: (input) =>
          Effect.gen(function* () {
            const data = yield* SubscriptionRef.get(dataRef);
            const finished = finishedSessionViews(data);
            const trackedMetrics = data.exerciseCatalog.get(input.exerciseId)?.trackedMetrics;
            const result: LastActualForExerciseResult = {
              exerciseId: input.exerciseId,
              perMetric: resolveLastActualForExercise(finished, input.exerciseId, trackedMetrics),
              sets: resolveLastSetsForExercise(finished, input.exerciseId, trackedMetrics),
            };
            const bestE1rm = resolveBestE1rm(finished, input.exerciseId);
            return bestE1rm === undefined ? result : { ...result, bestE1rm };
          }),
        importWorkouts: (input) =>
          SubscriptionRef.modify(dataRef, (data): [ImportWorkoutsResult, StoreData] => {
            const loggedSessions = new Map(data.loggedSessions);
            const actualsByCommandId = new Map(data.actualsByCommandId);
            let imported = 0;
            let skipped = 0;
            for (const workout of input.workouts) {
              const rows = importedSessionRows(workout);
              if (loggedSessions.has(rows.loggedSessionId)) {
                skipped++;
                continue;
              }
              loggedSessions.set(rows.loggedSessionId, {
                loggedSessionId: rows.loggedSessionId,
                prescribedSessionId: rows.loggedSessionId,
                startedAt: workout.startedAt,
                status: "finished",
                snapshot: rows.snapshot,
                finishedAt: workout.finishedAt,
                reviewStatus: "reviewed",
              });
              for (const actual of rows.actuals) actualsByCommandId.set(actual.commandId, actual);
              imported++;
            }
            return [{ imported, skipped }, { ...data, loggedSessions, actualsByCommandId }];
          }),
        logBodyweight: (input) =>
          Effect.gen(function* () {
            const entry: BodyweightEntry = {
              date: input.date,
              weightKg: input.weightKg,
              recordedAt: new Date().toISOString(),
            };
            yield* SubscriptionRef.update(dataRef, (data) => ({
              ...data,
              bodyweight: new Map(data.bodyweight).set(input.date, entry),
            }));
            return entry;
          }),
        removeBodyweight: (input) =>
          SubscriptionRef.update(dataRef, (data) => {
            const bodyweight = new Map(data.bodyweight);
            bodyweight.delete(input.date);
            return { ...data, bodyweight };
          }).pipe(Effect.as({})),
        listBodyweight: SubscriptionRef.get(dataRef).pipe(
          Effect.map(
            (data): ListBodyweightResult => ({
              entries: Array.from(data.bodyweight.values()).sort((a, b) => a.date.localeCompare(b.date)),
            }),
          ),
        ),
        getExerciseProgress: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data): GetExerciseProgressResult => ({
            exercises: resolveExerciseProgress(finishedSessionViews(data)),
          })),
        ),
        logSetActualAtForTest: (input, appliedAt) =>
          Effect.gen(function* () {
            const result: LogSetActualResult = { ...input, appliedAt, retraction: false };
            yield* SubscriptionRef.update(dataRef, (data) => ({
              ...data,
              actualsByCommandId: new Map(data.actualsByCommandId).set(input.commandId, result),
            }));
            return result;
          }),
        mutatePrescribedSessionForTest: (sessionId) =>
          Effect.gen(function* () {
            const data = yield* SubscriptionRef.get(dataRef);
            const existing = data.prescribedSessions.get(sessionId);
            if (existing === undefined) {
              return Option.none();
            }
            const mutated: PrescribedSession = {
              ...existing,
              blocks: existing.blocks.map((block) => ({
                ...block,
                entries: block.entries.map((entry) => ({
                  ...entry,
                  sets: entry.sets.map((set) => {
                    const { load, ...restTarget } = set.target;
                    if (load === undefined) {
                      return set;
                    }
                    const bumpedLoad: PrescribedTargetInterval = {
                      ...(load.min === undefined ? {} : { min: load.min }),
                      max: (load.max ?? 0) + 5,
                    };
                    return { ...set, target: { ...restTarget, load: bumpedLoad } };
                  }),
                })),
              })),
            };
            yield* SubscriptionRef.set(dataRef, {
              ...data,
              prescribedSessions: new Map(data.prescribedSessions).set(sessionId, mutated),
            });
            return Option.some(mutated);
          }),
        shortenPrescribedRestForTest: (sessionId, restSec) =>
          Effect.gen(function* () {
            const data = yield* SubscriptionRef.get(dataRef);
            const existing = data.prescribedSessions.get(sessionId);
            if (existing === undefined) {
              return Option.none();
            }
            const shortened: PrescribedSession = {
              ...existing,
              blocks: existing.blocks.map((block) => ({
                ...block,
                entries: block.entries.map((entry) => ({
                  ...entry,
                  sets: entry.sets.map((set) =>
                    set.restSec === undefined ? set : { ...set, restSec },
                  ),
                })),
              })),
            };
            yield* SubscriptionRef.set(dataRef, {
              ...data,
              prescribedSessions: new Map(data.prescribedSessions).set(sessionId, shortened),
            });
            return Option.some(shortened);
          }),
        openPrescribedLoadForTest: (sessionId) =>
          Effect.gen(function* () {
            const data = yield* SubscriptionRef.get(dataRef);
            const existing = data.prescribedSessions.get(sessionId);
            if (existing === undefined) {
              return Option.none();
            }
            const opened: PrescribedSession = {
              ...existing,
              blocks: existing.blocks.map((block) => ({
                ...block,
                entries: block.entries.map((entry) => ({
                  ...entry,
                  sets: entry.sets.map((set) =>
                    set.target.load === undefined
                      ? set
                      : { ...set, target: { ...set.target, load: {} } },
                  ),
                })),
              })),
            };
            yield* SubscriptionRef.set(dataRef, {
              ...data,
              prescribedSessions: new Map(data.prescribedSessions).set(sessionId, opened),
            });
            return Option.some(opened);
          }),
        getCoachingFeed: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) => visibleCoachingFeed(data.coachingFeed, data.decisions)),
        ),
        getProposals: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) => visibleProposals(data.decisions)),
        ),
        getDecision: (id) =>
          SubscriptionRef.get(dataRef).pipe(
            Effect.map((data) => {
              const row = data.decisions.get(id);
              return row === undefined ? Option.none() : Option.some(row);
            }),
          ),
        getProposalExchange: (proposalId) =>
          SubscriptionRef.get(dataRef).pipe(
            Effect.map((data) => buildProposalExchange(proposalId, data.decisions)),
          ),
        subscribeProposalExchanges: SubscriptionRef.changes(dataRef).pipe(
          Stream.map((data) =>
            visibleProposals(data.decisions).flatMap((proposal) => {
              const exchange = buildProposalExchange(proposal.id, data.decisions);
              return Option.isSome(exchange) ? [exchange.value] : [];
            }),
          ),
          Stream.flattenIterable,
        ),
        getPlan: SubscriptionRef.get(dataRef).pipe(Effect.map((data) => data.plan)),
        getExerciseCatalog: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) => toExerciseCatalog(inMemoryAuthoringContext(data.exerciseCatalog))),
        ),
        createExercise: (input) =>
          SubscriptionRef.modify(dataRef, (data): readonly [CatalogExercise, StoreData] => {
            const existing = data.exerciseCatalog.get(input.exerciseId);
            // The id is the client's idempotency key (ADR 0016 §3 puts this
            // write outside the outbox, so there is no `commandId` to dedupe
            // on): a replay returns what the first attempt minted.
            if (existing !== undefined) return [toCatalogExercise(existing), data];
            const exercise: ExerciseCatalogEntry = {
              id: input.exerciseId,
              name: input.name,
              // Name only. Empty is the un-enriched marker, not a claim that
              // the exercise records nothing.
              trackedMetrics: [],
              ...(input.libraryId === undefined ? {} : { libraryId: input.libraryId }),
            };
            return [
              toCatalogExercise(exercise),
              {
                ...data,
                exerciseCatalog: new Map(data.exerciseCatalog).set(exercise.id, exercise),
              },
            ];
          }),
        renameExercise: (input) =>
          Effect.gen(function* () {
            const data = yield* SubscriptionRef.get(dataRef);
            const existing = data.exerciseCatalog.get(input.exerciseId);
            if (existing === undefined) {
              return yield* Effect.fail(new ExerciseNotFoundError({ exerciseId: input.exerciseId }));
            }
            // Same id, new name, metadata back to un-enriched — see the
            // `Store` interface for why the old metadata does not travel.
            const renamed: ExerciseCatalogEntry = {
              id: existing.id,
              name: input.name,
              trackedMetrics: [],
              // The library link survives: a rename fixes how the exercise is
              // spelled, not which movement the animation shows.
              ...(existing.libraryId === undefined ? {} : { libraryId: existing.libraryId }),
            };
            yield* SubscriptionRef.update(dataRef, (current) => {
              // The anatomy goes with the metrics (#104): it described the
              // old name just as much as they did, and leaving it behind
              // would keep the row joining to muscles the renamed exercise
              // may not train at all.
              const nextAnatomy = new Map(current.exerciseAnatomy);
              nextAnatomy.delete(renamed.id);
              return {
                ...current,
                exerciseCatalog: new Map(current.exerciseCatalog).set(renamed.id, renamed),
                exerciseAnatomy: nextAnatomy,
              };
            });
            return toCatalogExercise(renamed);
          }),
        listUnenrichedExercises: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) =>
            Array.from(data.exerciseCatalog.values())
              .filter((exercise) =>
                isUnenrichedExercise({
                  trackedMetrics: exercise.trackedMetrics,
                  muscles: data.exerciseAnatomy.get(exercise.id)?.muscles,
                }),
              )
              .map(
                (exercise): UnenrichedExercise => ({
                  id: exercise.id as UnenrichedExercise["id"],
                  name: exercise.name,
                }),
              ),
          ),
        ),
        enrichExercises: (input) =>
          SubscriptionRef.modify(dataRef, (data): readonly [ReadonlyArray<string>, StoreData] => {
            const nextCatalog = new Map(data.exerciseCatalog);
            const nextAnatomy = new Map(data.exerciseAnatomy);
            const written: Array<string> = [];

            for (const enrichment of input.enrichments) {
              const existing = nextCatalog.get(enrichment.exercise_id);
              // An id the catalog does not hold, or one already filled in, is
              // a no-op — never a failure, and never an overwrite.
              if (existing === undefined) continue;
              const anatomy = nextAnatomy.get(enrichment.exercise_id);
              if (!isUnenrichedExercise({ trackedMetrics: existing.trackedMetrics, muscles: anatomy?.muscles })) {
                continue;
              }

              // The id and the user's name are never touched — the user owns
              // the name, the coach owns everything else (ADR 0016).
              if (enrichment.tracked_metrics !== undefined) {
                nextCatalog.set(existing.id, { ...existing, trackedMetrics: enrichment.tracked_metrics });
              }
              if (enrichment.muscles !== undefined || enrichment.movement_pattern !== undefined) {
                nextAnatomy.set(existing.id, {
                  // Absent leaves what is already there, so a partial answer
                  // lands its half instead of erasing the other one.
                  ...anatomy,
                  ...(enrichment.muscles === undefined ? {} : { muscles: enrichment.muscles }),
                  ...(enrichment.movement_pattern === undefined
                    ? {}
                    : { movementPattern: enrichment.movement_pattern }),
                });
              }
              if (
                enrichment.tracked_metrics !== undefined ||
                enrichment.muscles !== undefined ||
                enrichment.movement_pattern !== undefined
              ) {
                written.push(existing.id);
              }
            }

            if (written.length === 0) return [written, data];
            return [written, { ...data, exerciseCatalog: nextCatalog, exerciseAnatomy: nextAnatomy }];
          }),
        getExerciseEnrichmentForTest: (exerciseId) =>
          SubscriptionRef.get(dataRef).pipe(
            Effect.map((data) => {
              const exercise = data.exerciseCatalog.get(exerciseId);
              if (exercise === undefined) return Option.none();
              const anatomy = data.exerciseAnatomy.get(exerciseId);
              return Option.some({
                trackedMetrics: exercise.trackedMetrics ?? [],
                muscles: anatomy?.muscles,
                movementPattern: anatomy?.movementPattern,
              });
            }),
          ),
        subscribeCoachingFeed: SubscriptionRef.changes(dataRef).pipe(
          Stream.map((data) => visibleCoachingFeed(data.coachingFeed, data.decisions)),
          Stream.flattenIterable,
        ),
        subscribeProposals: SubscriptionRef.changes(dataRef).pipe(
          Stream.map((data) => visibleProposals(data.decisions)),
          Stream.flattenIterable,
        ),
        subscribePlan: SubscriptionRef.changes(dataRef).pipe(Stream.map((data) => data.plan)),
        resolveProposal: (input) =>
          Effect.gen(function* () {
            const data = yield* SubscriptionRef.get(dataRef);
            const existing = data.decisions.get(input.proposalId);
            if (existing === undefined || existing.kind !== "proposal") {
              return yield* Effect.fail(
                new ProposalNotFoundError({ proposalId: input.proposalId }),
              );
            }
            if (existing.status !== "pending") {
              return yield* Effect.fail(
                new ProposalAlreadyResolvedError({
                  proposalId: input.proposalId,
                  status: existing.status as never,
                }),
              );
            }
            const resolvedDecision: DecisionRecord = { ...existing, status: input.decision };
            const resolved: Proposal = toProposalFromDecision(resolvedDecision);

            // --- accepting applies the Change the Proposal carries ---------
            //
            // Acceptance is the ONE place a Proposal mutates the Plan (ADR
            // 0008), and what it mutates it into is what the Proposal SAID —
            // one of two payloads, never a stand-in:
            //
            // - a whole drafted Plan (#75, the Intake cold-start case, ADR
            //   0014 §6: no prior Plan to diff against) — it REPLACES the Plan;
            // - ADR 0015 Plan operations (#86, every review cadence) — folded
            //   over the standing Plan by the same pure applier a user-direct
            //   edit goes through.
            //
            // A Proposal carrying neither proposes no Plan change at all — an
            // Observation-shaped finding — and resolves cleanly, mutating
            // nothing. That is a real, first-class outcome; before #86 this
            // branch applied a fixed +2.5 kg to every prescribed Set in the
            // Plan regardless of what the Proposal actually said.
            if (input.decision === "accepted" && resolved.draftPlan !== undefined) {
              const materialized = materializeDraftPlan(resolved.draftPlan, {
                planId: data.plan.id,
                context: inMemoryAuthoringContext(data.exerciseCatalog),
                newId: randomUUID,
              });
              // An Exercise the draft named but the catalog didn't have yet is
              // the coach authoring a new one (CONTEXT `Exercise catalog`),
              // not a refused Accept — folded into the catalog alongside the
              // Plan it accompanies.
              const nextExerciseCatalog = new Map(data.exerciseCatalog);
              for (const exercise of materialized.newCatalogEntries) {
                nextExerciseCatalog.set(exercise.id, exercise);
              }
              yield* SubscriptionRef.set(dataRef, {
                ...data,
                decisions: new Map(data.decisions).set(input.proposalId, resolvedDecision),
                plan: materialized.plan,
                // Mirror into the map `getPrescribedSession`/`startSession`
                // read, so "Start workout" instantiates the accepted plan —
                // and the seeded demo Session is gone with it (user story 4).
                prescribedSessions: new Map(
                  materialized.plan.sessions.map((session) => [session.id as string, session]),
                ),
                exerciseCatalog: nextExerciseCatalog,
              });
              return { proposal: resolved };
            }

            // The operations the Proposal carries (#86), applied in order
            // through the SAME pure applier `applyUserPlanChange` uses — so a
            // coach Proposal is held to exactly the structural validation a
            // user-direct edit is, and the two `Store` layers cannot disagree
            // about what accepting one means.
            // The Exercises the operations may assume exist (ADR 0016), folded
            // into the context they are VALIDATED against and written only if
            // they validate — the same order the SQLite layer keeps, so the
            // two cannot disagree about what accepting such a Proposal means.
            const proposedExercises =
              input.decision === "accepted" && resolved.planOperations !== undefined
                ? foldProposedExercises(
                    inMemoryAuthoringContext(data.exerciseCatalog),
                    resolved.catalogExercises,
                  )
                : undefined;
            const proposed =
              input.decision === "accepted" && resolved.planOperations !== undefined
                ? applyPlanOperations(
                    data.plan,
                    resolved.planOperations,
                    proposedExercises?.context ?? inMemoryAuthoringContext(data.exerciseCatalog),
                  )
                : undefined;
            if (proposed !== undefined && !proposed.ok) {
              // Nothing has been written, so the Plan is untouched and the
              // Proposal is still `pending` — it can be revised or dismissed
              // rather than silently half-applied. This is the honest outcome
              // when the user has edited the Plan out from under a Proposal
              // drafted against an older shape of it.
              return yield* Effect.fail(
                new PlanOperationRejectedError({
                  operation: proposed.operation,
                  code: proposed.code,
                  reason: `operation ${proposed.index + 1} of ${resolved.planOperations?.length ?? 0}: ${proposed.reason}`,
                }),
              );
            }

            const decisions = new Map(data.decisions).set(input.proposalId, resolvedDecision);
            const nextPlan = proposed?.ok === true ? proposed.plan : data.plan;
            if (proposed?.ok === true) {
              // The applied Change (ADR 0008): origin `coach-proposal`, born
              // `applied`, recording what the accepted Proposal actually did
              // to the Plan. The Proposal row carries the DECISION (`accepted`)
              // and this row carries the EFFECT, exactly as a user-direct edit
              // writes one — so the Plan's history reads the same whoever
              // authored the change.
              const changeId = randomUUID();
              decisions.set(changeId, {
                id: changeId,
                kind: "change",
                origin: "coach-proposal",
                status: "applied",
                summary: proposed.summaries.join("; "),
                rationale: `Applied by accepting Proposal ${input.proposalId} (ADR 0008).`,
                citationsJson: null,
                dataWindowJson: JSON.stringify({ acceptedProposalId: input.proposalId }),
                createdAt: new Date().toISOString(),
                inResponseToId: input.proposalId as string,
                revisionProse: null,
                runId: null,
                intakePlanJson: null,
                planOperationsJson: JSON.stringify(resolved.planOperations),
                // The Change row records what the operations DID to the Plan.
                // Creating a catalog row is not a Plan change and mints no
                // Change (ADR 0016), so it is not part of that account.
                catalogExercisesJson: null,
                measurementsJson: null,
                rule: null,
                uncertainty: null,
              });
            }
            // The catalog rows the accepted operations named (ADR 0016) —
            // folded in only now, so rejecting the Proposal leaves the catalog
            // exactly as it was. Permanent rows must not accumulate behind
            // Proposals nobody accepted.
            const nextCatalog =
              proposed?.ok === true && (proposedExercises?.newCatalogEntries.length ?? 0) > 0
                ? new Map(data.exerciseCatalog)
                : undefined;
            if (nextCatalog !== undefined) {
              for (const exercise of proposedExercises?.newCatalogEntries ?? []) {
                nextCatalog.set(exercise.id, exercise);
              }
            }
            yield* SubscriptionRef.set(dataRef, {
              ...data,
              decisions,
              plan: nextPlan,
              ...(nextCatalog === undefined ? {} : { exerciseCatalog: nextCatalog }),
              // Keep the map `getPrescribedSession`/`startSession` read in step
              // with the Plan, or "Start workout" would instantiate the shape
              // the user just replaced.
              ...(proposed?.ok === true
                ? {
                    prescribedSessions: new Map(
                      nextPlan.sessions.map((session) => [session.id as string, session]),
                    ),
                  }
                : {}),
            });
            return { proposal: resolved };
          }),
        applyUserPlanChange: (input) =>
          Effect.gen(function* () {
            const data = yield* SubscriptionRef.get(dataRef);

            // --- the structural seam (#71) --------------------------------
            if (isPlanEditCommand(input)) {
              const commandId = input.commandId as string | undefined;
              if (commandId !== undefined) {
                const alreadyApplied = data.planEditsByCommandId.get(commandId);
                if (alreadyApplied !== undefined) {
                  // Exactly-once (ADR 0006): a retry over a flaky link must
                  // not duplicate the user's Sets — it replays the Plan the
                  // first application produced.
                  return alreadyApplied;
                }
              }
              const result = applyPlanOperation(
                data.plan,
                input.operation,
                inMemoryAuthoringContext(data.exerciseCatalog),
              );
              if (!result.ok) {
                // A stale client naming something that no longer exists
                // fails cleanly and changes NOTHING — a partially applied
                // structural edit would corrupt the thing the user owns.
                return yield* Effect.fail(
                  new PlanOperationRejectedError({
                    operation: input.operation._tag,
                    code: result.code,
                    reason: result.reason,
                  }),
                );
              }

              const changeId = randomUUID();
              const window: PlanChangeWindow = {
                operation: input.operation._tag,
                ...(commandId === undefined ? {} : { commandId }),
                ...(result.orderingContainer === undefined
                  ? {}
                  : { orderingContainer: result.orderingContainer }),
              };
              const decisions = new Map(data.decisions);
              // A new ordering Change supersedes the previous live one on the
              // same container; undo supersedes the Change it reverses.
              for (const [id, decision] of decisions) {
                const supersededByOrdering =
                  result.orderingContainer !== undefined &&
                  decision.kind === "change" &&
                  decision.status === "applied" &&
                  decision.dataWindowJson !== null &&
                  (JSON.parse(decision.dataWindowJson) as PlanChangeWindow).orderingContainer ===
                    result.orderingContainer;
                const supersededByUndo = id === (input.undoesChangeId as string | undefined);
                if (supersededByOrdering || supersededByUndo) {
                  decisions.set(id, { ...decision, status: "superseded" });
                }
              }
              decisions.set(changeId, {
                id: changeId,
                kind: "change",
                origin: "user-direct",
                status: "applied",
                summary: result.summary,
                rationale: "Direct Plan edit — auto-applied without review (ADR 0008).",
                citationsJson: null,
                dataWindowJson: JSON.stringify(window),
                createdAt: new Date().toISOString(),
                inResponseToId: null,
                revisionProse: null,
                runId: null,
                intakePlanJson: null,
                // A user-direct Change is already applied; the operation it
                // applied is in its `dataWindowJson`, and this column is the
                // COACH's proposed-but-unapplied change (#86).
                planOperationsJson: null,
                catalogExercisesJson: null,
                // A user's own edit has no coach working to show (#79) — the
                // summary IS the whole account of what happened.
                measurementsJson: null,
                rule: null,
                uncertainty: null,
              });

              yield* SubscriptionRef.set(dataRef, {
                ...data,
                plan: result.plan,
                // Mirror into the map `getPrescribedSession`/`startSession`
                // read, so "Start workout" sees the user's own edit. Already
                // instantiated Logged Sessions are deep copies and are
                // untouched (ADR 0006/0007).
                prescribedSessions: new Map(
                  result.plan.sessions.map((session) => [session.id as string, session]),
                ),
                decisions,
                ...(commandId === undefined
                  ? {}
                  : {
                      planEditsByCommandId: new Map(data.planEditsByCommandId).set(
                        commandId,
                        result.plan,
                      ),
                    }),
              });
              return result.plan;
            }

            let found = false;
            const replaceInSession = (session: PrescribedSession): PrescribedSession => ({
              ...session,
              blocks: session.blocks.map((block) => ({
                ...block,
                entries: block.entries.map((entry) => ({
                  ...entry,
                  sets: entry.sets.map((set) => {
                    if (set.id !== input.setId) return set;
                    found = true;
                    return { ...set, target: input.target };
                  }),
                })),
              })),
            });
            const nextPlan: PlanSnapshot = {
              ...data.plan,
              sessions: data.plan.sessions.map(replaceInSession),
            };
            if (!found) {
              return yield* Effect.fail(new PrescribedSetNotFoundError({ setId: input.setId }));
            }
            // Mirror the edit into `prescribedSessions` too (the map
            // `getPrescribedSession`/`startSession` read from) so a
            // subsequent "Start workout" sees the user's own edit — the
            // same dual-write `resolveProposal`'s `accepted` path above only
            // does for `data.plan`, kept here for consistency since a
            // user-direct edit must be visible everywhere the Plan is read.
            const nextPrescribedSessions = new Map(
              Array.from(data.prescribedSessions.entries()).map(
                ([id, session]) => [id, replaceInSession(session)] as const,
              ),
            );
            yield* SubscriptionRef.set(dataRef, {
              ...data,
              plan: nextPlan,
              prescribedSessions: nextPrescribedSessions,
            });
            return nextPlan;
          }),
        commitDeliberationOutput: (input) =>
          SubscriptionRef.modify(dataRef, (data) => {
            const nextDecisions = new Map(data.decisions);
            const nextFeed: Array<CoachingFeedEntry> = [...data.coachingFeed];
            const decisionIds: Array<string> = [];
            const feedEntryIds: Array<string> = [];
            // Present only on a Revision run (ADR 0013): the pushed-back
            // Proposal every row of this run joins the lineage of, and the
            // only id a `supersede` directive may name.
            const reviseTargetId = input.reviseTargetProposalId ?? null;
            const isRevisionRun = reviseTargetId !== null;
            // The Intake marker (ADR 0014 §6) — runner-supplied, never in the
            // agent's output contract. Presence marks this as the ONE Decision
            // an Intake produces, and carries the drafted Plan the Proposal
            // card renders in whole-Plan mode.
            const intakePlanJson =
              input.intakeRun === undefined ? null : JSON.stringify(input.intakeRun.draftPlan);
            const isIntakeRun = intakePlanJson !== null;
            // ADR 0013 §7 — a Revision run is user-invoked and has a SUBJECT,
            // so its emissions are scoped (unlike a review cadence, ADR 0011
            // §4): at most ONE revised Proposal survives, because answering a
            // question must not change the subject.
            let proposalCommitted = false;

            for (const draft of input.runOutput.decisions) {
              // ADR 0014 §2's "one Decision, written once" is the whole reason
              // Intake's store contract stays trivial (no interim rows, no
              // cleanup on abandonment), so the store holds the bar rather than
              // trusting the runner to: at most one Proposal per Intake commit.
              if ((isRevisionRun || isIntakeRun) && draft.kind === "proposal") {
                if (proposalCommitted) continue;
                proposalCommitted = true;
              }
              const id = randomUUID();
              const createdAt = new Date().toISOString();
              const record: DecisionRecord = {
                id,
                kind: draft.kind,
                origin: "coach-proposal",
                // An Answer is born terminal — it proposes no Change, so there
                // is nothing to accept and no accumulation to sit in.
                status:
                  draft.kind === "observation" ? "open" : draft.kind === "answer" ? "answered" : "pending",
                summary: draft.summary,
                rationale: draft.rationale,
                citationsJson: JSON.stringify(draft.citations),
                dataWindowJson: JSON.stringify(input.dataWindow),
                createdAt,
                inResponseToId: reviseTargetId,
                // Stamped on every row this run commits, same posture as
                // `inResponseToId` (ADR 0013 §1/§9) — `undefined` (not just
                // "no reviseTargetProposalId") folds to `null` here.
                revisionProse: input.revisionProse ?? null,
                // Only a Proposal carries the drafted Plan — an Observation the
                // Intake commit happened to include is not the artifact the
                // takeover produced, and stamping it would make it hide from
                // the feed for no reason.
                intakePlanJson: draft.kind === "proposal" ? intakePlanJson : null,
                // The Change the Proposal proposes (#86) — only a Proposal can
                // carry one, because only a Proposal is a Change awaiting a
                // decision. An Observation or an Answer that emitted operations
                // anyway has them dropped here rather than stored where nothing
                // would ever apply them.
                planOperationsJson:
                  draft.kind === "proposal" && draft.plan_operations !== undefined
                    ? JSON.stringify(draft.plan_operations)
                    : null,
                // The catalog rows those operations need (ADR 0016). Scoped to
                // a Proposal WITH operations for the same reason: on anything
                // else there is no Accept that would ever create them, and a
                // row nothing references is how an orphan catalog grows.
                catalogExercisesJson:
                  draft.kind === "proposal" &&
                  draft.plan_operations !== undefined &&
                  draft.catalog_exercises !== undefined &&
                  draft.catalog_exercises.length > 0
                    ? JSON.stringify(draft.catalog_exercises)
                    : null,
                // The working (#79), carried exactly as emitted: an absent
                // field stays absent rather than becoming `[]`/`""`, so the
                // card can tell "no evidence offered" from "no evidence".
                measurementsJson:
                  draft.measurements === undefined ? null : JSON.stringify(draft.measurements),
                rule: draft.rule ?? null,
                uncertainty: draft.uncertainty ?? null,
                // The run this Decision came out of (ADR 0011 §8) —
                // runner-supplied, and absent when the run's own row was never
                // written, which the record handles rather than this commit.
                runId: input.runId ?? null,
              };
              nextDecisions.set(id, record);
              decisionIds.push(id);

              // Every Proposal gets a feed entry; an Observation only when
              // the agent marked it `surface: true` (ADR 0011 §6) — keeps
              // the feed signal-dense while the Decision log stays complete.
              // An Answer never gets one (ADR 0013 §7): it is already on the
              // card the user is looking at, and asking a question must not
              // manufacture an unread feed item. Nor does an Observation a
              // Revision run happened to notice: kept as evidence for future
              // runs, forced unsurfaced (ADR 0013 §7).
              if (
                draft.kind === "proposal" ||
                (draft.kind === "observation" && draft.surface && !isRevisionRun && !isIntakeRun)
              ) {
                const feedId = randomUUID();
                const feedEntry: CoachingFeedEntry = {
                  id: feedId as never,
                  kind: draft.kind,
                  summary: draft.summary,
                  createdAt,
                  // Every entry knows the row it came from (#79) — an
                  // Observation has no Proposal to act on but still expands
                  // into its own working.
                  decisionId: id as never,
                  ...(draft.kind === "proposal" ? { proposalId: id as never } : {}),
                };
                nextFeed.push(feedEntry);
                feedEntryIds.push(feedId);
              }
            }

            // Status-only flips against EXISTING, still-OPEN Observation rows
            // (ADR 0011 §5) — rationale/citations/data_window are never
            // touched. A directive that names an unknown id, a non-Observation
            // row (e.g. a Proposal), OR an already-terminal Observation
            // (`escalated`/`expired`) is a no-op: `observation_directives` are
            // defined to act only on Observations the run read as `open`, and
            // §5 maps each action to exactly one terminal status. A terminal
            // Observation has LEFT the accumulation (the seed provider only
            // injects `status='open'` priors), so re-flipping it — resurrecting
            // a closed one, or contradicting an `escalated` one a Proposal
            // already references — would corrupt the log. The store is the
            // trust boundary over an untrusted agent output, so it enforces
            // the open-only bar rather than relying on the agent to.
            //
            // `supersede` (ADR 0013 §3) is the one action naming a PROPOSAL,
            // and it is scoped twice: the id must be the Proposal this
            // Revision run was invoked against, and that row must still be
            // `pending`. The agent supplies the judgment, the runner supplies
            // the subject — so a slip cannot kill an unrelated pending row or
            // flip an already-`accepted` one.
            for (const directive of input.runOutput.observation_directives) {
              const existing = nextDecisions.get(directive.id);
              if (existing === undefined) continue;

              if (directive.action === "supersede") {
                // Under the Intake marker (ADR 0014 §5) the subject is not an
                // id the runner passes but a property of the row: re-converging
                // after reopening the exchange may supersede the PRIOR INTAKE
                // Proposal and nothing else. Scoping it by the marker rather
                // than by a second id field means there is no way to name a
                // row — so an agent reasoning slip cannot kill an unrelated
                // pending Proposal or flip an already-`accepted` one.
                if (isIntakeRun) {
                  if (!isLiveIntakeArtifact(existing)) continue;
                  nextDecisions.set(directive.id, { ...existing, status: "superseded" });
                  continue;
                }
                if (reviseTargetId === null || directive.id !== reviseTargetId) continue;
                if (existing.kind !== "proposal" || existing.status !== "pending") continue;
                nextDecisions.set(directive.id, { ...existing, status: "superseded" });
                continue;
              }

              // In a Revision run every Observation is off-subject (the
              // subject is a Proposal), so escalate/close are discarded
              // wholesale — escalation belongs to the surveying cadences.
              // Same reasoning for Intake: at cold start there are no prior
              // Observations to escalate or close — the database is empty by
              // definition — so escalate/close under the Intake marker can only
              // be a slip.
              if (isRevisionRun || isIntakeRun) continue;
              if (existing.kind !== "observation" || existing.status !== "open") continue;
              nextDecisions.set(directive.id, {
                ...existing,
                status: directive.action === "escalate" ? "escalated" : "expired",
              });
            }

            const result: CommitDeliberationOutputResult = {
              decisionIds: decisionIds as never,
              feedEntryIds: feedEntryIds as never,
            };
            return [
              result,
              { ...data, decisions: nextDecisions, coachingFeed: nextFeed },
            ];
          }),
        listDecisionsForTest: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) => Array.from(data.decisions.values())),
        ),

        // --- seed-input storage (ADR 0011 §2, issue #34) --------------------

        getGoal: SubscriptionRef.get(dataRef).pipe(Effect.map((data) => data.goal)),
        setGoal: (input) =>
          SubscriptionRef.modify(dataRef, (data) => {
            const goal: GoalSummary = { statement: input.statement, proxies: input.proxies };
            return [goal, { ...data, goal }];
          }),
        listStandingConstraints: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) => Array.from(data.standingConstraints.values())),
        ),
        addStandingConstraint: (input) =>
          SubscriptionRef.modify(dataRef, (data) => {
            const constraint: StandingConstraint = { id: randomUUID(), text: input.text, severity: input.severity };
            return [
              constraint,
              { ...data, standingConstraints: new Map(data.standingConstraints).set(constraint.id, constraint) },
            ];
          }),
        removeStandingConstraint: (input) =>
          SubscriptionRef.modify(dataRef, (data): readonly [{ readonly removed: boolean }, StoreData] => {
            const exists = data.standingConstraints.has(input.constraintId);
            if (!exists) return [{ removed: false }, data];
            const next = new Map(data.standingConstraints);
            next.delete(input.constraintId);
            return [{ removed: true }, { ...data, standingConstraints: next }];
          }),
        listCheckIns: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) =>
            Array.from(data.checkIns.values())
              .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
              .map(toCheckIn),
          ),
        ),
        addCheckIn: (input) =>
          SubscriptionRef.modify(dataRef, (data) => {
            const record: CheckInRecord = {
              id: randomUUID(),
              recordedAt: input.recordedAt ?? new Date().toISOString(),
              sleep: input.sleep,
              soreness: input.soreness,
              stress: input.stress,
              energy: input.energy,
            };
            return [toCheckIn(record), { ...data, checkIns: new Map(data.checkIns).set(record.id, record) }];
          }),
        listContextNotes: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) =>
            Array.from(data.contextNotes.values()).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)),
          ),
        ),
        addContextNote: (input) =>
          SubscriptionRef.modify(dataRef, (data) => {
            // A supplied `commandId` doubles as the note's `id` (migration
            // `018`'s doc) — an existing row under that id makes replay a
            // no-op, mirroring sqlStore's `ON CONFLICT(id) DO NOTHING`.
            const id = input.commandId ?? randomUUID();
            const existing = data.contextNotes.get(id);
            if (existing !== undefined) {
              return [existing, data];
            }
            const note: ContextNote = {
              id,
              recordedAt: input.recordedAt ?? new Date().toISOString(),
              text: input.text,
              ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
              ...(input.loggedSessionId === undefined ? {} : { loggedSessionId: input.loggedSessionId }),
            };
            return [note, { ...data, contextNotes: new Map(data.contextNotes).set(note.id, note) }];
          }),
        editContextNote: (input) =>
          SubscriptionRef.modify(dataRef, (data) => {
            const existing = data.contextNotes.get(input.noteId);
            if (existing === undefined) return [undefined, data];
            // `recordedAt` is deliberately untouched: the note still belongs
            // where it was recorded in the Session's timeline — an edit
            // sharpens an observation, it does not re-date it.
            const note: ContextNote = { ...existing, text: input.text };
            return [note, { ...data, contextNotes: new Map(data.contextNotes).set(note.id, note) }];
          }),
        listEvidenceRoster: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) => data.evidenceRoster.map(({ id: _id, ...claim }) => claim)),
        ),
        getPointerDigestHistory: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) =>
            deriveDigestHistory(
              Array.from(data.decisions.values()).map((d) => ({
                createdAt: d.createdAt,
                dataWindowJson: d.dataWindowJson,
              })),
              Array.from(data.loggedSessions.values()).map((s) => s.startedAt),
            ),
          ),
        ),

        getCadenceModel: (cadence) =>
          SubscriptionRef.get(dataRef).pipe(
            Effect.map((data) => {
              const entry = data.cadenceModels.get(cadence);
              return { model: entry?.model, effort: entry?.effort };
            }),
          ),
        setCadenceModel: (input) =>
          SubscriptionRef.modify(dataRef, (data) => {
            const setting: CadenceModelSetting = {
              cadence: input.cadence,
              model: input.model,
              ...(input.effort === undefined ? {} : { effort: input.effort }),
            };
            return [
              setting,
              {
                ...data,
                cadenceModels: new Map(data.cadenceModels).set(input.cadence, {
                  model: input.model,
                  effort: input.effort,
                }),
              },
            ];
          }),

        // --- the run ledger (ADR 0011 §8 amendment, issue #81) -------------

        recordRunLedgerRow: (row) =>
          SubscriptionRef.update(dataRef, (data) => ({
            ...data,
            runLedger: [
              ...data.runLedger,
              {
                id: randomUUID(),
                runId: row.runId,
                cadence: row.cadence,
                stage: row.stage,
                model: row.model,
                usage: row.usage,
                costUsd: row.costUsd,
                ranAt: new Date().toISOString(),
              },
            ],
          })),

        getSpendSummary: SubscriptionRef.get(dataRef).pipe(Effect.map((data) => summarizeRunLedger(data.runLedger))),

        // --- the run record (ADR 0011 §8, the Coach run history) -----------

        startDeliberationRun: (input) =>
          SubscriptionRef.update(dataRef, (data) =>
            data.deliberationRuns.has(input.runId)
              ? data
              : {
                  ...data,
                  deliberationRuns: new Map(data.deliberationRuns).set(input.runId, {
                    runId: input.runId,
                    cadence: input.cadence,
                    status: "running",
                    failureReason: undefined,
                    dataWindowJson: undefined,
                    startedAt: input.startedAt,
                    finishedAt: undefined,
                  }),
                },
          ),

        finishDeliberationRun: (input) =>
          SubscriptionRef.update(dataRef, (data) => {
            const existing = data.deliberationRuns.get(input.runId);
            // A run whose opening write never landed is not resurrected here —
            // see `Store.finishDeliberationRun`'s note. Same rule in both
            // layers, so a test on this one is a test of the real thing.
            if (existing === undefined) return data;
            return {
              ...data,
              deliberationRuns: new Map(data.deliberationRuns).set(input.runId, {
                ...existing,
                status: input.outcome,
                failureReason: input.failureReason,
                dataWindowJson:
                  input.dataWindow === undefined ? undefined : JSON.stringify(input.dataWindow),
                finishedAt: input.finishedAt,
              }),
            };
          }),

        discardDeliberationRun: (runId) =>
          SubscriptionRef.update(dataRef, (data) => {
            if (!data.deliberationRuns.has(runId)) return data;
            const next = new Map(data.deliberationRuns);
            next.delete(runId);
            return { ...data, deliberationRuns: next };
          }),

        failRunsInterruptedByRestart: SubscriptionRef.modify(dataRef, (data) => {
          const stranded = Array.from(data.deliberationRuns.values()).filter(
            (run) => run.status === "running",
          );
          if (stranded.length === 0) return [{ failed: 0 }, data];
          const finishedAt = new Date().toISOString();
          const next = new Map(data.deliberationRuns);
          for (const run of stranded) {
            next.set(run.runId, {
              ...run,
              status: "failed",
              failureReason: "the home server restarted while this run was in flight",
              finishedAt,
            });
          }
          return [{ failed: stranded.length }, { ...data, deliberationRuns: next }];
        }),

        getDeliberationRuns: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) => assembleInMemoryRuns(data)),
        ),

        subscribeDeliberationRuns: SubscriptionRef.changes(dataRef).pipe(
          Stream.map((data) => assembleInMemoryRuns(data)),
          Stream.flattenIterable,
        ),

        // --- the RPE capture control (#63, issue #81) -----------------------

        getRpeCaptureMode: SubscriptionRef.get(dataRef).pipe(Effect.map((data) => data.rpeCaptureMode)),
        setRpeCaptureMode: (mode) =>
          SubscriptionRef.modify(dataRef, (data) => [mode, { ...data, rpeCaptureMode: mode }]),

        // The in-memory twin of migration `011`'s conditional UPDATE (#91).
        // `SubscriptionRef.modify` is the atomic read-decide-write this needs:
        // two concurrent claims cannot both observe the same due window.
        claimDueCycleReview: (params) =>
          SubscriptionRef.modify(dataRef, (data) => {
            const previous = data.cycleReviewLastRunAt;
            // Fresh store: start the clock, claim nothing.
            if (previous === undefined) {
              const claim: CycleReviewClaim = { claimed: false, lastRunAt: params.now };
              return [claim, { ...data, cycleReviewLastRunAt: params.now }];
            }
            const due =
              Date.parse(params.now) - Date.parse(previous) >= params.intervalMillis;
            if (!due) return [{ claimed: false, lastRunAt: previous }, data];
            const claim: CycleReviewClaim = { claimed: true, lastRunAt: params.now };
            return [claim, { ...data, cycleReviewLastRunAt: params.now }];
          }),

        // #82: this also appends a **coaching-feed entry**, which it did not
        // when #22 added it — at the time the feed was one stream and Coach was
        // a fixture. Now that Coach is the permanent record, a lever that
        // injects a Proposal onto Today but not onto the record means two
        // different things on two surfaces, and a flow asserting the record
        // updates live would be asserting against a lever that never wrote to
        // it. Every real Proposal gets a feed entry (`commitDeliberationOutput`
        // writes both in one pass), so the lever now obeys the rule it exists
        // to demonstrate.
        pushProposalForTest: (proposal) =>
          SubscriptionRef.update(dataRef, (data) => ({
            ...data,
            deliberationRuns: new Map(data.deliberationRuns).set(
              testProposalRun(proposal).runId,
              testProposalRun(proposal),
            ),
            coachingFeed: [
              ...data.coachingFeed,
              {
                id: `feed-${proposal.id}` as never,
                kind: "proposal" as const,
                summary: proposal.summary,
                createdAt: proposal.createdAt,
                // A Proposal's Decision row IS the Proposal (`decisions` is
                // keyed by it above), so the two ids are the same string
                // wearing two brands — exactly as `seedCoachingFeed` writes it.
                decisionId: proposal.id as never,
                proposalId: proposal.id,
              },
            ],
            decisions: new Map(data.decisions).set(proposal.id, {
              id: proposal.id,
              kind: "proposal",
              origin: proposal.origin,
              status: proposal.status,
              summary: proposal.summary,
              rationale: proposal.rationale,
              citationsJson: null,
              dataWindowJson: null,
              inResponseToId: null,
              revisionProse: null,
              runId: testProposalRun(proposal).runId,
              createdAt: proposal.createdAt,
              intakePlanJson: proposal.draftPlan === undefined ? null : JSON.stringify(proposal.draftPlan),
              planOperationsJson:
                proposal.planOperations === undefined ? null : JSON.stringify(proposal.planOperations),
              catalogExercisesJson:
                proposal.catalogExercises === undefined
                  ? null
                  : JSON.stringify(proposal.catalogExercises),
              measurementsJson: null,
              rule: null,
              uncertainty: null,
            }),
          })),
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
          yield* SubscriptionRef.set(dataRef, seedData());
          yield* Ref.set(inFlightRef, new Map());
        }),
        appliedCount: SubscriptionRef.get(dataRef).pipe(Effect.map((data) => data.actualsByCommandId.size)),
        listActuals: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) => Array.from(data.actualsByCommandId.values())),
        ),
        listEntrySwaps: SubscriptionRef.get(dataRef).pipe(
          Effect.map((data) => Array.from(data.entrySwapsByCommandId.values())),
        ),
      });
    }),
  );
}
