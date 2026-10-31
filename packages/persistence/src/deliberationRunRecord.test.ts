import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { DeliberationRunRecord } from "@repcoach/contracts";

import { assembleDeliberationRuns } from "./deliberationRunRecord.ts";
import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/**
 * The Deliberation run as a row of its own (ADR 0011 §8) — the record behind
 * the Coach surface's run history, proven against BOTH `Store` layers behind
 * the shared tag.
 *
 * The claims worth testing here are not "a row round-trips". They are the two
 * states that motivated giving a run a row at all, and which no amount of
 * grouping over committed Decisions can reach:
 *
 * - **A run that emitted nothing is still on the record.** `commitDeliberation
 *   Output` loops over the run's decisions, so zero decisions wrote zero rows
 *   and a restrained run (ADR 0011 §4) was indistinguishable from a coach that
 *   never ran.
 * - **A run that failed says so, durably.** Its reason used to live only in the
 *   runner's in-memory `runStateRef`, so it survived exactly until the next run
 *   or the next restart.
 *
 * Plus the compatibility claim that makes the migration safe: history written
 * before run rows existed is **reconstructed** from the `data_window_json` its
 * Decisions share, so nothing already on the record disappears the day this
 * lands.
 */

const tempDbPath = (): string => path.join(os.tmpdir(), `repcoach-run-record-${randomUUID()}.sqlite`);

const cleanupDbFile = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

const runAgainstFreshLayer = <A, E>(dbPath: string, effect: Effect.Effect<A, E, Store>): Promise<A> =>
  effect.pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);

const window = (ranAt: string, sessionIds: ReadonlyArray<string> = []) => ({
  cadence: "session-review" as const,
  ran_at: ranAt,
  session_ids_considered: sessionIds,
  evidence_roster_version: "seed-1",
});

const emptyOutput = { decisions: [], observation_directives: [] } as never;

const oneObservation = {
  decisions: [
    {
      kind: "observation" as const,
      summary: "Squat load held.",
      rationale: "Three sessions at the same load.",
      citations: [],
      reasoning_only_points: [],
      surface: true,
    },
  ],
  observation_directives: [],
} as never;

describe("the Deliberation run record (ADR 0011 §8)", () => {
  describe("assembleDeliberationRuns — the grouping itself", () => {
    it("keeps a run that emitted nothing, with no decisions and a window it read over", () => {
      const runs = assembleDeliberationRuns(
        [
          {
            runId: "run-quiet",
            cadence: "session-review",
            status: "committed",
            failureReason: undefined,
            dataWindowJson: JSON.stringify(window("2026-07-08T18:20:00.000Z", ["session-4"])),
            startedAt: "2026-07-08T18:20:00.000Z",
            finishedAt: "2026-07-08T18:24:00.000Z",
          },
        ],
        [],
        new Map([["run-quiet", new Set(["deliberator", "sweep"])]]),
      );

      expect(runs).toHaveLength(1);
      expect(runs[0]?.outcome).toBe("committed");
      expect(runs[0]?.decisions).toEqual([]);
      // The window is what makes the silence legible — "read one session and
      // said nothing" is a different statement from "said nothing".
      expect(runs[0]?.dataWindow?.session_ids_considered).toEqual(["session-4"]);
    });

    it("reports both stages done on a committed run even when a ledger row was lost", () => {
      // The ledger write is best-effort (ADR 0011 §6), so a missing row means
      // the bookkeeping was dropped — not that the sweep was skipped, which it
      // never is (ADR 0011 §8). Claiming otherwise would turn a lost cost row
      // into a false claim about the trust floor.
      const runs = assembleDeliberationRuns(
        [
          {
            runId: "run-committed",
            cadence: "session-review",
            status: "committed",
            failureReason: undefined,
            dataWindowJson: JSON.stringify(window("2026-07-01T00:00:00.000Z")),
            startedAt: "2026-07-01T00:00:00.000Z",
            finishedAt: "2026-07-01T00:03:00.000Z",
          },
        ],
        [],
        new Map(),
      );

      expect(runs[0]?.stages).toEqual([
        { stage: "deliberator", state: "done" },
        { stage: "sweep", state: "done" },
      ]);
    });

    it("reads a failed run's stages the opposite way — no ledger row means the stage never completed", () => {
      const runs = assembleDeliberationRuns(
        [
          {
            runId: "run-failed",
            cadence: "session-review",
            status: "failed",
            failureReason: "hit the turn cap",
            dataWindowJson: undefined,
            startedAt: "2026-07-05T18:02:00.000Z",
            finishedAt: "2026-07-05T18:09:00.000Z",
          },
        ],
        [],
        new Map([["run-failed", new Set(["deliberator"])]]),
      );

      expect(runs[0]?.stages).toEqual([
        { stage: "deliberator", state: "done" },
        { stage: "sweep", state: "not-run" },
      ]);
      expect(runs[0]?.failureReason).toBe("hit the turn cap");
      expect(runs[0]?.dataWindow).toBeUndefined();
    });

    it("marks the next unrecorded stage of a live run as the one running now", () => {
      const runs = assembleDeliberationRuns(
        [
          {
            runId: "run-live",
            cadence: "session-review",
            status: "running",
            failureReason: undefined,
            dataWindowJson: undefined,
            startedAt: "2026-07-09T17:41:00.000Z",
            finishedAt: undefined,
          },
        ],
        [],
        new Map([["run-live", new Set(["deliberator"])]]),
      );

      expect(runs[0]?.stages).toEqual([
        { stage: "deliberator", state: "done" },
        { stage: "sweep", state: "running" },
      ]);
    });

    it("reconstructs a pre-run-row run from the data window its Decisions share, claiming no stages", () => {
      const shared = JSON.stringify(window("2026-06-01T00:00:00.000Z", ["session-0"]));
      const runs = assembleDeliberationRuns(
        [],
        [
          {
            decisionId: "d-1",
            kind: "observation",
            status: "open",
            summary: "First.",
            createdAt: "2026-06-01T00:00:01.000Z",
            runId: undefined,
            dataWindowJson: shared,
            reviseProse: undefined,
          },
          {
            decisionId: "d-2",
            kind: "proposal",
            status: "pending",
            summary: "Second.",
            createdAt: "2026-06-01T00:00:02.000Z",
            runId: undefined,
            dataWindowJson: shared,
            reviseProse: undefined,
          },
        ],
        new Map(),
      );

      expect(runs).toHaveLength(1);
      expect(runs[0]?.runId).toBe("reconstructed:d-1");
      expect(runs[0]?.outcome).toBe("committed");
      expect(runs[0]?.decisions.map((d) => d.decisionId)).toEqual(["d-1", "d-2"]);
      // Nothing recorded them, so nothing is claimed about them — the honest
      // limit of reconstruction, and the reason run rows exist.
      expect(runs[0]?.stages).toEqual([]);
    });

    it("mints a stable id for a reconstructed run, so re-reading does not duplicate it", () => {
      const shared = JSON.stringify(window("2026-06-01T00:00:00.000Z"));
      const decisions = [
        {
          decisionId: "d-1",
          kind: "observation",
          status: "open",
          summary: "First.",
          createdAt: "2026-06-01T00:00:01.000Z",
          runId: undefined,
          dataWindowJson: shared,
          reviseProse: undefined,
        },
      ];

      expect(assembleDeliberationRuns([], decisions, new Map())[0]?.runId).toBe(
        assembleDeliberationRuns([], decisions, new Map())[0]?.runId,
      );
    });

    it("does not mint a run for a Decision whose data window is not a provenance envelope", () => {
      // What an applied Change carries (ADR 0008) — a command marker, not a
      // run's envelope. Left in, it would put a "run" on the rail for every
      // Plan edit the user ever made by hand.
      const runs = assembleDeliberationRuns(
        [],
        [
          {
            decisionId: "change-1",
            kind: "proposal",
            status: "applied",
            summary: "Edited a target.",
            createdAt: "2026-06-02T00:00:00.000Z",
            runId: undefined,
            dataWindowJson: JSON.stringify({ setId: "set-1", target: {} }),
            reviseProse: undefined,
          },
        ],
        new Map(),
      );

      expect(runs).toEqual([]);
    });

    it("orders newest first, so a run in flight is the first element", () => {
      const runs = assembleDeliberationRuns(
        [
          {
            runId: "older",
            cadence: "session-review",
            status: "committed",
            failureReason: undefined,
            dataWindowJson: JSON.stringify(window("2026-07-01T00:00:00.000Z")),
            startedAt: "2026-07-01T00:00:00.000Z",
            finishedAt: "2026-07-01T00:03:00.000Z",
          },
          {
            runId: "live",
            cadence: "session-review",
            status: "running",
            failureReason: undefined,
            dataWindowJson: undefined,
            startedAt: "2026-07-09T17:41:00.000Z",
            finishedAt: undefined,
          },
        ],
        [],
        new Map(),
      );

      expect(runs.map((run) => run.runId)).toEqual(["live", "older"]);
    });
  });

  describe("both Store layers", () => {
    it("in-memory Store: a run that commits nothing is on the record, with no Decisions under it", async () => {
      const runs = await Effect.gen(function* () {
        const store = yield* Store;
        yield* store.startDeliberationRun({
          runId: "run-silent",
          cadence: "session-review",
          startedAt: "2026-08-01T10:00:00.000Z",
        });
        yield* store.commitDeliberationOutput({
          runOutput: emptyOutput,
          dataWindow: window("2026-08-01T10:04:00.000Z", ["session-9"]),
          runId: "run-silent",
        });
        yield* store.finishDeliberationRun({
          runId: "run-silent",
          outcome: "committed",
          finishedAt: "2026-08-01T10:04:00.000Z",
          dataWindow: window("2026-08-01T10:04:00.000Z", ["session-9"]),
        });
        return yield* store.getDeliberationRuns;
      }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

      const silent = runs.find((run) => run.runId === "run-silent");
      expect(silent?.outcome).toBe("committed");
      expect(silent?.decisions).toEqual([]);
      expect(silent?.dataWindow?.session_ids_considered).toEqual(["session-9"]);
    });

    it("in-memory Store: a failed run keeps its reason, and carries no Decisions", async () => {
      const runs = await Effect.gen(function* () {
        const store = yield* Store;
        yield* store.startDeliberationRun({
          runId: "run-broke",
          cadence: "cycle-review",
          startedAt: "2026-08-02T10:00:00.000Z",
        });
        yield* store.finishDeliberationRun({
          runId: "run-broke",
          outcome: "failed",
          finishedAt: "2026-08-02T10:06:00.000Z",
          failureReason: "the deliberator session could not start",
        });
        return yield* store.getDeliberationRuns;
      }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

      const failed = runs.find((run) => run.runId === "run-broke");
      expect(failed?.outcome).toBe("failed");
      expect(failed?.failureReason).toBe("the deliberator session could not start");
      expect(failed?.decisions).toEqual([]);
    });

    it("in-memory Store: a Decision committed under a run is listed beneath it", async () => {
      const runs = await Effect.gen(function* () {
        const store = yield* Store;
        yield* store.startDeliberationRun({
          runId: "run-spoke",
          cadence: "session-review",
          startedAt: "2026-08-03T10:00:00.000Z",
        });
        yield* store.commitDeliberationOutput({
          runOutput: oneObservation,
          dataWindow: window("2026-08-03T10:04:00.000Z"),
          runId: "run-spoke",
        });
        yield* store.finishDeliberationRun({
          runId: "run-spoke",
          outcome: "committed",
          finishedAt: "2026-08-03T10:04:00.000Z",
          dataWindow: window("2026-08-03T10:04:00.000Z"),
        });
        return yield* store.getDeliberationRuns;
      }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

      const spoke = runs.find((run) => run.runId === "run-spoke");
      expect(spoke?.decisions).toHaveLength(1);
      expect(spoke?.decisions[0]?.summary).toBe("Squat load held.");
      expect(spoke?.decisions[0]?.kind).toBe("observation");
      expect(spoke?.decisions[0]?.status).toBe("open");
    });

    it("in-memory Store: a run whose row was never opened does not get one at finish time", async () => {
      // The best-effort posture, from the other end: a run whose opening write
      // was swallowed is history the record reconstructs from its Decisions,
      // not a row minted later with a start time nobody observed.
      const runs = await Effect.gen(function* () {
        const store = yield* Store;
        yield* store.finishDeliberationRun({
          runId: "run-never-opened",
          outcome: "committed",
          finishedAt: "2026-08-04T10:04:00.000Z",
          dataWindow: window("2026-08-04T10:04:00.000Z"),
        });
        return yield* store.getDeliberationRuns;
      }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

      expect(runs.some((run) => run.runId === "run-never-opened")).toBe(false);
    });

    it("in-memory Store: a cancelled run's row is discarded, not recorded as failed (ADR 0013 §5)", async () => {
      const runs = await Effect.gen(function* () {
        const store = yield* Store;
        yield* store.startDeliberationRun({
          runId: "run-cancelled",
          cadence: "revision-run",
          startedAt: "2026-08-05T10:00:00.000Z",
        });
        yield* store.discardDeliberationRun("run-cancelled");
        return yield* store.getDeliberationRuns;
      }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

      expect(runs.some((run) => run.runId === "run-cancelled")).toBe(false);
    });

    it("in-memory Store: a run left running is closed as interrupted, not left pulsing forever", async () => {
      const [closed, runs] = await Effect.gen(function* () {
        const store = yield* Store;
        yield* store.startDeliberationRun({
          runId: "run-stranded",
          cadence: "session-review",
          startedAt: "2026-08-06T10:00:00.000Z",
        });
        const closed = yield* store.failRunsInterruptedByRestart;
        return [closed, yield* store.getDeliberationRuns] as const;
      }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

      expect(closed.failed).toBe(1);
      const stranded = runs.find((run) => run.runId === "run-stranded");
      expect(stranded?.outcome).toBe("failed");
      expect(stranded?.failureReason).toMatch(/restart/i);
    });

    it("SqlStore: the same three run outcomes survive a round trip through SQLite", async () => {
      const dbPath = tempDbPath();
      try {
        const runs = await runAgainstFreshLayer(
          dbPath,
          Effect.gen(function* () {
            const store = yield* Store;

            yield* store.startDeliberationRun({
              runId: "sql-spoke",
              cadence: "session-review",
              startedAt: "2026-08-03T10:00:00.000Z",
            });
            yield* store.commitDeliberationOutput({
              runOutput: oneObservation,
              dataWindow: window("2026-08-03T10:04:00.000Z"),
              runId: "sql-spoke",
            });
            yield* store.finishDeliberationRun({
              runId: "sql-spoke",
              outcome: "committed",
              finishedAt: "2026-08-03T10:04:00.000Z",
              dataWindow: window("2026-08-03T10:04:00.000Z"),
            });

            yield* store.startDeliberationRun({
              runId: "sql-silent",
              cadence: "session-review",
              startedAt: "2026-08-04T10:00:00.000Z",
            });
            yield* store.commitDeliberationOutput({
              runOutput: emptyOutput,
              dataWindow: window("2026-08-04T10:04:00.000Z", ["session-9"]),
              runId: "sql-silent",
            });
            yield* store.finishDeliberationRun({
              runId: "sql-silent",
              outcome: "committed",
              finishedAt: "2026-08-04T10:04:00.000Z",
              dataWindow: window("2026-08-04T10:04:00.000Z", ["session-9"]),
            });

            yield* store.startDeliberationRun({
              runId: "sql-failed",
              cadence: "session-review",
              startedAt: "2026-08-05T10:00:00.000Z",
            });
            yield* store.finishDeliberationRun({
              runId: "sql-failed",
              outcome: "failed",
              finishedAt: "2026-08-05T10:06:00.000Z",
              failureReason: "could not parse the sweep's output",
            });

            return yield* store.getDeliberationRuns;
          }),
        );

        const byId = new Map(runs.map((run) => [run.runId, run] as const));
        expect(byId.get("sql-spoke")?.decisions).toHaveLength(1);
        expect(byId.get("sql-silent")?.outcome).toBe("committed");
        expect(byId.get("sql-silent")?.decisions).toEqual([]);
        expect(byId.get("sql-failed")?.outcome).toBe("failed");
        expect(byId.get("sql-failed")?.failureReason).toBe("could not parse the sweep's output");

        // Newest first, including against the seeded runs already in the file.
        const started = runs.map((run) => run.startedAt);
        expect([...started].sort((a, b) => b.localeCompare(a))).toEqual(started);
      } finally {
        cleanupDbFile(dbPath);
      }
    });

    it("SqlStore: a run carrying an escalated and an expired Observation still decodes as a DeliberationRunRecord", async () => {
      // The bug this pins: `escalate`/`close` write terminal Observation
      // statuses the store has always produced (ADR 0011 §5), but the wire
      // contract's `DecisionStatus` only listed the Change statuses plus
      // `open`/`answered` — so the first escalation on the live server made
      // the whole Coach record undecodable, not just that one row. Reading
      // the record back through the schema is the step that died, so that is
      // the step this asserts.
      const dbPath = tempDbPath();
      try {
        const statuses = await runAgainstFreshLayer(
          dbPath,
          Effect.gen(function* () {
            const store = yield* Store;
            const seeded = yield* store.commitDeliberationOutput({
              runOutput: {
                decisions: [
                  {
                    kind: "observation",
                    summary: "Bench has stalled for three sessions.",
                    rationale: "Same load, same reps, three sessions running.",
                    citations: [],
                    reasoning_only_points: [],
                    surface: true,
                  },
                  {
                    kind: "observation",
                    summary: "Squat volume drifted low.",
                    rationale: "Two short sessions in a row.",
                    citations: [],
                    reasoning_only_points: [],
                    surface: true,
                  },
                ],
                observation_directives: [],
              } as never,
              dataWindow: window("2026-07-20T09:00:00.000Z", ["session-9"]),
            });
            const [toEscalate, toClose] = seeded.decisionIds;
            yield* store.commitDeliberationOutput({
              runOutput: {
                decisions: [],
                observation_directives: [
                  { id: toEscalate, action: "escalate" },
                  { id: toClose, action: "close" },
                ],
              } as never,
              dataWindow: window("2026-07-21T09:00:00.000Z", ["session-10"]),
            });

            const runs = yield* store.getDeliberationRuns;
            // Decode exactly as the client does; a status outside the union
            // dies here rather than at the one offending field.
            const decoded = Schema.decodeUnknownSync(Schema.Array(DeliberationRunRecord))(runs);
            return decoded.flatMap((run) => run.decisions.map((d) => d.status));
          }),
        );

        expect(statuses).toContain("escalated");
        expect(statuses).toContain("expired");
      } finally {
        cleanupDbFile(dbPath);
      }
    });

    it("SqlStore: the seed carries a run that said nothing and a run that failed", async () => {
      // The seed is what dev and e2e look at, and this surface's argument is
      // about states the coach reaches rarely — so they have to be in it, or
      // the only run anybody sees while building is the easy one.
      const dbPath = tempDbPath();
      try {
        const runs = await runAgainstFreshLayer(
          dbPath,
          Effect.gen(function* () {
            const store = yield* Store;
            return yield* store.getDeliberationRuns;
          }),
        );

        expect(runs.some((run) => run.outcome === "committed" && run.decisions.length > 0)).toBe(
          true,
        );
        expect(runs.some((run) => run.outcome === "committed" && run.decisions.length === 0)).toBe(
          true,
        );
        expect(runs.some((run) => run.outcome === "failed")).toBe(true);
        // And no in-flight run: a `running` row nothing is running would be a
        // lie the surface tells on every cold start.
        expect(runs.some((run) => run.outcome === "running")).toBe(false);
      } finally {
        cleanupDbFile(dbPath);
      }
    });
  });
});
