import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type { PlanSnapshot } from "@repcoach/contracts";

import type { ProposalExchangeEntry } from "@repcoach/contracts";

import {
  assembleIntakeSeed,
  assembleRevisionSeed,
  assembleSeed,
  SeedInputsProvider,
  SeedInputsProviderLive,
  type RevisionSeedTarget,
  type SeedInputs,
  type StandingConstraint,
} from "./seedContext.ts";
import { SEEDED_SESSION_ID, Store } from "./store.ts";

/**
 * Structural coverage for the thin seed-context assembly (ADR 0011 §2, issue
 * #27 — 2B slice 2): "given `SeedInputs`, the assembled seed always contains
 * all provided hard Standing constraints, the Plan snapshot, and the data
 * dictionary; assert structure, not model behavior" (per the issue #27
 * brief) — the live model's actual reasoning is exercised in e2e/UAT, never
 * here.
 */

const EMPTY_PLAN: PlanSnapshot = { id: "plan-1" as never, planModel: "manual", sessions: [] };

const baseInputs = (overrides: Partial<SeedInputs> = {}): SeedInputs => ({
  cadence: "on-demand",
  planSnapshot: EMPTY_PLAN,
  goal: undefined,
  standingConstraints: [],
  evidenceRoster: [],
  checkIns: [],
  contextNotes: [],
  openObservations: [],
  unenrichedExercises: [],
  pointerDigest: { sessionsSinceLastReview: 0, openObservationCount: 0, lastCycleReviewAt: undefined },
  snapshotDbPath: "/tmp/fake-snapshot.sqlite",
  ...overrides,
});

describe("assembleSeed (ADR 0011 §2)", () => {
  it("always contains every provided hard Standing constraint verbatim — never left to on-demand retrieval", () => {
    const constraints: ReadonlyArray<StandingConstraint> = [
      { id: "c1", text: "No overhead pressing — shoulder injury", severity: "hard" },
      { id: "c2", text: "Training days: Mon/Wed/Fri only", severity: "hard" },
      { id: "c3", text: "Prefers barbell over machines", severity: "soft" },
    ];
    const seed = assembleSeed(baseInputs({ standingConstraints: constraints }));

    for (const constraint of constraints) {
      expect(seed).toContain(constraint.text);
      expect(seed).toContain(constraint.id);
    }
    // Hard vs. soft is visibly distinguished, not merged into one undifferentiated list.
    expect(seed).toContain("[HARD]");
    expect(seed).toContain("[SOFT]");
  });

  it("contains the Plan snapshot", () => {
    const plan: PlanSnapshot = { id: "plan-42" as never, planModel: "manual", sessions: [] };
    const seed = assembleSeed(baseInputs({ planSnapshot: plan }));
    expect(seed).toContain("plan-42");
    expect(seed).toContain("## Plan snapshot");
  });

  it("contains the data dictionary naming every persisted table the agent can query", () => {
    const seed = assembleSeed(baseInputs());
    expect(seed).toContain("## Data dictionary");
    for (const table of [
      "plan",
      "prescribed_session",
      "block",
      "entry",
      "prescribed_set",
      "exercise_catalog",
      "logged_session",
      "logged_set_actual",
      "logged_set_net",
      "logged_entry_swap",
      "decision",
      "coaching_feed_entry",
    ]) {
      expect(seed).toContain(table);
    }
  });

  it("sends Set counts to logged_set_net and labels logged_set_actual as an edit log", () => {
    const seed = assembleSeed(baseInputs());
    const line = (table: string) => seed.split("\n").find((l) => l.startsWith(`- ${table}(`)) ?? "";
    expect(line("logged_set_net")).toMatch(/read sets here/i);
    expect(line("logged_set_net")).toContain("SUM(counts_as_set)");
    expect(line("logged_set_net")).toMatch(/drop.*never an extra one/i);
    expect(line("logged_set_net")).toMatch(/exercise_id is what was performed/i);
    expect(line("logged_entry_swap")).toContain("latest swap");
    expect(line("logged_set_actual")).toMatch(/edit log/i);
    expect(line("logged_set_actual")).toContain("retraction");
  });

  it("names the read-only snapshot DB path so the agent's pointers target it, not the live DB", () => {
    const seed = assembleSeed(baseInputs({ snapshotDbPath: "/tmp/repcoach-deliberation-snapshot-abc123.sqlite" }));
    expect(seed).toContain("/tmp/repcoach-deliberation-snapshot-abc123.sqlite");
    expect(seed).toMatch(/READ-ONLY/i);
  });

  /**
   * Issue #93: the first live Session review read NOTHING. The seed offered
   * `sqlite3` and nothing else, and the home host has no such binary — the run
   * reasoned from the injected seed alone and said so in its rationale. Node
   * is the one engine guaranteed present (it is what the server runs on), so
   * the recipe the seed leads with must be the Node one.
   */
  it("gives a query recipe that does not assume a sqlite3 binary exists", () => {
    const seed = assembleSeed(baseInputs({ snapshotDbPath: "/tmp/snap.sqlite" }));

    expect(seed).toMatch(/node -e/);
    expect(seed).toContain("node:sqlite");
    expect(seed).toContain("readOnly:true");
    // …and the failure the last run hit is now named, so a blind run says so
    // rather than quietly presenting unread data as read.
    expect(seed).toMatch(/never present unread data as read/i);
  });

  it("renders a Windows snapshot path the agent's shell can actually open", () => {
    const seed = assembleSeed(
      baseInputs({ snapshotDbPath: "C:\\Users\\me\\AppData\\Local\\Temp\\repcoach-snap.sqlite" }),
    );

    // Bash on the home host is git-bash: raw backslashes are eaten as escapes
    // and the query fails as if the data were missing.
    expect(seed).toContain("'C:/Users/me/AppData/Local/Temp/repcoach-snap.sqlite'");
    expect(seed).not.toMatch(/node -e .*C:\\\\Users/);
  });

  it("carries the cadence framing distinctly per cadence", () => {
    const sessionReviewSeed = assembleSeed(baseInputs({ cadence: "session-review" }));
    const cycleReviewSeed = assembleSeed(baseInputs({ cadence: "cycle-review" }));
    expect(sessionReviewSeed).toMatch(/current cycle/i);
    expect(cycleReviewSeed).toMatch(/longer history/i);
    expect(sessionReviewSeed).not.toBe(cycleReviewSeed);
  });

  // 2B slice 4 (issue #29): the Session review framing carries a RESTRAINT
  // instruction (prompt-level only — ADR 0011 §4 has no structural emission
  // lane) that the Cycle/on-demand framings do not.
  it("the session-review framing carries the restraint instruction; other cadences do not", () => {
    const sessionReviewSeed = assembleSeed(baseInputs({ cadence: "session-review" }));
    const cycleReviewSeed = assembleSeed(baseInputs({ cadence: "cycle-review" }));
    const onDemandSeed = assembleSeed(baseInputs({ cadence: "on-demand" }));

    expect(sessionReviewSeed).toMatch(/prefer observations/i);
    expect(sessionReviewSeed).toMatch(/acute|safety/i);
    expect(cycleReviewSeed).not.toMatch(/prefer observations/i);
    expect(onDemandSeed).not.toMatch(/prefer observations/i);

    // Not a structural restriction — the framing never forbids Proposals
    // outright, only frames when to escalate to one.
    expect(sessionReviewSeed).not.toMatch(/must not (emit|propose)/i);
  });

  it("renders an empty Standing-constraints list honestly rather than fabricating content", () => {
    const seed = assembleSeed(baseInputs({ standingConstraints: [] }));
    expect(seed).toContain("(none on file)");
  });

  // 2B slice 5 (issue #30): every run injects the open Observations as PRIORS
  // (ADR 0011 §5) so the agent can judge accumulation and name their ids in
  // escalate/close directives. The id is the only join between the seed and a
  // directive, so it must render verbatim.
  it("injects every open Observation prior verbatim with its id so a directive can name it back", () => {
    const seed = assembleSeed(
      baseInputs({
        openObservations: [
          {
            id: "obs-aaaa",
            summary: "Bench load flat 3 sessions",
            rationale: "Same load, reps at top of range across the last three logged sessions.",
            createdAt: "2026-07-10T00:00:00.000Z",
          },
          {
            id: "obs-bbbb",
            summary: "Squat RPE creeping up at matched load",
            rationale: "Reported difficulty rising with no load change.",
            createdAt: "2026-07-12T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(seed).toContain("## Open Observations");
    expect(seed).toContain("obs-aaaa");
    expect(seed).toContain("Bench load flat 3 sessions");
    expect(seed).toContain("obs-bbbb");
    expect(seed).toContain("Squat RPE creeping up at matched load");
  });

  it("renders an empty open-Observation list honestly rather than fabricating priors", () => {
    const seed = assembleSeed(baseInputs({ openObservations: [] }));
    expect(seed).toMatch(/none open/i);
  });

  // The escalation-judgment instruction is a PROMPT-level directive present
  // for EVERY cadence (ADR 0011 §4/§5) — the soft, no-hardcoded-counter bar,
  // the escalate/close actions, and the acute/safety carve-out.
  it("carries the escalation-judgment instruction (soft bar, escalate/close, acute/safety carve-out) for every cadence", () => {
    for (const cadence of ["session-review", "cycle-review", "on-demand"] as const) {
      const seed = assembleSeed(baseInputs({ cadence }));
      expect(seed).toMatch(/soft bar/i);
      expect(seed).toMatch(/no .*fixed count|NO fixed count/i);
      expect(seed).toMatch(/escalate/i);
      expect(seed).toMatch(/close/i);
      expect(seed).toMatch(/acute|safety/i);
      // The carve-out is explicit that a Proposal need not wait for a trend.
      expect(seed).toMatch(/without .*trend/i);
    }
  });

  it("contains the pointer digest counts", () => {
    const seed = assembleSeed(
      baseInputs({
        pointerDigest: { sessionsSinceLastReview: 3, openObservationCount: 2, lastCycleReviewAt: "2026-06-01T00:00:00.000Z" },
      }),
    );
    expect(seed).toContain("Sessions since last review: 3");
    expect(seed).toContain("Open Observations: 2");
    expect(seed).toContain("2026-06-01T00:00:00.000Z");
  });
});

/**
 * The retrieval-guardrail instruction (ADR 0003 §3, issue #89): the source
 * bar and the no-source fallback, stated once and reaching every cadence
 * because the deliberator, the Intake seed and the Revision-run seed all
 * build on `assembleSeed`.
 */
describe("retrieval guardrails (ADR 0003 §3)", () => {
  it("states the scientific-source bar and excludes open-web blogs/forums, for every review/on-demand cadence", () => {
    for (const cadence of ["session-review", "cycle-review", "on-demand"] as const) {
      const seed = assembleSeed(baseInputs({ cadence }));
      expect(seed).toContain("## Retrieval guardrails");
      expect(seed).toMatch(/PubMed/);
      expect(seed).toMatch(/meta-analys[ei]s/i);
      expect(seed).toMatch(/systematic review/i);
      expect(seed).toMatch(/blog|forum/i);
    }
  });

  it("states the two-option no-source fallback by name — seed principle, or reasoning-only/uncited", () => {
    const seed = assembleSeed(baseInputs());
    expect(seed).toMatch(/fall.*back to a seed principle/i);
    expect(seed).toMatch(/reasoning only, uncited/i);
    expect(seed).toMatch(/fabricated or invented reference is never acceptable/i);
  });

  it("reaches the Intake seed via assembleIntakeSeed", () => {
    const seed = assembleIntakeSeed(
      baseInputs({ cadence: "intake" }),
      {
        goal: "get stronger",
        daysPerWeek: 4,
        equipment: ["barbell"],
      },
      [{ id: "exercise-back-squat", name: "Back Squat", trackedMetrics: ["reps", "load"] }],
    );
    expect(seed).toContain("## Retrieval guardrails");
    expect(seed).toMatch(/PubMed/);
  });

  /**
   * Issue #93 injected the catalog because the first live Intake invented ids
   * that existed nowhere and Accept rejected the finished plan. ADR 0016
   * removed that rejection — `materializeDraftPlan` mints a row per unknown
   * id — so the catalog is injected now to be REUSED, not to fence the coach
   * in. The ids still have to be in the seed (a coach who cannot see
   * `exercise-back-squat` mints a second id for the same movement and splits
   * the user's history), but nothing may tell the coach it cannot mint one.
   */
  it("injects the exercise catalog as ids to reuse, not a set the coach may not leave", () => {
    const seed = assembleIntakeSeed(
      baseInputs({ cadence: "intake" }),
      { goal: "get stronger", daysPerWeek: 3, equipment: ["barbell"] },
      [
        { id: "exercise-back-squat", name: "Back Squat", trackedMetrics: ["reps", "load"] },
        { id: "exercise-plank", name: "Plank", trackedMetrics: ["duration"] },
      ],
    );

    expect(seed).toContain("exercise-back-squat — Back Squat (tracks: reps, load)");
    expect(seed).toContain("exercise-plank — Plank (tracks: duration)");
    expect(seed).toMatch(/REUSE an id below/);
    expect(seed).toMatch(/Otherwise MINT one/);
    // The wording that outlived its constraint. Its return would re-deadlock
    // a cold start, so it is asserted absent rather than merely un-asserted.
    expect(seed).not.toMatch(/CLOSED set/);
    expect(seed).not.toMatch(/rejected outright/);
  });

  /**
   * The cold-start case, and the one that mattered: the catalog is empty by
   * definition at Intake, and is only ever populated BY accepting a plan. The
   * seed used to tell the coach to say so "rather than drafting a plan you
   * know cannot be accepted" — which refused the one plan that would have
   * accepted cleanly, and left the user with no catalog and no plan.
   */
  it("treats an empty catalog as an ordinary cold start, not a reason to refuse", () => {
    const seed = assembleIntakeSeed(
      baseInputs({ cadence: "intake" }),
      { goal: "get stronger", daysPerWeek: 3, equipment: [] },
      [],
    );

    expect(seed).toMatch(/the catalog is empty/);
    expect(seed).toMatch(/every exercise you prescribe mints a new row/);
    expect(seed).not.toMatch(/cannot be accepted/);
  });

  it("reaches the Revision-run seed via assembleRevisionSeed", () => {
    const seed = assembleRevisionSeed(baseInputs({ cadence: "revision-run" }), {
      targetDecision: {
        summary: "s",
        rationale: "r",
        citations: [],
        dataWindowJson: null,
      },
      priorTurns: [],
      revisionProse: "why?",
    });
    expect(seed).toContain("## Retrieval guardrails");
    expect(seed).toMatch(/PubMed/);
  });
});

/**
 * Structural coverage for the Revision-run seed assembly (ADR 0013 §6, issue
 * #66 slice 2): "given the ordinary seed inputs PLUS the target Decision and
 * the prior exchange turns, the assembled seed always contains all of it" —
 * same posture as `assembleSeed`'s suite above, asserting structure rather
 * than model behavior.
 */
describe("assembleRevisionSeed (ADR 0013 §6)", () => {
  const target: RevisionSeedTarget = {
    summary: "REVISE-TARGET-SUMMARY: switch to a 5-day upper/lower split",
    rationale: "REVISE-TARGET-RATIONALE: volume trend supports the extra day",
    citations: [
      { claim: "REVISE-TARGET-CLAIM", source_url: "https://example.com/revise-target", trust: "corpus-verified" },
    ],
    dataWindowJson: '{"cadence":"session-review","ran_at":"2026-07-01T00:00:00.000Z"}',
  };

  it("carries the ordinary seed (cadence framing, Plan snapshot, data dictionary) unchanged", () => {
    const seed = assembleRevisionSeed(baseInputs({ cadence: "revision-run" }), {
      targetDecision: target,
      priorTurns: [],
      revisionProse: "why 5 days?",
    });
    expect(seed).toContain("# Deliberation run — revision-run");
    expect(seed).toContain("## Plan snapshot");
    expect(seed).toContain("## Data dictionary");
    expect(seed).toMatch(/pushed back on a Proposal/i);
  });

  it("contains the target Decision in full — summary, rationale, citations, and its Data window", () => {
    const seed = assembleRevisionSeed(baseInputs({ cadence: "revision-run" }), {
      targetDecision: target,
      priorTurns: [],
      revisionProse: "why 5 days?",
    });
    expect(seed).toContain(target.summary);
    expect(seed).toContain(target.rationale);
    expect(seed).toContain("REVISE-TARGET-CLAIM");
    expect(seed).toContain("https://example.com/revise-target");
    expect(seed).toContain(target.dataWindowJson as string);
  });

  it("contains every prior exchange turn, oldest first, distinguishing user prose / coach Answers / superseded versions", () => {
    const priorTurns: ReadonlyArray<ProposalExchangeEntry> = [
      { kind: "revise", text: "TURN-1-REVISE: why 5 days?", createdAt: "2026-06-01T00:00:00.000Z" },
      {
        kind: "answer",
        id: "answer-1" as never,
        summary: "TURN-2-ANSWER-SUMMARY",
        rationale: "TURN-2-ANSWER-RATIONALE",
        citations: [],
        createdAt: "2026-06-02T00:00:00.000Z",
      },
      {
        kind: "superseded-proposal",
        id: "proposal-old" as never,
        summary: "TURN-3-SUPERSEDED-SUMMARY",
        rationale: "TURN-3-SUPERSEDED-RATIONALE",
        createdAt: "2026-06-03T00:00:00.000Z",
      },
    ];
    const seed = assembleRevisionSeed(baseInputs({ cadence: "revision-run" }), {
      targetDecision: target,
      priorTurns,
      revisionProse: "not 5 days, I can't train more than 3",
    });

    for (const turn of priorTurns) {
      if (turn.kind === "revise") {
        expect(seed).toContain(turn.text);
      } else {
        expect(seed).toContain(turn.summary);
        expect(seed).toContain(turn.rationale);
      }
    }
    // Oldest-first ordering is preserved verbatim from the input array.
    const idx1 = seed.indexOf("TURN-1-REVISE");
    const idx2 = seed.indexOf("TURN-2-ANSWER-SUMMARY");
    const idx3 = seed.indexOf("TURN-3-SUPERSEDED-SUMMARY");
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it("renders an empty prior-turns list honestly as the first Revise, rather than fabricating history", () => {
    const seed = assembleRevisionSeed(baseInputs({ cadence: "revision-run" }), {
      targetDecision: target,
      priorTurns: [],
      revisionProse: "why 5 days?",
    });
    expect(seed).toMatch(/first Revise/i);
  });

  it("contains the user's current Revise prose verbatim", () => {
    const seed = assembleRevisionSeed(baseInputs({ cadence: "revision-run" }), {
      targetDecision: target,
      priorTurns: [],
      revisionProse: "CURRENT-REVISE-PROSE: not 5 days, I can't train more than 3",
    });
    expect(seed).toContain("CURRENT-REVISE-PROSE: not 5 days, I can't train more than 3");
  });
});

/**
 * `SeedInputsProviderLive` coverage (issue #34 — real store-backed sourcing
 * replaced the walking-skeleton stub): proves it sources the Plan snapshot,
 * and that user-authored inputs come back genuinely empty on a fresh store
 * (never fabricated) while the server-seeded Evidence-base roster is real
 * and non-empty out of the box (ADR 0003 — the seed corpus always exists,
 * unlike user-authored data).
 */
describe("SeedInputsProviderLive", () => {
  it("sources the Plan snapshot from Store; user-authored inputs are genuinely empty on a fresh store", async () => {
    const TestLayer = SeedInputsProviderLive.pipe(Layer.provide(Store.layer));

    const seedInputs = await Effect.gen(function* () {
      const store = yield* Store;
      const provider = yield* SeedInputsProvider;
      const plan = yield* store.getPlan;
      const inputs = yield* provider.buildSeedInputs({ cadence: "on-demand", snapshotDbPath: "/tmp/x.sqlite" });
      return { plan, inputs };
    }).pipe(
      Effect.provide(TestLayer.pipe(Layer.provideMerge(Store.layer))),
      Effect.runPromise,
    );

    expect(seedInputs.inputs.planSnapshot).toEqual(seedInputs.plan);
    // Genuinely empty — a fresh store has no Goal/constraints/check-ins/notes
    // yet, never invented data.
    expect(seedInputs.inputs.goal).toBeUndefined();
    expect(seedInputs.inputs.standingConstraints).toEqual([]);
    expect(seedInputs.inputs.checkIns).toEqual([]);
    expect(seedInputs.inputs.contextNotes).toEqual([]);
    expect(seedInputs.inputs.pointerDigest.lastCycleReviewAt).toBeUndefined();
    expect(seedInputs.inputs.pointerDigest.sessionsSinceLastReview).toBe(0);
    expect(seedInputs.inputs.snapshotDbPath).toBe("/tmp/x.sqlite");

    // The Evidence-base roster is server-seeded (ADR 0003 §1/§5) — real and
    // non-empty even on a completely fresh store, unlike the user-authored
    // inputs above.
    expect(seedInputs.inputs.evidenceRoster.length).toBeGreaterThan(0);
    for (const entry of seedInputs.inputs.evidenceRoster) {
      expect(entry.trust).toBe("corpus-verified");
    }
  });

  it("renders the WHOLE vetted roster into the seed — full-inject, no cap (ADR 0003 §5, #87)", async () => {
    const TestLayer = SeedInputsProviderLive.pipe(Layer.provide(Store.layer));

    const seed = await Effect.gen(function* () {
      const provider = yield* SeedInputsProvider;
      const inputs = yield* provider.buildSeedInputs({ cadence: "on-demand", snapshotDbPath: "/tmp/x.sqlite" });
      return { inputs, prompt: assembleSeed(inputs) };
    }).pipe(Effect.provide(TestLayer.pipe(Layer.provideMerge(Store.layer))), Effect.runPromise);

    // Every seated entry reaches the prompt — the roster is small and every
    // entry is load-bearing, so there is deliberately no truncation between
    // the store and the agent.
    expect(seed.inputs.evidenceRoster).toHaveLength(7);
    for (const entry of seed.inputs.evidenceRoster) {
      expect(seed.prompt).toContain(entry.claim);
      expect(seed.prompt).toContain(entry.source);
      expect(seed.prompt).toContain(entry.applicability);
    }
    expect(seed.prompt).not.toContain("PLACEHOLDER");
  });

  it("sources a real Goal, Standing constraints (hard+soft), Check-ins, and Context notes once authored", async () => {
    const TestLayer = SeedInputsProviderLive.pipe(Layer.provide(Store.layer));

    const inputs = await Effect.gen(function* () {
      const store = yield* Store;
      yield* store.setGoal({ statement: "Build strength", proxies: ["e1RM trend"] });
      const hard = yield* store.addStandingConstraint({
        text: "No overhead pressing — shoulder injury",
        severity: "hard",
      });
      const soft = yield* store.addStandingConstraint({ text: "Prefers barbell over machines", severity: "soft" });
      yield* store.addCheckIn({ sleep: 4, soreness: 2, stress: 3, energy: 4 });
      yield* store.addContextNote({ text: "Traveling next week, dumbbells only" });
      const provider = yield* SeedInputsProvider;
      const seedInputs = yield* provider.buildSeedInputs({ cadence: "on-demand", snapshotDbPath: "/tmp/x.sqlite" });
      return { seedInputs, hard, soft };
    }).pipe(
      Effect.provide(TestLayer.pipe(Layer.provideMerge(Store.layer))),
      Effect.runPromise,
    );

    expect(inputs.seedInputs.goal).toEqual({ statement: "Build strength", proxies: ["e1RM trend"] });
    expect(inputs.seedInputs.standingConstraints).toHaveLength(2);
    expect(inputs.seedInputs.standingConstraints.map((c) => c.id)).toEqual(
      expect.arrayContaining([inputs.hard.id, inputs.soft.id]),
    );
    // The hard constraint is present — the always-injected guarantee holds
    // with real, store-backed data, not just structural inputs.
    expect(
      inputs.seedInputs.standingConstraints.some((c) => c.id === inputs.hard.id && c.severity === "hard"),
    ).toBe(true);
    expect(inputs.seedInputs.checkIns).toHaveLength(1);
    expect(inputs.seedInputs.checkIns[0]?.summary).toContain("Sleep 4/5");
    expect(inputs.seedInputs.contextNotes).toHaveLength(1);
    expect(inputs.seedInputs.contextNotes[0]?.text).toBe("Traveling next week, dumbbells only");

    const seed = assembleSeed(inputs.seedInputs);
    expect(seed).toContain("No overhead pressing — shoulder injury");
    expect(seed).toContain("[HARD]");
    expect(seed).toContain("Prefers barbell over machines");
    expect(seed).toContain("[SOFT]");
  });

  // Issue #130's acceptance bar: not merely that an Entry-anchored note
  // persists, but that it actually reaches the Deliberation prompt — the
  // whole point of "Add a note". `renderContextNotes` is the one and only
  // channel (the ticket forbids a second one), so this proves an anchored
  // note lands in the SAME `## Recent Context notes` section an unanchored
  // one does, with its Entry visible so the coach can tell which exercise it
  // is about.
  it("an Entry-anchored note (issue #130) reaches the assembled Deliberation prompt, distinguishable from an unanchored one", async () => {
    const TestLayer = SeedInputsProviderLive.pipe(Layer.provide(Store.layer));

    const seedInputs = await Effect.gen(function* () {
      const store = yield* Store;
      const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
      yield* store.addContextNote({ text: "Traveling next week, dumbbells only" });
      yield* store.addContextNote({
        text: "left elbow twinged on set 3",
        entryId: "entry-1" as never,
        loggedSessionId,
        commandId: "seed-note-cmd-1" as never,
      });
      const provider = yield* SeedInputsProvider;
      return yield* provider.buildSeedInputs({ cadence: "session-review", snapshotDbPath: "/tmp/x.sqlite" });
    }).pipe(Effect.provide(TestLayer.pipe(Layer.provideMerge(Store.layer))), Effect.runPromise);

    expect(seedInputs.contextNotes).toHaveLength(2);
    const anchored = seedInputs.contextNotes.find((n) => n.text === "left elbow twinged on set 3");
    expect(anchored?.entryId).toBe("entry-1");

    const seed = assembleSeed(seedInputs);
    expect(seed).toContain("Traveling next week, dumbbells only");
    expect(seed).toContain("left elbow twinged on set 3");
    // The anchor is visible in the rendered prompt, not just on the typed input.
    expect(seed).toContain("left elbow twinged on set 3 (entry: entry-1)");
  });

  it("openObservationCount reflects real open Observation decisions in the store", async () => {
    const TestLayer = SeedInputsProviderLive.pipe(Layer.provide(Store.layer));

    const openCount = await Effect.gen(function* () {
      const store = yield* Store;
      // Push a pending Proposal via the existing test lever, then commit a
      // real Observation through the Deliberation write path so there's a
      // genuine open Observation row to count.
      yield* store.commitDeliberationOutput({
        runOutput: {
          decisions: [
            {
              kind: "observation",
              summary: "test observation",
              rationale: "test rationale",
              citations: [],
              reasoning_only_points: [],
              surface: false,
            },
          ],
          observation_directives: [],
        },
        dataWindow: {
          cadence: "on-demand",
          ran_at: new Date().toISOString(),
          session_ids_considered: [],
          evidence_roster_version: "seed-1",
        },
      });
      const provider = yield* SeedInputsProvider;
      const inputs = yield* provider.buildSeedInputs({ cadence: "on-demand", snapshotDbPath: "/tmp/x.sqlite" });
      return inputs.pointerDigest.openObservationCount;
    }).pipe(
      Effect.provide(TestLayer.pipe(Layer.provideMerge(Store.layer))),
      Effect.runPromise,
    );

    expect(openCount).toBeGreaterThanOrEqual(1);
  });

  // 2B slice 5 (issue #30): the provider injects the actual open Observations
  // as priors, not just their count — and only the ones still `open` (an
  // escalated/expired one has left the accumulation and must not resurface).
  it("sources open Observations as priors and excludes ones a prior run escalated or closed", async () => {
    const TestLayer = SeedInputsProviderLive.pipe(Layer.provide(Store.layer));

    const inputs = await Effect.gen(function* () {
      const store = yield* Store;
      const dataWindow = {
        cadence: "on-demand" as const,
        ran_at: new Date().toISOString(),
        session_ids_considered: [],
        evidence_roster_version: "seed-1",
      };
      // Commit three open Observations; capture their runner-assigned ids.
      const committed = yield* store.commitDeliberationOutput({
        runOutput: {
          decisions: [
            { kind: "observation", summary: "obs one", rationale: "r1", citations: [], reasoning_only_points: [], surface: false },
            { kind: "observation", summary: "obs two", rationale: "r2", citations: [], reasoning_only_points: [], surface: false },
            { kind: "observation", summary: "obs three", rationale: "r3", citations: [], reasoning_only_points: [], surface: false },
          ],
          observation_directives: [],
        },
        dataWindow,
      });
      const [escalateId, closeId, keepOpenId] = committed.decisionIds as ReadonlyArray<string>;
      // A later run escalates the first and closes the second; the third stays open.
      yield* store.commitDeliberationOutput({
        runOutput: {
          decisions: [],
          observation_directives: [
            { id: escalateId as never, action: "escalate" },
            { id: closeId as never, action: "close" },
          ],
        },
        dataWindow,
      });
      const provider = yield* SeedInputsProvider;
      const seedInputs = yield* provider.buildSeedInputs({ cadence: "on-demand", snapshotDbPath: "/tmp/x.sqlite" });
      return { seedInputs, escalateId, closeId, keepOpenId };
    }).pipe(
      Effect.provide(TestLayer.pipe(Layer.provideMerge(Store.layer))),
      Effect.runPromise,
    );

    const priorIds = inputs.seedInputs.openObservations.map((o) => o.id);
    expect(priorIds).toContain(inputs.keepOpenId);
    expect(priorIds).not.toContain(inputs.escalateId);
    expect(priorIds).not.toContain(inputs.closeId);
    // The prior carries the summary/rationale the agent needs to judge it.
    const kept = inputs.seedInputs.openObservations.find((o) => o.id === inputs.keepOpenId);
    expect(kept?.summary).toBe("obs three");

    // And it reaches the assembled seed with its id, ready to be named in a directive.
    const seed = assembleSeed(inputs.seedInputs);
    expect(seed).toContain(inputs.keepOpenId);
  });
});
