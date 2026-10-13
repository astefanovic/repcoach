import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import type { CommitDeliberationOutputInput, DeliberationRunOutput } from "@repcoach/contracts";
import { DecisionWorking } from "@repcoach/contracts";

import { toDecisionWorking } from "./decisionWorking.ts";
import { SqlStore } from "./sqlStore.ts";
import { Store } from "./store.ts";

/**
 * The **working** a Decision carries (#79) — the measurements it rests on, the
 * rule that fired, and the place the coach says it could be wrong.
 *
 * Run against BOTH `Store` layers through one shared body, exactly as
 * `commitDeliberationOutput.test.ts` does, because the whole risk here is the
 * two layers disagreeing about what an absent field means.
 *
 * The rule every test below is really asserting: **absent stays absent**.
 * These three fields are optional so that a card renders a block only when the
 * coach filled one in. The moment anything on the write or read path softens
 * `undefined` into `[]` or `""`, "the coach offered no evidence" becomes
 * indistinguishable from "the coach offered empty evidence", and the surface
 * starts showing furniture instead of working.
 */

const dataWindow = {
  cadence: "session-review" as const,
  ran_at: "2026-07-18T12:00:00.000Z",
  window_from: "2026-07-04T00:00:00.000Z",
  window_to: "2026-07-18T00:00:00.000Z",
  session_ids_considered: ["session-a", "session-b"],
  evidence_roster_version: "roster-v1",
};

const measurements = [
  { label: "e1RM, bench", series: "142.5 → 148.4 kg", delta: "+4.1%" },
  { label: "Top-set reps at range ceiling", series: "8, 8, 8, 8 of 8", delta: "4/4" },
];

const rule =
  "Double progression — advance load once every working set reaches the top of the prescribed rep range.";

const uncertainty =
  "Your last session's second set dropped to 7 reps. If that repeats, this is early — I'd hold instead.";

/** A draft carrying every part of its working. */
const workedDraft = (): DeliberationRunOutput["decisions"][number] => ({
  kind: "proposal",
  summary: "Bench Press: add 2.5 kg to your top sets.",
  rationale: "Every working set reached the top of the range across four sessions.",
  citations: [
    {
      claim: "Advance load once the top of the rep range is reached across all working sets.",
      source_url: "https://example.com/research/double-progression",
      trust: "corpus-verified",
    },
  ],
  reasoning_only_points: [],
  surface: true,
  measurements,
  rule,
  uncertainty,
});

/** The same shape with the working omitted — not emptied. */
const bareDraft = (): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary: "Pushing volume is running ahead of pulling.",
  rationale: "18 push sets against 11 pull sets over the last 7 days.",
  citations: [],
  reasoning_only_points: [],
  surface: true,
});

const commitInput = (
  decisions: DeliberationRunOutput["decisions"],
): CommitDeliberationOutputInput => ({
  runOutput: { decisions, observation_directives: [] },
  dataWindow,
});

const runWorkingSuite = (withStore: <A>(effect: Effect.Effect<A, never, Store>) => Promise<A>) => {
  it("round-trips measurements, rule and uncertainty verbatim", async () => {
    const working = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commit = yield* store.commitDeliberationOutput(commitInput([workedDraft()]));
        const id = (commit.decisionIds as ReadonlyArray<string>)[0] as never;
        const record = yield* store.getDecision(id);
        return Option.map(record, toDecisionWorking);
      }),
    );

    expect(Option.isSome(working)).toBe(true);
    const value = Option.getOrThrow(working);
    expect(value.measurements).toEqual(measurements);
    expect(value.rule).toBe(rule);
    expect(value.uncertainty).toBe(uncertainty);
    // The parts that already existed still arrive alongside them.
    expect(value.citations).toHaveLength(1);
    expect(value.dataWindow?.ran_at).toBe(dataWindow.ran_at);
    expect(value.summary).toBe("Bench Press: add 2.5 kg to your top sets.");
  });

  it("leaves an omitted field absent rather than empty", async () => {
    const working = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commit = yield* store.commitDeliberationOutput(commitInput([bareDraft()]));
        const id = (commit.decisionIds as ReadonlyArray<string>)[0] as never;
        const record = yield* store.getDecision(id);
        return Option.map(record, toDecisionWorking);
      }),
    );

    const value = Option.getOrThrow(working);
    expect(value.measurements).toBeUndefined();
    expect(value.rule).toBeUndefined();
    expect(value.uncertainty).toBeUndefined();
    expect("measurements" in value).toBe(false);
    expect("rule" in value).toBe(false);
    expect("uncertainty" in value).toBe(false);
  });

  it("keeps one decision's working off another committed in the same run", async () => {
    const [worked, bare] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commit = yield* store.commitDeliberationOutput(
          commitInput([workedDraft(), bareDraft()]),
        );
        const ids = commit.decisionIds as ReadonlyArray<string>;
        const decisions = yield* store.listDecisionsForTest;
        const created = decisions
          .filter((decision) => ids.includes(decision.id))
          .map(toDecisionWorking);
        return [
          created.find((decision) => decision.kind === "proposal"),
          created.find((decision) => decision.kind === "observation"),
        ] as const;
      }),
    );

    expect(worked?.rule).toBe(rule);
    expect(bare?.rule).toBeUndefined();
  });

  it("gives every committed feed entry a route back to its Decision", async () => {
    const [entries, decisionIds] = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commit = yield* store.commitDeliberationOutput(
          commitInput([workedDraft(), bareDraft()]),
        );
        const feed = yield* store.getCoachingFeed;
        return [
          feed.filter((entry) => commit.feedEntryIds.includes(entry.id)),
          commit.decisionIds as ReadonlyArray<string>,
        ] as const;
      }),
    );

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      // The Observation's entry is the one that had no id at all before #79.
      expect(entry.decisionId).toBeDefined();
      expect(decisionIds).toContain(entry.decisionId as string);
    }
  });

  it("produces a value the wire contract accepts, for every kind a run can commit", async () => {
    // The mapper hands `DecisionWorking` back with its ids cast, so nothing
    // upstream of the RPC boundary ever decodes it — which is exactly how a
    // status axis too narrow for an Observation (`open`) or an Answer
    // (`answered`) reached the browser as a decode failure at expand time.
    // This is the assertion that keeps that at rung 1.
    const working = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const commit = yield* store.commitDeliberationOutput(
          commitInput([workedDraft(), bareDraft()]),
        );
        const ids = commit.decisionIds as ReadonlyArray<string>;
        const decisions = yield* store.listDecisionsForTest;
        return decisions.filter((decision) => ids.includes(decision.id)).map(toDecisionWorking);
      }),
    );

    const decode = Schema.decodeUnknownSync(DecisionWorking);
    for (const value of working) {
      expect(() => decode(value)).not.toThrow();
    }
    // Both statuses a fresh run can produce are represented, so this is not
    // quietly passing over one kind.
    expect(working.map((value) => value.status).sort()).toEqual(["open", "pending"]);
  });

  it("returns nothing for an id that names no Decision", async () => {
    const record = await withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.getDecision("no-such-decision" as never);
      }),
    );

    expect(Option.isNone(record)).toBe(true);
  });
};

describe("Decision working (#79) — in-memory Store", () => {
  const withStore = <A>(effect: Effect.Effect<A, never, Store>): Promise<A> =>
    effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

  runWorkingSuite(withStore);
});

describe("Decision working (#79) — SqlStore (real SQLite)", () => {
  const tempDbPath = (): string =>
    path.join(os.tmpdir(), `repcoach-decision-working-${randomUUID()}.sqlite`);

  const cleanupDbFile = (dbPath: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };

  const withStore = <A>(effect: Effect.Effect<A, never, Store>): Promise<A> => {
    const dbPath = tempDbPath();
    return effect
      .pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise)
      .finally(() => cleanupDbFile(dbPath));
  };

  runWorkingSuite(withStore);
});
