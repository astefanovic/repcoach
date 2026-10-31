import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  decodeCachedPrescription,
  encodeCachedPrescription,
  type CachedPrescription,
} from "./model.ts";

/**
 * Storage seam for the prescription prefetch cache (Task 5, issue #19) —
 * mirrors the outbox's `OutboxStorage` (`../outbox/storage.ts`): injectable
 * so rung-1 tests use an in-memory implementation while the real app
 * persists durably (IndexedDB, see
 * `apps/web/src/platform/prescriptionCacheStorage.ts`). Single-slot: only
 * one in-flight workout's cached prescription needs to survive an app kill
 * at a time (Task 5's scope), unlike the outbox's multi-item queue.
 */
export class PrescriptionCacheStorageError extends Schema.TaggedErrorClass<PrescriptionCacheStorageError>()(
  "PrescriptionCacheStorageError",
  {
    operation: Schema.Literals(["load", "write", "clear"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Prescription cache storage operation ${this.operation} failed.`;
  }
}

export interface PrescriptionCacheStorage {
  readonly load: Effect.Effect<Option.Option<CachedPrescription>, unknown>;
  readonly write: (entry: CachedPrescription) => Effect.Effect<void, unknown>;
  readonly clear: Effect.Effect<void, unknown>;
}

/**
 * In-memory storage backed by a caller-supplied single-slot box. Passing the
 * same box to two separately-constructed caches simulates "app kill and
 * relaunch" for rung-1 tests: the second cache's `load` sees whatever the
 * first left behind.
 */
export function makeInMemoryPrescriptionCacheStorage(
  box: { value: unknown } = { value: undefined },
): PrescriptionCacheStorage {
  return {
    load: Effect.sync(() => {
      if (box.value === undefined) {
        return Option.none();
      }
      try {
        return Option.some(decodeCachedPrescription(box.value));
      } catch {
        // Unknown/corrupt schema version — treat as empty rather than fail
        // the whole load (mirrors the outbox's per-row decode tolerance).
        return Option.none();
      }
    }),
    write: (entry) =>
      Effect.sync(() => {
        box.value = encodeCachedPrescription(entry);
      }),
    clear: Effect.sync(() => {
      box.value = undefined;
    }),
  };
}
