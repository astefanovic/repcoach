import { describe, expect, it } from "vitest";

import { defaultEmptyDecisionLists, dropNullValues } from "./agentSdkSession.ts";

/**
 * Issue #93, observed against the FIRST live Intake session: the model emitted
 * `"citationId": null` on an uncited rationale line where the contract's
 * `Schema.optionalKey` wants the key absent, and the whole drafted Plan was
 * thrown away over it. `null` and absent say the same thing in these payloads,
 * so the adapters collapse one into the other before decoding.
 *
 * What must NOT happen is the other half of ADR 0011 §6: an omission softened
 * into `[]` or `""`. Dropping the key preserves "the coach offered nothing";
 * inventing an empty value would destroy it.
 */
describe("dropNullValues (issue #93)", () => {
  it("drops a null optional field so the key reads as absent", () => {
    expect(dropNullValues({ text: "double progression", citationId: null })).toEqual({
      text: "double progression",
    });
  });

  it("never substitutes an empty value for an omission (ADR 0011 §6)", () => {
    const out = dropNullValues({ summary: "s", measurements: null, rule: null }) as Record<string, unknown>;

    expect("measurements" in out).toBe(false);
    expect("rule" in out).toBe(false);
  });

  it("recurses through nested objects and arrays", () => {
    expect(
      dropNullValues({
        decisions: [{ kind: "observation", rule: null, citations: [{ claim: "c", trust: null }] }],
      }),
    ).toEqual({ decisions: [{ kind: "observation", citations: [{ claim: "c" }] }] });
  });

  it("leaves every non-null value, falsy ones included, exactly as it found them", () => {
    const input = { a: 0, b: "", c: false, d: [], e: {}, f: [1, "two", { g: true }] };

    expect(dropNullValues(input)).toEqual(input);
  });

  it("passes primitives and a bare null through without throwing", () => {
    expect(dropNullValues("plain")).toBe("plain");
    expect(dropNullValues(7)).toBe(7);
    expect(dropNullValues(null)).toBeNull();
  });
});

/**
 * Issue #93, second live Session review: the run did all its reasoning and
 * then died on `Missing key at ["decisions"][0]["reasoning_only_points"]` —
 * a list whose empty value is not ambiguous, omitted because there was
 * nothing to put in it.
 */
describe("defaultEmptyDecisionLists (issue #93)", () => {
  const decision = (extra: Record<string, unknown> = {}) => ({
    decisions: [{ kind: "observation", summary: "s", rationale: "r", surface: true, ...extra }],
  });

  it("fills in the two lists where empty and absent mean the same thing", () => {
    const out = defaultEmptyDecisionLists(decision()) as {
      decisions: ReadonlyArray<Record<string, unknown>>;
    };

    expect(out.decisions[0]?.["citations"]).toEqual([]);
    expect(out.decisions[0]?.["reasoning_only_points"]).toEqual([]);
  });

  it("leaves populated lists exactly as the run emitted them", () => {
    const citations = [{ claim: "c", source_url: "u", trust: "corpus-verified" }];
    const out = defaultEmptyDecisionLists(
      decision({ citations, reasoning_only_points: ["uncited point"] }),
    ) as { decisions: ReadonlyArray<Record<string, unknown>> };

    expect(out.decisions[0]?.["citations"]).toEqual(citations);
    expect(out.decisions[0]?.["reasoning_only_points"]).toEqual(["uncited point"]);
  });

  it("never invents the three working fields — absence there is the meaning (ADR 0011 §6)", () => {
    const out = defaultEmptyDecisionLists(decision()) as {
      decisions: ReadonlyArray<Record<string, unknown>>;
    };
    const draft = out.decisions[0] ?? {};

    expect("measurements" in draft).toBe(false);
    expect("rule" in draft).toBe(false);
    expect("uncertainty" in draft).toBe(false);
  });

  it("does not touch the working fields when the run did fill them in", () => {
    const out = defaultEmptyDecisionLists(
      decision({ measurements: [{ label: "e1RM", series: "142.5 -> 148.4 kg", delta: "+4.1%" }], rule: "R" }),
    ) as { decisions: ReadonlyArray<Record<string, unknown>> };

    expect(out.decisions[0]?.["measurements"]).toEqual([
      { label: "e1RM", series: "142.5 -> 148.4 kg", delta: "+4.1%" },
    ]);
    expect(out.decisions[0]?.["rule"]).toBe("R");
    expect("uncertainty" in (out.decisions[0] ?? {})).toBe(false);
  });

  it("surfaces a Proposal that omitted `surface` — ADR 0011 §6 says every Proposal gets a feed entry", () => {
    const out = defaultEmptyDecisionLists({ decisions: [{ kind: "proposal", summary: "s" }] }) as {
      decisions: ReadonlyArray<Record<string, unknown>>;
    };

    expect(out.decisions[0]?.["surface"]).toBe(true);
  });

  it("keeps an Observation that omitted `surface` off the feed, not out of the record", () => {
    const out = defaultEmptyDecisionLists({ decisions: [{ kind: "observation", summary: "s" }] }) as {
      decisions: ReadonlyArray<Record<string, unknown>>;
    };

    expect(out.decisions[0]?.["surface"]).toBe(false);
  });

  it("never overrides a `surface` the coach did state", () => {
    const out = defaultEmptyDecisionLists({
      decisions: [
        { kind: "observation", surface: true },
        { kind: "proposal", surface: false },
      ],
    }) as { decisions: ReadonlyArray<Record<string, unknown>> };

    expect(out.decisions[0]?.["surface"]).toBe(true);
    expect(out.decisions[1]?.["surface"]).toBe(false);
  });

  it("passes through anything that is not a decisions payload", () => {
    expect(defaultEmptyDecisionLists({ observation_directives: [] })).toEqual({ observation_directives: [] });
    expect(defaultEmptyDecisionLists("nope")).toBe("nope");
    expect(defaultEmptyDecisionLists(null)).toBeNull();
  });
});
