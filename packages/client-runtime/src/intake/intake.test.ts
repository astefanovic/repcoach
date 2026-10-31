import type {
  ConvergeIntakeResult,
  IntakeDraftPlan,
  IntakeSweepDisclosure,
  IntakeToolEvent,
  IntakeTurn,
} from "@repcoach/contracts";
import { describe, expect, it } from "vitest";

import { intakeActivityLines, phraseIntakeToolEvent } from "./activity.ts";
import { provisionalCitations, scopeDisclosure, sweptCitations, turnCitationIds } from "./citations.ts";
import { summariseDisclosure } from "./disclosure.ts";
import { draftSessionLines, formatDraftSets } from "./draft.ts";
import {
  emptyIntakeForm,
  isIntakeAnswerSubmittable,
  isIntakeFormDirty,
  isIntakeFormReady,
  isIntakeTakeoverDirty,
  summariseIntakeForm,
  toStartIntakeInput,
  toggleEquipment,
} from "./form.ts";
import { deriveIntakeLedger, describeDraftChange } from "./ledger.ts";
import { coldDraftFailureMessage, sweepFailureMessage, turnFailureMessage } from "./messages.ts";
import { addIntakeSpend, formatIntakeSpend, noIntakeSpend } from "./spend.ts";

/* --------------------------------------------------------------- fixtures */

const plan = (overrides?: Partial<IntakeDraftPlan>): IntakeDraftPlan => ({
  planModel: "upper/lower",
  headline: "Upper / lower, four days a week",
  sessions: [
    {
      label: "Upper A",
      entries: [
        {
          exerciseId: "ex-bench" as never,
          exerciseName: "DB bench",
          sets: [
            { setType: "working", target: { reps: { min: 6, max: 10 } } },
            { setType: "working", target: { reps: { min: 6, max: 10 } } },
          ],
        },
        {
          exerciseId: "ex-row" as never,
          exerciseName: "Row",
          sets: [{ setType: "working", target: { reps: { min: 8, max: 12 } } }],
        },
      ],
    },
  ],
  ...overrides,
});

const turn = (overrides?: Partial<IntakeTurn>): IntakeTurn => ({
  revision: 1,
  draftPlan: plan(),
  rationale: [
    { text: "Four days lets each muscle be trained twice a week.", citationId: "c1" },
    { text: "Starting loads come off your own numbers." },
  ],
  citations: [
    { id: "c1", claim: "10–20 hard sets per muscle per week.", source_url: "https://example.org/dose" },
    { id: "c2", claim: "Unused by the rationale.", source_url: "https://example.org/unused" },
  ],
  calibrationNote: "This first block is more template than coaching.",
  usage: { input: 20_000, output: 4_000, cacheRead: 0, cacheCreation: 0 },
  ...overrides,
});

const event = (seq: number, tool: string, subject?: string): IntakeToolEvent => ({
  seq,
  tool,
  ...(subject === undefined ? {} : { subject }),
});

/* ------------------------------------------------------------------- form */

describe("the form", () => {
  it("gates submit on the goal and days only", () => {
    expect(isIntakeFormReady(emptyIntakeForm)).toBe(false);
    expect(isIntakeFormReady({ ...emptyIntakeForm, goal: "  " })).toBe(false);
    // No equipment, no lifts — and still submittable, which is what makes the
    // optional fields visibly optional.
    expect(isIntakeFormReady({ ...emptyIntakeForm, goal: "get stronger" })).toBe(true);
  });

  it("multi-selects equipment", () => {
    const one = toggleEquipment(emptyIntakeForm, "Dumbbells");
    const two = toggleEquipment(one, "Barbell + rack");
    expect(two.equipment).toEqual(["Dumbbells", "Barbell + rack"]);
    expect(toggleEquipment(two, "Dumbbells").equipment).toEqual(["Barbell + rack"]);
  });

  it("summarises unanswered optional fields as answers rather than gaps", () => {
    expect(summariseIntakeForm({ ...emptyIntakeForm, goal: " get stronger " })).toBe(
      "get stronger · 4 days · equipment unstated · no current lifts given",
    );
    expect(
      summariseIntakeForm({
        goal: "put on size",
        daysPerWeek: 3,
        equipment: ["Dumbbells", "Barbell + rack"],
        lifts: " squat 100 ",
      }),
    ).toBe("put on size · 3 days · dumbbells, barbell + rack · squat 100");
  });

  it("omits a skipped lifts field rather than sending it blank", () => {
    expect(toStartIntakeInput({ ...emptyIntakeForm, goal: " get stronger " })).toEqual({
      goal: "get stronger",
      daysPerWeek: 4,
      equipment: [],
    });
    expect(toStartIntakeInput({ ...emptyIntakeForm, goal: "g", lifts: " squat 100 " })).toMatchObject({
      lifts: "squat 100",
    });
  });

  it("measures dirtiness against how the screen opened, not against an empty form", () => {
    const opened = { ...emptyIntakeForm, goal: "get stronger", equipment: ["Dumbbells"] };
    expect(isIntakeFormDirty(opened, opened)).toBe(false);
    expect(isIntakeFormDirty({ ...opened, equipment: [] }, opened)).toBe(true);
    expect(isIntakeFormDirty({ ...opened, daysPerWeek: 5 }, opened)).toBe(true);
  });

  it("counts a landed cold draft as something to lose even with the form untouched", () => {
    const opened = { ...emptyIntakeForm, goal: "get stronger" };
    expect(isIntakeTakeoverDirty(undefined, opened, opened)).toBe(false);
    expect(isIntakeTakeoverDirty(turn(), opened, opened)).toBe(true);
  });

  it("still catches form edits before any turn has landed", () => {
    const opened = { ...emptyIntakeForm, goal: "get stronger" };
    expect(isIntakeTakeoverDirty(undefined, { ...opened, daysPerWeek: 5 }, opened)).toBe(true);
  });
});

describe("the exchange answer", () => {
  it("is submittable once trimmed and non-empty", () => {
    expect(isIntakeAnswerSubmittable("")).toBe(false);
    expect(isIntakeAnswerSubmittable("   ")).toBe(false);
    expect(isIntakeAnswerSubmittable("  3 days is plenty  ")).toBe(true);
  });
});

/* -------------------------------------------------------- activity phrasing */

describe("the activity line", () => {
  it("phrases known tools in plain language, never the tool name", () => {
    expect(phraseIntakeToolEvent(event(1, "WebSearch", "training frequency"))).toBe(
      "reading up on training frequency",
    );
    expect(phraseIntakeToolEvent(event(2, "WebFetch", "https://pubmed.gov/a/b?c=d"))).toBe(
      "reading pubmed.gov",
    );
    expect(phraseIntakeToolEvent(event(3, "collect_claims", "5"))).toBe(
      "collecting every claim in the plan",
    );
    expect(phraseIntakeToolEvent(event(4, "rewrite_rationale"))).toBe(
      "rewriting the rationale around what held",
    );
  });

  it("renders an unrecognised tool honestly rather than blank", () => {
    expect(phraseIntakeToolEvent(event(1, "draft_session", "Upper A"))).toBe(
      "draft session — Upper A",
    );
    expect(phraseIntakeToolEvent(event(2, "SomeNewTool"))).toBe("some new tool");
  });

  it("orders by seq and drops replays", () => {
    const lines = intakeActivityLines([
      event(2, "WebSearch", "set volume"),
      event(1, "WebSearch", "training frequency"),
      event(2, "WebSearch", "set volume"),
    ]);
    expect(lines.map((line) => line.seq)).toEqual([1, 2]);
  });

  it("derives the sweep's ordinals from the scoped citation count", () => {
    const lines = intakeActivityLines(
      [
        event(1, "collect_claims", "2"),
        event(2, "verify_citation", "https://a.example"),
        event(3, "verify_citation", "https://b.example"),
      ],
      { citationCount: 2 },
    );
    expect(lines.map((line) => line.text)).toEqual([
      "collecting every claim in the plan",
      "checking source 1 of 2",
      "checking source 2 of 2",
    ]);
  });

  it("says what it is doing and no more when there is no count to give", () => {
    expect(intakeActivityLines([event(1, "verify_citation")])[0]!.text).toBe("checking a source");
  });
});

/* ----------------------------------------------------- citation lifecycle */

describe("the citation lifecycle", () => {
  it("scopes a plan's citations to what its rationale actually cites", () => {
    // `c2` is on the turn but cited by nothing, so it is not this plan's.
    expect(turnCitationIds(turn())).toEqual(["c1"]);
  });

  it("renders an interim citation as provisional and never as trusted", () => {
    const lookup = provisionalCitations(turn());
    expect(lookup("c1")).toEqual({
      status: "provisional",
      id: "c1",
      claim: "10–20 hard sets per muscle per week.",
      source_url: "https://example.org/dose",
    });
    expect(lookup(undefined)).toBeUndefined();
    expect(lookup("nope")).toBeUndefined();
  });

  it("replaces the marking with a verdict after the sweep", () => {
    const result = {
      proposalId: "d1" as never,
      revision: 5,
      draftPlan: plan(),
      rationale: [{ text: "Four days.", citationId: "c1" }, { text: "Folklore.", citationId: "c4" }],
      citations: [
        {
          id: "c1",
          claim: "10–20 hard sets per muscle per week.",
          source_url: "https://example.org/dose",
          trust: "corpus-verified",
        },
      ],
      calibrationNote: "note",
      disclosure: {
        verdicts: [
          {
            citationId: "c1",
            claim: "10–20 hard sets.",
            source_url: "https://example.org/dose",
            outcome: "corpus-verified",
          },
          {
            citationId: "c4",
            claim: "Heavy top set folklore.",
            source_url: "https://example.org/folklore",
            outcome: "removed",
            why: "no source found that says this",
          },
        ],
      },
      usage: { input: 10_000, output: 2_000, cacheRead: 0, cacheCreation: 0 },
    } satisfies ConvergeIntakeResult;

    const lookup = sweptCitations(result);
    expect(lookup("c1")).toMatchObject({ status: "verified", trust: "corpus-verified" });
    // A removed source still resolves, so the line it backed can be marked
    // reasoning-only instead of quietly losing its support.
    expect(lookup("c4")).toMatchObject({ status: "removed", why: "no source found that says this" });
  });
});

/* ------------------------------------------------------ disclosure scoping */

describe("the sweep's disclosure", () => {
  const disclosure: IntakeSweepDisclosure = {
    verdicts: [
      { citationId: "c1", claim: "a", source_url: "https://a", outcome: "corpus-verified" },
      { citationId: "c2", claim: "b", source_url: "https://b", outcome: "retrieved-unverified" },
      { citationId: "c3", claim: "c", source_url: "https://c", outcome: "removed", why: "folklore" },
    ],
  };

  it("discloses only the citations the converged plan carried", () => {
    // The impatient user: converged straight off a draft that cited c1 alone.
    // Reporting c3's removal here would be reporting a source they never saw.
    const scoped = scopeDisclosure(disclosure, ["c1"]);
    expect(scoped.map((verdict) => verdict.citationId)).toEqual(["c1"]);
    expect(summariseDisclosure(scoped).removed).toEqual([]);
    expect(summariseDisclosure(scoped).statement).toBe(
      "Every source held up. 1 of 1 is in the corpus.",
    );
  });

  it("orders the verdicts the way the plan's rationale stated them", () => {
    expect(scopeDisclosure(disclosure, ["c3", "c1"]).map((v) => v.citationId)).toEqual(["c3", "c1"]);
  });

  it("only reassures about the prescription when something was removed", () => {
    expect(summariseDisclosure(scopeDisclosure(disclosure, ["c1", "c2"])).prescriptionUntouched).toBe(
      false,
    );
    const all = summariseDisclosure(scopeDisclosure(disclosure, ["c1", "c2", "c3"]));
    expect(all.prescriptionUntouched).toBe(true);
    expect(all.statement).toBe(
      "One source didn't hold up and was removed. Two held: 1 verified against the corpus, 1 retrieved but unverified.",
    );
  });

  it("calls a gutted plan gutted without calling it an error", () => {
    const gutted = summariseDisclosure([
      { citationId: "c1", claim: "a", source_url: "https://a", outcome: "corpus-verified" },
      { citationId: "c2", claim: "b", source_url: "https://b", outcome: "removed", why: "x" },
      { citationId: "c3", claim: "c", source_url: "https://c", outcome: "removed", why: "y" },
    ]);
    expect(gutted.gutted).toBe(true);
    expect(gutted.statement).toMatch(/^Two sources didn't hold up and were removed\./);
  });

  it("says so when the plan cited nothing at all", () => {
    expect(summariseDisclosure([]).statement).toMatch(/cited no sources/);
    expect(summariseDisclosure([]).gutted).toBe(false);
  });
});

/* ------------------------------------------------------------ the ledger */

describe("the revision ledger", () => {
  it("says what the answer did to the plan", () => {
    const before = plan();
    const after = plan({
      sessions: [
        {
          label: "Upper A",
          entries: [
            {
              exerciseId: "ex-incline" as never,
              exerciseName: "Incline DB press",
              sets: [{ setType: "working", target: { reps: { min: 8, max: 12 } } }],
            },
            {
              exerciseId: "ex-row" as never,
              exerciseName: "Row",
              sets: [{ setType: "working", target: { reps: { min: 8, max: 12 } } }],
            },
          ],
        },
      ],
    });
    expect(describeDraftChange(before, after)).toBe("Upper A: DB bench → Incline DB press");
  });

  it("reports a changed prescription on an exercise that stayed", () => {
    const after = plan({
      sessions: [
        {
          label: "Upper A",
          entries: [
            {
              exerciseId: "ex-bench" as never,
              exerciseName: "DB bench",
              sets: [
                { setType: "working", target: { reps: { min: 4, max: 6 } } },
                { setType: "working", target: { reps: { min: 6, max: 10 } } },
              ],
            },
            {
              exerciseId: "ex-row" as never,
              exerciseName: "Row",
              sets: [{ setType: "working", target: { reps: { min: 8, max: 12 } } }],
            },
          ],
        },
      ],
    });
    expect(describeDraftChange(plan(), after)).toBe(
      "Upper A: DB bench now 1 × 4-6 reps, 1 × 6-10 reps",
    );
  });

  it("leads with the headline when the shape of the plan changed", () => {
    expect(describeDraftChange(plan(), plan({ headline: "Full body, three days" }))).toBe(
      "Now “Full body, three days”",
    );
  });

  it("states an unchanged plan rather than rendering a blank row", () => {
    expect(describeDraftChange(plan(), plan())).toBe("Noted — the plan is unchanged.");
  });

  it("keeps the user's own words subordinate to the consequence, newest first", () => {
    const second = turn({
      revision: 2,
      draftPlan: plan({ headline: "Upper / lower, four days — heavy top set" }),
    });
    const third = turn({ revision: 3, draftPlan: plan({ headline: "Upper / lower, low spinal load" }) });
    const ledger = deriveIntakeLedger(turn(), [
      { answer: "Both, honestly", turn: second },
      { answer: "Bad lower back", turn: third },
    ]);
    expect(ledger).toEqual([
      { revision: 3, changed: "Now “Upper / lower, low spinal load”", answer: "Bad lower back" },
      {
        revision: 2,
        changed: "Now “Upper / lower, four days — heavy top set”",
        answer: "Both, honestly",
      },
    ]);
  });
});

/* -------------------------------------------------------- drafted plan text */

describe("the drafted plan", () => {
  it("coalesces identical sets into runs the way the Plan view does", () => {
    expect(draftSessionLines(plan())).toEqual([
      { label: "Upper A", body: "DB bench 2 × 6-10 reps · Row 1 × 8-12 reps" },
    ]);
  });

  it("expresses the metrics a reps/load pair could not", () => {
    expect(
      formatDraftSets({
        exerciseId: "ex-plank" as never,
        exerciseName: "Plank",
        sets: [{ setType: "working", target: { duration: { min: 45 }, rpe: {} } }],
      }),
    ).toBe("1 × 45+ sec · report effort");
    expect(
      formatDraftSets({
        exerciseId: "ex-carry" as never,
        exerciseName: "Carry",
        sets: [{ setType: "working", target: { distance: { min: 40, max: 40 }, load: { min: 24, max: 24 } } }],
      }),
    ).toBe("1 × 24 kg · 40 m");
  });

  it("states an empty entry rather than rendering it blank", () => {
    expect(formatDraftSets({ exerciseId: "e" as never, exerciseName: "Squat", sets: [] })).toBe(
      "no sets drafted",
    );
  });
});

/* -------------------------------------------------------------- the spend */

describe("the spend footer", () => {
  it("shows nothing until a run has returned", () => {
    expect(formatIntakeSpend(noIntakeSpend, "claude-sonnet-4.5")).toBeUndefined();
  });

  it("accumulates across the held-open session and counts only turns as turns", () => {
    const afterCold = addIntakeSpend(noIntakeSpend, { input: 30_000, output: 8_400, cacheRead: 0, cacheCreation: 0 });
    const afterTurn = addIntakeSpend(afterCold, { input: 3_000, output: 1_100, cacheRead: 0, cacheCreation: 0 }, { countsAsTurn: true });
    expect(formatIntakeSpend(afterTurn, "claude-sonnet-4.5")).toBe(
      "intake · claude-sonnet-4.5 · 42.5k tokens · 1 turn",
    );
    expect(formatIntakeSpend(afterCold)).toBe("intake · 38.4k tokens");
  });
});

/* ----------------------------------------------------------- the failures */

describe("the failure copy", () => {
  it("points a quota failure at the manual path rather than at a queue", () => {
    const quota = coldDraftFailureMessage({ _tag: "IntakeQuotaExhaustedError" });
    expect(quota.offerManualPath).toBe(true);
    expect(quota.text).toMatch(/write the first plan yourself/);
  });

  it("tells a failed turn it changed nothing", () => {
    expect(turnFailureMessage(new Error("socket closed")).text).toMatch(
      /the draft is exactly as it was/,
    );
    expect(turnFailureMessage(new Error("socket closed")).offerManualPath).toBe(false);
  });

  it("does not invite a re-send once the session is gone", () => {
    const gone = turnFailureMessage({ _tag: "IntakeSessionNotFoundError" });
    expect(gone.text).toMatch(/has ended/);
    expect(gone.offerManualPath).toBe(true);
  });

  it("leaves a failed sweep retryable with the draft untouched", () => {
    expect(sweepFailureMessage({ _tag: "IntakeSweepRejectedError" }).text).toMatch(
      /draft is untouched/,
    );
    expect(sweepFailureMessage(new Error("boom")).text).toMatch(/draft is untouched/);
  });

  it("never apologises", () => {
    const all = [
      coldDraftFailureMessage(new Error("x")),
      turnFailureMessage(new Error("x")),
      sweepFailureMessage(new Error("x")),
      coldDraftFailureMessage({ _tag: "IntakeQuotaExhaustedError" }),
    ];
    for (const message of all) {
      expect(message.text.toLowerCase()).not.toMatch(/sorry|unfortunately|error|oops/);
    }
  });
});
