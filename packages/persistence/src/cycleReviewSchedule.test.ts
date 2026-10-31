import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { SqlStore } from "./sqlStore.ts";
import { MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS, Store } from "./store.ts";

/**
 * The monthly Cycle-review schedule's storage (ADR 0011 §4, issue #91),
 * proven against BOTH `Store` layers behind the shared tag: the in-memory
 * `Store.layer` and the durable `SqlStore.layer` (migration `011`).
 *
 * The durability leg is the whole reason the schedule lives in a table rather
 * than in a process's memory: the coach runs on an always-on home server that
 * reboots (ADR 0005), and a monthly timer that resets on every boot never
 * fires. So the tests below are about survival and exclusivity, not arithmetic
 * — a claim must survive a restart, a missed window must still be claimable
 * after one, and one due window must be claimable exactly once.
 */

const HOUR = 60 * 60 * 1000;

const BASE = "2026-01-01T00:00:00.000Z";
const at = (offsetMillis: number): string => new Date(Date.parse(BASE) + offsetMillis).toISOString();

const monthly = (now: string) => ({ now, intervalMillis: MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS });

const tempDbPath = (): string =>
  path.join(os.tmpdir(), `repcoach-cycle-schedule-${randomUUID()}.sqlite`);

const cleanupDbFile = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

/** Builds a FRESH `SqlStore` over `dbPath` — i.e. a server restart. */
const runAgainstFreshLayer = <A, E>(dbPath: string, effect: Effect.Effect<A, E, Store>): Promise<A> =>
  effect.pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);

describe.each([
  ["in-memory Store", <A, E>(_db: string, e: Effect.Effect<A, E, Store>) =>
    e.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise)],
  ["SqlStore", runAgainstFreshLayer],
] as const)("Cycle-review schedule claims — %s (ADR 0011 §4, issue #91)", (_name, run) => {
  it("a fresh schedule claims nothing — it just starts the clock", async () => {
    const dbPath = tempDbPath();
    try {
      const claim = await run(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.claimDueCycleReview(monthly(BASE));
        }),
      );
      // Standing a server up must not immediately spend subscription quota on
      // a Cycle review of a history that does not exist yet.
      expect(claim.claimed).toBe(false);
      expect(claim.lastRunAt).toBe(BASE);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("nothing is due before the month is up, and the window is claimed once it is", async () => {
    const dbPath = tempDbPath();
    try {
      const result = await run(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.claimDueCycleReview(monthly(BASE));
          const midMonth = yield* store.claimDueCycleReview(monthly(at(15 * 24 * HOUR)));
          const due = yield* store.claimDueCycleReview(
            monthly(at(MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS)),
          );
          return { midMonth, due };
        }),
      );
      expect(result.midMonth.claimed).toBe(false);
      expect(result.due.claimed).toBe(true);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("one due window is claimable exactly ONCE — two ticks cannot both fire it", async () => {
    const dbPath = tempDbPath();
    try {
      const claims = await run(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.claimDueCycleReview(monthly(BASE));
          const overdue = at(MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS + HOUR);
          // Two ticks against the SAME due window, back to back.
          const first = yield* store.claimDueCycleReview(monthly(overdue));
          const second = yield* store.claimDueCycleReview(monthly(overdue));
          return [first.claimed, second.claimed];
        }),
      );
      expect(claims).toEqual([true, false]);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("a claim moves the schedule forward — the next window is a month from the CLAIM", async () => {
    const dbPath = tempDbPath();
    try {
      const result = await run(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.claimDueCycleReview(monthly(BASE));
          const claimedAt = at(MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS);
          yield* store.claimDueCycleReview(monthly(claimedAt));
          // A month after the ORIGINAL start, but only an hour after the claim.
          const tooSoon = yield* store.claimDueCycleReview(
            monthly(at(MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS + HOUR)),
          );
          const nextMonth = yield* store.claimDueCycleReview(
            monthly(at(2 * MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS)),
          );
          return { tooSoon, nextMonth };
        }),
      );
      expect(result.tooSoon.claimed).toBe(false);
      expect(result.nextMonth.claimed).toBe(true);
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});

describe("Cycle-review schedule survives restarts (issue #91)", () => {
  it("a restart does NOT reset the interval — a just-claimed window stays claimed across reopens", async () => {
    const dbPath = tempDbPath();
    try {
      await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.claimDueCycleReview(monthly(BASE));
          const claim = yield* store.claimDueCycleReview(
            monthly(at(MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS)),
          );
          expect(claim.claimed).toBe(true);
        }),
      );

      // Restart #1, #2, #3 — a fresh process each time, all within the month.
      for (const restart of [1, 2, 3]) {
        const claim = await runAgainstFreshLayer(
          dbPath,
          Effect.gen(function* () {
            const store = yield* Store;
            return yield* store.claimDueCycleReview(
              monthly(at(MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS + restart * HOUR)),
            );
          }),
        );
        // A memory-held timer would restart the month here and fire again (or,
        // resetting on every boot, never fire at all). The persisted timestamp
        // is what makes a reboot a non-event.
        expect(claim.claimed).toBe(false);
      }
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("a boot after a MISSED window runs the review rather than skipping it", async () => {
    const dbPath = tempDbPath();
    try {
      await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.claimDueCycleReview(monthly(BASE));
        }),
      );

      // The server was DOWN across the whole due window and boots two months
      // late. The window is still owed, so this boot claims it.
      const claim = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.claimDueCycleReview(
            monthly(at(2 * MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS + 5 * HOUR)),
          );
        }),
      );
      expect(claim.claimed).toBe(true);
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});
