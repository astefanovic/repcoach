import * as Effect from "effect/Effect";

import { Logging, type Outbox } from "@repcoach/client-runtime";
import {
  RPC_METHODS,
  type ActualMetricMap,
  type CancelSessionResult,
  type EntryId,
  type ExerciseId,
  type GetDailySetCountsResult,
  type ListSessionsResult,
  type LoggedSessionId,
  type PlanOperation,
  type PlanSnapshot,
  type SessionId,
  type SetId,
  type SetType,
} from "@repcoach/contracts";

import { makeCommandId } from "./ids.ts";
import { inFlightSession, type InFlightSession } from "./inFlightSession.ts";
import type { RepCoachRuntime } from "./RuntimeProvider.tsx";
import { callRpc, runEffect } from "./rpc.ts";

/**
 * The four writes the app makes (#72), each one gathered here so a surface
 * calls a verb rather than assembling an RPC.
 *
 * The split that matters is *which of them tolerate being offline*.
 * Confirming a set and editing the Plan both go to the outbox and are
 * therefore always available — that is the whole local-first bet (ADR 0009).
 * Starting a workout and finishing one are server round-trips that fail
 * honestly when the home server is out of reach, because each needs an answer
 * the client cannot invent: a Logged Session id, and a Session review.
 *
 * Plan editing moved across that line in #80. It reads like it needs a server
 * answer — a validated Plan — but it does not: `validatePlanOperation` is the
 * *same function* on both sides, so the client can decide locally whether an
 * operation is legal and be right. What the server adds is durability and the
 * Change record, and neither has to happen before the user sees their edit.
 */

/**
 * Start (user story 4): instantiates a Logged Session — a deep copy, so the
 * Plan is untouched — and prefetches the prescription into the durable cache
 * in the same breath, which is what makes the rest of the workout
 * network-free (ADR 0009 gate 3).
 *
 * The prefetch is deliberately *not* fatal. If it fails after the Logged
 * Session was created, the workout still exists and the surface can read the
 * prescription from the server; refusing to start would be worse.
 *
 * **Adopt-don't-duplicate (issue #147).** Before minting, ask the server which
 * Logged Sessions are `active`. If one already exists for this Prescribed
 * Session, resume *that* — a client whose device-local Resume pointer was lost
 * (site-data loss, a second device) would otherwise tap Start and strand the
 * first session behind a second `active` row that nothing ever finishes. The
 * store's `startSession` stays non-idempotent by design; this guard is the
 * one place "one intended workout, one active row" is enforced. A dead link
 * makes this list unavailable — then the pre-#147 behaviour stands and the
 * reconcile on Today's next connect catches any duplicate.
 */
export async function startWorkout(
  runtime: RepCoachRuntime,
  prescribedSessionId: SessionId,
): Promise<InFlightSession> {
  const existing = await callRpc(runtime, RPC_METHODS.listActiveSessions, {})
    .then(({ sessions }) => sessions.find((s) => s.prescribedSessionId === prescribedSessionId))
    .catch(() => undefined);
  if (existing !== undefined) {
    const adopted: InFlightSession = {
      loggedSessionId: existing.loggedSessionId,
      prescribedSessionId: existing.prescribedSessionId,
      startedAt: existing.startedAt,
    };
    inFlightSession.write(adopted);
    return adopted;
  }

  const { loggedSessionId } = await callRpc(runtime, RPC_METHODS.startSession, {
    prescribedSessionId,
  });

  await runEffect(
    runtime,
    runtime.prescriptions
      .startWorkout(prescribedSessionId, (sessionId) =>
        Effect.promise(() =>
          callRpc(runtime, RPC_METHODS.getPrescribedSession, { sessionId }),
        ),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => console.warn("[start] prescription prefetch failed", cause)),
        ),
      ),
  );

  const session: InFlightSession = {
    loggedSessionId,
    prescribedSessionId,
    startedAt: new Date().toISOString(),
  };
  inFlightSession.write(session);
  return session;
}

/**
 * Confirm a set (user stories 12, 13). The `commandId` is minted here,
 * **once**, by `buildConfirmCommand` — the constraint `grid.ts` states and
 * the reason this is a function call rather than something a component
 * derives during render. The outbox persists before it reflects, so by the
 * time this resolves the set has survived the tab being killed.
 */
export function confirmSet(
  runtime: RepCoachRuntime,
  args: {
    readonly loggedSessionId: LoggedSessionId;
    readonly sessionId: SessionId;
    readonly entryId: EntryId;
    readonly setId: SetId;
    readonly setType: SetType;
    readonly actual: ActualMetricMap;
  },
): Promise<void> {
  const command = Logging.buildConfirmCommand({ makeCommandId, ...args });
  return Effect.runPromise(runtime.outbox.enqueue(command)).then(() => undefined);
}

/**
 * Un-log a set (#83, ADR 0019): tapping an already-logged Set's confirm again
 * retracts it. Through the outbox exactly like `confirmSet` — offline-first,
 * idempotent by the `commandId` minted here, **once**, by
 * `Logging.buildUnlogCommand`, same constraint as `confirmSet`'s.
 */
export function unlogSet(
  runtime: RepCoachRuntime,
  args: {
    readonly loggedSessionId: LoggedSessionId;
    readonly entryId: EntryId;
    readonly setId: SetId;
  },
): Promise<void> {
  const command = Logging.buildUnlogCommand({ makeCommandId, ...args });
  return Effect.runPromise(runtime.outbox.enqueue(command)).then(() => undefined);
}

/**
 * Add a note (issue #130): the per-Entry sheet's one item that is not a Set.
 * Goes through the outbox exactly like `confirmSet` — offline-first, and
 * idempotent under replay by the `commandId` minted here. Unlike a Set's
 * `setId`, a note's `commandId` is not already known to the caller before
 * this runs (it doubles as the note's own id, migration `018`), so the built
 * command is returned rather than discarded — the caller needs it to render
 * the note optimistically the same tick, the way `SetRow.write` already has
 * `setId` in hand for `onRecord`.
 */
export function addEntryNote(
  runtime: RepCoachRuntime,
  args: {
    readonly loggedSessionId: LoggedSessionId;
    readonly entryId: EntryId;
    readonly text: string;
  },
): Promise<Outbox.NewQueuedAddEntryNote> {
  const command = Logging.buildAddEntryNoteCommand({ makeCommandId, ...args });
  return Effect.runPromise(runtime.outbox.enqueue(command)).then(() => command);
}

/**
 * Edit a note (UAT): the sheet's note item once the Entry already has one.
 * The append-only shape #130 shipped produced a pile of near-duplicate lines
 * under an exercise as an observation was refined during a workout — the
 * user's intent was one running note, not a log of edits.
 *
 * Through the outbox exactly like `addEntryNote`, and returned for the same
 * reason: the caller renders the rewritten text optimistically the same tick.
 * `noteId` is the existing note's id; the minted `commandId` is this
 * command's own outbox identity, not a row id (see `buildEditEntryNoteCommand`).
 */
export function editEntryNote(
  runtime: RepCoachRuntime,
  args: {
    readonly loggedSessionId: LoggedSessionId;
    readonly entryId: EntryId;
    readonly noteId: string;
    readonly text: string;
  },
): Promise<Outbox.NewQueuedEditEntryNote> {
  const command = Logging.buildEditEntryNoteCommand({ makeCommandId, ...args });
  return Effect.runPromise(runtime.outbox.enqueue(command)).then(() => command);
}

/**
 * Swap (#131, ADR 0019): records that an Entry's Sets are actually being
 * performed against a different Exercise than the prescribed one. A pure
 * actual-side annotation — through the outbox exactly like `confirmSet`, and
 * for the same reason (offline-first, idempotent by `commandId`).
 *
 * Unlike `confirmSet`, the built command is **returned** rather than
 * discarded: the caller needs the minted `commandId`/`entryId`/`exerciseId`
 * to render the swap optimistically before the outbox has drained, the same
 * reason `addEntryNote` above does.
 */
export function swapExercise(
  runtime: RepCoachRuntime,
  args: {
    readonly loggedSessionId: LoggedSessionId;
    readonly entryId: EntryId;
    readonly exerciseId: ExerciseId;
  },
): Promise<{
  readonly commandId: ReturnType<typeof makeCommandId>;
  readonly entryId: EntryId;
  readonly exerciseId: ExerciseId;
}> {
  const command = Logging.buildSwapCommand({ makeCommandId, ...args });
  return Effect.runPromise(runtime.outbox.enqueue(command)).then(() => command);
}

/**
 * Finish (user story 24): the explicit workout-done event. It also queues the
 * Session-review Deliberation server-side, which is why it is a real
 * round-trip and not a local flag — the coach cannot review a session the
 * server was never told had ended.
 *
 * **It no longer waits for the coach** (issue #132). The server used to run the
 * whole Session review inside this call, so finishing a workout blocked on an
 * Opus run before the UI would move. It now returns as soon as the session is
 * finalized and marked `pending` review; the run's progress shows on the status
 * strip and its output arrives on the coaching feed. A resolved promise
 * therefore means "the session is finished and a review is owed", not "the
 * coach has been".
 *
 * The in-flight pointer is cleared only on success — but note what "failure"
 * now means. Because the review is no longer part of this call, a rejection
 * here means the finalization itself did not happen, so the session really is
 * still open and Today must keep offering Resume for it. That was NOT true
 * before #132: a run failure rejected this promise even though the server had
 * already committed the transition, which stranded the user on a Resume button
 * for a session the server considered finished.
 */
export async function finishWorkout(
  runtime: RepCoachRuntime,
  loggedSessionId: LoggedSessionId,
): Promise<void> {
  await callRpc(runtime, RPC_METHODS.finishWorkout, { loggedSessionId });
  inFlightSession.write(undefined);
}

/**
 * Cancel (issue #114 Part 1) — unmakes an accidentally-started session.
 * Offered only while the session has zero confirmed sets (the surface's
 * job); the server enforces the same rule independently and rejects loudly
 * if it disagrees, so this is not the only guard.
 *
 * The in-flight pointer is cleared only on success, same reasoning as
 * `finishWorkout`: a cancel that failed leaves a genuinely open session, and
 * Today must keep offering Resume for it.
 */
export async function cancelSession(
  runtime: RepCoachRuntime,
  loggedSessionId: LoggedSessionId,
): Promise<CancelSessionResult> {
  const result = await callRpc(runtime, RPC_METHODS.cancelSession, { loggedSessionId });
  inFlightSession.write(undefined);
  return result;
}

/** History (issue #114 Part 2) — a reverse-chronological page of finished sessions. */
export async function listSessions(
  runtime: RepCoachRuntime,
  args: { readonly limit?: number; readonly before?: string } = {},
): Promise<ListSessionsResult> {
  return callRpc(runtime, RPC_METHODS.listSessions, args);
}

/**
 * Stats (issue #117) — daily set counts behind the consistency heatmap.
 * `utcOffsetMinutes` is minted here, once, from this device's own clock
 * (`-Date#getTimezoneOffset()`, the conventional east-of-UTC-positive sign —
 * see `packages/contracts/src/stats.ts`), the same "compute the one true
 * value where it's asked for" rule `makeCommandId` follows for commandIds.
 */
export async function getDailySetCounts(runtime: RepCoachRuntime): Promise<GetDailySetCountsResult> {
  return callRpc(runtime, RPC_METHODS.getDailySetCounts, {
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
  });
}

/**
 * "Export my data": the home server's whole database as a JSON file, handed
 * to the browser as a download. Online-only — the data lives at home, and a
 * partial export assembled from this device's caches would be a worse lie
 * than a disabled button.
 */
export async function downloadDataExport(runtime: RepCoachRuntime): Promise<void> {
  const exported = await callRpc(runtime, RPC_METHODS.exportData, {});
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `repcoach-export-${exported.exportedAt.slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * A structural Plan edit (user stories 26, 28). Auto-applied with no
 * approval step — a user editing their own Plan is not something to review
 * (ADR 0008).
 *
 * **#80 moved this onto the outbox, and that is the whole ticket.** #71 shipped
 * it as a direct RPC and wrote the cut down: Plan edits did not queue, so an
 * edit made in a gym dead spot was applied optimistically, failed to send, and
 * was rolled back off the screen. Losing a Plan edit that way is the same class
 * of failure as losing a Set, and the Set path was already protected — the
 * asymmetry was the bug.
 *
 * The `commandId` is minted here, **once**, exactly as `confirmSet`'s is, and
 * for the same reason: the server's exactly-once discipline for structural
 * edits (`StoreData.planEditsByCommandId`, ADR 0006) is keyed on it. That
 * discipline existed before this ticket and never fired, because the old direct
 * call minted a *fresh* id per attempt — so a retry looked like a brand-new
 * edit. A queued command has one id for its whole life, which is what finally
 * makes the server's dedupe reachable.
 *
 * This no longer echoes the updated Plan. It cannot: enqueueing resolves as
 * soon as the command is durable, which is typically long before the server
 * has seen it. The editor keeps its optimistic Plan and reconciles against
 * `subscribePlan` instead — see `usePlanEditor`.
 *
 * Undo sends the **inverse operation** as a new edit (#71: undo is not a new
 * primitive). It does *not* set `undoesChangeId`, because
 * `applyUserPlanChange` answers with a `PlanSnapshot` and never tells the
 * client which Change it recorded — so there is no id to name. The Plan ends
 * up correct either way; what is lost is the server marking the original
 * `superseded`, which leaves the undone edit and its inverse both live in
 * the Change history. Closing that needs the RPC to return the Change id,
 * which is a contract change and belongs with #71's surface, not here.
 */
export function enqueuePlanEdit(
  runtime: RepCoachRuntime,
  operation: PlanOperation,
): Promise<void> {
  return Effect.runPromise(
    runtime.outbox.enqueue({
      kind: "applyPlanEdit",
      commandId: makeCommandId(),
      operation,
    }),
  ).then(() => undefined);
}
