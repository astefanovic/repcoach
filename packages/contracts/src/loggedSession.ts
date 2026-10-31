import * as Schema from "effect/Schema";

import { IsoDateTime, LoggedSessionId, NonNegativeInt, SessionId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ContextNote } from "./coachingInputs.ts";
import { LogSetActualResult, SwapEntryExerciseResult, UnlogSetActualResult } from "./logging.ts";
import { PrescribedSession } from "./scaffold.ts";

/**
 * Real Logged Session instantiation (Step 2A, task 2A.2 — see the Step 2A
 * handoff's "Contract-evolution decisions", decision #1): `startSession`
 * deep-copies the current Prescribed Session tree into a Logged Session
 * (copy-on-instantiate, ADR 0006/0007) so later Plan edits never reach an
 * in-flight workout's logged copy. `getLoggedSession` is the prod-safe
 * black-box read lever this durability story needs (NOT a `/__test__/`
 * endpoint) — decision #2 of the same section.
 */

export const StartSessionInput = Schema.Struct({
  prescribedSessionId: SessionId,
});
export type StartSessionInput = typeof StartSessionInput.Type;

export const StartSessionResult = Schema.Struct({
  loggedSessionId: LoggedSessionId,
});
export type StartSessionResult = typeof StartSessionResult.Type;

/**
 * A Logged Session's lifecycle status. `active` from `startSession`
 * (2A.2); `finished` is set by `finishWorkout` (2B slice 4, issue #29) — the
 * explicit "Finish Workout" event, never mid-workout set-syncs
 * (`logSetActual` never transitions status). `cancelled` is set by
 * `cancelSession` (issue #114) — the honest option for "unmake a mistake":
 * a third terminal status rather than a row delete, so the table stays
 * append-only-ish and a future stats query can exclude it explicitly.
 */
export const LoggedSessionStatus = Schema.Literals(["active", "finished", "cancelled"]);
export type LoggedSessionStatus = typeof LoggedSessionStatus.Type;

/**
 * A Logged Session: the frozen Prescribed Session snapshot it was
 * instantiated from, plus every actual applied against it so far, plus every
 * Entry swap (ADR 0019, CONTEXT `Swap`). Returned by `getLoggedSession` — the
 * read lever durability tests assert against instead of poking server
 * internals.
 *
 * `swaps` is disjoint from `session`: the frozen prescribed exercise inside
 * `session` is never overwritten by a swap, so a Logged Session's prescribed
 * and performed exercise identity for a swapped Entry are both readable from
 * this one response — "swap-provenance is free" (ADR 0007).
 */
export const LoggedSession = Schema.Struct({
  loggedSessionId: LoggedSessionId,
  prescribedSessionId: SessionId,
  startedAt: IsoDateTime,
  status: LoggedSessionStatus,
  session: PrescribedSession,
  // A retraction (ADR 0019, issue #83) is interleaved into the SAME ordered
  // array as a log, not a sibling list like `swaps`: net state is "the last
  // row per `setId` by application order", and that fold only works if logs
  // and retractions share one stream. The `retraction` literal on each arm
  // (false | true) is the discriminator the client folds on.
  actuals: Schema.Array(Schema.Union([LogSetActualResult, UnlogSetActualResult])),
  swaps: Schema.Array(SwapEntryExerciseResult),
  /** Entry-anchored Context notes for this Logged Session (issue #130) — the "Add a note" sheet item. */
  notes: Schema.Array(ContextNote),
});
export type LoggedSession = typeof LoggedSession.Type;

export const GetLoggedSessionInput = Schema.Struct({
  loggedSessionId: LoggedSessionId,
});
export type GetLoggedSessionInput = typeof GetLoggedSessionInput.Type;

export class LoggedSessionNotFoundError extends Schema.TaggedErrorClass<LoggedSessionNotFoundError>()(
  "LoggedSessionNotFoundError",
  {
    loggedSessionId: LoggedSessionId,
  },
) {
  override get message(): string {
    return `No Logged Session found for id ${this.loggedSessionId}`;
  }
}

/**
 * Whether a finished Logged Session still owes a Session review (issue #132).
 *
 * Separate from `LoggedSessionStatus` because the two answer different
 * questions and conflating them is what lost three sessions' reviews: `status`
 * says whether the workout ended, `reviewStatus` says whether the coach has
 * looked at it. A `finished` session is always exactly one of these; `active`
 * and `cancelled` sessions carry no marker at all (a cancelled session must
 * never trigger a review — #114).
 *
 * `pending` is the **only** trigger for a review, and it is durable, so the
 * work survives a failed run, a low-quota deferral, and a server restart
 * alike — see migration `017`.
 */
export const LoggedSessionReviewStatus = Schema.Literals(["pending", "reviewed"]);
export type LoggedSessionReviewStatus = typeof LoggedSessionReviewStatus.Type;

/**
 * "Finish Workout" (ADR 0011 §4, 2B slice 4 — issue #29; reshaped by #132):
 * the client-driven event on session finalization (NOT a mid-workout
 * `logSetActual` set-sync) that flips `logged_session.status` to `finished`,
 * marks the session `pending` review in the same write, and **returns
 * immediately**.
 *
 * **Why it no longer returns the review.** It used to run the Session-review
 * Deliberation synchronously and echo the committed output, mirroring
 * `RunDeliberationNowRpc`. That coupling is the #132 bug: the transition was
 * already committed when the run failed, `transitioned: false` then made every
 * retry a silent no-op, and the review became permanently unreachable. A
 * review that a *durable marker* owes is recoverable; a review that an
 * in-flight RPC owes is not.
 *
 * It also stopped being the right shape for the user: an Opus run takes
 * minutes, and holding the request open made "Finish Workout" wait on the
 * coach before the UI would move. The run's progress belongs on the status
 * strip, which already carries exactly this (`subscribeDeliberationActivity`),
 * and its output arrives on `subscribeCoachingFeed`/`subscribeProposals` like
 * every other cadence's does. Revise made the same call for the same reason
 * (ADR 0013 §5) — this brings Session review into line with it.
 *
 * `reviewStatus` is what the caller gets instead: `pending` when this call
 * finalized the session and a review is now owed, `reviewed` when the session
 * had already been finished AND reviewed (a genuine double-tap, nothing to
 * do). A re-finish of a session still awaiting its review reports `pending`
 * again — honest, and it lets the drain pick it up rather than swallowing it.
 */
export const FinishWorkoutInput = Schema.Struct({
  loggedSessionId: LoggedSessionId,
});
export type FinishWorkoutInput = typeof FinishWorkoutInput.Type;

export const FinishWorkoutResult = Schema.Struct({
  loggedSessionId: LoggedSessionId,
  status: LoggedSessionStatus,
  reviewStatus: LoggedSessionReviewStatus,
});
export type FinishWorkoutResult = typeof FinishWorkoutResult.Type;

/**
 * "Cancel session" (issue #114 Part 1): unmakes an accidentally-started
 * session. The owner's rule — cancel is offered only while the session has
 * zero confirmed sets — is enforced server-side too, not just hidden client
 * UI: an `active` session with a logged actual fails loudly rather than
 * silently no-opping, mirroring `cancelRevision`'s "nothing to cancel" shape
 * for the genuinely idempotent case (double-cancel, or cancelling a session
 * already `finished`) while refusing the destructive-looking one.
 */
export const CancelSessionInput = Schema.Struct({
  loggedSessionId: LoggedSessionId,
});
export type CancelSessionInput = typeof CancelSessionInput.Type;

export class LoggedSessionHasActualsError extends Schema.TaggedErrorClass<LoggedSessionHasActualsError>()(
  "LoggedSessionHasActualsError",
  {
    loggedSessionId: LoggedSessionId,
  },
) {
  override get message(): string {
    return `Logged Session ${this.loggedSessionId} has a logged set and cannot be cancelled`;
  }
}

/**
 * `cancelled: false` when there was nothing to cancel — already `cancelled`,
 * or `finished` (with no actuals, so the actuals guard didn't already
 * reject it) — never a failure. `status` echoes the row's status after the
 * call so a caller need not re-fetch to know what it ended up as.
 */
export const CancelSessionResult = Schema.Struct({
  loggedSessionId: LoggedSessionId,
  status: LoggedSessionStatus,
  cancelled: Schema.Boolean,
});
export type CancelSessionResult = typeof CancelSessionResult.Type;

/**
 * "History" (issue #114 Part 2): a reverse-chronological page of finished
 * sessions off `Today.tsx`, excluding `cancelled` and `active`. `before`
 * pages backward by `finishedAt` (strictly older than) so the list stays
 * boundable as it grows forever; omitted on the first page.
 */
export const ListSessionsInput = Schema.Struct({
  limit: Schema.optionalKey(NonNegativeInt),
  before: Schema.optionalKey(IsoDateTime),
});
export type ListSessionsInput = typeof ListSessionsInput.Type;

/**
 * One row of the history list. `loggedSetCount`/`totalSetCount` so the list
 * row needs no second call (CONTEXT "n of m sets" idiom `Logging.tsx`
 * already renders mid-workout).
 */
export const LoggedSessionSummary = Schema.Struct({
  loggedSessionId: LoggedSessionId,
  prescribedSessionId: SessionId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  loggedSetCount: NonNegativeInt,
  totalSetCount: NonNegativeInt,
});
export type LoggedSessionSummary = typeof LoggedSessionSummary.Type;

export const ListSessionsResult = Schema.Struct({
  sessions: Schema.Array(LoggedSessionSummary),
});
export type ListSessionsResult = typeof ListSessionsResult.Type;

/**
 * "Which Logged Sessions are still in flight" (issue #147). The `active` rows,
 * newest `startedAt` first.
 *
 * The device-local `repcoach.inFlightSession` pointer is only a synchronous
 * first-render hint — a browser that loses site data, or a second device,
 * has no pointer at all, and before this RPC there was no way to ask the
 * server, so a genuinely open session became unreachable from every surface
 * (and tapping Start again minted a *second* `active` row). The client
 * reconciles the pointer against this list once connected; `startSession` is
 * idempotent per Prescribed Session so the reconcile cannot itself create a
 * duplicate.
 *
 * `loggedSetCount` is the net count of still-logged Sets (a mis-tapped
 * log-then-retract does not inflate it), so the Resume hero can say how much
 * work is already captured without a second call. The session `name` comes
 * from the frozen snapshot, same as `LoggedSessionSummary`. No error channel,
 * exactly like `ListSessionsResult`: an empty list is a valid answer, never a
 * failure.
 */
export const ActiveLoggedSessionSummary = Schema.Struct({
  loggedSessionId: LoggedSessionId,
  prescribedSessionId: SessionId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  startedAt: IsoDateTime,
  loggedSetCount: NonNegativeInt,
});
export type ActiveLoggedSessionSummary = typeof ActiveLoggedSessionSummary.Type;

export const ListActiveSessionsResult = Schema.Struct({
  sessions: Schema.Array(ActiveLoggedSessionSummary),
});
export type ListActiveSessionsResult = typeof ListActiveSessionsResult.Type;

/**
 * "Next up" (ADR 0023): the Prescribed Session Today suggests, derived from
 * the current Plan and the finished Logged Sessions on every read and stored
 * nowhere. Absent when no session in the Plan can be started. No error
 * channel, same as `ListActiveSessionsResult`: nothing to suggest is a valid
 * answer.
 */
export const GetNextUpResult = Schema.Struct({
  prescribedSessionId: Schema.optionalKey(SessionId),
});
export type GetNextUpResult = typeof GetNextUpResult.Type;
