import * as Schema from "effect/Schema";

import { IsoDateTime, PrescribedSession, SessionId } from "@repcoach/contracts";

/**
 * Task 5 (issue #19, G3) — the durable prefetch cache's persisted row.
 * Mirrors the outbox's schema-versioned storage discipline
 * (`../outbox/model.ts`): every write re-stamps the current version, decode
 * tolerates the legacy shape, and the durable copy is a plain data snapshot
 * — no reference back to server/store internals — so a later server-side
 * prescription edit can never reach through it (ADR 0006/0007, "copy on
 * instantiate").
 */
export const PRESCRIPTION_CACHE_SCHEMA_VERSION = 1;

const StoredCachedPrescriptionSchema = Schema.Struct({
  schemaVersion: Schema.Literals([PRESCRIPTION_CACHE_SCHEMA_VERSION]),
  sessionId: SessionId,
  session: PrescribedSession,
  cachedAt: IsoDateTime,
});

/** A durably-cached Prescribed Session — the frozen copy an in-flight workout reads from. */
export interface CachedPrescription {
  readonly sessionId: SessionId;
  readonly session: PrescribedSession;
  readonly cachedAt: string;
}

const decodeStoredCachedPrescription = Schema.decodeUnknownSync(StoredCachedPrescriptionSchema);
const encodeStoredCachedPrescription = Schema.encodeUnknownSync(StoredCachedPrescriptionSchema);

/** Throws on an unknown/corrupt schema version — callers should treat the cache as empty. */
export function decodeCachedPrescription(value: unknown): CachedPrescription {
  const { schemaVersion: _schemaVersion, ...entry } = decodeStoredCachedPrescription(value);
  return entry;
}

export function encodeCachedPrescription(entry: CachedPrescription): unknown {
  return encodeStoredCachedPrescription({
    schemaVersion: PRESCRIPTION_CACHE_SCHEMA_VERSION,
    ...entry,
  });
}

export function buildCachedPrescription(
  sessionId: SessionId,
  session: PrescribedSession,
  cachedAt: string = new Date().toISOString(),
): CachedPrescription {
  return { sessionId, session, cachedAt };
}
