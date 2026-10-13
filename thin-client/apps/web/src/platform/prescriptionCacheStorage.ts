import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Prescription } from "@repcoach/client-runtime";

import { kvDelete, kvGet, kvPut, PRESCRIPTION_CACHE_STORE } from "./indexedDb.ts";

/**
 * DOM platform seam for the prescription prefetch cache's storage (#50,
 * absorbing #51). This superseded the retired native/Expo client's
 * AsyncStorage adapter (ADR 0012, #53); the web client is now the only
 * client.
 *
 * Lower stakes than the outbox — this is a display cache, and losing it
 * costs a re-fetch rather than a logged set — but it shares the outbox's
 * IndexedDB database so there is one schema-upgrade path rather than two
 * storage technologies (see `./indexedDb.ts`). It still has to survive a tab
 * kill and reload: that is the whole of ADR 0009 gate 3 (offline prefetch),
 * covered by `g3-offline-prefetch`.
 *
 * Single-slot, as before: only one in-flight workout's prescription is kept
 * at a time. Decode failure is treated as an empty cache rather than an
 * error, mirroring `makeInMemoryPrescriptionCacheStorage` — a stale row from
 * an older schema should send the client back to the server, not wedge it.
 * Transport failures *are* typed, using the `PrescriptionCacheStorageError`
 * already declared alongside the seam and previously unused.
 */
const CURRENT_SLOT = "current";

export const indexedDbPrescriptionCacheStorage: Prescription.PrescriptionCacheStorage = {
  load: Effect.tryPromise({
    try: async () => {
      const raw = await kvGet(PRESCRIPTION_CACHE_STORE, CURRENT_SLOT);
      if (raw === undefined) {
        return Option.none();
      }
      try {
        return Option.some(Prescription.decodeCachedPrescription(raw));
      } catch (cause) {
        console.warn("[prescription-cache] ignored invalid persisted row", cause);
        return Option.none();
      }
    },
    catch: (cause) => new Prescription.PrescriptionCacheStorageError({ operation: "load", cause }),
  }),

  write: (entry) =>
    Effect.tryPromise({
      try: () =>
        kvPut(
          PRESCRIPTION_CACHE_STORE,
          CURRENT_SLOT,
          Prescription.encodeCachedPrescription(entry),
        ),
      catch: (cause) =>
        new Prescription.PrescriptionCacheStorageError({ operation: "write", cause }),
    }),

  clear: Effect.tryPromise({
    try: () => kvDelete(PRESCRIPTION_CACHE_STORE, CURRENT_SLOT),
    catch: (cause) => new Prescription.PrescriptionCacheStorageError({ operation: "clear", cause }),
  }),
};
