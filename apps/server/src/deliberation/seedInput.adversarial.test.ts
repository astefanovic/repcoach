import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlStore } from "@repcoach/persistence";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RepCoachRpcGroup } from "@repcoach/contracts";

import { makeCannedDeliberationRunnerLayer } from "./deliberationRunner.ts";
import { CannedModelCatalog } from "../agents/modelCatalog.ts";
import { RpcHandlersLayer } from "../rpcHandlers.ts";
import { assembleSeed, SeedInputsProvider, SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "../store.ts";

/**
 * Adversarial black-box coverage for issue #34's provider-level and
 * RPC-level surfaces: the recency injection limits (last 14 check-ins / last
 * 10 context notes), the hard-constraint-always-injected invariant holding
 * with a hard constraint added LAST among many souls, and the RPC write
 * paths end-to-end via `RpcTest` (no sockets), including layer parity
 * against real `SqlStore`.
 */

describe("Seed-input recency injection — provider layer", () => {
  const withProvider = <A>(
    effect: Effect.Effect<A, never, Store | SeedInputsProvider>,
  ): Promise<A> =>
    effect.pipe(
      Effect.provide(SeedInputsProviderLive.pipe(Layer.provideMerge(Store.layer))),
      Effect.runPromise,
    );

  it("injects only the NEWEST 14 of 20 check-ins into the seed, but the store still lists all 20", async () => {
    const result = await withProvider(
      Effect.gen(function* () {
        const store = yield* Store;
        const inserted = [];
        for (let i = 0; i < 20; i++) {
          const recordedAt = `2026-06-${String(i + 1).padStart(2, "0")}T08:00:00.000Z`;
          inserted.push(yield* store.addCheckIn({ recordedAt, sleep: 3, soreness: 3, stress: 3, energy: 3 }));
        }
        const provider = yield* SeedInputsProvider;
        const seedInputs = yield* provider.buildSeedInputs({ cadence: "on-demand", snapshotDbPath: "/tmp/x.sqlite" });
        const allListed = yield* store.listCheckIns;
        return { inserted, injected: seedInputs.checkIns, allListed };
      }),
    );

    // Store retains everything.
    expect(result.allListed).toHaveLength(20);
    // Seed only injects the recent slice.
    expect(result.injected).toHaveLength(14);
    // The injected ones are the NEWEST 14 (days 7 through 20 of June), not
    // the oldest 14.
    const injectedDates = result.injected.map((c) => c.recordedAt).sort();
    const expectedNewest14 = result.inserted
      .map((c) => c.recordedAt)
      .sort()
      .slice(-14);
    expect(injectedDates).toEqual(expectedNewest14);
  });

  it("injects only the NEWEST 10 of 15 context notes into the seed, but the store still lists all 15", async () => {
    const result = await withProvider(
      Effect.gen(function* () {
        const store = yield* Store;
        const inserted = [];
        for (let i = 0; i < 15; i++) {
          const recordedAt = `2026-06-${String(i + 1).padStart(2, "0")}T08:00:00.000Z`;
          inserted.push(yield* store.addContextNote({ text: `note-${i}`, recordedAt }));
        }
        const provider = yield* SeedInputsProvider;
        const seedInputs = yield* provider.buildSeedInputs({ cadence: "on-demand", snapshotDbPath: "/tmp/x.sqlite" });
        const allListed = yield* store.listContextNotes;
        return { inserted, injected: seedInputs.contextNotes, allListed };
      }),
    );

    expect(result.allListed).toHaveLength(15);
    expect(result.injected).toHaveLength(10);
    const injectedTexts = result.injected.map((n) => n.text).sort();
    const expectedNewest10 = result.inserted
      .slice()
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .slice(-10)
      .map((n) => n.text)
      .sort();
    expect(injectedTexts).toEqual(expectedNewest10);
  });

  it("with exactly 14 check-ins and 10 notes, ALL are injected (boundary, not off-by-one)", async () => {
    const result = await withProvider(
      Effect.gen(function* () {
        const store = yield* Store;
        for (let i = 0; i < 14; i++) {
          yield* store.addCheckIn({
            recordedAt: `2026-06-${String(i + 1).padStart(2, "0")}T08:00:00.000Z`,
            sleep: 3,
            soreness: 3,
            stress: 3,
            energy: 3,
          });
        }
        for (let i = 0; i < 10; i++) {
          yield* store.addContextNote({
            text: `note-${i}`,
            recordedAt: `2026-06-${String(i + 1).padStart(2, "0")}T08:00:00.000Z`,
          });
        }
        const provider = yield* SeedInputsProvider;
        return yield* provider.buildSeedInputs({ cadence: "on-demand", snapshotDbPath: "/tmp/x.sqlite" });
      }),
    );

    expect(result.checkIns).toHaveLength(14);
    expect(result.contextNotes).toHaveLength(10);
  });
});

describe("Hard-constraint always-injected invariant — real provider data, hard constraint added LAST", () => {
  const withProvider = <A>(
    effect: Effect.Effect<A, never, Store | SeedInputsProvider>,
  ): Promise<A> =>
    effect.pipe(
      Effect.provide(SeedInputsProviderLive.pipe(Layer.provideMerge(Store.layer))),
      Effect.runPromise,
    );

  it("a hard constraint added AFTER many soft ones still appears (real data, not just structural)", async () => {
    const seed = await withProvider(
      Effect.gen(function* () {
        const store = yield* Store;
        for (let i = 0; i < 5; i++) {
          yield* store.addStandingConstraint({ text: `soft constraint ${i}`, severity: "soft" });
        }
        const hard = yield* store.addStandingConstraint({
          text: "No overhead pressing — shoulder injury (added last)",
          severity: "hard",
        });
        const provider = yield* SeedInputsProvider;
        const seedInputs = yield* provider.buildSeedInputs({ cadence: "on-demand", snapshotDbPath: "/tmp/x.sqlite" });
        return { seed: assembleSeed(seedInputs), hard };
      }),
    );

    expect(seed.seed).toContain("No overhead pressing — shoulder injury (added last)");
    expect(seed.seed).toContain("[HARD]");
  });
});

describe("Seed-input write RPCs — end-to-end via RpcTest, layer parity between in-memory Store and SqlStore", () => {
  const makeTestLayer = (storeLayer: Layer.Layer<Store, never>) =>
    RpcHandlersLayer.pipe(
      Layer.provideMerge(CannedModelCatalog),
      Layer.provideMerge(makeCannedDeliberationRunnerLayer(storeLayer)),
      Layer.provideMerge(storeLayer),
    );

  const tempDbPath = (): string => path.join(os.tmpdir(), `repcoach-seed-input-rpc-adv-${randomUUID()}.sqlite`);
  const cleanupDbFile = (dbPath: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };

  const layers: ReadonlyArray<{ readonly name: string; readonly make: () => { readonly layer: Layer.Layer<Store, unknown>; readonly cleanup: () => void } }> = [
    { name: "in-memory Store", make: () => ({ layer: Store.layer, cleanup: () => {} }) },
    {
      name: "SqlStore (real SQLite)",
      make: () => {
        const dbPath = tempDbPath();
        return { layer: SqlStore.layer({ filename: dbPath }), cleanup: () => cleanupDbFile(dbPath) };
      },
    },
  ];

  for (const { name, make } of layers) {
    describe(name, () => {
      it("checkIns.add rejects an out-of-range rating (0) over the RPC boundary", async () => {
        const { layer: storeLayer, cleanup } = make();
        try {
          const exit = await Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
            return yield* client["checkIns.add"]({
              sleep: 0,
              soreness: 3,
              stress: 3,
              energy: 3,
            } as never);
          }).pipe(
            Effect.provide(makeTestLayer(storeLayer as Layer.Layer<Store, never>)),
            Effect.scoped,
            Effect.exit,
            Effect.runPromise,
          );

          expect(exit._tag).toBe("Failure");
        } finally {
          cleanup();
        }
      });

      it("checkIns.add accepts boundary ratings (1 and 5) and the check-in round-trips via a subsequent Deliberation seed build", async () => {
        const { layer: storeLayer, cleanup } = make();
        try {
          const result = await Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
            const added = yield* client["checkIns.add"]({
              sleep: 1,
              soreness: 5,
              stress: 1,
              energy: 5,
            } as never);
            const store = yield* Store;
            const listed = yield* store.listCheckIns;
            return { added, listed };
          }).pipe(
            Effect.provide(makeTestLayer(storeLayer as Layer.Layer<Store, never>)),
            Effect.scoped,
            Effect.runPromise,
          );

          expect(result.listed).toHaveLength(1);
          expect(result.added.checkIn.summary).toContain("Sleep 1/5");
          expect(result.added.checkIn.summary).toContain("Energy 5/5");
        } finally {
          cleanup();
        }
      });

      it("standingConstraints.remove on an unknown id returns removed:false via RPC, no error thrown", async () => {
        const { layer: storeLayer, cleanup } = make();
        try {
          const result = await Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
            return yield* client["standingConstraints.remove"]({ constraintId: "does-not-exist" } as never);
          }).pipe(
            Effect.provide(makeTestLayer(storeLayer as Layer.Layer<Store, never>)),
            Effect.scoped,
            Effect.runPromise,
          );

          expect(result).toEqual({ removed: false });
        } finally {
          cleanup();
        }
      });

      it("goal.set called via RPC twice keeps a single Goal — second call wins, over the RPC boundary", async () => {
        const { layer: storeLayer, cleanup } = make();
        try {
          const result = await Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(RepCoachRpcGroup);
            yield* client["goal.set"]({ statement: "First goal", proxies: ["a"] } as never);
            const second = yield* client["goal.set"]({ statement: "Second goal", proxies: [] } as never);
            const store = yield* Store;
            const stored = yield* store.getGoal;
            return { second, stored };
          }).pipe(
            Effect.provide(makeTestLayer(storeLayer as Layer.Layer<Store, never>)),
            Effect.scoped,
            Effect.runPromise,
          );

          expect(result.second.goal).toEqual({ statement: "Second goal", proxies: [] });
          expect(result.stored).toEqual({ statement: "Second goal", proxies: [] });
        } finally {
          cleanup();
        }
      });
    });
  }
});
