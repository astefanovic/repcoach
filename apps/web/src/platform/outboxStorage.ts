import * as Effect from "effect/Effect";

import { Outbox } from "@repcoach/client-runtime";
import type { CommandId } from "@repcoach/contracts";

import { kvDelete, kvEntries, kvPut, OUTBOX_STORE } from "./indexedDb.ts";

/**
 * DOM platform seam for the outbox's storage (#50, absorbing #51) —
 * IndexedDB-backed. Since #80 it persists any `QueuedCommand`, logged Sets and
 * Plan edits alike; the store is keyed on `commandId` and never cared what the
 * row contained, so widening it was a rename. This superseded the retired native/Expo client's
 * AsyncStorage adapter (ADR 0012, #53); the web client is now the only client.
 *
 * This is the app's only durable write path: ADR 0009 gate 1 (offline
 * capture with no duplicates and no loss) rides entirely on it, so the swap
 * was the riskiest single change in the migration and `g1-offline-outbox`
 * is its acceptance test. Three things carry over deliberately from the
 * AsyncStorage adapter, because they are what made it correct:
 *
 * - **One key per queued item**, so a partial write never corrupts siblings.
 *   The key is the `commandId`, which also makes `write` idempotent — a
 *   re-enqueued command overwrites its own row instead of duplicating it.
 * - **Per-row decode tolerance**: an unreadable row is dropped with a warning
 *   rather than failing the whole load, mirroring
 *   `makeInMemoryOutboxStorage`. A single bad row must not strand every other
 *   unsynced set the user logged.
 * - **The `OutboxStorage` interface is unchanged.** The seam was designed for
 *   exactly this swap.
 *
 * Two things improve on it:
 *
 * - **Failures are typed, not defects.** The AsyncStorage adapter used
 *   `Effect.promise`, which turns a rejected write into a defect. The
 *   `OutboxStorageError` this now fails with was already declared in
 *   `packages/client-runtime/src/outbox/storage.ts` and simply unused. It
 *   matters here: the manager's persist-before-reflect discipline means a
 *   typed write failure correctly leaves the in-memory queue untouched, so
 *   the UI never shows a set as captured that storage rejected.
 * - **No key prefix needed.** An object store is its own namespace, so the
 *   `@repcoach/outbox/log-set-actual/` prefix and the `getAllKeys` filter it
 *   existed to support are both gone.
 */
export const indexedDbOutboxStorage: Outbox.OutboxStorage = {
  load: Effect.tryPromise({
    try: async () => {
      const entries = await kvEntries(OUTBOX_STORE);
      const items: Array<Outbox.QueuedCommand> = [];
      for (const [key, value] of entries) {
        try {
          items.push(Outbox.decodeQueuedCommand(value));
        } catch (cause) {
          console.warn("[outbox] ignored invalid persisted row", key, cause);
        }
      }
      return items;
    },
    catch: (cause) =>
      new Outbox.OutboxStorageError({ operation: "load", commandId: null, cause }),
  }),

  write: (item) =>
    Effect.tryPromise({
      try: () => kvPut(OUTBOX_STORE, item.commandId, Outbox.encodeQueuedCommand(item)),
      catch: (cause) =>
        new Outbox.OutboxStorageError({
          operation: "write",
          commandId: item.commandId,
          cause,
        }),
    }),

  remove: (commandId: CommandId) =>
    Effect.tryPromise({
      try: () => kvDelete(OUTBOX_STORE, commandId),
      catch: (cause) => new Outbox.OutboxStorageError({ operation: "remove", commandId, cause }),
    }),
};
