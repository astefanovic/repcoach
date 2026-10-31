import * as Schema from "effect/Schema";

import {
  DecisionId,
  FeedEntryId,
  IsoDateTime,
  PlanId,
  ProposalId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  Citation,
  DecisionKind,
  DecisionMeasurement,
  DecisionStatus,
  DeliberationDataWindow,
  IntakeDraftPlan,
  ProposedCatalogExercise,
} from "./deliberation.ts";
import { PlanOperation } from "./planEdit.ts";
import { PrescribedSession } from "./scaffold.ts";

/**
 * Plan / Proposal / Coaching feed (CONTEXT.md) — the always-online review
 * surfaces (thin-client-experiment.md: "online-only by design"). Subscribed
 * via `subscribe*`, which re-attaches and replays current server state on
 * reconnect (mechanism 2) rather than the client caching anything durably.
 */

// A Change has exactly two origins (CONTEXT `Change`).
export const ChangeOrigin = Schema.Literals(["coach-proposal", "user-direct"]);
export type ChangeOrigin = typeof ChangeOrigin.Type;

// A Change's status axis (CONTEXT `Change`).
export const ChangeStatus = Schema.Literals([
  "pending",
  "accepted",
  "rejected",
  "applied",
  "superseded",
]);
export type ChangeStatus = typeof ChangeStatus.Type;

/** A Proposal: a Change in the `pending` state, surfaced for user approval. */
export const Proposal = Schema.Struct({
  id: ProposalId,
  origin: ChangeOrigin,
  status: ChangeStatus,
  summary: TrimmedNonEmptyString,
  rationale: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  /**
   * Present only on the Intake Proposal (ADR 0014 §6): the whole drafted Plan,
   * as structured data. An ordinary Proposal renders a **diff against the
   * standing Plan**; at cold start there is no prior Plan, so the payload is
   * the whole Plan rendered as itself. Its presence is what tells the card
   * which of its two modes to render — the same card either way, which is what
   * makes a user's first Plan the tutorial for every Proposal they will ever
   * see.
   */
  draftPlan: Schema.optionalKey(IntakeDraftPlan),
  /**
   * **The Change this Proposal proposes** (issue #86): the ADR 0015 Plan
   * operations, in order, that Accept applies through the shared pure applier.
   * The other half of `draftPlan`'s pair — a review-cadence Proposal diffs
   * against the standing Plan, so it carries operations; the cold-start Intake
   * Proposal has nothing to diff against, so it carries the whole Plan.
   *
   * Absent means the Proposal proposes no Plan change (an Observation-shaped
   * finding). That resolves cleanly and mutates nothing — it is not a hole to
   * be filled with a stand-in mutation.
   */
  planOperations: Schema.optionalKey(Schema.Array(PlanOperation)),
  /**
   * The catalog rows `planOperations` needs to exist before it can be applied
   * (ADR 0016, migration 014) — see `ProposedCatalogExercise`. Accept writes
   * these first, then applies the operations against a catalog that holds
   * them; rejecting the Proposal writes nothing, which is why they ride the
   * Proposal rather than being written when the run committed.
   *
   * Absent on the overwhelming majority of Proposals: introducing a new
   * Exercise is rarer than changing the prescription of an existing one.
   */
  catalogExercises: Schema.optionalKey(Schema.Array(ProposedCatalogExercise)),
  /**
   * Proposal lineage (ADR 0013 §9, migration 005) — the Decision this
   * Proposal answered, i.e. the target of a Revision run that superseded a
   * prior Proposal and put this one in its place. `undefined` for every
   * unprompted Proposal (a Session/Cycle review, or the Intake Proposal),
   * which is the overwhelming majority. Nullable at the store layer,
   * `optionalKey` on the wire — same "absent, not null" convention the rest
   * of this contract uses for wire-facing optionals.
   */
  inResponseToId: Schema.optionalKey(DecisionId),
});
export type Proposal = typeof Proposal.Type;

export const CoachingFeedEntryKind = Schema.Literals(["observation", "proposal"]);
export type CoachingFeedEntryKind = typeof CoachingFeedEntryKind.Type;

/**
 * One entry in the Coaching feed — an Observation, or a pointer at a Proposal.
 *
 * `decisionId` names the `decision` row the entry was minted from (issue
 * #79). `proposalId` is the same id, typed as a Proposal, and only on
 * proposal-kind entries: it is what the card's Accept/Dismiss/Revise actions
 * address. The Coach surface needs the former because an Observation has
 * actions on nothing but still expands into its own working — before #79 an
 * Observation entry carried no route back to the row it came from at all.
 *
 * Optional for exactly one reason: entries written before migration 008 have
 * no `decision_id` to backfill from unless they name a Proposal. Every entry
 * written since carries it. An entry without it renders its summary and does
 * not expand — the honest degradation, and not a state new writes can reach.
 */
export const CoachingFeedEntry = Schema.Struct({
  id: FeedEntryId,
  kind: CoachingFeedEntryKind,
  summary: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  decisionId: Schema.optionalKey(DecisionId),
  proposalId: Schema.optionalKey(ProposalId),
});
export type CoachingFeedEntry = typeof CoachingFeedEntry.Type;

/**
 * The layered explanation behind one Decision (issue #79) — what a Proposal
 * card or a Coach feed item expands into. CONTEXT's Decision log promises
 * exactly this shape: "a quick cited summary on top, deeper evidence and the
 * rule that fired underneath".
 *
 * **Read-only and one-shot** (`decisions.get`, not a subscription). ADR 0011
 * §5 makes `rationale`/`citations`/`data_window` immutable once committed —
 * a directive flips `status` and nothing else — so there is nothing here to
 * stream. The one mutable field a card acts on, the Proposal's status, already
 * arrives on `subscribeProposals`.
 *
 * Every field below `citations` is **optional at the row level**, and absent
 * means absent: the run did not produce that part of its working, so the
 * surface renders one fewer block rather than an empty one. See
 * `DecisionDraft`'s note on why nothing may back-fill these.
 */
export const DecisionWorking = Schema.Struct({
  id: DecisionId,
  kind: DecisionKind,
  /**
   * `DecisionStatus`, not `ChangeStatus`: the record shows Observations and
   * Answers too, and neither is ever in a Change state.
   */
  status: DecisionStatus,
  summary: TrimmedNonEmptyString,
  rationale: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  citations: Schema.Array(Citation),
  /**
   * The run's provenance envelope — cadence, when it ran, the window it read
   * and the sessions it considered. Assembled by the runner, never by the
   * agent. Optional because rows predating it, and any row committed outside
   * a Deliberation run, have none.
   */
  dataWindow: Schema.optionalKey(DeliberationDataWindow),
  measurements: Schema.optionalKey(Schema.Array(DecisionMeasurement)),
  rule: Schema.optionalKey(TrimmedNonEmptyString),
  uncertainty: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DecisionWorking = typeof DecisionWorking.Type;

/** `decisions.get`'s payload — one Decision row, by id. */
export const GetDecisionWorkingInput = Schema.Struct({
  decisionId: DecisionId,
});
export type GetDecisionWorkingInput = typeof GetDecisionWorkingInput.Type;

/**
 * A `decisionId` naming no `decision` row. Distinct from
 * `ProposalNotFoundError`, which is about acting on a Proposal — this one is
 * a read that found nothing, and the surface degrades to the summary it
 * already has rather than to an error state.
 */
export class DecisionNotFoundError extends Schema.TaggedErrorClass<DecisionNotFoundError>()(
  "DecisionNotFoundError",
  {
    decisionId: DecisionId,
  },
) {
  override get message(): string {
    return `Decision not found: ${this.decisionId}`;
  }
}

/** Plan snapshot: the Plan model tag plus its ordered Prescribed Sessions. */
export const PlanSnapshot = Schema.Struct({
  id: PlanId,
  planModel: TrimmedNonEmptyString,
  sessions: Schema.Array(PrescribedSession),
});
export type PlanSnapshot = typeof PlanSnapshot.Type;

export class FeedUnavailableError extends Schema.TaggedErrorClass<FeedUnavailableError>()(
  "FeedUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Coaching feed unavailable: ${this.reason}`;
  }
}

/** The only two terminal decisions a user can make on a pending Proposal. */
export const ProposalDecision = Schema.Literals(["accepted", "rejected"]);
export type ProposalDecision = typeof ProposalDecision.Type;

/**
 * Input for resolving a pending Proposal (ADR 0008 — the Plan mutates only
 * on `accepted`; `rejected` retains the Proposal as context, Plan untouched).
 */
export const ResolveProposalInput = Schema.Struct({
  proposalId: ProposalId,
  decision: ProposalDecision,
});
export type ResolveProposalInput = typeof ResolveProposalInput.Type;

/** Echoes the resolved Proposal back to the caller. */
export const ResolveProposalResult = Schema.Struct({
  proposal: Proposal,
});
export type ResolveProposalResult = typeof ResolveProposalResult.Type;

export class ProposalNotFoundError extends Schema.TaggedErrorClass<ProposalNotFoundError>()(
  "ProposalNotFoundError",
  {
    proposalId: ProposalId,
  },
) {
  override get message(): string {
    return `Proposal not found: ${this.proposalId}`;
  }
}

export class ProposalAlreadyResolvedError extends Schema.TaggedErrorClass<ProposalAlreadyResolvedError>()(
  "ProposalAlreadyResolvedError",
  {
    proposalId: ProposalId,
    status: ChangeStatus,
  },
) {
  override get message(): string {
    return `Proposal ${this.proposalId} is already ${this.status}`;
  }
}

// --- Revise / Proposal exchange (ADR 0013, issue #66 slice 1) --------------

/**
 * Only one Revision run may be in flight against a Proposal at a time (ADR
 * 0013 §4/§5 — the card locks behind a spinner). Raised by `proposals.revise`
 * when a run against the SAME Proposal is already `queued`/`running`; it is
 * not raised for a second Revise on a DIFFERENT Proposal, and it is not raised
 * by Cancel (`proposals.cancelRevision` is always idempotent, never a
 * failure).
 */
export class RevisionAlreadyInFlightError extends Schema.TaggedErrorClass<RevisionAlreadyInFlightError>()(
  "RevisionAlreadyInFlightError",
  {
    proposalId: ProposalId,
  },
) {
  override get message(): string {
    return `A Revision run is already in flight for Proposal ${this.proposalId}`;
  }
}

/**
 * The card's spinner has two words, not one (ADR 0013 §5): "queued" behind
 * quota vs. actually "running" is the whole reason the lock explains itself
 * instead of reading as a silently stuck button. `"idle"` is every Proposal
 * with no run against it — the ordinary case. This is filled in by the
 * RUNNER layer (slice 2), never by the store: the store has no visibility
 * into the deferral queue (ADR 0011 §8's `RunState` lives there), so
 * `getProposalExchange`/`subscribeProposalExchanges` always emit `"idle"`
 * here and the runner's RPC handler (slice 2) overlays the live value.
 */
export const ProposalRevisionStatus = Schema.Literals(["idle", "queued", "running"]);
export type ProposalRevisionStatus = typeof ProposalRevisionStatus.Type;

/** One user Revise turn — the prose that produced a Revision run (ADR 0013 §1/§9). */
export const ProposalExchangeRevise = Schema.Struct({
  kind: Schema.Literal("revise"),
  text: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type ProposalExchangeRevise = typeof ProposalExchangeRevise.Type;

/** One coach Answer in the exchange (ADR 0013 §2) — cited prose, no Change attached. */
export const ProposalExchangeAnswer = Schema.Struct({
  kind: Schema.Literal("answer"),
  id: DecisionId,
  summary: TrimmedNonEmptyString,
  rationale: TrimmedNonEmptyString,
  citations: Schema.Array(Citation),
  createdAt: IsoDateTime,
});
export type ProposalExchangeAnswer = typeof ProposalExchangeAnswer.Type;

/** One collapsed prior version of the chain (ADR 0013 §9) — a Proposal this Revision superseded. */
export const ProposalExchangeSupersededProposal = Schema.Struct({
  kind: Schema.Literal("superseded-proposal"),
  id: DecisionId,
  summary: TrimmedNonEmptyString,
  rationale: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type ProposalExchangeSupersededProposal = typeof ProposalExchangeSupersededProposal.Type;

/**
 * One entry in a Proposal's exchange — a `kind`-tagged union of the three
 * shapes the chain walk (`Store.getProposalExchange`) can produce, matching
 * how this codebase discriminates other unions (`CoachingFeedEntryKind`,
 * `DecisionKind`).
 */
export const ProposalExchangeEntry = Schema.Union([
  ProposalExchangeRevise,
  ProposalExchangeAnswer,
  ProposalExchangeSupersededProposal,
]);
export type ProposalExchangeEntry = typeof ProposalExchangeEntry.Type;

/**
 * The read model behind a Proposal card's exchange (ADR 0013 §9): `[current
 * Proposal] + [collapsed history]`. `entries` is ordered **oldest-first** —
 * the walk starts at the head Proposal and follows `in_response_to_id` back
 * through every Answer and superseded Proposal in the chain, then reverses.
 *
 * **Why this is a read model, not something the client walks itself.** The
 * client only ever receives Proposals over `subscribeProposals` — `answer`-
 * and `superseded`-kind Decision rows have no client-facing surface of their
 * own (an Answer deliberately never gets a `coaching_feed_entry`, ADR 0013
 * §7/"Settled while building the store seam"). A card that wanted to render
 * "the objection that produced this revision" (§9) would have nothing to walk.
 * The store already holds the whole chain, so it assembles the view once,
 * server-side, rather than exposing raw Decision rows and asking every client
 * to reconstruct the same lineage logic.
 *
 * `revisionStatus` is deliberately NOT filled in by the store (`"idle"`
 * always) — see `ProposalRevisionStatus`'s doc. The runner layer (slice 2)
 * overlays the live queued/running state before this reaches the wire, which
 * is also why issue #66's open question ("own subscription vs. riding
 * `subscribeProposals`") resolves to riding `subscribeProposalExchanges`
 * instead: the card needs the lineage rows on the same channel regardless, so
 * carrying in-flight state on that same stream avoids a second subscription
 * that could race it.
 */
export const ProposalExchange = Schema.Struct({
  proposalId: ProposalId,
  revisionStatus: ProposalRevisionStatus,
  entries: Schema.Array(ProposalExchangeEntry),
});
export type ProposalExchange = typeof ProposalExchange.Type;

// --- Revise RPC payloads (ADR 0013, `rpc.ts` registers the Rpc.make calls) --

/** `proposals.revise`'s payload: the Proposal being pushed back on, and the user's free-text prose (ADR 0013 §1). */
export const ReviseProposalInput = Schema.Struct({
  proposalId: ProposalId,
  text: TrimmedNonEmptyString,
});
export type ReviseProposalInput = typeof ReviseProposalInput.Type;

/**
 * Echoes the Proposal id back — the run itself is asynchronous (ADR 0011 §8:
 * queued behind quota, minutes not seconds), so there is no result to return
 * beyond confirming the run was accepted. The card learns the outcome via
 * `subscribeProposalExchanges`, not this response.
 */
export const ReviseProposalResult = Schema.Struct({
  proposalId: ProposalId,
});
export type ReviseProposalResult = typeof ReviseProposalResult.Type;

/** `proposals.cancelRevision`'s payload — the locked Proposal the user wants to escape (ADR 0013 §5). */
export const CancelRevisionInput = Schema.Struct({
  proposalId: ProposalId,
});
export type CancelRevisionInput = typeof CancelRevisionInput.Type;

/**
 * `cancelled: false` when there was nothing to cancel (idempotent, ADR 0013
 * §5) — never a failure. `ProposalNotFoundError` is reserved for a
 * `proposalId` that names no Proposal at all.
 */
export const CancelRevisionResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type CancelRevisionResult = typeof CancelRevisionResult.Type;
