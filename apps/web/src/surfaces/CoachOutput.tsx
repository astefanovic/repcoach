// Today's coach output: the ONE undecided Proposal, with its working and its
// actions (#42 — Today carries what is still owed a decision; the permanent
// record is the Coach surface).
//
// **This file used to be the last fixture-driven surface in the app** (#72 left
// it that way deliberately, because the working had no contract behind it).
// #79 gave it one: the measurements, the rule and the uncertainty are now
// optional fields on `DecisionDraft`, fetched per item through `decisions.get`.
// Everything on screen here is live, and every block is conditional — the card
// shows what the run actually produced and nothing it did not.
//
// Two deletions came with that. The hardcoded Observation item is gone
// (Observations are the Coach surface's, not Today's), and so is the
// provenance footer's model and token count — nothing persists either per
// Decision, so a footer naming them would have been naming a guess. What the
// data window does know — cadence, when it ran, how much it read — moved into
// the item itself, where an item-per-run record needs it.
//
// The presentation lives in `coachItem.tsx`, shared with the Coach surface, so
// what you accept here and what you re-read there are visibly one artifact.
import { useState } from "react";

import type { Proposal, ProposalExchange, ProposalExchangeEntry } from "@repcoach/contracts";

import {
  canSubmitRevise,
  detectsConstraintPromotion,
  foldExchangeEntries,
  isRevisionLocked,
  reviseLockLabel,
} from "../runtime/proposalExchange.ts";
import { useDecisionWorking } from "../runtime/useDecisionWorking.ts";
import { useProposedChange, type ProposedChangeState } from "../runtime/useProposedChange.ts";
import { useProposalCard, type ProposalCardActions } from "../runtime/useProposalCard.ts";
import {
  Block,
  ItemHeader,
  Kind,
  Provenance,
  Working,
  collapsedHint,
  windowLabel,
} from "./coachItem.tsx";

export function CoachOutput() {
  const card = useProposalCard();
  const [open, setOpen] = useState(true);

  return (
    <>
      <h2 className="mt-6 flex items-baseline gap-2 border-b border-border-strong pb-1 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">
        Coach output
        <span className="text-text-faint">{card.status === "ready" ? "1 item" : "nothing owed"}</span>
      </h2>

      {card.status === "ready" ? (
        <ProposalItem
          open={open}
          onToggle={() => setOpen((v) => !v)}
          proposal={card.proposal}
          exchange={card.exchange}
          actions={card}
        />
      ) : (
        <EmptyProposalItem status={card.status} reason={card.status === "failed" ? card.reason : undefined} />
      )}
    </>
  );
}

/**
 * The honest empty state (in place of a fake card) when there is no live
 * pending Proposal to show — either none exists, the subscription is still
 * loading, or it failed outright.
 */
function EmptyProposalItem({
  status,
  reason,
}: {
  readonly status: "loading" | "empty" | "failed";
  readonly reason: string | undefined;
}) {
  return (
    <article className="mt-6 border-t-2 border-border-strong pt-2.5 pb-4 first:mt-3">
      <span className="flex items-center gap-2">
        <Kind tone="muted">Proposal</Kind>
      </span>
      <p className="mt-2 text-sm leading-snug text-text-muted">
        {status === "loading" && "Loading…"}
        {status === "empty" && "Nothing pending — the coach has no proposed change right now."}
        {status === "failed" && `Could not load the Proposal — ${reason}`}
      </p>
    </article>
  );
}

function ProposalItem({
  open,
  onToggle,
  proposal: liveProposal,
  exchange,
  actions,
}: {
  open: boolean;
  onToggle: () => void;
  proposal: Proposal;
  exchange: ProposalExchange | undefined;
  actions: ProposalCardActions;
}) {
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseText, setReviseText] = useState("");

  const revisionStatus = exchange?.revisionStatus ?? "idle";
  const locked = isRevisionLocked(revisionStatus);
  const lockLabel = reviseLockLabel(revisionStatus);
  const promotesConstraint = detectsConstraintPromotion(liveProposal);
  const { collapsed, current } = foldExchangeEntries(exchange?.entries ?? []);

  // A Proposal's id and its Decision row's id are the same id (the row IS the
  // Proposal — `store.getProposals` filters the decision table by kind), so
  // the card's working is one fetch away. Only while expanded: the collapsed
  // card shows the summary, which arrives on the Proposal itself.
  const workingState = useDecisionWorking(liveProposal.id as never, open);
  const working = workingState.status === "ready" ? workingState.working : undefined;

  // What Accept would actually do (#86) — the operations the Proposal carries,
  // folded over the standing Plan by the same applier the server uses. Shown
  // collapsed or expanded, unlike the working: the change is the thing being
  // decided, not part of the explanation behind it.
  const proposedChange = useProposedChange(liveProposal);

  const submitRevise = () => {
    if (!canSubmitRevise(reviseText)) return;
    const text = reviseText.trim();
    void actions.revise(text).then(() => {
      setReviseText("");
      setReviseOpen(false);
    });
  };

  return (
    <article className="mt-6 first:mt-3">
      <ItemHeader
        kind="Proposal"
        window={windowLabel(working)}
        headline={liveProposal.summary}
        collapsedHint={collapsedHint(working)}
        open={open}
        onToggle={onToggle}
      />

      <div className={open ? "pl-5" : ""}>
        <ProposedChange state={proposedChange} />
      </div>

      {open && (
        <div className="pl-5">
          <Working state={workingState} />

          {(collapsed.length > 0 || current.length > 0) && (
            <ExchangeLineage collapsed={collapsed} current={current} />
          )}

          <Provenance working={working} />
        </div>
      )}

      {/* ADR 0013 §8 — a bundled Standing-constraint promotion must be stated
          plainly next to Accept, never a silent second effect of one tap. */}
      {promotesConstraint && (
        <p
          className={`mt-4 text-xs leading-snug font-semibold text-deviation ${open ? "pl-5" : ""}`}
        >
          Accepting this also records a new standing constraint — read the summary above before you
          accept.
        </p>
      )}

      {/* The lock (ADR 0013 §5): queued/running hides Accept/Dismiss/Revise
          entirely and leaves Cancel as the one way out. Caution tone only —
          red stays reserved for the coach's proposed change (#43). */}
      {locked ? (
        <div className={`mt-4 flex items-center gap-3 ${open ? "pl-5" : ""}`}>
          <span className="flex h-tap flex-1 items-center gap-2 rounded-control border border-deviation/50 bg-deviation-quiet px-3 font-numeric text-[0.6875rem] font-semibold tracking-wider text-deviation uppercase">
            <span aria-hidden className="inline-block animate-spin">
              ◐
            </span>
            {lockLabel}
          </span>
          <button
            onClick={() => void actions.cancelRevision()}
            disabled={actions.actionPending}
            className="h-tap rounded-control border border-border-strong px-3 font-numeric text-[0.6875rem] font-semibold tracking-wider uppercase disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <div className={`mt-4 flex gap-1.5 ${open ? "pl-5" : ""}`}>
            <button
              onClick={() => void actions.resolve("accepted")}
              /* A Proposal whose operations no longer apply would be refused
                 server-side and change nothing (#86). Disabling says so before
                 the tap; the reason is already stated in the block above. */
              disabled={actions.actionPending || proposedChange.status === "rejected"}
              className="h-tap flex-[2] rounded-control bg-accent px-3 font-numeric text-[0.6875rem] font-semibold tracking-wider text-on-accent uppercase disabled:opacity-50"
            >
              Accept — apply to plan
            </button>
            {/* #42 handed #60 a constraint: Revise expands IN PLACE on this
                card. No chat destination, no fifth chrome slot. Renamed from
                "Push back" per ADR 0013 §1 — the coach revises, not the user. */}
            <button
              onClick={() => setReviseOpen((v) => !v)}
              disabled={actions.actionPending}
              aria-expanded={reviseOpen}
              className="h-tap flex-1 rounded-control border border-border-strong px-3 font-numeric text-[0.6875rem] font-semibold tracking-wider uppercase disabled:opacity-50"
            >
              Revise
            </button>
            <button
              onClick={() => void actions.resolve("rejected")}
              disabled={actions.actionPending}
              className="h-tap flex-1 rounded-control border border-border px-3 font-numeric text-[0.6875rem] font-semibold tracking-wider text-text-muted uppercase disabled:opacity-50"
            >
              Dismiss
            </button>
          </div>

          {reviseOpen && (
            <div className={`mt-3 ${open ? "pl-5" : ""}`}>
              <textarea
                value={reviseText}
                onChange={(e) => setReviseText(e.target.value)}
                placeholder="ask a question, object, or request a change"
                rows={3}
                className="w-full rounded-control border border-border-strong bg-surface p-2.5 text-sm leading-snug placeholder:text-text-faint"
              />
              <div className="mt-1.5 flex gap-1.5">
                <button
                  onClick={submitRevise}
                  disabled={actions.actionPending || !canSubmitRevise(reviseText)}
                  className="h-tap flex-1 rounded-control border border-border-strong px-3 font-numeric text-[0.6875rem] font-semibold tracking-wider uppercase disabled:opacity-50"
                >
                  Send
                </button>
                <button
                  onClick={() => {
                    setReviseOpen(false);
                    setReviseText("");
                  }}
                  className="h-tap rounded-control px-3 font-numeric text-[0.6875rem] tracking-wider text-text-muted uppercase"
                >
                  Never mind
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {actions.actionError !== undefined && (
        <p className={`mt-2 font-numeric text-[0.6875rem] text-deviation ${open ? "pl-5" : ""}`}>
          {actions.actionError}
        </p>
      )}
    </article>
  );
}

/**
 * **The change itself** (#86), as a diff against the standing Plan.
 *
 * A Proposal is a Change awaiting approval, and until #86 the card could only
 * show the coach's *prose* about it — accepting applied a fixed stand-in that
 * had nothing to do with what the summary said. Now the Proposal carries ADR
 * 0015 operations and this block renders the fold of them over the live Plan,
 * so what is on screen and what Accept applies are the same computation.
 *
 * Three states worth their own copy. Nothing to show is silence, not an empty
 * block: an Observation-shaped Proposal proposes no Plan change and saying
 * "no changes" would invent a claim. A change that no longer applies is stated
 * plainly, because the honest thing to tell someone about to tap Accept is
 * that it would be refused.
 */
function ProposedChange({ state }: { readonly state: ProposedChangeState }) {
  if (state.status === "none") return null;
  if (state.status === "loading") {
    return (
      <Block title="Proposed change">
        <p className="mt-1.5 text-sm leading-snug text-text-muted">Reading your plan…</p>
      </Block>
    );
  }
  if (state.status === "rejected") {
    return (
      <Block title="Proposed change" tone="deviation">
        <p className="mt-1.5 text-sm leading-snug text-deviation">
          This no longer applies to your plan — {state.reason}. Revise it or dismiss it; accepting
          would change nothing.
        </p>
      </Block>
    );
  }
  if (state.lines.length === 0) {
    return (
      <Block title="Proposed change">
        <p className="mt-1.5 text-sm leading-snug text-text-muted">
          Your plan already reads this way — accepting changes nothing.
        </p>
      </Block>
    );
  }
  return (
    <Block title="Proposed change" tone="deviation">
      <ul className="mt-1.5 space-y-2">
        {state.lines.map((line, i) => (
          <li key={i} className="text-sm leading-snug">
            <span className="block font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase">
              {line.subject}
            </span>
            {line.before !== undefined && (
              <span className="text-text-faint line-through">{line.before}</span>
            )}
            {line.before !== undefined && line.after !== undefined && (
              <span aria-hidden className="px-1.5 text-text-faint">
                →
              </span>
            )}
            {line.after !== undefined && <span className="text-deviation">{line.after}</span>}
          </li>
        ))}
      </ul>
    </Block>
  );
}

/**
 * The lineage (ADR 0013 §9): `[current turn] + [collapsed history]`. Rendered
 * as an appended, collapsible list under the card — never a chat/bubble
 * transcript, never a thread view (#42). `entries` arrives oldest-first
 * already assembled by the store; this only decides which half is visible by
 * default (`foldExchangeEntries`).
 */
function ExchangeLineage({
  collapsed,
  current,
}: {
  readonly collapsed: ReadonlyArray<ProposalExchangeEntry>;
  readonly current: ReadonlyArray<ProposalExchangeEntry>;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <Block title="Exchange">
      {collapsed.length > 0 && (
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          aria-expanded={historyOpen}
          className="mb-2 block font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase underline underline-offset-4"
        >
          {historyOpen ? "Hide" : "Show"} earlier turns ({collapsed.length})
        </button>
      )}
      {historyOpen && (
        <ul className="mb-3 space-y-2 border-b border-border pb-3">
          {collapsed.map((entry, i) => (
            <ExchangeEntryRow key={i} entry={entry} />
          ))}
        </ul>
      )}
      <ul className="space-y-2">
        {current.map((entry, i) => (
          <ExchangeEntryRow key={i} entry={entry} />
        ))}
      </ul>
    </Block>
  );
}

function ExchangeEntryRow({ entry }: { readonly entry: ProposalExchangeEntry }) {
  switch (entry.kind) {
    case "revise":
      return (
        <li className="text-sm leading-snug">
          <Kind>You</Kind> {entry.text}
        </li>
      );
    case "answer":
      return (
        <li className="text-sm leading-snug">
          <Kind tone="muted">Coach</Kind> {entry.summary}
          {entry.rationale.length > 0 && (
            <span className="mt-0.5 block text-xs text-text-muted">{entry.rationale}</span>
          )}
        </li>
      );
    case "superseded-proposal":
      return (
        <li className="text-sm leading-snug text-text-faint">
          <Kind tone="muted">Previous version</Kind> {entry.summary}
        </li>
      );
  }
}
