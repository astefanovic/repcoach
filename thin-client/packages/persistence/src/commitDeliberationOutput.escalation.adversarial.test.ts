import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { Store, type DecisionRecord } from "./store.ts";

/**
 * ADVERSARIAL escalation/directive-integrity coverage for
 * `Store.commitDeliberationOutput` (2B slice 5, issue #30, ADR 0011 §5),
 * probing the seams the slice-1 adversarial suite
 * (`commitDeliberationOutput.adversarial.test.ts`) does NOT reach: what
 * happens when a directive names an Observation that is NOT `open` — i.e.
 * already `escalated` or `expired`. ADR 0011 §5 says an Observation's two
 * directive actions "map to exactly one terminal status each" and a terminal
 * Observation has LEFT the accumulation (the seed provider only injects
 * `status='open'` priors, so the agent should never even see a terminal id).
 * The store is the trust boundary over an untrusted agent output, so a
 * directive naming a terminal id must be a NO-OP — never a re-flip that
 * resurrects a closed Observation or contradicts an escalation that a
 * Proposal already references.
 *
 * These run against BOTH Store layers (in-memory + real SqlStore) via the
 * shared harness, so any layer drift on this guard is caught.
 */

const dataWindow = {
  cadence: "on-demand" as const,
  ran_at: "2026-07-18T12:00:00.000Z",
  session_ids_considered: ["session-a"],
  evidence_roster_version: "roster-v1",
};

const observationDraft = (
  summary: string,
  overrides: Partial<DeliberationRunOutput["decisions"][number]> = {},
): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary,
  rationale: `rationale for: ${summary}`,
  citations: [
    { claim: "a claim", source_url: "https://example.com/x", trust: "retrieved-unverified" },
  ],
  reasoning_only_points: [],
  surface: false,
  ...overrides,
});

const proposalDraft = (
  summary: string,
): DeliberationRunOutput["decisions"][number] => ({
  kind: "proposal",
  summary,
  rationale: `rationale for: ${summary}`,
  citations: [
    { claim: "a claim", source_url: "https://example.com/p", trust: "corpus-verified" },
  ],
  reasoning_only_points: [],
  surface: false,
});

type WithStore = <A>(effect: Effect.Effect<A, never, Store>) => Promise<A>;

/** Commit one open Observation and return its runner-assigned id. */
const seedOpenObservation = (summary: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const res = yield* store.commitDeliberationOutput({
      runOutput: { decisions: [observationDraft(summary)], observation_directives: [] },
      dataWindow,
    });
    const id = res.decisionIds[0];
    if (id === undefined) return yield* Effect.die(new Error("expected observation id"));
    return id as string;
  });

const runEscalationAdversarialSuite = (withStore: WithStore) => {
  it("a later `close` does NOT re-flip an already-`escalated` Observation (no escalated→expired; the Proposal linkage is not contradicted)", async () => {
    const status = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const obsId = yield* seedOpenObservation("Bench plateau");
        // First run escalates it (and emits the roll-up Proposal).
        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [proposalDraft("Bump bench load")],
            observation_directives: [{ id: obsId as never, action: "escalate" }],
          },
          dataWindow,
        });
        // A later, adversarial/confused run tries to CLOSE the same id.
        yield* store.commitDeliberationOutput({
          runOutput: { decisions: [], observation_directives: [{ id: obsId as never, action: "close" }] },
          dataWindow,
        });
        const all = yield* store.listDecisionsForTest;
        return all.find((d) => d.id === obsId)?.status;
      }),
    );
    expect(status).toBe("escalated");
  });

  it("a later `escalate` does NOT resurrect an already-`expired` Observation (no expired→escalated)", async () => {
    const status = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const obsId = yield* seedOpenObservation("Possible grip weakness");
        yield* store.commitDeliberationOutput({
          runOutput: { decisions: [], observation_directives: [{ id: obsId as never, action: "close" }] },
          dataWindow,
        });
        // A later run names the (now expired) id in an escalate directive.
        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [proposalDraft("Change grip work")],
            observation_directives: [{ id: obsId as never, action: "escalate" }],
          },
          dataWindow,
        });
        const all = yield* store.listDecisionsForTest;
        return all.find((d) => d.id === obsId)?.status;
      }),
    );
    expect(status).toBe("expired");
  });

  it("re-`escalate`-ing an already-`escalated` Observation is a stable no-op (idempotent replay) and creates no duplicate rows for it", async () => {
    const { status, obsRowCount } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const obsId = yield* seedOpenObservation("Overhead press stalled");
        const escalateOnce = {
          runOutput: {
            decisions: [] as DeliberationRunOutput["decisions"],
            observation_directives: [{ id: obsId as never, action: "escalate" as const }],
          },
          dataWindow,
        };
        yield* store.commitDeliberationOutput(escalateOnce);
        // Replay the exact same escalate directive (e.g. a retried run).
        yield* store.commitDeliberationOutput(escalateOnce);
        const all = yield* store.listDecisionsForTest;
        return {
          status: all.find((d) => d.id === obsId)?.status,
          obsRowCount: all.filter((d) => d.id === obsId).length,
        };
      }),
    );
    expect(status).toBe("escalated");
    expect(obsRowCount).toBe(1); // the directive never inserts a row
  });

  it("`escalate` moves ONLY status — rationale/citations/data_window/summary/createdAt stay byte-identical (immutability, escalate variant)", async () => {
    const [before, after] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const obsId = yield* seedOpenObservation("Squat RPE creeping");
        const beforeAll = yield* store.listDecisionsForTest;
        const before = beforeAll.find((d) => d.id === obsId);
        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [proposalDraft("Deload squat")],
            observation_directives: [{ id: obsId as never, action: "escalate" }],
          },
          dataWindow,
        });
        const afterAll = yield* store.listDecisionsForTest;
        const after = afterAll.find((d) => d.id === obsId);
        return [before, after] as const;
      }),
    );
    expect(after?.status).toBe("escalated");
    const { status: _b, ...beforeRest } = before as DecisionRecord;
    const { status: _a, ...afterRest } = after as DecisionRecord;
    expect(afterRest).toEqual(beforeRest);
  });

  it("two directives on the SAME open Observation in ONE call resolve deterministically to the FIRST action (the row leaves `open` after the first, so the second is a no-op)", async () => {
    const status = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const obsId = yield* seedOpenObservation("Ambiguous signal");
        yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [],
            observation_directives: [
              { id: obsId as never, action: "escalate" },
              { id: obsId as never, action: "close" },
            ],
          },
          dataWindow,
        });
        const all = yield* store.listDecisionsForTest;
        return all.find((d) => d.id === obsId)?.status;
      }),
    );
    // First-wins: escalate applied, the trailing close saw a non-open row.
    expect(status).toBe("escalated");
  });

  it("a bad/terminal id mid-batch does NOT roll back the Proposal insert or the other valid flips (partial-skip, not all-or-nothing throw)", async () => {
    const { escalatedStatus, keepOpenStatus, expiredStatus, proposalCreated } = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        // Two open observations; escalate the first, close nothing yet.
        const seeded = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [observationDraft("obs-escalate"), observationDraft("obs-keepopen")],
            observation_directives: [],
          },
          dataWindow,
        });
        const [escId, keepId] = seeded.decisionIds as ReadonlyArray<string>;
        // Pre-expire a third so it is a TERMINAL id we then re-target mid-batch.
        const terminalId = yield* seedOpenObservation("obs-terminal");
        yield* store.commitDeliberationOutput({
          runOutput: { decisions: [], observation_directives: [{ id: terminalId as never, action: "close" }] },
          dataWindow,
        });

        // One batch: a Proposal insert + a valid escalate + a directive on the
        // TERMINAL id + a directive on a totally UNKNOWN id. Only the valid
        // flip and the insert should take effect; nothing should throw or roll back.
        const res = yield* store.commitDeliberationOutput({
          runOutput: {
            decisions: [proposalDraft("roll-up proposal")],
            observation_directives: [
              { id: escId as never, action: "escalate" },
              { id: terminalId as never, action: "escalate" }, // terminal -> no-op
              { id: "totally-unknown-id" as never, action: "close" }, // unknown -> no-op
            ],
          },
          dataWindow,
        });
        const all = yield* store.listDecisionsForTest;
        return {
          escalatedStatus: all.find((d) => d.id === escId)?.status,
          keepOpenStatus: all.find((d) => d.id === keepId)?.status,
          expiredStatus: all.find((d) => d.id === terminalId)?.status,
          proposalCreated: all.some(
            (d) => res.decisionIds.includes(d.id as never) && d.kind === "proposal",
          ),
        };
      }),
    );
    expect(proposalCreated).toBe(true); // insert survived
    expect(escalatedStatus).toBe("escalated"); // valid flip survived
    expect(keepOpenStatus).toBe("open"); // untouched
    expect(expiredStatus).toBe("expired"); // terminal id NOT re-flipped to escalated
  });
};

describe("commitDeliberationOutput escalation — ADVERSARIAL — in-memory Store", () => {
  const withStore: WithStore = (effect) =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);
  runEscalationAdversarialSuite(withStore);
});

describe("commitDeliberationOutput escalation — ADVERSARIAL — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-commit-escalation-adversarial-${randomUUID()}.sqlite`);
  const cleanupDbFile = (dbPath: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  };
  const withStore: WithStore = (effect) => {
    const dbPath = tempDbPath();
    return effect
      .pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise)
      .finally(() => cleanupDbFile(dbPath));
  };
  runEscalationAdversarialSuite(withStore);
});
