import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CommandId } from "@repcoach/contracts";

import { decodeQueuedCommand, encodeQueuedCommand, type QueuedCommand } from "./model.ts";

/**
 * Storage seam for the log outbox (Task 4, issue #18) — mirrors t3code's
 * `ThreadOutboxStorage`. Kept injectable so rung-1 tests use an in-memory
 * implementation while the real app persists durably (IndexedDB, see
 * `apps/web/src/platform/outboxStorage.ts`).
 */
export class OutboxStorageError extends Schema.TaggedErrorClass<OutboxStorageError>()(
  "OutboxStorageError",
  {
    operation: Schema.Literals(["load", "write", "remove"]),
    commandId: Schema.NullOr(CommandId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Outbox storage operation ${this.operation} failed for commandId ${this.commandId ?? "unknown"}.`;
  }
}

export interface OutboxStorage {
  readonly load: Effect.Effect<ReadonlyArray<QueuedCommand>, unknown>;
  readonly write: (item: QueuedCommand) => Effect.Effect<void, unknown>;
  readonly remove: (commandId: CommandId) => Effect.Effect<void, unknown>;
}

/**
 * In-memory storage backed by a caller-supplied `Map`. Passing the same
 * `Map` to two separately-constructed managers simulates "app kill and
 * relaunch" for rung-1 tests: the second manager's `load` sees whatever the
 * first left behind.
 */
export function makeInMemoryOutboxStorage(
  backing: Map<string, unknown> = new Map(),
): OutboxStorage {
  return {
    load: Effect.sync(() => {
      const items: Array<QueuedCommand> = [];
      for (const raw of backing.values()) {
        try {
          items.push(decodeQueuedCommand(raw));
        } catch {
          // Unknown/corrupt schema version — drop the row rather than fail
          // the whole load (mirrors t3code's per-file decode tolerance).
        }
      }
      return items;
    }),
    write: (item) =>
      Effect.sync(() => {
        backing.set(item.commandId, encodeQueuedCommand(item));
      }),
    remove: (commandId) =>
      Effect.sync(() => {
        backing.delete(commandId);
      }),
  };
}
