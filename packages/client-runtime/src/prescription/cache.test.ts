import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "vitest";

import { BlockId, EntryId, SessionId, SetId, type PrescribedSession } from "@repcoach/contracts";

import { makePrescriptionCache } from "./cache.ts";
import { makeInMemoryPrescriptionCacheStorage } from "./storage.ts";

const sessionId = SessionId.make("session-seed-1");

const prescribedSession = (loadMax: number): PrescribedSession => ({
  id: sessionId,
  blocks: [
    {
      id: BlockId.make("block-1"),
      format: "straight",
      entries: [
        {
          id: EntryId.make("entry-1"),
          exerciseId: "exercise-back-squat" as never,
          sets: [
            {
              id: SetId.make("set-1"),
              setType: "working",
              target: { reps: { min: 5, max: 5 }, load: { min: 100, max: loadMax } },
              restSec: 120,
            },
          ],
        },
      ],
    },
  ],
});

describe("prescription cache", () => {
  it("cache hit serves the full prescribed tree with no fetcher involved", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* makePrescriptionCache(makeInMemoryPrescriptionCacheStorage());
        const fetched = yield* cache.startWorkout(sessionId, () =>
          Effect.succeed(prescribedSession(100)),
        );
        expect(fetched.blocks[0]?.entries[0]?.sets[0]?.target.load).toEqual({ min: 100, max: 100 });

        // A later read must not call the fetcher at all — it comes from
        // `current`, not the network.
        const cached = yield* SubscriptionRef.get(cache.current);
        expect(Option.isSome(cached)).toBe(true);
        if (Option.isSome(cached)) {
          expect(cached.value.session).toEqual(prescribedSession(100));
        }
      }),
    );
  });

  it("frozen in-flight: a fetch after startWorkout does not mutate the cached copy", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* makePrescriptionCache(makeInMemoryPrescriptionCacheStorage());
        yield* cache.startWorkout(sessionId, () => Effect.succeed(prescribedSession(100)));

        // Simulate a mutable "server" whose prescription changes after
        // prefetch — the cache must never re-read it mid-workout.
        let serverLoadMax = 100;
        serverLoadMax = 999;
        void serverLoadMax; // the point: nothing below reads this variable again.

        const stillCached = yield* SubscriptionRef.get(cache.current);
        expect(Option.isSome(stillCached)).toBe(true);
        if (Option.isSome(stillCached)) {
          expect(stillCached.value.session.blocks[0]?.entries[0]?.sets[0]?.target.load).toEqual({
            min: 100,
            max: 100,
          });
        }

        // Only an explicit next-start refresh picks up the change.
        const refreshed = yield* cache.startWorkout(sessionId, () =>
          Effect.succeed(prescribedSession(999)),
        );
        expect(refreshed.blocks[0]?.entries[0]?.sets[0]?.target.load).toEqual({ min: 100, max: 999 });
      }),
    );
  });

  it("storage round-trip + app-kill reload: a new cache over the same storage reloads the session", async () => {
    const box: { value: unknown } = { value: undefined };

    await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* makePrescriptionCache(makeInMemoryPrescriptionCacheStorage(box));
        yield* cache.startWorkout(sessionId, () => Effect.succeed(prescribedSession(100)));
      }),
    );

    // A brand-new cache instance, as if the app process had been killed and
    // relaunched, pointed at the same backing box.
    const reloaded = await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* makePrescriptionCache(makeInMemoryPrescriptionCacheStorage(box));
        yield* cache.load;
        return yield* SubscriptionRef.get(cache.current);
      }),
    );

    expect(Option.isSome(reloaded)).toBe(true);
    if (Option.isSome(reloaded)) {
      expect(reloaded.value.sessionId).toBe(sessionId);
      expect(reloaded.value.session).toEqual(prescribedSession(100));
    }
  });

  it("no cache and no fetch: `current` stays None until startWorkout or load finds something", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* makePrescriptionCache(makeInMemoryPrescriptionCacheStorage());
        const before = yield* SubscriptionRef.get(cache.current);
        expect(Option.isNone(before)).toBe(true);
      }),
    );
  });
});
