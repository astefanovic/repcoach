import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { summarizeRunLedger, type RunLedgerRecord } from "./store.ts";
import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/**
 * The run ledger (ADR 0011 §8 amendment, issue #81) — a persisted row per
 * agent SESSION, not per run, proven against BOTH `Store` layers behind the
 * shared tag (migration `012`). This is the regression coverage for bug 2
 * named in the issue: the adversarial sweep used to write no usage row at
 * all, so its cost was invisible; every stage recorded here proves that no
 * longer holds.
 */

const tempDbPath = (): string => path.join(os.tmpdir(), `repcoach-run-ledger-${randomUUID()}.sqlite`);

const cleanupDbFile = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

const runAgainstFreshLayer = <A, E>(dbPath: string, effect: Effect.Effect<A, E, Store>): Promise<A> =>
  effect.pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);

describe("the run ledger — per-stage rows (ADR 0011 §8 amendment, issue #81)", () => {
  it("in-memory Store: recordRunLedgerRow appends one row per agent session, readable back through getSpendSummary", async () => {
    const summary = await Effect.gen(function* () {
      const store = yield* Store;
      yield* store.recordRunLedgerRow({
        runId: "run-1",
        cadence: "session-review",
        stage: "deliberator",
        model: "model-a",
        usage: { input: 1000, output: 200, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0.05,
      });
      yield* store.recordRunLedgerRow({
        runId: "run-1",
        cadence: "session-review",
        stage: "sweep",
        model: "model-a",
        usage: { input: 300, output: 100, cacheRead: 50, cacheCreation: 0 },
        costUsd: 0.01,
      });
      return yield* store.getSpendSummary;
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(summary.perCadence).toEqual([
      {
        cadence: "session-review",
        runCount: 1,
        usage: { input: 1300, output: 300, cacheRead: 50, cacheCreation: 0 },
      },
    ]);
    expect(summary.recentRuns).toHaveLength(1);
    const run = summary.recentRuns[0];
    expect(run?.runId).toBe("run-1");
    expect(run?.model).toBe("model-a");
    expect(run?.usage).toEqual({ input: 1300, output: 300, cacheRead: 50, cacheCreation: 0 });
    expect(run?.stages).toHaveLength(2);
    expect(run?.stages.map((s) => s.stage).sort()).toEqual(["deliberator", "sweep"]);
  });

  it("in-memory Store: runCount is DISTINCT run ids, not row count — a run is a deliberator session plus a sweep session", async () => {
    const summary = await Effect.gen(function* () {
      const store = yield* Store;
      for (const runId of ["run-1", "run-2"]) {
        yield* store.recordRunLedgerRow({
          runId,
          cadence: "cycle-review",
          stage: "deliberator",
          model: "model-a",
          usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
          costUsd: 0,
        });
        yield* store.recordRunLedgerRow({
          runId,
          cadence: "cycle-review",
          stage: "sweep",
          model: "model-a",
          usage: { input: 2, output: 1, cacheRead: 0, cacheCreation: 0 },
          costUsd: 0,
        });
      }
      return yield* store.getSpendSummary;
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(summary.perCadence).toEqual([
      {
        cadence: "cycle-review",
        runCount: 2, // NOT 4 — one per run, not one per row
        usage: { input: 24, output: 12, cacheRead: 0, cacheCreation: 0 },
      },
    ]);
  });

  it("in-memory Store: separates cold-draft tokens from per-turn tokens for one Intake session (UAT watchlist entry 2)", async () => {
    const summary = await Effect.gen(function* () {
      const store = yield* Store;
      const intakeSessionId = "intake-session-1";
      yield* store.recordRunLedgerRow({
        runId: intakeSessionId,
        cadence: "intake",
        stage: "intake-draft",
        model: "model-a",
        usage: { input: 4200, output: 900, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0,
      });
      yield* store.recordRunLedgerRow({
        runId: intakeSessionId,
        cadence: "intake",
        stage: "intake-turn",
        model: "model-a",
        usage: { input: 380, output: 120, cacheRead: 200, cacheCreation: 0 },
        costUsd: 0,
      });
      yield* store.recordRunLedgerRow({
        runId: intakeSessionId,
        cadence: "intake",
        stage: "intake-turn",
        model: "model-a",
        usage: { input: 200, output: 80, cacheRead: 300, cacheCreation: 0 },
        costUsd: 0,
      });
      yield* store.recordRunLedgerRow({
        runId: intakeSessionId,
        cadence: "intake",
        stage: "sweep",
        model: "model-a",
        usage: { input: 500, output: 200, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0,
      });
      return yield* store.getSpendSummary;
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(summary.perCadence).toEqual([{ cadence: "intake", runCount: 1, usage: expect.any(Object) }]);
    const run = summary.recentRuns[0];
    expect(run?.stages).toHaveLength(3); // draft, turn (summed across both turns), sweep
    const draft = run?.stages.find((s) => s.stage === "intake-draft");
    const turn = run?.stages.find((s) => s.stage === "intake-turn");
    const sweep = run?.stages.find((s) => s.stage === "sweep");
    expect(draft?.usage).toEqual({ input: 4200, output: 900, cacheRead: 0, cacheCreation: 0 });
    // Both turns summed into one entry — the comparison a client actually draws.
    expect(turn?.usage).toEqual({ input: 580, output: 200, cacheRead: 500, cacheCreation: 0 });
    expect(sweep?.usage).toEqual({ input: 500, output: 200, cacheRead: 0, cacheCreation: 0 });
  });

  it("in-memory Store: getSpendSummary caps the recent-runs list at RECENT_RUNS_LIMIT, newest first", async () => {
    const runs = await Effect.gen(function* () {
      const store = yield* Store;
      for (let i = 0; i < 20; i += 1) {
        yield* store.recordRunLedgerRow({
          runId: `run-${i}`,
          cadence: "on-demand",
          stage: "deliberator",
          model: "model-a",
          usage: { input: i, output: 0, cacheRead: 0, cacheCreation: 0 },
          costUsd: 0,
        });
      }
      return (yield* store.getSpendSummary).recentRuns;
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(runs.length).toBeLessThanOrEqual(15);
    // Newest first — the last-recorded run leads.
    expect(runs[0]?.runId).toBe("run-19");
  });

  it("SqlStore: a ledger row survives closing the store and reopening a fresh SqlStore over the same file", async () => {
    const dbPath = tempDbPath();
    try {
      await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.recordRunLedgerRow({
            runId: "run-durable",
            cadence: "session-review",
            stage: "deliberator",
            model: "model-a",
            usage: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 },
            costUsd: 0.001,
          });
        }),
      );

      const reread = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getSpendSummary;
        }),
      );

      expect(reread.recentRuns).toHaveLength(1);
      expect(reread.recentRuns[0]?.runId).toBe("run-durable");
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});

describe("summarizeRunLedger (the pure grouping used by both Store layers)", () => {
  it("reads a run's model off its deliberator/intake-draft stage, not the sweep", async () => {
    const rows: ReadonlyArray<RunLedgerRecord> = [
      {
        id: "1",
        runId: "run-1",
        cadence: "session-review",
        stage: "deliberator",
        model: "cheap-model",
        usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0,
        ranAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "2",
        runId: "run-1",
        cadence: "session-review",
        stage: "sweep",
        model: "different-sweep-model",
        usage: { input: 2, output: 1, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0,
        ranAt: "2026-01-01T00:00:01.000Z",
      },
    ];

    const summary = summarizeRunLedger(rows);
    expect(summary.recentRuns[0]?.model).toBe("cheap-model");
  });

  it("returns an empty summary for an empty ledger", () => {
    expect(summarizeRunLedger([])).toEqual({ perCadence: [], recentRuns: [] });
  });
});
