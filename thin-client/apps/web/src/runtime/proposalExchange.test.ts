import { describe, expect, it } from "vitest";
import type { ProposalExchangeEntry } from "@repcoach/contracts";

import {
  canSubmitRevise,
  detectsConstraintPromotion,
  foldExchangeEntries,
  isRevisionLocked,
  reviseLockLabel,
} from "./proposalExchange.ts";

function revise(text: string): ProposalExchangeEntry {
  return { kind: "revise", text: text as never, createdAt: "2026-01-01T00:00:00.000Z" as never };
}

function answer(id: string): ProposalExchangeEntry {
  return {
    kind: "answer",
    id: id as never,
    summary: "an answer" as never,
    rationale: "because" as never,
    citations: [],
    createdAt: "2026-01-01T00:00:01.000Z" as never,
  };
}

function superseded(id: string): ProposalExchangeEntry {
  return {
    kind: "superseded-proposal",
    id: id as never,
    summary: "a prior proposal" as never,
    rationale: "because" as never,
    createdAt: "2026-01-01T00:00:02.000Z" as never,
  };
}

describe("reviseLockLabel / isRevisionLocked", () => {
  it("is undefined and unlocked when idle", () => {
    expect(reviseLockLabel("idle")).toBeUndefined();
    expect(isRevisionLocked("idle")).toBe(false);
  });

  it("distinguishes queued from running (ADR 0013 §5 — the lock must explain itself)", () => {
    const queued = reviseLockLabel("queued")!;
    const running = reviseLockLabel("running")!;
    expect(queued).not.toEqual(running);
    expect(queued.toLowerCase()).toContain("waiting");
    expect(running.toLowerCase()).toContain("running");
  });

  it("locks on both queued and running", () => {
    expect(isRevisionLocked("queued")).toBe(true);
    expect(isRevisionLocked("running")).toBe(true);
  });
});

describe("canSubmitRevise", () => {
  it("rejects blank and whitespace-only text", () => {
    expect(canSubmitRevise("")).toBe(false);
    expect(canSubmitRevise("   ")).toBe(false);
  });

  it("accepts text once trimmed", () => {
    expect(canSubmitRevise("  no more than 3 days a week  ")).toBe(true);
  });
});

describe("foldExchangeEntries", () => {
  it("treats an empty exchange as nothing current and nothing collapsed", () => {
    const { collapsed, current } = foldExchangeEntries([]);
    expect(collapsed).toEqual([]);
    expect(current).toEqual([]);
  });

  it("keeps a single revise turn entirely current", () => {
    const entries = [revise("why 5 days?"), answer("a1")];
    const { collapsed, current } = foldExchangeEntries(entries);
    expect(collapsed).toEqual([]);
    expect(current).toEqual(entries);
  });

  it("collapses everything before the most recent revise", () => {
    const entries = [
      revise("why 5 days?"),
      answer("a1"),
      revise("not 5 days, I can't do more than 3"),
      superseded("p1"),
      answer("a2"),
    ];
    const { collapsed, current } = foldExchangeEntries(entries);
    expect(collapsed).toEqual(entries.slice(0, 2));
    expect(current).toEqual(entries.slice(2));
  });
});

describe("detectsConstraintPromotion", () => {
  it("is false for an ordinary revision with no bundled promotion", () => {
    expect(
      detectsConstraintPromotion({
        summary: "3 days instead of 5" as never,
        rationale: "You said you can't train more than 3 days a week." as never,
      }),
    ).toBe(false);
  });

  it("is true when the revision states it plainly (ADR 0013 §8's own example)", () => {
    expect(
      detectsConstraintPromotion({
        summary: "3 days instead of 5, and record 'max 3 training days' as a standing constraint" as never,
        rationale: "You asked for a hard cap, so this also proposes a standing constraint." as never,
      }),
    ).toBe(true);
  });

  it("catches the phrase in either field, and is case-insensitive", () => {
    expect(
      detectsConstraintPromotion({
        summary: "ok" as never,
        rationale: "This also installs a STANDING RULE going forward." as never,
      }),
    ).toBe(true);
  });
});
