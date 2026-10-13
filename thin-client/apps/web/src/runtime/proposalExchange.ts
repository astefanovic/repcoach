import type { Proposal, ProposalExchangeEntry, ProposalRevisionStatus } from "@repcoach/contracts";

/**
 * Pure logic behind the Proposal card's Revise affordance (ADR 0013,
 * issue #66 slice 3) — split out of `CoachOutput.tsx` so it can be
 * unit-tested without a browser, mirroring `statusStrip.ts`'s split from the
 * shell it feeds.
 */

/**
 * The lock/spinner label (ADR 0013 §5): "queued" and "running" are two
 * different words on purpose — a silently stuck button is exactly what the
 * ADR is trying to avoid — and `"idle"` means the card is not locked at all.
 * Caution/neutral only: red is reserved for the coach's proposed change
 * (#43), never for the lock.
 */
export function reviseLockLabel(status: ProposalRevisionStatus): string | undefined {
  switch (status) {
    case "idle":
      return undefined;
    case "queued":
      return "Revising — waiting for a slot…";
    case "running":
      return "Revising — running now…";
  }
}

/** Whether the card is locked (ADR 0013 §5): no Accept, no Dismiss, no second Revise. */
export function isRevisionLocked(status: ProposalRevisionStatus): boolean {
  return status !== "idle";
}

/** Whether the Revise textarea's contents are worth sending — non-blank once trimmed. */
export function canSubmitRevise(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * The lineage fold (ADR 0013 §9): `entries` arrives oldest-first from
 * `ProposalExchange`. Everything but the **current turn** collapses by
 * default — a turn being the most recent Revise and whatever it produced
 * (an Answer and/or a superseded-proposal marker). A fresh Proposal with no
 * exchange yet has nothing current and nothing collapsed.
 *
 * The split point is the last `"revise"` entry: everything from there to the
 * end is current, everything before it is collapsed history. This is the
 * whole of the fold — no client-side chain walk, the entries already arrived
 * assembled by the store (`Store.getProposalExchange`).
 */
export function foldExchangeEntries(entries: ReadonlyArray<ProposalExchangeEntry>): {
  readonly collapsed: ReadonlyArray<ProposalExchangeEntry>;
  readonly current: ReadonlyArray<ProposalExchangeEntry>;
} {
  let lastReviseIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.kind === "revise") {
      lastReviseIndex = i;
      break;
    }
  }
  if (lastReviseIndex === -1) {
    return { collapsed: entries, current: [] };
  }
  return {
    collapsed: entries.slice(0, lastReviseIndex),
    current: entries.slice(lastReviseIndex),
  };
}

/**
 * Bundled constraint-promotion disclosure (ADR 0013 §8) — the one UI
 * requirement the ADR frames as a *trust obligation*: a revision may fold a
 * Standing-constraint promotion into itself, so a single Accept can install a
 * durable rule. The agent is instructed to state that plainly in the
 * revision's own summary/rationale (§8: "the revision reads: '...and I'd like
 * to record ... as a standing constraint — accept both?'"), so detection is a
 * text scan over those two fields rather than a structured flag — there is no
 * separate wire signal for it (`Proposal` carries no such field), and the ADR
 * places the obligation on the agent's prose, not on a schema addition.
 */
export function detectsConstraintPromotion(proposal: Pick<Proposal, "summary" | "rationale">): boolean {
  const text = `${proposal.summary} ${proposal.rationale}`.toLowerCase();
  return (
    text.includes("standing constraint") ||
    text.includes("standing rule") ||
    (text.includes("standing") && text.includes("constraint"))
  );
}
