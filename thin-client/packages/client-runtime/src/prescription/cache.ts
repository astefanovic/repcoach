import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { PrescribedSession, SessionId } from "@repcoach/contracts";

import { buildCachedPrescription, type CachedPrescription } from "./model.ts";
import type { PrescriptionCacheStorage } from "./storage.ts";

/**
 * The prescription prefetch cache (Task 5, issue #19, G3): on a connected
 * "Start workout", fetches the Prescribed Session once and durably caches
 * it; every read a workout needs thereafter (prescribed targets, ghost-text
 * source, prescribed rest) comes from `current` — no network dependency
 * between sets. Mirrors the outbox manager's (`../outbox/manager.ts`)
 * persist-before-reflect discipline.
 *
 * **Frozen in-flight (ADR 0006/0007):** `startWorkout` is the *only* place
 * that overwrites `current`/storage. A server-side prescription edit made
 * after prefetch has no path back into an already-cached copy — the fetched
 * `PrescribedSession` is a fresh value decoded off the wire, not a live
 * reference, so nothing later mutates it in place. The cache only refreshes
 * on the *next* connected `startWorkout` call, exactly matching "instantiation
 * is a copy" for the minimal Plan (ADR 0007).
 */
export interface PrescriptionCache {
  readonly current: SubscriptionRef.SubscriptionRef<Option.Option<CachedPrescription>>;
  /** Reloads whatever was left in durable storage — the "app kill and relaunch" path. */
  readonly load: Effect.Effect<void, unknown>;
  /**
   * Fetches `sessionId` via `fetchPrescribedSession` (only meaningful while
   * connected — callers should gate this on the supervisor's session being
   * `Some`) and durably caches the result, replacing whatever was cached
   * before. Returns the freshly cached session.
   */
  readonly startWorkout: (
    sessionId: SessionId,
    fetchPrescribedSession: (sessionId: SessionId) => Effect.Effect<PrescribedSession, unknown>,
  ) => Effect.Effect<PrescribedSession, unknown>;
}

export const makePrescriptionCache = Effect.fn("Prescription.makePrescriptionCache")(function* (
  storage: PrescriptionCacheStorage,
) {
  const current = yield* SubscriptionRef.make<Option.Option<CachedPrescription>>(Option.none());

  const load: Effect.Effect<void, unknown> = Effect.gen(function* () {
    const persisted = yield* storage.load;
    yield* SubscriptionRef.set(current, persisted);
  });

  const startWorkout = (
    sessionId: SessionId,
    fetchPrescribedSession: (sessionId: SessionId) => Effect.Effect<PrescribedSession, unknown>,
  ): Effect.Effect<PrescribedSession, unknown> =>
    Effect.gen(function* () {
      const session = yield* fetchPrescribedSession(sessionId);
      const entry = buildCachedPrescription(sessionId, session);
      // Persist BEFORE reflecting — same discipline as the outbox (see
      // `../outbox/manager.ts`): a crash between the two steps never leaves
      // the in-memory `current` out of sync with what a reload would see.
      yield* storage.write(entry);
      yield* SubscriptionRef.set(current, Option.some(entry));
      return session;
    });

  return { current, load, startWorkout } satisfies PrescriptionCache;
});
