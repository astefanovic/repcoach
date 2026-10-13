import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { CommandId } from "@repcoach/contracts";

import { buildQueuedCommand, type NewQueuedCommand, type QueuedCommand } from "./model.ts";
import type { OutboxStorage } from "./storage.ts";

/**
 * The outbox manager (Task 4, issue #18) — ported from t3code's
 * `createThreadOutboxManager`. Keeps its two core disciplines:
 *  - a serialized mutation queue (one `Semaphore` permit) so concurrent
 *    enqueue/remove calls can't interleave and corrupt the persisted state;
 *  - **persist-before-reflect**: every mutation writes to `storage` before
 *    updating the in-memory `queued` state the UI/flusher observe, so a
 *    crash between the two steps never loses an item silently.
 *
 * #80 widened what it carries from logged Sets to any `QueuedCommand`, and
 * nothing in here had to learn the difference: the manager was already generic
 * over "a thing with a `commandId` and a `createdAt`". That is why option A
 * was the cheap one — the ordering guarantee callers depend on
 * (`createdAt`-sorted, FIFO drain) already holds for Plan operations, which is
 * exactly what "operations apply in enqueue order per container" needs.
 */
/**
 * A command the server **refused** — evaluated and rejected, not merely
 * undelivered. It is off the queue for good and will never be retried.
 *
 * This exists because "removed from the queue" is otherwise ambiguous between
 * the two outcomes that matter most to the user: delivered, and discarded. A
 * caller rendering an optimistic view has to be able to tell them apart, or it
 * will keep showing work that no longer exists anywhere.
 */
export interface RejectedCommand {
  readonly commandId: CommandId;
  readonly reason: string;
  /**
   * The refused command itself. More than one surface subscribes to
   * `rejections` now (#148 — Logging joined the Plan editor), so a bare
   * `commandId` no longer routes: a subscriber needs `kind` to tell whether the
   * rejection is its concern at all, and `loggedSessionId`/`entryId` to roll
   * back exactly the state it optimistically applied.
   */
  readonly command: QueuedCommand;
}

export interface OutboxManager {
  readonly queued: SubscriptionRef.SubscriptionRef<ReadonlyArray<QueuedCommand>>;
  /**
   * Commands the server refused, awaiting acknowledgement by whoever is
   * showing them. Not a log: a rejection has to reach the surface that
   * optimistically applied the command, and a `logWarning` reaches only the
   * console.
   */
  readonly rejections: SubscriptionRef.SubscriptionRef<ReadonlyArray<RejectedCommand>>;
  readonly load: Effect.Effect<void, unknown>;
  readonly enqueue: (input: NewQueuedCommand) => Effect.Effect<QueuedCommand, unknown>;
  readonly remove: (commandId: CommandId) => Effect.Effect<void, unknown>;
  /** Drops a command the server refused, and records it (with why) for the UI to pick up. */
  readonly reject: (command: QueuedCommand, reason: string) => Effect.Effect<void, unknown>;
  /** Clears a rejection once it has been shown, so it is reported exactly once. */
  readonly acknowledgeRejection: (commandId: CommandId) => Effect.Effect<void, unknown>;
}

/**
 * Ordered by `seq` first, because that is the only total order that survives a
 * reload — see `QueuedSetActual.seq`. `createdAt` remains the tiebreak for
 * legacy rows, which all carry `seq: 0` and predate the counter entirely.
 */
function dedupeByCommandId(items: ReadonlyArray<QueuedCommand>): ReadonlyArray<QueuedCommand> {
  const byId = new Map<string, QueuedCommand>();
  for (const item of items) {
    byId.set(item.commandId, item);
  }
  return [...byId.values()].sort(
    (a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt),
  );
}

export const makeOutboxManager = Effect.fn("Outbox.makeOutboxManager")(function* (
  storage: OutboxStorage,
) {
  const queued = yield* SubscriptionRef.make<ReadonlyArray<QueuedCommand>>([]);
  const rejections = yield* SubscriptionRef.make<ReadonlyArray<RejectedCommand>>([]);
  // The enqueue-order counter. Resumed past the highest persisted `seq` on
  // load, so a command enqueued after a reload still sorts after everything
  // that was already waiting.
  const nextSeq = yield* Ref.make(1);
  const semaphore = yield* Semaphore.make(1);
  const serialize = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    semaphore.withPermits(1)(effect);

  const load: Effect.Effect<void, unknown> = serialize(
    Effect.gen(function* () {
      const persisted = yield* storage.load;
      const current = yield* SubscriptionRef.get(queued);
      const all = dedupeByCommandId([...persisted, ...current]);
      yield* SubscriptionRef.set(queued, all);
      const highest = all.reduce((max, item) => Math.max(max, item.seq), 0);
      yield* Ref.update(nextSeq, (n) => Math.max(n, highest + 1));
    }),
  );

  const enqueue = (input: NewQueuedCommand): Effect.Effect<QueuedCommand, unknown> =>
    serialize(
      Effect.gen(function* () {
        const seq = yield* Ref.getAndUpdate(nextSeq, (n) => n + 1);
        const item = buildQueuedCommand(input, seq);
        // Persist BEFORE reflecting — see module doc.
        yield* storage.write(item);
        const current = yield* SubscriptionRef.get(queued);
        yield* SubscriptionRef.set(queued, [...current, item]);
        return item;
      }),
    );

  const remove = (commandId: CommandId): Effect.Effect<void, unknown> =>
    serialize(
      Effect.gen(function* () {
        yield* storage.remove(commandId);
        const current = yield* SubscriptionRef.get(queued);
        yield* SubscriptionRef.set(
          queued,
          current.filter((candidate) => candidate.commandId !== commandId),
        );
      }),
    );

  const reject = (command: QueuedCommand, reason: string): Effect.Effect<void, unknown> =>
    serialize(
      Effect.gen(function* () {
        // Same persist-before-reflect order as `remove`: the row is gone from
        // storage before anything observes it as gone.
        yield* storage.remove(command.commandId);
        const current = yield* SubscriptionRef.get(queued);
        yield* SubscriptionRef.set(
          queued,
          current.filter((candidate) => candidate.commandId !== command.commandId),
        );
        const currentRejections = yield* SubscriptionRef.get(rejections);
        yield* SubscriptionRef.set(rejections, [
          ...currentRejections,
          { commandId: command.commandId, reason, command },
        ]);
      }),
    );

  const acknowledgeRejection = (commandId: CommandId): Effect.Effect<void, unknown> =>
    serialize(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(rejections);
        yield* SubscriptionRef.set(
          rejections,
          current.filter((candidate) => candidate.commandId !== commandId),
        );
      }),
    );

  return {
    queued,
    rejections,
    load,
    enqueue,
    remove,
    reject,
    acknowledgeRejection,
  } satisfies OutboxManager;
});
