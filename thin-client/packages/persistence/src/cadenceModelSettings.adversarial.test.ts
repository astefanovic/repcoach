import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  type DeliberationCadence,
  GetCadenceModelInput,
  SetCadenceModelInput,
} from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/**
 * ADVERSARIAL per-cadence model settings coverage (ADR 0011 §4, issue #31 —
 * 2B slice 6), probing the seams the happy-path `cadenceModelSettings.test.ts`
 * does NOT reach:
 *
 * - the CONTRACT is the only validation boundary — `SetCadenceModelInput`
 *   rejects a garbage cadence and an empty model, but (matching the rest of
 *   the codebase) does NOT trim, so a whitespace-only model slips through;
 * - the Store layers themselves do NOT re-validate the cadence key (typed,
 *   not runtime-guarded) — a cast-in garbage cadence round-trips, pinning that
 *   the trust boundary lives at the RPC/schema edge, not the store;
 * - the `on-demand` cadence is a first-class, independently-configurable
 *   cadence too (three cadences, no cross-talk);
 * - migration `004` is NON-DESTRUCTIVE on a populated DB and last-write-wins
 *   survives repeated process restarts (multiple SqlStore reopens).
 */

const tempDbPath = (): string =>
  path.join(os.tmpdir(), `repcoach-cadence-model-adv-${randomUUID()}.sqlite`);

const cleanupDbFile = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

const runAgainstFreshLayer = <A, E>(dbPath: string, effect: Effect.Effect<A, E, Store>): Promise<A> =>
  effect.pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);

// --- contract-level validation (the sole trust boundary) -------------------

describe("SetCadenceModelInput / GetCadenceModelInput decode guards (issue #31)", () => {
  const decodeSetExit = Schema.decodeUnknownExit(SetCadenceModelInput);
  const decodeGetExit = Schema.decodeUnknownExit(GetCadenceModelInput);

  it("rejects an unknown/garbage cadence key — only the three literal cadences are valid", () => {
    expect(decodeSetExit({ cadence: "weekly-review", model: "model-x" })._tag).toBe("Failure");
    expect(decodeSetExit({ cadence: "", model: "model-x" })._tag).toBe("Failure");
    expect(decodeGetExit({ cadence: "monthly" })._tag).toBe("Failure");
  });

  it("accepts each of the three real cadences", () => {
    for (const cadence of ["session-review", "cycle-review", "on-demand"] as const) {
      expect(decodeSetExit({ cadence, model: "model-x" })._tag).toBe("Success");
      expect(decodeGetExit({ cadence })._tag).toBe("Success");
    }
  });

  it("rejects an empty model id — a cadence with no model is expressed by ABSENCE, never an empty string", () => {
    expect(decodeSetExit({ cadence: "cycle-review", model: "" })._tag).toBe("Failure");
  });

  // NOTE: despite its name, `TrimmedNonEmptyString` (packages/contracts/src/
  // baseSchemas.ts) does NOT trim — it only checks `Schema.isNonEmpty()`. This
  // is shared infra predating this slice, so this pins the ACTUAL behavior: a
  // whitespace-only model decodes successfully and would be stored/passed to
  // the deliberator verbatim. Documented, not asserted-as-rejected.
  it("a whitespace-only model currently DECODES SUCCESSFULLY — the shared schema does not trim", () => {
    expect(decodeSetExit({ cadence: "cycle-review", model: "   " })._tag).toBe("Success");
  });

  it("rejects a missing cadence field outright", () => {
    expect(decodeSetExit({ model: "model-x" })._tag).toBe("Failure");
    expect(decodeGetExit({})._tag).toBe("Failure");
  });
});

// --- Store layers: no runtime cadence validation below the contract --------

describe("per-cadence model settings — Store-layer adversarial (issue #31)", () => {
  it("the on-demand cadence is independently configurable — three cadences, no cross-talk (in-memory)", async () => {
    const result = await Effect.gen(function* () {
      const store = yield* Store;
      yield* store.setCadenceModel({ cadence: "on-demand", model: "model-ondemand" });
      yield* store.setCadenceModel({ cadence: "session-review", model: "model-session" });
      yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-cycle" });
      return {
        onDemand: yield* store.getCadenceModel("on-demand"),
        session: yield* store.getCadenceModel("session-review"),
        cycle: yield* store.getCadenceModel("cycle-review"),
      };
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(result.onDemand).toEqual({ model: "model-ondemand", effort: undefined });
    expect(result.session).toEqual({ model: "model-session", effort: undefined });
    expect(result.cycle).toEqual({ model: "model-cycle", effort: undefined });
  });

  it("neither Store layer re-validates the cadence key — a cast-in garbage cadence round-trips (trust boundary is the contract, not the store)", async () => {
    const garbage = "totally-made-up-cadence" as DeliberationCadence;

    const inMemory = await Effect.gen(function* () {
      const store = yield* Store;
      yield* store.setCadenceModel({ cadence: garbage, model: "model-garbage" });
      return yield* store.getCadenceModel(garbage);
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);
    expect(inMemory).toEqual({ model: "model-garbage", effort: undefined });

    const dbPath = tempDbPath();
    try {
      const durable = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.setCadenceModel({ cadence: garbage, model: "model-garbage" });
          return yield* store.getCadenceModel(garbage);
        }),
      );
      expect(durable).toEqual({ model: "model-garbage", effort: undefined });
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});

// --- durability / migration non-destructiveness ----------------------------

describe("per-cadence model settings — durability across restarts (issue #31)", () => {
  it("last-write-wins survives REPEATED reopens (set v1 → reopen → set v2 → reopen → v2)", async () => {
    const dbPath = tempDbPath();
    try {
      await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-v1" });
        }),
      );
      const afterFirst = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const before = yield* store.getCadenceModel("cycle-review");
          yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-v2" });
          return before;
        }),
      );
      const afterSecond = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getCadenceModel("cycle-review");
        }),
      );

      expect(afterFirst).toEqual({ model: "model-v1", effort: undefined }); // v1 survived the first restart
      expect(afterSecond).toEqual({ model: "model-v2", effort: undefined }); // v2 (last write) survived the second
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("migration 004 is NON-DESTRUCTIVE — seeded slice-1 data (evidence roster) coexists with the cadence-model row across a reopen", async () => {
    const dbPath = tempDbPath();
    try {
      // A fresh SqlStore auto-seeds the evidence roster; write a cadence model
      // ON TOP of that populated DB.
      const seededRosterLen = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const roster = yield* store.listEvidenceRoster;
          yield* store.setCadenceModel({ cadence: "cycle-review", model: "model-durable" });
          return roster.length;
        }),
      );
      expect(seededRosterLen).toBeGreaterThan(0);

      // Reopen (DB not empty → NO reseed): both the pre-existing seeded data
      // AND the new cadence-model row must still be there.
      const reread = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return {
            rosterLen: (yield* store.listEvidenceRoster).length,
            model: yield* store.getCadenceModel("cycle-review"),
          };
        }),
      );

      expect(reread.rosterLen).toBe(seededRosterLen); // no data loss from migration 004
      expect(reread.model).toEqual({ model: "model-durable", effort: undefined });
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});
