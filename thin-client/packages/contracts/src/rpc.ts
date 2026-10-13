import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  AddCheckInInput,
  AddCheckInResult,
  AddContextNoteInput,
  AddContextNoteResult,
  EditContextNoteInput,
  EditContextNoteResult,
  AddStandingConstraintInput,
  AddStandingConstraintResult,
  RemoveStandingConstraintInput,
  RemoveStandingConstraintResult,
  SetGoalInput,
  SetGoalResult,
} from "./coachingInputs.ts";
import { ServerConfig, ServerConfigUnavailableError } from "./config.ts";
import { ExportDataResult } from "./dataExport.ts";
import { GetExerciseProgressResult } from "./progress.ts";
import { BodyweightEntry, ListBodyweightResult, LogBodyweightInput, RemoveBodyweightInput } from "./bodyweight.ts";
import { ImportWorkoutsInput, ImportWorkoutsResult } from "./workoutImport.ts";
import { GetDailySetCountsInput, GetDailySetCountsResult } from "./stats.ts";
import {
  CommitDeliberationOutputResult,
  ConvergeIntakeInput,
  ConvergeIntakeResult,
  DeliberationRunRecord,
  GetCadenceModelInput,
  GetCadenceModelResult,
  ListModelsResult,
  GetRpeCaptureModeResult,
  GetSpendSummaryResult,
  IntakeQuotaExhaustedError,
  IntakeSessionNotFoundError,
  IntakeSweepRejectedError,
  IntakeToolEvent,
  IntakeTurnFailedError,
  IntakeTurnInput,
  IntakeTurnResult,
  RunState,
  SetCadenceModelInput,
  SetCadenceModelResult,
  SetRpeCaptureModeInput,
  SetRpeCaptureModeResult,
  StartIntakeInput,
  StartIntakeResult,
  SubscribeIntakeEventsInput,
} from "./deliberation.ts";
import {
  CancelRevisionInput,
  CancelRevisionResult,
  CoachingFeedEntry,
  DecisionNotFoundError,
  DecisionWorking,
  FeedUnavailableError,
  GetDecisionWorkingInput,
  PlanSnapshot,
  Proposal,
  ProposalAlreadyResolvedError,
  ProposalExchange,
  ProposalNotFoundError,
  ResolveProposalInput,
  ResolveProposalResult,
  ReviseProposalInput,
  ReviseProposalResult,
  RevisionAlreadyInFlightError,
} from "./feed.ts";
import {
  CancelSessionInput,
  CancelSessionResult,
  FinishWorkoutInput,
  FinishWorkoutResult,
  GetLoggedSessionInput,
  GetNextUpResult,
  ListActiveSessionsResult,
  ListSessionsInput,
  ListSessionsResult,
  LoggedSession,
  LoggedSessionHasActualsError,
  LoggedSessionNotFoundError,
  StartSessionInput,
  StartSessionResult,
} from "./loggedSession.ts";
import {
  EntryAlreadyLoggedError,
  LastActualForExerciseInput,
  LastActualForExerciseResult,
  LogSetActualInput,
  LogSetActualRejectedError,
  LogSetActualResult,
  SwapEntryExerciseInput,
  SwapEntryExerciseResult,
  UnlogSetActualInput,
  UnlogSetActualResult,
} from "./logging.ts";
import {
  ApplyUserChangeInput,
  PlanOperationRejectedError,
  PrescribedSetNotFoundError,
} from "./planEdit.ts";
import {
  CatalogExercise,
  CreateExerciseInput,
  ExerciseCatalog,
  ExerciseNotFoundError,
  GetPrescribedSessionInput,
  PrescribedSession,
  PrescribedSessionNotFoundError,
  RenameExerciseInput,
} from "./scaffold.ts";

/**
 * The single RPC surface both the client (Task 3) and the dev-server
 * (Task 2) import — style of t3code `packages/contracts/src/rpc.ts`.
 */
export const RPC_METHODS = {
  serverGetConfig: "server.getConfig",
  getPrescribedSession: "session.getPrescribed",
  startSession: "session.start",
  logSetActual: "logging.logSetActual",
  unlogSetActual: "logging.unlogSetActual",
  swapEntryExercise: "logging.swapEntryExercise",
  getLoggedSession: "logging.getLoggedSession",
  finishWorkout: "logging.finishWorkout",
  cancelSession: "logging.cancelSession",
  lastActualForExercise: "logging.lastActualForExercise",
  listSessions: "logging.listSessions",
  listActiveSessions: "logging.listActiveSessions",
  getNextUp: "logging.getNextUp",
  getDailySetCounts: "stats.getDailySetCounts",
  exportData: "data.export",
  getExerciseProgress: "stats.getExerciseProgress",
  logBodyweight: "bodyweight.log",
  removeBodyweight: "bodyweight.remove",
  listBodyweight: "bodyweight.list",
  importWorkouts: "data.importWorkouts",
  subscribeCoachingFeed: "subscribeCoachingFeed",
  subscribeProposals: "subscribeProposals",
  subscribePlan: "subscribePlan",
  resolveProposal: "proposals.resolve",
  reviseProposal: "proposals.revise",
  cancelRevision: "proposals.cancelRevision",
  subscribeProposalExchanges: "proposals.subscribeExchanges",
  applyUserPlanChange: "plan.applyUserChange",
  runDeliberationNow: "deliberation.runNow",
  runCycleReview: "deliberation.runCycleReview",
  setCadenceModel: "settings.setCadenceModel",
  getCadenceModel: "settings.getCadenceModel",
  listModels: "settings.listModels",
  getSpendSummary: "settings.getSpendSummary",
  setRpeCaptureMode: "settings.setRpeCaptureMode",
  getRpeCaptureMode: "settings.getRpeCaptureMode",
  setGoal: "goal.set",
  addStandingConstraint: "standingConstraints.add",
  removeStandingConstraint: "standingConstraints.remove",
  addCheckIn: "checkIns.add",
  addContextNote: "contextNotes.add",
  editContextNote: "contextNotes.edit",
  subscribeDeliberationState: "deliberation.subscribeState",
  subscribeDeliberationRuns: "deliberation.subscribeRuns",
  startIntake: "intake.start",
  intakeTurn: "intake.turn",
  convergeIntake: "intake.converge",
  subscribeIntakeEvents: "intake.events",
  getPlan: "plan.get",
  getExerciseCatalog: "catalog.getExercises",
  createExercise: "catalog.createExercise",
  renameExercise: "catalog.renameExercise",
  getDecisionWorking: "decisions.get",
} as const;

/** Used by the connection supervisor's resume health-probe. */
export const ServerGetConfigRpc = Rpc.make(RPC_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: ServerConfigUnavailableError,
});

/** Prescribed side only (ADR 0001) — the reusable Plan blueprint. */
export const GetPrescribedSessionRpc = Rpc.make(RPC_METHODS.getPrescribedSession, {
  payload: GetPrescribedSessionInput,
  success: PrescribedSession,
  error: PrescribedSessionNotFoundError,
});

/**
 * Real Logged Session instantiation (Step 2A, task 2A.2): deep-copies the
 * current Prescribed Session into a Logged Session (copy-on-instantiate,
 * ADR 0006/0007). The natural client call site is "Start workout" while
 * connected — the same moment `getPrescribedSession` is prefetched.
 */
export const StartSessionRpc = Rpc.make(RPC_METHODS.startSession, {
  payload: StartSessionInput,
  success: StartSessionResult,
  error: PrescribedSessionNotFoundError,
});

/** Idempotent by `commandId` (ADR 0006) — actual-capture only, never a Change. */
export const LogSetActualRpc = Rpc.make(RPC_METHODS.logSetActual, {
  payload: LogSetActualInput,
  success: LogSetActualResult,
  error: LogSetActualRejectedError,
});

/**
 * A retraction (ADR 0019, issue #83) — tapping a logged Set's confirm again
 * un-logs it. Idempotent by `commandId`, exactly like `logSetActual`; no
 * lookup validation against the prescribed tree, and no rejectable-error arm
 * — a retraction carries no FK to fail (migration `020`'s note).
 */
export const UnlogSetActualRpc = Rpc.make(RPC_METHODS.unlogSetActual, {
  payload: UnlogSetActualInput,
  success: UnlogSetActualResult,
});

/**
 * Idempotent by `commandId` (ADR 0006), same discipline as `logSetActual` —
 * a pure actual-side annotation (ADR 0019) that never touches the Plan or
 * the Logged Session's frozen prescribed copy. `EntryAlreadyLoggedError` is
 * the server-side half of the "offered only before any Set is logged" rule
 * (`Logging.canSwapEntry` is the client-side half).
 */
export const SwapEntryExerciseRpc = Rpc.make(RPC_METHODS.swapEntryExercise, {
  payload: SwapEntryExerciseInput,
  success: SwapEntryExerciseResult,
  error: EntryAlreadyLoggedError,
});

/**
 * Prod-safe black-box read lever for a Logged Session (Step 2A, task 2A.2)
 * — makes durability testable (log -> restart -> read back) without a
 * `/__test__/*` endpoint.
 */
export const GetLoggedSessionRpc = Rpc.make(RPC_METHODS.getLoggedSession, {
  payload: GetLoggedSessionInput,
  success: LoggedSession,
  error: LoggedSessionNotFoundError,
});

/**
 * "Finish Workout" (ADR 0011 §4, 2B slice 4 — issue #29): the explicit
 * workout-done event (distinct from mid-workout `logSetActual` set-syncs,
 * which never trigger a review). Finalizes `logged_session.status` to
 * `finished` AND synchronously runs + commits a Session-review Deliberation
 * run over that session's fresh data (recent-focus prompt framing +
 * restraint, ADR 0011 §4 — no structural emission-authority difference from
 * `runNow`). No deferral queue yet (2B slice 7).
 */
export const FinishWorkoutRpc = Rpc.make(RPC_METHODS.finishWorkout, {
  payload: FinishWorkoutInput,
  success: FinishWorkoutResult,
  error: LoggedSessionNotFoundError,
});

/**
 * "Cancel session" (issue #114 Part 1) — unmakes an accidentally-started
 * session while it still has zero confirmed sets. Idempotent (`cancelled:
 * false`, never a failure) for the already-resolved cases; fails loudly
 * with `LoggedSessionHasActualsError` for the one case that would otherwise
 * look like silent data loss — an `active` session that already has a
 * logged actual.
 */
export const CancelSessionRpc = Rpc.make(RPC_METHODS.cancelSession, {
  payload: CancelSessionInput,
  success: CancelSessionResult,
  error: Schema.Union([LoggedSessionNotFoundError, LoggedSessionHasActualsError]),
});

/**
 * "History" (issue #114 Part 2) — a reverse-chronological, `before`-paged
 * list of finished sessions off `Today.tsx`. No error channel: an unknown
 * `before` cursor is simply an empty page, not a failure.
 */
export const ListSessionsRpc = Rpc.make(RPC_METHODS.listSessions, {
  payload: ListSessionsInput,
  success: ListSessionsResult,
});

/**
 * "Which Logged Sessions are still in flight" (issue #147) — the server-side
 * source of truth for Resume-vs-picker on Today, which until now was a
 * device-local `localStorage` pointer and nothing else. The client reconciles
 * that pointer against this list once connected: adopt an `active` session the
 * pointer lost, clear a pointer the server no longer calls `active`. No error
 * channel, same as `ListSessionsRpc` — an empty list is a valid answer.
 */
export const ListActiveSessionsRpc = Rpc.make(RPC_METHODS.listActiveSessions, {
  payload: Schema.Struct({}),
  success: ListActiveSessionsResult,
});

/**
 * "Next up" (ADR 0023) — the session Today's hero suggests: the one after the
 * session the most recently finished workout came from, wrapping at the end
 * of the Plan's order. No error channel, same as `ListActiveSessionsRpc`.
 */
export const GetNextUpRpc = Rpc.make(RPC_METHODS.getNextUp, {
  payload: Schema.Struct({}),
  success: GetNextUpResult,
});

/**
 * "Stats" (issue #117) — the daily set-count aggregation behind the
 * consistency heatmap. No error channel, same as `ListSessionsRpc`: there is
 * no failure case, only an empty or partial `days` array.
 */
export const GetDailySetCountsRpc = Rpc.make(RPC_METHODS.getDailySetCounts, {
  payload: GetDailySetCountsInput,
  success: GetDailySetCountsResult,
});

/**
 * "Export my data" — every table on the home server as one JSON document
 * (`dataExport.ts`). No error channel: an empty database is a valid export.
 */
export const ExportDataRpc = Rpc.make(RPC_METHODS.exportData, {
  payload: Schema.Struct({}),
  success: ExportDataResult,
});

/**
 * The Progress surface: every performed Exercise's history of finished
 * sessions, for the e1RM / volume charts and the PR list (`progress.ts`).
 * No error channel: never having trained is an empty list.
 */
export const GetExerciseProgressRpc = Rpc.make(RPC_METHODS.getExerciseProgress, {
  payload: Schema.Struct({}),
  success: GetExerciseProgressResult,
});

/**
 * Bodyweight (`bodyweight.ts`): one reading per local day, an upsert —
 * logging a day twice keeps the second. A direct, connected write rather
 * than an outbox command: weighing in happens at home, where the home server
 * is, and the Progress surface that hosts it is online-only already.
 */
export const LogBodyweightRpc = Rpc.make(RPC_METHODS.logBodyweight, {
  payload: LogBodyweightInput,
  success: BodyweightEntry,
});

/** Removes a day's reading. Idempotent: removing a day with none is not an error. */
export const RemoveBodyweightRpc = Rpc.make(RPC_METHODS.removeBodyweight, {
  payload: RemoveBodyweightInput,
  success: Schema.Struct({}),
});

/** Every reading, oldest first. */
export const ListBodyweightRpc = Rpc.make(RPC_METHODS.listBodyweight, {
  payload: Schema.Struct({}),
  success: ListBodyweightResult,
});

/**
 * Writes imported workout history (`workoutImport.ts`) as finished, reviewed
 * Logged Sessions. Idempotent per workout on `importKey`. A direct, connected
 * write like `data.export`: an import is a one-off done at home, not a gym-floor
 * write the outbox exists for.
 */
export const ImportWorkoutsRpc = Rpc.make(RPC_METHODS.importWorkouts, {
  payload: ImportWorkoutsInput,
  success: ImportWorkoutsResult,
});

/**
 * The tier-2 one-tap ✓ seed source (issue #149) — "what did I last lift on
 * this Exercise". No error channel, same as `ListSessionsRpc`: a
 * never-performed Exercise is an empty `perMetric`, not a failure.
 */
export const LastActualForExerciseRpc = Rpc.make(RPC_METHODS.lastActualForExercise, {
  payload: LastActualForExerciseInput,
  success: LastActualForExerciseResult,
});

/** Re-attaches and replays current feed state on reconnect. */
export const SubscribeCoachingFeedRpc = Rpc.make(RPC_METHODS.subscribeCoachingFeed, {
  payload: Schema.Struct({}),
  success: CoachingFeedEntry,
  error: FeedUnavailableError,
  stream: true,
});

/** Re-attaches and replays current Proposals on reconnect. */
export const SubscribeProposalsRpc = Rpc.make(RPC_METHODS.subscribeProposals, {
  payload: Schema.Struct({}),
  success: Proposal,
  error: FeedUnavailableError,
  stream: true,
});

/** Re-attaches and replays the current Plan snapshot on reconnect. */
export const SubscribePlanRpc = Rpc.make(RPC_METHODS.subscribePlan, {
  payload: Schema.Struct({}),
  success: PlanSnapshot,
  error: FeedUnavailableError,
  stream: true,
});

/**
 * Resolves a pending Proposal (ADR 0008): `accepted` mutates the Plan
 * server-side; `rejected` retains the Proposal as context with no Plan
 * mutation. Not a subscription — a one-shot unary request/response like
 * `logSetActual`.
 *
 * `PlanOperationRejectedError` is the SAME error a user-direct edit fails with
 * (`plan.applyUserChange` below), and that is the point of issue #86: a coach
 * Proposal carries ADR 0015 operations and is validated by the one shared
 * applier, so a Proposal drafted against a Plan the user has since edited fails
 * exactly as a stale tap does — nothing half-applied, the Proposal left
 * `pending` so it can be revised or dismissed rather than silently lost.
 */
export const ResolveProposalRpc = Rpc.make(RPC_METHODS.resolveProposal, {
  payload: ResolveProposalInput,
  success: ResolveProposalResult,
  error: Schema.Union([
    ProposalNotFoundError,
    ProposalAlreadyResolvedError,
    PlanOperationRejectedError,
  ]),
});

/**
 * "Revise" (ADR 0013 §1): submits the user's free-text pushback on a pending
 * Proposal and enqueues a Revision run — the Session-review runner under a
 * third prompt framing (ADR 0013 §6), not a fourth config. Success only
 * confirms the run was accepted; the card's spinner and eventual outcome
 * (Answer / revised Proposal / both) arrive over
 * `subscribeProposalExchanges`, not this response, because the run is
 * minutes not seconds (ADR 0011 §8).
 *
 * `RevisionAlreadyInFlightError` enforces ADR 0013 §4/§5's "one run in flight
 * per Proposal" — the card locks on submit, so a second Revise before the
 * first lands is refused rather than queueing a second run against the same
 * subject.
 */
export const ReviseProposalRpc = Rpc.make(RPC_METHODS.reviseProposal, {
  payload: ReviseProposalInput,
  success: ReviseProposalResult,
  error: Schema.Union([
    ProposalNotFoundError,
    ProposalAlreadyResolvedError,
    RevisionAlreadyInFlightError,
  ]),
});

/**
 * Cancel (ADR 0013 §5) — the single escape from a locked Proposal card:
 * dropped from the queue if still `queued`, or its result abandoned (nothing
 * committed) if already `running`. Either way no rows are written. Idempotent
 * by design: cancelling a Proposal with nothing in flight returns
 * `cancelled: false` rather than failing, since a double-tap or a race with
 * the run landing naturally must not surface as an error.
 */
export const CancelRevisionRpc = Rpc.make(RPC_METHODS.cancelRevision, {
  payload: CancelRevisionInput,
  success: CancelRevisionResult,
  error: ProposalNotFoundError,
});

/**
 * The Proposal-exchange stream (ADR 0013 §9): one `ProposalExchange` per live
 * chain head, replayed on attach like `subscribeProposals`. Issue #66 left
 * open whether the locked/queued/running state should ride this stream or get
 * its own subscription — this is the resolution: it rides here, because the
 * card needs the lineage rows (the user's prose, the coach's Answers, the
 * collapsed prior versions) over this same channel regardless, and a second
 * subscription for just the in-flight flag could race it.
 */
export const SubscribeProposalExchangesRpc = Rpc.make(RPC_METHODS.subscribeProposalExchanges, {
  payload: Schema.Struct({}),
  success: ProposalExchange,
  error: FeedUnavailableError,
  stream: true,
});

/**
 * User-direct Plan edit (CONTEXT `Change`): a prod-safe RPC (not a
 * `/__test__` lever), auto-applied — born `applied` per ADR 0008 — with no
 * approval step. The **whole Plan-authoring surface** is this one method
 * (#71): its payload is either the original narrow Set-target edit or a
 * `PlanEditCommand` carrying one of the structural operations, so there is a
 * single seam to validate and a single Change per accepted call. Success
 * echoes back the updated `PlanSnapshot` so a caller can render the result
 * immediately without waiting on `subscribePlan`'s next emission.
 */
export const ApplyUserChangeRpc = Rpc.make(RPC_METHODS.applyUserPlanChange, {
  payload: ApplyUserChangeInput,
  success: PlanSnapshot,
  error: Schema.Union([PrescribedSetNotFoundError, PlanOperationRejectedError]),
});

/**
 * "Run now" (ADR 0002/0011 §4 — on-demand is always available): invokes the
 * `DeliberationRunner` with its injected `DeliberationAgent` (canned for
 * this walking-skeleton slice, issue #26) and commits the output via
 * `Store.commitDeliberationOutput`. Success echoes the runner-assigned ids
 * so a caller can correlate without waiting on `subscribeCoachingFeed`/
 * `subscribeProposals`'s next emission — those subscriptions are still the
 * durable way the result reaches the phone's Coaching feed.
 */
export const RunDeliberationNowRpc = Rpc.make(RPC_METHODS.runDeliberationNow, {
  payload: Schema.Struct({}),
  success: CommitDeliberationOutputResult,
});

/**
 * The Cycle-review trigger seam (ADR 0011 §4, 2B slice 6 — issue #31): the
 * monthly schedule fires this to enqueue + run a Cycle review (long-history
 * prompt framing + the cadence's configured model, same runner mechanism as
 * `deliberation.runNow`/Session review). Not wired to a real wall-clock cron
 * here — a scheduler process (or a test) invokes it; it doubles as the
 * on-demand "run a Cycle review now" lever (ADR 0002/0011 §4: on-demand is
 * always available for EITHER cadence).
 */
export const RunCycleReviewRpc = Rpc.make(RPC_METHODS.runCycleReview, {
  payload: Schema.Struct({}),
  success: CommitDeliberationOutputResult,
});

/**
 * Per-cadence model settings (ADR 0011 §4, 2B slice 6 — issue #31): persist a
 * model choice per cadence so the frequent Session review and the rare Cycle
 * review can run on different models. The runner reads the persisted value
 * (`Store.getCadenceModel`) and passes it to that cadence's deliberator.
 */
export const SetCadenceModelRpc = Rpc.make(RPC_METHODS.setCadenceModel, {
  payload: SetCadenceModelInput,
  success: SetCadenceModelResult,
});

export const GetCadenceModelRpc = Rpc.make(RPC_METHODS.getCadenceModel, {
  payload: GetCadenceModelInput,
  success: GetCadenceModelResult,
});

/**
 * The selectable model catalog, read live from the Agent SDK (issue #81
 * follow-up). Server-side because the SDK — and the account it is signed in
 * as — lives on the home server; the phone has no way to ask, and a list
 * hard-coded in the client would go stale and would offer models this
 * installation may not be entitled to run.
 *
 * Never fails: a catalog that could not be read comes back empty with an
 * `unavailableReason`, so the Settings surface degrades to its free-text
 * model field rather than erroring out.
 */
export const ListModelsRpc = Rpc.make(RPC_METHODS.listModels, {
  payload: Schema.Struct({}),
  success: ListModelsResult,
});

/**
 * The run ledger's read, grouped server-side (issue #81, ADR 0011 §8
 * amendment): a per-cadence breakdown plus a short recent-runs list — one RPC
 * because the grouping is the part worth testing at the runtime level, per
 * the issue's Testing Decisions, and a client has no business re-deriving it
 * from raw rows.
 */
export const GetSpendSummaryRpc = Rpc.make(RPC_METHODS.getSpendSummary, {
  payload: Schema.Struct({}),
  success: GetSpendSummaryResult,
});

/** The RPE capture control (#63, issue #81) — three states, stored server-side because it changes what the Plan prescribes. */
export const SetRpeCaptureModeRpc = Rpc.make(RPC_METHODS.setRpeCaptureMode, {
  payload: SetRpeCaptureModeInput,
  success: SetRpeCaptureModeResult,
});

export const GetRpeCaptureModeRpc = Rpc.make(RPC_METHODS.getRpeCaptureMode, {
  payload: Schema.Struct({}),
  success: GetRpeCaptureModeResult,
});

/**
 * User-authored seed-input write endpoints (ADR 0011 §2, issue #34 — 2B
 * "seed-input storage"): the real write path for Goal / Standing constraint
 * / Check-in / Context note, mirroring `ApplyUserChangeRpc`'s shape (one-shot
 * unary request/response, no subscription). Evidence claims are
 * server-seeded (ADR 0003), not user-authored, so there is no
 * `evidenceClaims.add` RPC.
 */
export const SetGoalRpc = Rpc.make(RPC_METHODS.setGoal, {
  payload: SetGoalInput,
  success: SetGoalResult,
});

export const AddStandingConstraintRpc = Rpc.make(RPC_METHODS.addStandingConstraint, {
  payload: AddStandingConstraintInput,
  success: AddStandingConstraintResult,
});

export const RemoveStandingConstraintRpc = Rpc.make(RPC_METHODS.removeStandingConstraint, {
  payload: RemoveStandingConstraintInput,
  success: RemoveStandingConstraintResult,
});

export const AddCheckInRpc = Rpc.make(RPC_METHODS.addCheckIn, {
  payload: AddCheckInInput,
  success: AddCheckInResult,
});

export const AddContextNoteRpc = Rpc.make(RPC_METHODS.addContextNote, {
  payload: AddContextNoteInput,
  success: AddContextNoteResult,
});

/**
 * Rewrites an existing note's text in place — the Entry sheet's note item
 * once the Entry already has a note. No error arm: the command carries the
 * whole text by value (idempotent under replay) and an unknown `noteId` is a
 * no-op success, so there is nothing here for the outbox to be told to give
 * up on. See `EditContextNoteInput`.
 */
export const EditContextNoteRpc = Rpc.make(RPC_METHODS.editContextNote, {
  payload: EditContextNoteInput,
  success: EditContextNoteResult,
});

/**
 * Run-visibility subscription (ADR 0011 §8, 2B slice 7 — issue #32): emits
 * the current Deliberation run state — running / queued / idle — and the
 * run's token usage. Surfaces the deferral queue honestly.
 */
export const SubscribeDeliberationStateRpc = Rpc.make(RPC_METHODS.subscribeDeliberationState, {
  payload: Schema.Struct({}),
  success: RunState,
  stream: true,
});

/**
 * The Coach record's run history (ADR 0011 §8): every Deliberation run the
 * store has a row for, newest first, each with the Decisions it emitted.
 *
 * A subscription rather than a one-shot read, and that is the point rather
 * than a convenience: a run in flight is the newest entry in this same list,
 * so watching the coach work and reading what it did afterwards are one
 * surface instead of two that have to be reconciled. `RunState`
 * (`deliberation.subscribeState`) stays as it is — it answers "is the runner
 * busy right now", which is a strip-level question, not a record.
 *
 * Emits one run per element, exactly like `subscribeCoachingFeed`, so a client
 * accumulates by `runId` and a re-emission of a run whose outcome moved
 * (`running` → `committed`) replaces the entry already on screen.
 */
export const SubscribeDeliberationRunsRpc = Rpc.make(RPC_METHODS.subscribeDeliberationRuns, {
  payload: Schema.Struct({}),
  success: DeliberationRunRecord,
  error: FeedUnavailableError,
  stream: true,
});

// --- Intake RPCs (ADR 0011 §7 as amended by ADR 0014, issue #70) -------------
//
// Four methods, and **Accept is not one of them**. Once `intake.converge` has
// committed the Proposal, the user accepts it through the ordinary
// `proposals.resolve` path (ADR 0008) — which is what makes ADR 0014 §6's "it is
// genuinely the same Proposal card" true at the contract level rather than only
// visually. A fifth `intake.accept` would be a parallel acceptance mechanism for
// the one Proposal that most needs to teach the user how the real one works.

/**
 * Start the takeover: opens the held-open deliberator session on the four-field
 * form and returns the cold draft — the longest wait in the app, narrated by
 * `intake.events`.
 *
 * Quota exhaustion fails HERE rather than queueing (ADR 0014 §4): Intake is the
 * only user-blocking run in the app, and a queue position is not actionable for
 * a cold start that discards its draft on the way out.
 */
export const StartIntakeRpc = Rpc.make(RPC_METHODS.startIntake, {
  payload: StartIntakeInput,
  success: StartIntakeResult,
  error: Schema.Union([IntakeQuotaExhaustedError, IntakeTurnFailedError]),
});

/**
 * One user turn against the live session — a typed sentence or a tapped
 * quick-reply chip, indifferently (ADR 0014 §2). Writes nothing: no re-seed, no
 * sweep, no Decision row, so a failed turn is a genuine no-op and the draft on
 * screen survives it.
 */
export const IntakeTurnRpc = Rpc.make(RPC_METHODS.intakeTurn, {
  payload: IntakeTurnInput,
  success: IntakeTurnResult,
  error: Schema.Union([IntakeSessionNotFoundError, IntakeQuotaExhaustedError, IntakeTurnFailedError]),
});

/**
 * "Review the sources" (ADR 0014 §5): ends the exchange, fires the SINGLE
 * adversarial sweep over the final plan and the citations *that plan*
 * accumulated, commits the one Decision as a pending Proposal, and returns it
 * with a disclosure of what the sweep changed.
 *
 * A sweep that guts the plan still succeeds — that is the machinery working in
 * public (§8). `IntakeSweepRejectedError` is the narrower case where nothing
 * committable survived: no Proposal is offered, and the session stays alive so
 * the user can retry or keep tweaking rather than losing the plan.
 */
export const ConvergeIntakeRpc = Rpc.make(RPC_METHODS.convergeIntake, {
  payload: ConvergeIntakeInput,
  success: ConvergeIntakeResult,
  error: Schema.Union([IntakeSessionNotFoundError, IntakeQuotaExhaustedError, IntakeSweepRejectedError]),
});

/**
 * The activity line's tool-event stream (ADR 0014 §4), scoped to one Intake
 * session. Discrete ordered events, not a mutating status string — the client
 * keeps the past lines, dimmed, which is the only thing that carries a wait
 * where one retrieval step runs long.
 *
 * It is also the session's **liveness signal**: the subscription's lifetime is
 * the client's, so when the connection drops (reload, tab close) the stream
 * closes and the server tears the SDK session down. ADR 0014 §8 wants no
 * half-alive state and no resurrection, and this is where that is implemented.
 */
export const SubscribeIntakeEventsRpc = Rpc.make(RPC_METHODS.subscribeIntakeEvents, {
  payload: SubscribeIntakeEventsInput,
  success: IntakeToolEvent,
  error: IntakeSessionNotFoundError,
  stream: true,
});

/**
 * Reads the whole Plan (#71) — the ordered list of Prescribed Sessions the
 * store already produces. The one-shot sibling of `subscribePlan`: the
 * session picker and the Plan editor both read the same snapshot shape, so
 * authoring in one is visible in the other with no refetch. An empty Plan is
 * a valid snapshot with `sessions: []`, never an error — that is the state a
 * first-Session flow is offered from.
 */
export const GetPlanRpc = Rpc.make(RPC_METHODS.getPlan, {
  payload: Schema.Struct({}),
  success: PlanSnapshot,
});

/**
 * The Exercise catalog (#72 user story 29). The Plan's picker has to state
 * each exercise's tracked metrics *before* one is added, and the catalog is
 * the only place that fact lives — the server already reads it to build the
 * authoring context, it just had no way to say it out loud.
 *
 * Read-only: the Plan operations reference exercises by id rather than
 * embedding them, so nothing here mutates. The catalog's two *writes* are
 * their own methods below.
 */
export const GetExerciseCatalogRpc = Rpc.make(RPC_METHODS.getExerciseCatalog, {
  payload: Schema.Struct({}),
  success: ExerciseCatalog,
});

/**
 * Mints a **User-authored exercise** (#102, ADR 0016) — a name-only catalog
 * row the coach enriches later.
 *
 * Its own method rather than a `createExercise` member of the ADR 0015 Plan
 * operation union, and deliberately so: a catalog row is not part of the
 * Plan, it is shared metadata that outlives any Plan and is referenced by
 * past Logged Sessions, so creating one **mints no Change and writes nothing
 * to the Decision log**. "Add Zercher Squat to Push Day" is therefore two
 * writes — this, then `addEntry` naming the id — and the UI's job is to make
 * that read as one gesture. A dead spot between them leaves an orphan
 * catalog row, which ADR 0016 tolerates.
 *
 * Not routed through the outbox: the catalog is not cached offline, so the
 * client disables the affordance rather than queueing a write against a
 * catalog it cannot show.
 *
 * **Idempotent on `exerciseId`** — a retry with the same client-minted id
 * returns the existing row instead of minting a second exercise.
 */
export const CreateExerciseRpc = Rpc.make(RPC_METHODS.createExercise, {
  payload: CreateExerciseInput,
  success: CatalogExercise,
});

/**
 * Renames a catalog row (#102, ADR 0016). The id is untouched, so the Plan,
 * past Logged Sessions and analytics all follow the row; the enrichable
 * metadata is cleared, because it described the old name — that emptiness is
 * what marks the row for re-enrichment on the next Session review.
 */
export const RenameExerciseRpc = Rpc.make(RPC_METHODS.renameExercise, {
  payload: RenameExerciseInput,
  success: CatalogExercise,
  error: ExerciseNotFoundError,
});

/**
 * The working behind one Decision (#79) — the evidence, the rule, the
 * citations with their trust marks, the run's data window, and the place the
 * coach says it could be wrong. Both the Proposal card on Today and an item
 * on the Coach surface expand into this.
 *
 * One-shot rather than a subscription, and fetched on expand rather than
 * with the feed: ADR 0011 §5 freezes everything here at commit time, and a
 * feed of thirty items should not carry thirty working blocks the user may
 * never open.
 */
export const GetDecisionWorkingRpc = Rpc.make(RPC_METHODS.getDecisionWorking, {
  payload: GetDecisionWorkingInput,
  success: DecisionWorking,
  error: DecisionNotFoundError,
});

export const RepCoachRpcGroup = RpcGroup.make(
  ServerGetConfigRpc,
  GetPrescribedSessionRpc,
  StartSessionRpc,
  LogSetActualRpc,
  UnlogSetActualRpc,
  SwapEntryExerciseRpc,
  GetLoggedSessionRpc,
  FinishWorkoutRpc,
  CancelSessionRpc,
  ListSessionsRpc,
  ListActiveSessionsRpc,
  GetNextUpRpc,
  GetDailySetCountsRpc,
  ExportDataRpc,
  GetExerciseProgressRpc,
  LogBodyweightRpc,
  RemoveBodyweightRpc,
  ListBodyweightRpc,
  ImportWorkoutsRpc,
  LastActualForExerciseRpc,
  SubscribeCoachingFeedRpc,
  SubscribeProposalsRpc,
  SubscribePlanRpc,
  ResolveProposalRpc,
  ReviseProposalRpc,
  CancelRevisionRpc,
  SubscribeProposalExchangesRpc,
  ApplyUserChangeRpc,
  RunDeliberationNowRpc,
  RunCycleReviewRpc,
  SetCadenceModelRpc,
  GetCadenceModelRpc,
  ListModelsRpc,
  GetSpendSummaryRpc,
  SetRpeCaptureModeRpc,
  GetRpeCaptureModeRpc,
  SetGoalRpc,
  AddStandingConstraintRpc,
  RemoveStandingConstraintRpc,
  AddCheckInRpc,
  AddContextNoteRpc,
  EditContextNoteRpc,
  SubscribeDeliberationStateRpc,
  SubscribeDeliberationRunsRpc,
  StartIntakeRpc,
  IntakeTurnRpc,
  ConvergeIntakeRpc,
  SubscribeIntakeEventsRpc,
  GetPlanRpc,
  GetExerciseCatalogRpc,
  CreateExerciseRpc,
  RenameExerciseRpc,
  GetDecisionWorkingRpc,
);
export type RepCoachRpcGroup = typeof RepCoachRpcGroup;
