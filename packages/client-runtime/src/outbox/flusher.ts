import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { RPC_METHODS } from "@repcoach/contracts";

import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { OutboxManager } from "./manager.ts";

/**
 * Drains the outbox (Task 4, issue #18, G1) whenever the supervisor's
 * session is available: sends the head-of-queue command and removes it only
 * once the server acks. On a transport failure mid-flush the item stays queued
 * and the *next* session (a genuine reconnect, not merely the same live
 * session) restarts the drain from the new head — safe because the server
 * applies `commandId` exactly-once (ADR 0006/0009), so replaying an
 * already-applied command is a no-op that just returns the original result.
 *
 * **The drain is strictly head-of-queue and one-at-a-time, and #80 made that
 * load-bearing rather than merely tidy.** Logged Sets are independent of each
 * other, so a parallel drain would have been harmless; Plan operations are
 * not. "Add exercise" is `addEntry` followed by `replaceEntrySets` seeding its
 * first run, and the second names an Entry the first creates. Draining in
 * enqueue order is what lets a sequence like that replay after a dead spot and
 * land the same way it was authored — the ticket's "operations must apply in
 * enqueue order per container", satisfied globally because the queue is one
 * ordered list.
 *
 * This effect runs forever (until interrupted) — callers fork it alongside
 * the supervisor.
 */
export const runFlusher = Effect.fn("Outbox.runFlusher")(function* (
  supervisor: EnvironmentSupervisor["Service"],
  manager: OutboxManager,
) {
  const drainWhileConnected = Effect.gen(function* () {
    for (;;) {
      const items = yield* SubscriptionRef.get(manager.queued);
      const next = items[0];
      if (next === undefined) {
        // Nothing to send — wait for the next enqueue rather than busy-loop.
        yield* SubscriptionRef.changes(manager.queued).pipe(Stream.take(1), Stream.runDrain);
        continue;
      }
      const sessionOption = yield* SubscriptionRef.get(supervisor.session);
      if (Option.isNone(sessionOption)) {
        // The outer switchMap will tear this fiber down as soon as this
        // yields back to it; returning keeps the loop from spinning.
        return yield* Effect.never;
      }
      const session = sessionOption.value;
      // The only place anything branches on what a queued command *is*. Both
      // arms end the same way: remove on ack, never before.
      if (next.kind === "applyPlanEdit") {
        const rejectedReason = yield* session.client[RPC_METHODS.applyUserPlanChange]({
          operation: next.operation,
          commandId: next.commandId,
        }).pipe(
          Effect.as(Option.none<string>()),
          // A rejected operation is **permanent**, and that distinction is the
          // difference between a queue and a wedged queue. A transport failure
          // must keep the item (that is the whole local-first bet), but
          // `PlanOperationRejectedError` means the server evaluated the
          // operation and refused it — a stale edit naming a Session someone
          // deleted will be refused identically on every future replay. Left
          // queued it would be a poison pill at the head of a strictly
          // in-order drain, blocking every logged Set behind it forever, which
          // turns one impossible Plan edit into total loss of logging.
          //
          // So it comes off the queue — but through `reject`, not `remove`.
          // The two are not interchangeable: whoever applied this operation
          // optimistically is still showing it, and only a rejection tells
          // them to stop. Dropping it quietly would leave an edit on screen
          // that exists nowhere else, which is the silent loss this whole
          // ticket is against. Only this error is caught; the tag keys it so
          // transport failures still fall through and retry.
          Effect.catchTag("PlanOperationRejectedError", (rejection) =>
            Effect.succeed(Option.some(rejection.reason)),
          ),
        );
        yield* Option.match(rejectedReason, {
          onNone: () => manager.remove(next.commandId),
          onSome: (reason) => manager.reject(next, reason),
        });
      } else if (next.kind === "addEntryNote") {
        // A note has no server-side notion of "rejected" the way a Plan
        // operation does — `contextNotes.add` either applies (replay-safe by
        // `commandId`, migration `018`) or the call fails transiently, in
        // which case it stays queued for the next connected session.
        yield* session.client[RPC_METHODS.addContextNote]({
          commandId: next.commandId,
          loggedSessionId: next.loggedSessionId,
          entryId: next.entryId,
          text: next.text,
          recordedAt: next.recordedAt,
        });
        yield* manager.remove(next.commandId);
      } else if (next.kind === "editEntryNote") {
        // Same no-rejectable-error shape as `addEntryNote` above, for a
        // different reason: `contextNotes.edit` carries the whole resulting
        // text by value and treats an unknown `noteId` as a no-op success, so
        // there is no permanent refusal for this arm to handle — it either
        // applies or fails transiently and stays queued.
        yield* session.client[RPC_METHODS.editContextNote]({
          commandId: next.commandId,
          noteId: next.noteId,
          text: next.text,
        });
        yield* manager.remove(next.commandId);
      } else if (next.kind === "unlogSetActual") {
        // A retraction (#83, ADR 0019) has no rejectable-error arm — no
        // FK/lookup validation, migration `020`'s note — so it is
        // unconditional `remove` on success, exactly like `addEntryNote`
        // rather than `swapExercise`/`applyPlanEdit`'s reject-not-remove
        // shape. It either applies (replay-safe by `commandId`) or the call
        // fails transiently and stays queued for the next connected session.
        const result = yield* session.client[RPC_METHODS.unlogSetActual]({
          commandId: next.commandId,
          loggedSessionId: next.loggedSessionId,
          entryId: next.entryId,
          setId: next.setId,
        });
        yield* manager.remove(result.commandId);
      } else if (next.kind === "swapExercise") {
        // A swap (#131, ADR 0019) is a pure actual-side annotation, but it
        // shares `applyPlanEdit`'s reject-not-remove shape: a permanent
        // server refusal (`EntryAlreadyLoggedError` — the Entry won a race
        // against a Set logged elsewhere) must not be silently dropped, since
        // the swap is already showing on screen.
        const rejectedReason = yield* session.client[RPC_METHODS.swapEntryExercise]({
          commandId: next.commandId,
          loggedSessionId: next.loggedSessionId,
          entryId: next.entryId,
          exerciseId: next.exerciseId,
        }).pipe(
          Effect.as(Option.none<string>()),
          Effect.catchTag("EntryAlreadyLoggedError", (rejection) =>
            Effect.succeed(Option.some(rejection.message)),
          ),
        );
        yield* Option.match(rejectedReason, {
          onNone: () => manager.remove(next.commandId),
          onSome: (reason) => manager.reject(next, reason),
        });
      } else {
        const result = yield* session.client[RPC_METHODS.logSetActual]({
          commandId: next.commandId,
          loggedSessionId: next.loggedSessionId,
          sessionId: next.sessionId,
          entryId: next.entryId,
          setId: next.setId,
          setType: next.setType,
          actual: next.actual,
        });
        yield* manager.remove(result.commandId);
      }
    }
  });

  yield* SubscriptionRef.changes(supervisor.session).pipe(
    Stream.switchMap(
      Option.match({
        onNone: () => Stream.empty,
        onSome: () =>
          Stream.fromEffect(drainWhileConnected).pipe(
            Stream.catchCause(() => Stream.empty),
          ),
      }),
    ),
    Stream.runDrain,
  );
});
