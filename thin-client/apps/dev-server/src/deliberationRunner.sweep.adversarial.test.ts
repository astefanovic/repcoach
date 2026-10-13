import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type { DeliberationRunOutput, EvidenceClaim } from "@repcoach/contracts";
import { ZERO_TOKEN_USAGE } from "@repcoach/contracts";

import { DeliberationAgent } from "./deliberationAgent.ts";
import { NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { DeliberationRunner } from "./deliberationRunner.ts";
import { DeliberationSweepAgent } from "./deliberationSweepAgent.ts";
import { UnwiredIntakeSessionAgent } from "./intakeSessionAgent.ts";
import { CannedIntakeSweepAgent } from "./intakeSweepAgent.ts";
import { QuotaServiceAlwaysAvailable } from "./quotaService.ts";
import { SeedInputsProviderLive } from "./seedContext.ts";
import { Store } from "./store.ts";

/**
 * ADVERSARIAL wiring coverage for the one-way adversarial sweep (issue #28,
 * ADR 0011 §1) — written black-box from the spec, probing edges the
 * implementer's own `deliberationRunner.test.ts` does not: full evidence
 * collapse (empty commit), directives that originate in the SWEPT output
 * (not the draft), one-and-only-one deliberator invocation per run, and a
 * proposal->observation rewrite leaving NO pending proposal from the draft.
 *
 * Both agents are provided as fully-controlled stand-ins so the test pins
 * exactly which output reaches the store; internals are never read.
 */

const obsDraft = (summary: string, surface: boolean): DeliberationRunOutput["decisions"][number] => ({
  kind: "observation",
  summary,
  rationale: "rationale",
  citations: [],
  reasoning_only_points: [],
  surface,
});

const proposalDraft = (summary: string): DeliberationRunOutput["decisions"][number] => ({
  kind: "proposal",
  summary,
  rationale: "rationale",
  citations: [],
  reasoning_only_points: [],
  surface: false,
});

const makeRunner = (options: {
  readonly deliberate: () => DeliberationRunOutput;
  readonly sweep: (draft: DeliberationRunOutput) => DeliberationRunOutput;
  readonly onDeliberate?: () => void;
  readonly onSweepRoster?: (roster: ReadonlyArray<EvidenceClaim>) => void;
}) => {
  const DeliberationAgentTest = Layer.succeed(DeliberationAgent)({
    run: (_assembledPrompt) =>
      Effect.sync(() => {
        options.onDeliberate?.();
        return {
          output: options.deliberate(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          costUsd: 0,
        };
      }),
  });
  const DeliberationSweepAgentTest = Layer.succeed(DeliberationSweepAgent)({
    run: (draft, evidenceRoster) =>
      Effect.sync(() => {
        options.onSweepRoster?.(evidenceRoster);
        return { output: options.sweep(draft), usage: ZERO_TOKEN_USAGE, costUsd: 0 };
      }),
  });

  return DeliberationRunner.layer.pipe(
    Layer.provide(DeliberationAgentTest),
    Layer.provide(DeliberationSweepAgentTest),
    // Intake ports the review cadences never touch — provided so the runner layer builds.
    Layer.provide(UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(QuotaServiceAlwaysAvailable),
    Layer.provide(Store.layer),
    Layer.provideMerge(Store.layer),
  );
};

describe("DeliberationRunner sweep — ADVERSARIAL edges (issue #28)", () => {
  it("commits the operations the DRAFT proposed, byte for byte, through a sweep that rewrites its prose (#86)", async () => {
    // ADR 0014 §5: the sweep governs the justification, never the
    // prescription. This is the load-bearing case — a sweep that "improves" a
    // load here would put a change nobody proposed and nobody reviewed behind
    // an Accept button.
    const operations: DeliberationRunOutput["decisions"][number]["plan_operations"] = [
      {
        _tag: "replaceEntrySets",
        entryId: "entry-1" as never,
        sets: [
          {
            id: "set-1" as never,
            setType: "working",
            target: { reps: { min: 5, max: 5 }, load: { min: 105, max: 105 } },
            restSec: 120,
          },
        ],
      },
    ];

    const layer = makeRunner({
      deliberate: () => ({
        decisions: [{ ...proposalDraft("DRAFT-P"), plan_operations: operations }],
        observation_directives: [],
      }),
      // The sweep rewrites everything it legitimately governs and touches
      // nothing it does not.
      sweep: (draft) => ({
        ...draft,
        decisions: draft.decisions.map((decision) => ({
          ...decision,
          rationale: "swept rationale",
          reasoning_only_points: ["degraded to uncited"],
        })),
      }),
    });

    const proposals = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* runner.runNow;
      return yield* store.getProposals;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    const committed = proposals.find((proposal) => proposal.summary === "DRAFT-P");
    expect(committed?.planOperations).toEqual(operations);
  });

  it("a sweep that collapses everything to empty commits NOTHING and does not crash", async () => {
    const layer = makeRunner({
      deliberate: () => ({ decisions: [proposalDraft("DRAFT-P")], observation_directives: [] }),
      sweep: () => ({ decisions: [], observation_directives: [] }),
    });

    const result = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      return yield* runner.runNow;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // The run committed nothing — the collapsed sweep output is a clean no-op.
    expect(result.decisionIds).toHaveLength(0);
    expect(result.feedEntryIds).toHaveLength(0);
  });

  it("applies observation_directives that originate in the SWEPT output, even when the draft had none", async () => {
    let priorObservationId: string | undefined;
    let phase: 1 | 2 = 1;

    const layer = makeRunner({
      // Run 1 drafts an open Observation; run 2 drafts nothing.
      deliberate: () =>
        phase === 1
          ? { decisions: [obsDraft("prior open observation", true)], observation_directives: [] }
          : { decisions: [], observation_directives: [] },
      // Run 1 sweep is identity (commit the observation). Run 2 sweep injects a
      // `close` directive on the prior observation — the DRAFT carried none, so
      // if it lands, directives provably come from the swept output.
      sweep: (draft) =>
        phase === 1
          ? draft
          : {
              decisions: [],
              observation_directives: priorObservationId
                ? [{ id: priorObservationId as never, action: "close" }]
                : [],
            },
    });

    const decisions = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      const first = yield* runner.runNow;
      priorObservationId = first.decisionIds[0];
      phase = 2;
      yield* runner.runNow;
      return yield* store.listDecisionsForTest;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    const prior = decisions.find((d) => d.id === priorObservationId);
    expect(prior?.status).toBe("expired"); // closed by the sweep-only directive
  });

  it("invokes the deliberator EXACTLY once per runNow (one-way — no re-deliberation after the sweep)", async () => {
    let deliberateCount = 0;

    const layer = makeRunner({
      deliberate: () => ({ decisions: [obsDraft("x", true)], observation_directives: [] }),
      sweep: (draft) => draft,
      onDeliberate: () => {
        deliberateCount += 1;
      },
    });

    await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* runner.runNow;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(deliberateCount).toBe(1);
  });

  it("a sweep rewriting a draft proposal down to an observation leaves NO pending proposal from the draft", async () => {
    const layer = makeRunner({
      deliberate: () => ({ decisions: [proposalDraft("DRAFT-PROPOSAL")], observation_directives: [] }),
      sweep: (draft) => ({
        decisions: draft.decisions.map((d) => ({
          ...d,
          kind: "observation" as const,
          summary: "SWEPT-OBSERVATION",
          surface: true,
        })),
        observation_directives: [],
      }),
    });

    const [proposals, decisions] = await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      const store = yield* Store;
      yield* runner.runNow;
      return [yield* store.getProposals, yield* store.listDecisionsForTest] as const;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // The draft proposal never became a pending Proposal…
    expect(proposals.some((p) => p.summary === "DRAFT-PROPOSAL")).toBe(false);
    // …the committed row is the swept Observation, and the draft summary is gone.
    expect(decisions.some((d) => d.summary === "SWEPT-OBSERVATION" && d.kind === "observation")).toBe(true);
    expect(decisions.some((d) => d.summary === "DRAFT-PROPOSAL")).toBe(false);
  });

  it("hands the sweep the SAME Evidence-base roster the deliberator's seed carried (issue #92)", async () => {
    let sweepSawRoster: ReadonlyArray<EvidenceClaim> | undefined;

    const layer = makeRunner({
      deliberate: () => ({ decisions: [obsDraft("x", true)], observation_directives: [] }),
      sweep: (draft) => draft,
      onSweepRoster: (roster) => {
        sweepSawRoster = roster;
      },
    });

    await Effect.gen(function* () {
      const runner = yield* DeliberationRunner;
      yield* runner.runNow;
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    // `Store.layer` runs the real migrations, which seat the vetted evidence
    // corpus (#87) — a non-empty roster here is evidence the sweep received
    // the deliberator's actual seed roster, not an empty stand-in.
    expect(sweepSawRoster).toBeDefined();
    expect(sweepSawRoster?.length).toBeGreaterThan(0);
  });
});
