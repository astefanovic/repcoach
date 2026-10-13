import { describe, expect, it } from "vitest";

import type { PlanSnapshot } from "@repcoach/contracts";

import { assembleSeed, type SeedInputs, type StandingConstraint } from "./seedContext.ts";

/**
 * ADVERSARIAL coverage for `assembleSeed` (issue #27, ADR 0011 §2) written
 * BLACK-BOX against the spec and the exported `SeedInputs`/`assembleSeed`
 * signatures only — the module's render-function bodies were not consulted
 * to shape these assertions. Targets gaps the happy-path suite
 * (`seedContext.test.ts`) doesn't probe: constraint ORDER/duplicates,
 * hostile string content, fully-empty inputs, and the cadence header line.
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

describe("assembleSeed — adversarial (ADR 0011 §2)", () => {
  it("preserves EVERY hard constraint when mixed with many soft ones in arbitrary order, including a hard constraint placed LAST", () => {
    const constraints: ReadonlyArray<StandingConstraint> = [
      { id: "soft-1", text: "Prefers barbell over machines", severity: "soft" },
      { id: "soft-2", text: "Likes supersets", severity: "soft" },
      { id: "hard-1", text: "No overhead pressing — shoulder injury", severity: "hard" },
      { id: "soft-3", text: "Dislikes cardio", severity: "soft" },
      { id: "soft-4", text: "Trains at 6am", severity: "soft" },
      { id: "hard-2", text: "Hard cap: 3 training days/week (medical)", severity: "hard" },
      { id: "soft-5", text: "Prefers dumbbells for accessories", severity: "soft" },
      // A hard constraint deliberately placed LAST in the array, to catch any
      // truncation/slicing bug that only samples a prefix of the list.
      { id: "hard-3", text: "No spinal loading above bodyweight — L4/L5 herniation", severity: "hard" },
    ];

    const seed = assembleSeed(baseInputs({ standingConstraints: constraints }));

    const hardConstraints = constraints.filter((c) => c.severity === "hard");
    for (const c of hardConstraints) {
      expect(seed).toContain(c.text);
      expect(seed).toContain(c.id);
    }
    // Also verify soft constraints are not silently dropped either (the spec
    // says "all Standing constraints (hard/soft)").
    const softConstraints = constraints.filter((c) => c.severity === "soft");
    for (const c of softConstraints) {
      expect(seed).toContain(c.text);
    }
    // The [HARD] marker must appear once per hard constraint, not merged or
    // deduped away.
    const hardMarkerCount = (seed.match(/\[HARD\]/g) ?? []).length;
    expect(hardMarkerCount).toBe(hardConstraints.length);
  });

  it("preserves duplicate constraints (same id, same text, repeated) rather than silently deduping them", () => {
    const constraints: ReadonlyArray<StandingConstraint> = [
      { id: "dup-1", text: "No overhead pressing — shoulder injury", severity: "hard" },
      { id: "dup-1", text: "No overhead pressing — shoulder injury", severity: "hard" },
      { id: "dup-1", text: "No overhead pressing — shoulder injury", severity: "hard" },
    ];
    const seed = assembleSeed(baseInputs({ standingConstraints: constraints }));
    const occurrences = seed.split("No overhead pressing — shoulder injury").length - 1;
    expect(occurrences).toBe(3);
  });

  it("does not lose or truncate a hard constraint containing newlines, markdown, quotes, and a very long run of text", () => {
    const longTail = "x".repeat(5000);
    const hostileText =
      `Multi-line hard constraint:\n` +
      `- bullet one\n` +
      `- bullet two with "quoted phrase" and 'single quotes'\n` +
      `## a fake markdown heading injected mid-constraint\n` +
      `\`\`\`\nsome fenced code block\n\`\`\`\n` +
      `tail: ${longTail}`;
    const constraints: ReadonlyArray<StandingConstraint> = [
      { id: "hostile-1", text: hostileText, severity: "hard" },
      { id: "trailing-hard", text: "Trailing hard constraint after the hostile one", severity: "hard" },
    ];

    const seed = assembleSeed(baseInputs({ standingConstraints: constraints }));

    expect(seed).toContain(hostileText);
    // The structural sections after Standing constraints must still be
    // present and intact — a hostile string must not corrupt the rest of the
    // assembled document.
    expect(seed).toContain("## Evidence-base roster");
    expect(seed).toContain("## Recent Check-ins");
    expect(seed).toContain("## Recent Context notes");
    expect(seed).toContain("## Pointer digest");
    expect(seed).toContain("## Data dictionary");
    // The constraint placed AFTER the hostile one in the array must also
    // have made it through untouched.
    expect(seed).toContain("Trailing hard constraint after the hostile one");
  });

  it("fully empty inputs (no constraints/checkins/notes, goal undefined) produce a coherent, non-crashing seed", () => {
    expect(() => assembleSeed(baseInputs())).not.toThrow();
    const seed = assembleSeed(baseInputs());

    // Every section header must still be present even with nothing to
    // render under it — an empty seed should still be a complete, readable
    // document shape, not a partial/garbled one.
    for (const header of [
      "## Goal",
      "## Plan snapshot",
      "## Standing constraints",
      "## Evidence-base roster",
      "## Retrieval guardrails",
      "## Recent Check-ins",
      "## Recent Context notes",
      "## Pointer digest",
      "## Retrieval pointers",
      "## Data dictionary",
    ]) {
      expect(seed).toContain(header);
    }
    // No stray "undefined"/"null" leaking into the rendered text from the
    // `goal: undefined` case.
    expect(seed).not.toMatch(/\bundefined\b/);
    expect(seed).not.toMatch(/\bnull\b/);
  });

  it("reflects the cadence in the run header line itself, per cadence value", () => {
    const onDemand = assembleSeed(baseInputs({ cadence: "on-demand" }));
    const sessionReview = assembleSeed(baseInputs({ cadence: "session-review" }));
    const cycleReview = assembleSeed(baseInputs({ cadence: "cycle-review" }));

    expect(onDemand).toContain("# Deliberation run — on-demand");
    expect(sessionReview).toContain("# Deliberation run — session-review");
    expect(cycleReview).toContain("# Deliberation run — cycle-review");
  });

  it("renders openObservationCount for a large, non-trivial count (not just 0/1)", () => {
    const seed = assembleSeed(
      baseInputs({
        pointerDigest: { sessionsSinceLastReview: 47, openObservationCount: 913, lastCycleReviewAt: undefined },
      }),
    );
    expect(seed).toContain("Open Observations: 913");
    expect(seed).toContain("Sessions since last review: 47");
  });

  it("the data dictionary names the ACTUAL snapshotDbPath passed in, not a hardcoded placeholder, across two distinct calls", () => {
    const pathA = "/tmp/repcoach-deliberation-snapshot-aaaa.sqlite";
    const pathB = "/tmp/repcoach-deliberation-snapshot-bbbb.sqlite";

    const seedA = assembleSeed(baseInputs({ snapshotDbPath: pathA }));
    const seedB = assembleSeed(baseInputs({ snapshotDbPath: pathB }));

    expect(seedA).toContain(pathA);
    expect(seedA).not.toContain(pathB);
    expect(seedB).toContain(pathB);
    expect(seedB).not.toContain(pathA);
  });
});
