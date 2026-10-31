import * as Schema from "effect/Schema";

/**
 * Shared primitives for the contracts package. Kept intentionally small —
 * only what the RPC surface needs, mirroring t3code's `baseSchemas.ts`.
 */

export const TrimmedNonEmptyString = Schema.String.check(Schema.isNonEmpty());
export type TrimmedNonEmptyString = typeof TrimmedNonEmptyString.Type;

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export type NonNegativeInt = typeof NonNegativeInt.Type;

/** ISO-8601 timestamp string, transport-encoded (no Date instances on the wire). */
export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

const makeEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

// CONTEXT.md: Session / Block / Entry / Set (Scaffold), Plan, Proposal.
export const SessionId = makeEntityId("SessionId");
export type SessionId = typeof SessionId.Type;

export const BlockId = makeEntityId("BlockId");
export type BlockId = typeof BlockId.Type;

export const EntryId = makeEntityId("EntryId");
export type EntryId = typeof EntryId.Type;

export const SetId = makeEntityId("SetId");
export type SetId = typeof SetId.Type;

export const ExerciseId = makeEntityId("ExerciseId");
export type ExerciseId = typeof ExerciseId.Type;

export const PlanId = makeEntityId("PlanId");
export type PlanId = typeof PlanId.Type;

export const ProposalId = makeEntityId("ProposalId");
export type ProposalId = typeof ProposalId.Type;

export const FeedEntryId = makeEntityId("FeedEntryId");
export type FeedEntryId = typeof FeedEntryId.Type;

/**
 * Identifies a `decision` row (CONTEXT `Decision`) — the append-only log
 * entry underlying both Observations and Proposals. Introduced for the
 * Deliberation run-output contract (ADR 0011 §6, issue #26): an
 * `observation_directive` references an existing Observation by this id.
 */
export const DecisionId = makeEntityId("DecisionId");
export type DecisionId = typeof DecisionId.Type;

/**
 * Client-generated idempotency key for `logSetActual`. Generated once per
 * logged Set on the client and replayed verbatim on retry so the server can
 * apply exactly-once (ADR 0006 / thin-client outbox design).
 */
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;

/**
 * Identifies a Logged Session (Step 2A, task 2A.2): the deep-copy
 * instantiated from a Prescribed Session on `startSession`
 * (copy-on-instantiate, ADR 0006/0007). Actuals attach to this id, not the
 * Prescribed Session's `SessionId`.
 */
export const LoggedSessionId = makeEntityId("LoggedSessionId");
export type LoggedSessionId = typeof LoggedSessionId.Type;
