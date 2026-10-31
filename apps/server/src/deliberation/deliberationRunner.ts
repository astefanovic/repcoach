import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  IntakeQuotaExhaustedError,
  IntakeSessionNotFoundError,
  IntakeSweepRejectedError,
  IntakeTurnFailedError,
  ProposalAlreadyResolvedError,
  ProposalNotFoundError,
  RevisionAlreadyInFlightError,
} from "@repcoach/contracts";
import type {
  CancelRevisionResult,
  CommitDeliberationOutputResult,
  ConvergeIntakeResult,
  DeliberationCadence,
  DeliberationDataWindow,
  DeliberationEffort,
  DeliberationRunOutput,
  DeliberationRunStage,
  EvidenceClaim,
  IntakeToolEvent,
  IntakeTurn,
  ProposalRevisionStatus,
  ReviseProposalResult,
  RunState,
  StartIntakeInput,
  TokenUsage,
} from "@repcoach/contracts";

import {
  DEFAULT_AGENT_SDK_SESSION_CONFIG,
  DeliberationRunKilledError,
  DeliberationRunOutputParseError,
  type AgentSdkSessionConfig,
  type DeliberationRunFailure,
} from "../agents/agentSdkSession.ts";
import type { AgentSdkTransport } from "../agents/agentTransport.ts";
import { CannedDeliberationAgent, DeliberationAgent } from "../agents/deliberationAgent.ts";
import { DeliberationSnapshot, DeliberationSnapshotLive, NoopDeliberationSnapshotForTest } from "./deliberationSnapshot.ts";
import { CannedDeliberationSweepAgent, DeliberationSweepAgent } from "../agents/deliberationSweepAgent.ts";
import {
  IntakeSessionAgent,
  UnwiredIntakeSessionAgent,
  type IntakeAgentReply,
  type IntakeSessionHandle,
  type IntakeToolEventSink,
} from "../agents/intakeSessionAgent.ts";
import { CannedIntakeSweepAgent, IntakeSweepAgent } from "../agents/intakeSweepAgent.ts";
import { QuotaService, QuotaServiceAlwaysAvailable } from "../agents/quotaService.ts";
import { RealDeliberationAgent, type RealDeliberationAgentConfig } from "../agents/realDeliberationAgent.ts";
import { RealDeliberationSweepAgent, type RealDeliberationSweepAgentConfig } from "../agents/realDeliberationSweepAgent.ts";
import { RealIntakeSessionAgent, type RealIntakeSessionAgentConfig } from "../agents/realIntakeSessionAgent.ts";
import { RealIntakeSweepAgent, type RealIntakeSweepAgentConfig } from "../agents/realIntakeSweepAgent.ts";
import { QuotaServiceLive } from "../agents/realQuotaService.ts";
import {
  assembleIntakeSeed,
  assembleRevisionSeed,
  assembleSeed,
  SeedInputsProvider,
  SeedInputsProviderLive,
} from "./seedContext.ts";
import { Store } from "../store.ts";

/**
 * Turns a died run's defect into the human-readable line `RunState.
 * failureReason` carries (issue #90). A killed session or unreadable output
 * arrives here as a defect — raised from the typed agent failure by
 * `dieOnRunFailure` below (issue #94), at this boundary rather than at the
 * adapter's. `DeliberationRunKilledError`'s own `reason` literal distinguishes
 * "max-turns" / "wall-clock" / "could-not-start" /
 * "not-authenticated", and
 * `DeliberationRunOutputParseError`'s distinguishes "no-json" /
 * "invalid-json" / "contract"; both `message` getters render that plus the
 * detail, so the failed run state names WHICH way it failed. Anything else
 * dying here (a genuinely unexpected defect) falls back to its own message or
 * a `String(...)` of whatever was thrown.
 */
const describeRunDefect = (defect: unknown): string => {
  if (defect instanceof DeliberationRunKilledError || defect instanceof DeliberationRunOutputParseError) {
    return defect.message;
  }
  if (defect instanceof Error) return defect.message;
  return String(defect);
};

/**
 * Re-raises a TYPED agent failure as the defect this runner's failure handling
 * is built on (issue #94).
 *
 * The agent ports now declare their failure — a killed session, or output that
 * could not be read even after the one repair turn — rather than throwing it
 * past their own boundary (`DeliberationRunFailure`). That is right at the
 * seam: an unreadable final message is an outcome the adapter genuinely has,
 * and it carries a reason worth typing.
 *
 * It is right HERE, though, that a failed run stays loud. Issue #90's shape is
 * unchanged and deliberate: `runNow` and every RPC on top of it keep an empty
 * error channel, `runState` is where a failure is reported to the client, and
 * the caller's Exit is still a failure. So the typed error is caught at the one
 * boundary that owns `runState` and re-raised there — the conversion is a
 * single line in one place instead of an error channel threaded through every
 * pipeline, every RPC handler and every canned test agent.
 */
const dieOnRunFailure = <A, R>(
  effect: Effect.Effect<A, DeliberationRunFailure, R>,
): Effect.Effect<A, never, R> =>
  effect.pipe(Effect.catch((error: DeliberationRunFailure) => Effect.die(error)));

const EFFORT_LEVELS: ReadonlyArray<DeliberationEffort> = ["low", "medium", "high", "xhigh", "max"];

/**
 * Narrows the store's untyped `effort` column onto the contract's literal
 * union (issue #81).
 *
 * The Store layer deliberately does not re-validate `effort` — the trust
 * boundary is the contract's Schema decode on the wire, the same posture as
 * `cadence` itself — so what comes back out is `string | undefined`. The
 * runner is where that string is about to become an SDK option, so this is
 * where an unrecognised value is dropped rather than passed through: an
 * effort level the SDK does not know is worth ignoring, never worth failing a
 * whole Deliberation run over.
 */
const asEffort = (effort: string | undefined): DeliberationEffort | undefined =>
  effort !== undefined && (EFFORT_LEVELS as ReadonlyArray<string>).includes(effort)
    ? (effort as DeliberationEffort)
    : undefined;

/**
 * The Deliberation runner (2B slice 1 walking skeleton, issue #26; real
 * seed assembly + snapshot isolation added 2B slice 2, issue #27; the
 * adversarial sweep stage added 2B slice 3, issue #28; the deferral queue
 * added 2B slice 7, issue #32).
 *
 * Builds the thin seed context (ADR 0011 §2) over a read-only DB snapshot
 * (ADR 0011 §3), hands the assembled prompt to the injected
 * `DeliberationAgent` (the deliberator) to produce a DRAFT, then hands that
 * draft to the injected `DeliberationSweepAgent` (the one-way adversarial
 * sweep), builds the run's provenance envelope (ADR 0011 §6/§8
 * `data_window_json`), and performs the ONLY write-back via
 * `Store.commitDeliberationOutput` (ADR 0011 §3) — using the SWEEP's output,
 * NEVER the deliberator's draft (ADR 0011 §1/§6).
 *
 * **Deferral queue** (ADR 0011 §8, 2B slice 7 — issue #32): when subscription
 * quota is low, a run is queued and fires when quota frees up. The sweep is
 * never skipped to save budget — a run that cannot afford it defers.
 *
 * **Intake** (ADR 0011 §7 as amended by ADR 0014, issue #70): the one
 * interactive run. **One held-open deliberator session with many turns, swept
 * exactly once at convergence, writing exactly one Decision.** Convergence
 * ("Review the sources") is a separate act from Accept, and Accept is not an
 * Intake method at all — the committed Proposal is resolved through the ordinary
 * `Store.resolveProposal` path, which is what makes it genuinely the same
 * Proposal card the user will meet forever.
 *
 * This is the seam the whole capability is observable at: turns resume against a
 * held session, tool events leave on a per-session stream, quota failure is a
 * typed error rather than a queue position, and "one Decision, written once" is
 * assertable as a row count against a real store.
 */

export class DeliberationRunner extends Context.Service<
  DeliberationRunner,
  {
    readonly runNow: Effect.Effect<CommitDeliberationOutputResult>;
    readonly runSessionReview: (params: {
      readonly sessionIdsConsidered: ReadonlyArray<string>;
    }) => Effect.Effect<CommitDeliberationOutputResult>;
    /**
     * Reviews every session the store says still owes one, sequentially, and
     * marks each `reviewed` only once its run has committed (issue #132).
     *
     * The ONE path a Session review is ever reached by. `finishWorkout` forks
     * it so a review starts the moment a workout ends; the background schedule
     * polls it so a review lost to a failed run, a low-quota deferral, or a
     * restart is retried instead of stranded. Both go through the same
     * claim guard, so they cannot double-review one session.
     *
     * Exported on the service — rather than left as an internal detail — for
     * the same reason `runDueCycleReview` is: a test needs to drive the drain
     * a step at a time instead of racing a poll loop, and `finishWorkout` no
     * longer returns a review for a test to assert on.
     *
     * `reviewed` counts sessions whose review COMMITTED on this call, so a
     * caller can distinguish "nothing was owed" from "the backlog was worked".
     */
    readonly reviewPendingSessions: Effect.Effect<{ readonly reviewed: number }>;
    /**
     * Fire-and-forget `reviewPendingSessions` (issue #132) — what
     * `finishWorkout` calls so the review starts at once without the RPC
     * waiting minutes for an Opus run.
     *
     * The fork lives in here rather than in the handler because the fiber must
     * be forked into the RUNNER's scope, not the request's: a fiber tied to the
     * RPC would be interrupted the moment the response is written, which would
     * lose exactly the run this is starting. Keeping the scope private is why
     * the service exposes this instead of a scope for callers to fork into.
     */
    readonly nudgeSessionReviewDrain: Effect.Effect<void>;
    readonly runCycleReview: Effect.Effect<CommitDeliberationOutputResult>;
    readonly runState: SubscriptionRef.SubscriptionRef<RunState>;
    /** Opens the held session on the four-field form and returns the cold draft. */
    readonly startIntake: (
      input: StartIntakeInput,
    ) => Effect.Effect<
      { readonly intakeSessionId: string; readonly turn: IntakeTurn },
      IntakeQuotaExhaustedError | IntakeTurnFailedError
    >;
    /** One user turn against the live session. Writes nothing; a failure is a no-op. */
    readonly turnIntake: (params: {
      readonly intakeSessionId: string;
      readonly answer: string;
    }) => Effect.Effect<
      { readonly turn: IntakeTurn },
      IntakeSessionNotFoundError | IntakeQuotaExhaustedError | IntakeTurnFailedError
    >;
    /** "Review the sources": ends the exchange, sweeps ONCE, commits the ONE Decision. */
    readonly convergeIntake: (params: {
      readonly intakeSessionId: string;
    }) => Effect.Effect<
      ConvergeIntakeResult,
      IntakeSessionNotFoundError | IntakeQuotaExhaustedError | IntakeSweepRejectedError
    >;
    /** The activity line's live tool-event stream, scoped to one session. */
    readonly intakeEvents: (params: {
      readonly intakeSessionId: string;
    }) => Stream.Stream<IntakeToolEvent, IntakeSessionNotFoundError>;
    /** Tears the session down — a dropped connection, abandonment, or a finished takeover. */
    readonly abandonIntake: (params: { readonly intakeSessionId: string }) => Effect.Effect<void>;

    // --- Revise (ADR 0013, issue #66 slice 2) -----------------------------

    /**
     * Validates the Proposal exists and is still `pending`, refuses a second
     * concurrent run against the SAME Proposal (ADR 0013 §4/§5), then starts
     * the Revision run in the BACKGROUND and returns immediately — the card
     * observes progress through `subscribeProposalExchanges`'s overlay of
     * `revisionStates`, it does not hold the RPC open for the minutes a run
     * can take (ADR 0011 §8).
     */
    readonly reviseProposal: (params: {
      readonly proposalId: string;
      readonly prose: string;
    }) => Effect.Effect<
      ReviseProposalResult,
      ProposalNotFoundError | ProposalAlreadyResolvedError | RevisionAlreadyInFlightError
    >;
    /**
     * Cancel (ADR 0013 §5) — idempotent, never a failure for "nothing was in
     * flight". Queued → dropped from the deferral queue, never fires.
     * Running → the fiber is interrupted AND a cancellation flag is checked
     * immediately before the commit, so an in-flight agent call that returns
     * during teardown cannot still write. Either way, no rows are written.
     */
    readonly cancelRevision: (params: {
      readonly proposalId: string;
    }) => Effect.Effect<CancelRevisionResult, ProposalNotFoundError>;
    /**
     * Live queued/running state per Proposal id (absent = idle) — what
     * `proposals.subscribeExchanges` overlays onto the store's `"idle"`-only
     * emissions (ADR 0013 §9's doc in `feed.ts`).
     */
    readonly revisionStates: SubscriptionRef.SubscriptionRef<ReadonlyMap<string, ProposalRevisionStatus>>;
  }
>()("@repcoach/server/DeliberationRunner") {
  static readonly layer: Layer.Layer<
    DeliberationRunner,
    never,
    | Store
    | DeliberationAgent
    | DeliberationSweepAgent
    | IntakeSessionAgent
    | IntakeSweepAgent
    | DeliberationSnapshot
    | SeedInputsProvider
    | QuotaService
  > = Layer.effect(DeliberationRunner)(
    Effect.gen(function* () {
      const store = yield* Store;
      const agent = yield* DeliberationAgent;
      const sweep = yield* DeliberationSweepAgent;
      const sessionAgent = yield* IntakeSessionAgent;
      const sweepAgent = yield* IntakeSweepAgent;
      const snapshot = yield* DeliberationSnapshot;
      const seedInputsProvider = yield* SeedInputsProvider;
      const quota = yield* QuotaService;

      // Revision runs (below) start in the BACKGROUND from an RPC call that
      // must return immediately (ADR 0013 §5) — the fiber that actually runs
      // the pipeline has to outlive that one request. Captured once, at layer
      // construction, so every `reviseProposal` call forks into the RUNNER's
      // own lifetime rather than the calling request's — the same posture as
      // the quota-recovery daemon below, which forks into this same scope.
      const layerScope = yield* Effect.scope;

      // --- Run state tracking (ADR 0011 §8, issue #32) -----------------------
      const runStateRef = yield* SubscriptionRef.make<RunState>({
        status: "idle",
        queuedCount: 0,
      });

      // Nothing about a run survives this process: the deliberator session, the
      // deferral queue and `runStateRef` are all in-memory, so a
      // `deliberation_run` row still marked `running` when the runner is
      // constructed describes a run that was killed, not one still going.
      // Closing them here — once, at startup, by the only component allowed to
      // write these rows (ADR 0011 §3/§6) — is what stops the Coach record
      // showing a permanently pulsing live node, which would be the surface
      // asserting the coach is working when it is not.
      //
      // Best-effort like every other write to this table: a store that cannot
      // be reconciled at boot must not stop the runner from running.
      yield* store.failRunsInterruptedByRestart.pipe(
        Effect.flatMap(({ failed }) =>
          failed === 0
            ? Effect.void
            : Effect.log("Closed Deliberation runs interrupted by a restart").pipe(
                Effect.annotateLogs({ failed }),
              ),
        ),
        Effect.catchCause(() => Effect.void),
      );

      // --- Deferral queue (ADR 0011 §8, issue #32) ---------------------------
      // Each queued run carries its OWN parameters (cadence + session-id
      // provenance) with it, so a deferred run fires with exactly the inputs it
      // was requested with — never re-derived from whatever `runState` happens
      // to hold when it later drains.
      interface QueuedRun {
        readonly deferred: Deferred.Deferred<CommitDeliberationOutputResult, never>;
        readonly cadence: DeliberationCadence;
        readonly sessionIdsConsidered: ReadonlyArray<string>;
        /**
         * Cancellation flag (ADR 0013 §5, issue #66 slice 2) — always present,
         * but only ever flipped `true` for a Revision run. Checked by
         * `drainQueue` BEFORE dispatching a popped entry, so a Revise cancelled
         * while still queued is dropped rather than executed. Every
         * fire-and-forget cadence's entry carries one too (always `false`) so
         * `drainQueue` has one uniform check regardless of what is queued.
         */
        readonly cancelledRef: Ref.Ref<boolean>;
        /** Present only for a Revision run (ADR 0013 §6) — absent for the three ordinary cadences. */
        readonly revision?: { readonly proposalId: string; readonly prose: string };
      }
      const deferralQueue = yield* Queue.unbounded<QueuedRun>();

      /**
       * Logged Session ids with a Session review in flight RIGHT NOW (#132).
       *
       * In-memory on purpose, and it must stay that way: it exists only to stop
       * `finishWorkout`'s forked drain and a scheduled tick from reviewing the
       * same session concurrently. Persisting it would recreate the bug it
       * guards against — a process killed mid-review would leave the session
       * claimed forever and invisible to every later drain. Crash recovery is
       * the durable `review_status = 'pending'` row's job; this is only
       * concurrency control, and losing it on restart is correct.
       */
      const reviewClaimsRef = yield* Ref.make<ReadonlySet<string>>(new Set());

      // --- Revise (ADR 0013, issue #66 slice 2) -------------------------------
      //
      // One bookkeeping entry per Proposal with a Revision run in flight:
      // `status` mirrors the two-word spinner (§5), `cancelledRef` is the
      // belt-and-braces flag `executeRevisionRun` re-checks immediately before
      // its only write-back, and `fiber` is the handle `cancelRevision`
      // interrupts for the RUNNING case. `revisionControlRef` is the single
      // source of truth; `revisionStatesRef` (the public field) is a pure
      // projection of it, kept in lock-step by `updateRevisionControl` below —
      // two refs would let the public status drift from what is actually
      // running.
      interface RevisionControl {
        readonly status: ProposalRevisionStatus;
        readonly cancelledRef: Ref.Ref<boolean>;
        readonly fiber: Fiber.Fiber<CommitDeliberationOutputResult | undefined, never> | undefined;
      }
      const revisionControlRef = yield* Ref.make<ReadonlyMap<string, RevisionControl>>(new Map());
      const revisionStatesRef = yield* SubscriptionRef.make<ReadonlyMap<string, ProposalRevisionStatus>>(
        new Map(),
      );

      const projectRevisionStatuses = (
        controls: ReadonlyMap<string, RevisionControl>,
      ): ReadonlyMap<string, ProposalRevisionStatus> =>
        new Map(Array.from(controls.entries()).map(([id, c]) => [id, c.status] as const));

      const updateRevisionControl = (
        fn: (current: ReadonlyMap<string, RevisionControl>) => ReadonlyMap<string, RevisionControl>,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const next = yield* Ref.updateAndGet(revisionControlRef, fn);
          yield* SubscriptionRef.set(revisionStatesRef, projectRevisionStatuses(next));
        });

      /**
       * Clears a Proposal's in-flight entry ONLY if it is still the same one
       * this execution created — guarded by `cancelledRef` identity. Without
       * this check, a run that finishes (or is interrupted) after
       * `cancelRevision` has already cleared and a FRESH Revise has been
       * accepted on the same Proposal would delete the new run's lock instead
       * of its own stale one.
       */
      const clearRevisionControlIfCurrent = (
        proposalId: string,
        cancelledRef: Ref.Ref<boolean>,
      ): Effect.Effect<void> =>
        updateRevisionControl((current) => {
          const existing = current.get(proposalId);
          if (existing === undefined || existing.cancelledRef !== cancelledRef) return current;
          const next = new Map(current);
          next.delete(proposalId);
          return next;
        });

      /**
       * Runs the ONE shared pipeline (below) under Revision framing, tracking
       * the executing fiber on the control entry so `cancelRevision` can
       * interrupt it, then clears the lock on completion (success, failure, OR
       * interruption — `catchAllCause` swallows all three so a background
       * Revise can never crash the runner).
       */
      const runRevisionExecution = (
        proposalId: string,
        prose: string,
        cancelledRef: Ref.Ref<boolean>,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* updateRevisionControl((current) => {
            const existing = current.get(proposalId);
            if (existing === undefined || existing.cancelledRef !== cancelledRef) return current;
            return new Map(current).set(proposalId, { ...existing, status: "running" as const });
          });

          const fiber = yield* executeRevisionRun(proposalId, prose, cancelledRef).pipe(Effect.forkChild);

          yield* updateRevisionControl((current) => {
            const existing = current.get(proposalId);
            if (existing === undefined || existing.cancelledRef !== cancelledRef) return current;
            return new Map(current).set(proposalId, { ...existing, fiber });
          });

          yield* Fiber.join(fiber).pipe(Effect.catchCause(() => Effect.void));
          yield* clearRevisionControlIfCurrent(proposalId, cancelledRef);
        }).pipe(Effect.catchCause(() => Effect.void));

      // The run ledger's ONE write-through helper (ADR 0011 §3/§8 amendment,
      // issue #81): every agent-session cost this runner ever records goes
      // through here, keyed by `runId`/`cadence`/`stage`. Best-effort per the
      // issue's Testing Decisions — a failed ledger write must never fail the
      // run it is trying to record (losing a cost row should not lose a
      // Decision), matching how the existing `runState` updates already
      // swallow failures.
      const recordLedgerUsage = (
        runId: string,
        cadence: DeliberationCadence,
        stage: DeliberationRunStage,
        model: string | undefined,
        usage: TokenUsage,
        costUsd: number,
      ): Effect.Effect<void> =>
        store.recordRunLedgerRow({ runId, cadence, stage, model, usage, costUsd }).pipe(
          Effect.catchCause(() => Effect.void),
        );


      // --- the run record (ADR 0011 §8, the Coach run history) --------------
      //
      // Three best-effort write-throughs, in exactly the posture
      // `recordLedgerUsage` above already established and for the same reason:
      // ADR 0011 §6 makes the runner the only writer, and a bookkeeping write
      // that could fail the run it is recording would trade a Decision for a
      // row about a Decision. `catchCause` swallows every failure here, so the
      // worst case is a run missing from the record — which the record already
      // knows how to survive, by reconstructing the run from the data window
      // its Decisions carry.
      //
      // Opened BEFORE the first agent session, not after the last: a run that
      // never reaches an end still has to have said that it started, or the
      // whole point of the row (a run that failed, a run still going) is lost.

      const openRunRecord = (runId: string, cadence: DeliberationCadence): Effect.Effect<void> =>
        store
          .startDeliberationRun({ runId, cadence, startedAt: new Date().toISOString() })
          .pipe(Effect.catchCause(() => Effect.void));

      const closeRunRecord = (
        runId: string,
        outcome: "committed" | "failed",
        detail: {
          readonly failureReason?: string;
          readonly dataWindow?: DeliberationDataWindow;
        } = {},
      ): Effect.Effect<void> =>
        store
          .finishDeliberationRun({
            runId,
            outcome,
            finishedAt: new Date().toISOString(),
            ...detail,
          })
          .pipe(Effect.catchCause(() => Effect.void));

      /** ADR 0013 §5: a cancelled Revision writes no rows — including this one. */
      const discardRunRecord = (runId: string): Effect.Effect<void> =>
        store.discardDeliberationRun(runId).pipe(Effect.catchCause(() => Effect.void));

      /**
       * Catalog enrichment (#104, ADR 0016) — the coach's **plain write**,
       * and the only thing this runner writes that is not a Decision. ADR
       * 0011's contract is widened here on purpose: "the coach writes a
       * Decision when it exercises judgment about the user's training, and a
       * plain write when it states a fact about the world." The deliberator
       * still writes nothing; this is the runner performing the write-back,
       * exactly as it does for Decisions.
       *
       * Three things about how it is called are load-bearing:
       *
       * - **Off the deliberator's draft, not the sweep's output.** Everywhere
       *   else in this file the sweep's output is the committed thing (ADR
       *   0011 §1/§6) and the draft is discarded. An enrichment carries no
       *   citation and is not a Decision, so the sweep has nothing to verify
       *   about it and is not told the field exists — routing it through the
       *   sweep would only give a second agent an opportunity to drop it.
       * - **Session review only.** The seed offers the roster on no other
       *   cadence, so this gate is what keeps a run that was never asked from
       *   quietly writing catalog metadata anyway.
       * - **Best-effort.** A failed enrichment leaves the rows name-only and
       *   usable and does not fail the review — the review's real work is
       *   already committed by the time this runs, and losing a finding about
       *   the user's training to a metadata write would be a bad trade. Same
       *   posture as `recordLedgerUsage` above.
       */
      const applyCatalogEnrichments = (
        cadence: DeliberationCadence,
        draftOutput: DeliberationRunOutput,
      ): Effect.Effect<void> => {
        if (cadence !== "session-review") return Effect.void;
        const enrichments = draftOutput.catalog_enrichments;
        if (enrichments === undefined || enrichments.length === 0) return Effect.void;
        return store.enrichExercises({ enrichments }).pipe(Effect.asVoid, Effect.catchCause(() => Effect.void));
      };

      // The ONE shared run pipeline (ADR 0011 §1/§6): snapshot → assembleSeed →
      // deliberator → adversarial sweep → data window → commit. Both the
      // immediate path (`runWithCadence`) and the deferred-drain path
      // (`drainQueue`) go through this, so they cannot drift. Records the run's
      // SDK token usage on the run state (issue #32) on completion, and every
      // agent session's usage on the run ledger (issue #81).
      const executeRun = (
        cadence: DeliberationCadence,
        sessionIdsConsidered: ReadonlyArray<string>,
      ): Effect.Effect<CommitDeliberationOutputResult> =>
        // `Effect.suspend` so the run id is minted per execution and is in
        // scope for BOTH the body and the failure handler piped onto it — the
        // failure handler is what records a failed run, and a run id it could
        // not see would leave exactly the runs this record exists for
        // unrecorded.
        Effect.suspend(() => {
          // One id groups every agent session THIS run produces on the ledger
          // (deliberator + sweep) — a run is not one session (ADR 0011 §8
          // amendment) — and is the `deliberation_run` row's primary key.
          const runId = crypto.randomUUID();
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(runStateRef, ({ failureReason: _failureReason, ...rest }) => ({
              ...rest,
              status: "running" as const,
              cadence,
            }));

            yield* openRunRecord(runId, cadence);

            // ADR 0011 §4 / issue #31: read the cadence's configured model, and
            // (issue #81) the reasoning effort chosen alongside it. Both halves
            // are read here, once, and handed to BOTH agent stages — the setting
            // is only a setting if the run it names actually uses it.
            const { model, effort } = yield* store.getCadenceModel(cadence);
            const effortOrUndefined = asEffort(effort);

            let evidenceRoster: ReadonlyArray<EvidenceClaim> = [];
            const draft = yield* snapshot.withSnapshot((snapshotDbPath) =>
              Effect.gen(function* () {
                const seedInputs = yield* seedInputsProvider.buildSeedInputs({
                  cadence,
                  snapshotDbPath,
                });
                evidenceRoster = seedInputs.evidenceRoster;
                const assembledPrompt = assembleSeed(seedInputs);
                return yield* dieOnRunFailure(agent.run(assembledPrompt, model, effortOrUndefined));
              }),
            );
            yield* recordLedgerUsage(runId, cadence, "deliberator", model, draft.usage, draft.costUsd);

            // ADR 0011 §1/§6: the sweep is a SEPARATE, ONE-WAY stage. It gets the
            // SAME Evidence-base roster the deliberator's seed carried (issue
            // #92) — its own session never saw the deliberator's prompt, so
            // without this it could never confirm a citation against the roster.
            const swept = yield* dieOnRunFailure(sweep.run(draft.output, evidenceRoster, model, effortOrUndefined));
            yield* recordLedgerUsage(runId, cadence, "sweep", model, swept.usage, swept.costUsd);
            const finalRunOutput = swept.output;

            const dataWindow: DeliberationDataWindow = {
              cadence,
              ran_at: new Date().toISOString(),
              session_ids_considered: sessionIdsConsidered,
              evidence_roster_version: "seed-1",
            };

            const result = yield* store.commitDeliberationOutput({
              runOutput: finalRunOutput,
              dataWindow,
              runId,
            });

            // Closed only once the Decisions are down, so `committed` on the
            // record means the write-back happened — including the run that
            // committed NOTHING, which is the state the row exists to make
            // visible at all (ADR 0011 §4).
            yield* closeRunRecord(runId, "committed", { dataWindow });

            // After the Decisions land, and never in their way (see
            // `applyCatalogEnrichments`). Silent: no Decision row, nothing on
            // Today, nothing on the Coaching feed (ADR 0016).
            yield* applyCatalogEnrichments(cadence, draft.output);

            // Surface the run's real SDK token usage (issue #32 AC).
            yield* SubscriptionRef.update(runStateRef, (s) => ({ ...s, tokenUsage: draft.usage }));

            return result;
          }).pipe(
            // issue #90: a killed session or unparseable output reaches here as
            // a DEFECT (see `describeRunDefect`'s doc comment above). Record it
            // on `runState` before letting it keep propagating — the run stays
            // loud (ADR 0011 §4/§8: "logged, never left spending indefinitely"),
            // and the failure now reaches the client through the SAME
            // subscription a successful run's status already rides.
            // `tapCause` re-raises the same cause afterward, so a plain fiber
            // interruption (server shutdown, a cancelled Revision — no `Die`
            // reason, so `Cause.findDefect` comes back a `Result.Failure`) is
            // left alone and never recorded as a "failed" run.
            Effect.tapCause((cause) => {
              const defect = Cause.findDefect(cause);
              if (!Result.isSuccess(defect)) return Effect.void;
              const failureReason = describeRunDefect(defect.success);
              return SubscriptionRef.update(runStateRef, (s) => ({
                ...s,
                status: "failed" as const,
                cadence,
                failureReason,
              })).pipe(
                // The durable half of the same fact. `runState` is a live
                // snapshot that the next run overwrites and a restart forgets,
                // which is how "the coach has been quiet" and "the coach has
                // been crashing" used to read identically a day later.
                Effect.andThen(closeRunRecord(runId, "failed", { failureReason })),
              );
            }),
          );
        });

      /**
       * The Revision-run pipeline (ADR 0013 §6, issue #66 slice 2): the SAME
       * shape as `executeRun` — snapshot → seed → deliberator → adversarial
       * sweep → data window → commit — under a different seed assembly
       * (`assembleRevisionSeed`) and a different commit shape
       * (`reviseTargetProposalId`/`revisionProse`, `cadence: "revision-run"`).
       * Resolves its model from `"session-review"` — ADR 0013 §6 is explicit
       * there is deliberately no `revision-run` model selector.
       *
       * Returns `undefined` (not the result) when `cancelledRef` reads `true`
       * immediately before the commit — the belt-and-braces check (ADR 0013
       * §5) that stops an in-flight agent call which returns during teardown
       * from still writing rows for a cancelled Revision. `Fiber.interrupt`
       * (the other half of cancellation, in `cancelRevision` below) is the
       * belt; this is the braces.
       */
      const executeRevisionRun = (
        proposalId: string,
        prose: string,
        cancelledRef: Ref.Ref<boolean>,
      ): Effect.Effect<CommitDeliberationOutputResult | undefined> =>
        Effect.suspend(() => {
          // One id groups every agent session THIS Revision run produces on
          // the ledger (deliberator + sweep) — issue #81 — and is the
          // `deliberation_run` row's key (ADR 0011 §8). Minted out here, like
          // `executeRun`'s, so the handlers piped onto the body can see it.
          const runId = crypto.randomUUID();
          /**
           * Whether the run's row has already been closed with an outcome.
           *
           * What it is really guarding is the difference between a run that
           * ENDED and a run that was TAKEN AWAY. Cancellation (ADR 0013 §5)
           * reaches this pipeline as a fiber interruption, which is neither a
           * commit nor a failure — so the `ensuring` below discards the row
           * rather than inventing an outcome for it, and this flag is what
           * stops it from also discarding the row of a run that finished
           * normally an instant earlier.
           */
          let outcomeRecorded = false;
          return Effect.gen(function* () {
            yield* openRunRecord(runId, "revision-run");

            // ADR 0013 §6: resolve the model — and its effort (issue #81) — from
            // `session-review`; there is deliberately no `revision-run` selector
            // in settings, so arguing with the coach can never be the most
            // expensive thing in the app on either axis.
            const { model, effort } = yield* store.getCadenceModel("session-review");
            const effortOrUndefined = asEffort(effort);

            const targetOpt = yield* store.getDecision(proposalId);
            // `reviseProposal` already validated existence + `pending` before
            // this pipeline was ever started, and the card is locked for the
            // duration of the run (ADR 0013 §5 — no Accept/Dismiss/second
            // Revise reaches the store meanwhile), so the row cannot have
            // disappeared or changed kind underneath this read.
            const target = Option.getOrThrow(targetOpt);
            const priorTurnsExchange = yield* store.getProposalExchange(proposalId);
            const priorTurns = Option.isSome(priorTurnsExchange) ? priorTurnsExchange.value.entries : [];

            let evidenceRoster: ReadonlyArray<EvidenceClaim> = [];
            const draft = yield* snapshot.withSnapshot((snapshotDbPath) =>
              Effect.gen(function* () {
                const seedInputs = yield* seedInputsProvider.buildSeedInputs({
                  cadence: "revision-run",
                  snapshotDbPath,
                });
                evidenceRoster = seedInputs.evidenceRoster;
                const assembledPrompt = assembleRevisionSeed(seedInputs, {
                  targetDecision: {
                    summary: target.summary,
                    rationale: target.rationale,
                    citations: target.citationsJson === null ? [] : JSON.parse(target.citationsJson),
                    dataWindowJson: target.dataWindowJson,
                  },
                  priorTurns,
                  revisionProse: prose,
                });
                return yield* dieOnRunFailure(agent.run(assembledPrompt, model, effortOrUndefined));
              }),
            );
            yield* recordLedgerUsage(runId, "revision-run", "deliberator", model, draft.usage, draft.costUsd);

            // ADR 0011 §1/§6, ADR 0013 §6: the sweep is a SEPARATE, one-way
            // stage, and it ALWAYS runs for a Revision — never skipped to save
            // budget, and never skipped because the run is user-invoked. Same
            // roster the deliberator's seed carried (issue #92).
            const swept = yield* dieOnRunFailure(sweep.run(draft.output, evidenceRoster, model, effortOrUndefined));
            yield* recordLedgerUsage(runId, "revision-run", "sweep", model, swept.usage, swept.costUsd);
            const finalRunOutput = swept.output;

            // Belt-and-braces (ADR 0013 §5): re-checked immediately before the
            // ONLY write-back. `Fiber.interrupt` races this agent call; if the
            // call already returned by the time the interrupt lands, THIS check
            // is what stops the commit.
            const cancelledNow = yield* Ref.get(cancelledRef);
            if (cancelledNow) {
              // ADR 0013 §5: "no rows are written" — this row included.
              outcomeRecorded = true;
              yield* discardRunRecord(runId);
              return undefined;
            }

            const dataWindow: DeliberationDataWindow = {
              cadence: "revision-run",
              ran_at: new Date().toISOString(),
              session_ids_considered: [],
              evidence_roster_version: "seed-1",
            };

            const result = yield* store.commitDeliberationOutput({
              runOutput: finalRunOutput,
              dataWindow,
              runId,
              reviseTargetProposalId: proposalId as never,
              revisionProse: prose as never,
            });
            outcomeRecorded = true;
            yield* closeRunRecord(runId, "committed", { dataWindow });
            return result;
          }).pipe(
            // The same durable failure record `executeRun` writes, for the same
            // reason: a Revision run that died is a thing the user asked for and
            // did not get, and it should not be legible only from the absence of
            // an Answer.
            Effect.tapCause((cause) => {
              const defect = Cause.findDefect(cause);
              if (!Result.isSuccess(defect)) return Effect.void;
              outcomeRecorded = true;
              return closeRunRecord(runId, "failed", {
                failureReason: describeRunDefect(defect.success),
              });
            }),
            // Interruption is the third exit, and it is neither outcome: the
            // user cancelled (ADR 0013 §5), or the server went down under the
            // run. Both mean the question was never answered and nothing was
            // written, so the record says nothing rather than putting a red
            // node on the rail for a run the user themselves called off.
            Effect.ensuring(
              Effect.suspend(() => (outcomeRecorded ? Effect.void : discardRunRecord(runId))),
            ),
          );
        });

      const decrementQueuedCount: Effect.Effect<void> =
        SubscriptionRef.update(runStateRef, (s) => ({
          ...s,
          queuedCount: s.queuedCount > 0 ? s.queuedCount - 1 : 0,
        }));

      // Drains queued/deferred runs one at a time. Re-checks quota BEFORE each
      // drain: while quota is still low it drains NOTHING (a run that cannot
      // afford its adversarial sweep stays deferred — the sweep is never skipped
      // to save budget, ADR 0011 §8). Runs held runs with their OWN queued
      // parameters, never re-derived from current state.
      //
      // A Revision run rides this SAME queue (ADR 0013 §6) — cancellation
      // while still queued (ADR 0013 §5, issue #66 slice 2) is checked here,
      // BEFORE dispatch, so a cancelled entry is dropped rather than executed:
      // it must never later fire.
      const drainQueue: Effect.Effect<void> = Effect.gen(function* () {
        const isLow = yield* quota.isQuotaLow;
        if (isLow) {
          // #38 item 1: quota can drop MID-drain, after some queued runs have
          // already fired and left `runState.status` at "running" (`executeRun`
          // sets it, and only the empty-poll branch below used to reset it).
          // Reconcile against the queue's ACTUAL remaining depth here too, not
          // only on the empty-poll branch, so the run-visibility surface (#32)
          // never shows "running" while every remaining run is really deferred.
          const remaining = yield* Queue.size(deferralQueue);
          yield* SubscriptionRef.update(runStateRef, ({ cadence: _cadence, ...rest }) =>
            remaining > 0
              ? { ...rest, status: "queued" as const, queuedCount: remaining }
              // issue #90: a "failed" status must survive an empty-queue
              // reconciliation too — this branch exists to correct a STALE
              // "running"/"queued" left over from a run that already
              // finished, not to paper over a genuine failure.
              : { ...rest, status: rest.status === "failed" ? ("failed" as const) : ("idle" as const), queuedCount: 0 },
          );
          return;
        }

        const maybeQueued = yield* Queue.poll(deferralQueue);
        if (Option.isNone(maybeQueued)) {
          // issue #90: same "failed" survives an empty drain" rule as above —
          // `executeRun` already recorded the failure; this reconciliation
          // must not silently paper over it back to "idle".
          yield* SubscriptionRef.update(runStateRef, ({ cadence: _cadence, ...rest }) => ({
            ...rest,
            status: rest.status === "failed" ? ("failed" as const) : ("idle" as const),
            queuedCount: 0,
          }));
          return;
        }
        const queued = maybeQueued.value;

        const isCancelled = yield* Ref.get(queued.cancelledRef);
        if (isCancelled) {
          // Dropped, never executed. `cancelRevision` normally already
          // cleared the control-map entry when it flipped this flag; clearing
          // again here is a harmless no-op guard against the race where this
          // entry drains before that clear finishes.
          if (queued.revision !== undefined) {
            yield* clearRevisionControlIfCurrent(queued.revision.proposalId, queued.cancelledRef);
          }
          yield* decrementQueuedCount;
          yield* Deferred.interrupt(queued.deferred);
          yield* drainQueue;
          return;
        }

        if (queued.revision !== undefined) {
          yield* runRevisionExecution(
            queued.revision.proposalId,
            queued.revision.prose,
            queued.cancelledRef,
          );
          yield* decrementQueuedCount;
          // Nothing awaits a Revision's deferred (`reviseProposal` returns
          // long before this drains) — interrupting it is a clean no-op.
          yield* Deferred.interrupt(queued.deferred);
          yield* drainQueue;
          return;
        }

        // issue #90: `executeRun` dies on a killed/unparseable run — reified
        // via `Effect.exit` so a failed deferred run cannot kill THIS daemon
        // fiber (it drains every OTHER queued entry via the quota-recovery
        // subscription above, and letting it die here would silently strand
        // them, `Deferred.await`ing forever). `executeRun` has already
        // recorded the failure on `runState` before this Exit is inspected.
        const outcome = yield* Effect.exit(executeRun(queued.cadence, queued.sessionIdsConsidered));
        yield* decrementQueuedCount;
        if (Exit.isSuccess(outcome)) {
          yield* Deferred.succeed(queued.deferred, outcome.value);
        } else {
          // Nothing to hand the caller — interrupting (rather than hanging)
          // whatever awaited this deferred run, same as the cancelled-entry
          // branch above.
          yield* Deferred.interrupt(queued.deferred);
        }

        yield* drainQueue;
      });

      // KEY FIX (ADR 0011 §8): a queued run "fires when quota frees up". The
      // low→available transition is signalled by `QuotaService.quotaAvailable`;
      // a background daemon subscribes to it for the layer's lifetime and drains
      // the deferral queue whenever quota recovers. Without this subscription a
      // deferred run would await its `Deferred` forever.
      yield* Effect.forkScoped(Stream.runForEach(quota.quotaAvailable, () => drainQueue));

      // The core run mechanism with quota checking and deferral support.
      const runWithCadence = (
        cadence: DeliberationCadence,
        sessionIdsConsidered: ReadonlyArray<string>,
      ): Effect.Effect<CommitDeliberationOutputResult> =>
        Effect.gen(function* () {
          // Check quota first — if low, queue the run WITH its parameters and
          // await it; the quota-recovery daemon (or a later immediate run's
          // drain) fires it when quota frees.
          const isLow = yield* quota.isQuotaLow;
          if (isLow) {
            const deferred = yield* Deferred.make<CommitDeliberationOutputResult, never>();
            const cancelledRef = yield* Ref.make(false); // never cancelled — no Cancel affordance on these cadences
            yield* Queue.offer(deferralQueue, { deferred, cadence, sessionIdsConsidered, cancelledRef });
            yield* SubscriptionRef.update(runStateRef, (s) => ({
              ...s,
              status: "queued" as const,
              cadence,
              queuedCount: s.queuedCount + 1,
            }));
            return yield* Deferred.await(deferred);
          }

          // issue #90: reified via `Effect.exit` so a killed/unparseable run
          // does not skip the drain below (leaving anything queued behind it
          // stuck until the next quota-recovery transition) or leave
          // `runState` wedged — `executeRun` has already recorded "failed" on
          // `runState` by the time this Exit is inspected, and a run that
          // failed must NOT be reported "idle" over top of that.
          const outcome = yield* Effect.exit(executeRun(cadence, sessionIdsConsidered));

          if (Exit.isSuccess(outcome)) {
            // Back to idle, then try to drain anything that queued meanwhile.
            yield* SubscriptionRef.update(runStateRef, ({ cadence: _cadence, ...rest }) => ({
              ...rest,
              status: "idle" as const,
            }));
          }
          yield* drainQueue;

          return yield* outcome;
        });

      // --- Intake (ADR 0011 §7 as amended by ADR 0014, issue #70) ------------
      //
      // One held-open deliberator session with many turns, swept exactly once at
      // convergence, writing exactly ONE Decision. Everything below exists to
      // make those three clauses true and observable at this seam.
      //
      // Nothing about an Intake reaches the store until `convergeIntake`. That
      // is what keeps the store contract trivial (ADR 0014 §2/§8): a failed turn
      // is a genuine no-op, an abandoned Intake needs no cleanup, and the
      // Decision log reads honestly about what happened rather than accumulating
      // rows for a plan nobody accepted.
      interface IntakeSessionState {
        readonly handle: IntakeSessionHandle;
        /** The turn currently on screen — the thing a converge would sweep. */
        readonly turn: IntakeTurn;
        /** Monotonic event sequence for this session's activity line. */
        readonly nextSeq: number;
        /** Live-only fan-out; ends with the session (ADR 0014 §8's mortality rule). */
        readonly events: PubSub.PubSub<IntakeToolEvent>;
        /** The Intake Proposal a previous converge committed, if the user reopened the exchange. */
        readonly committedProposalId: string | undefined;
        readonly model: string | undefined;
        /**
         * The reasoning effort read alongside `model` when this session opened
         * (issue #81). Stashed for the same reason `model` is: `convergeIntake`
         * runs a SECOND session, and it must run under the same configuration
         * the exchange has been running under rather than re-reading a setting
         * the user may have changed mid-exchange.
         */
        readonly effort: DeliberationEffort | undefined;
        /**
         * The Evidence-base roster this Intake's seed carried (ADR 0003 §5,
         * issue #92) — stashed here so `convergeIntake`'s sweep session, which
         * never saw that seed, can still check citations against it.
         */
        readonly evidenceRoster: ReadonlyArray<EvidenceClaim>;
      }
      const intakeSessionsRef = yield* Ref.make<ReadonlyMap<string, IntakeSessionState>>(new Map());

      const getIntakeSession = (
        intakeSessionId: string,
      ): Effect.Effect<IntakeSessionState, IntakeSessionNotFoundError> =>
        Ref.get(intakeSessionsRef).pipe(
          Effect.flatMap((sessions) => {
            const session = sessions.get(intakeSessionId);
            return session === undefined
              ? Effect.fail(new IntakeSessionNotFoundError({ intakeSessionId }))
              : Effect.succeed(session);
          }),
        );

      const updateIntakeSession = (
        intakeSessionId: string,
        update: (session: IntakeSessionState) => IntakeSessionState,
      ): Effect.Effect<void> =>
        Ref.update(intakeSessionsRef, (sessions) => {
          const existing = sessions.get(intakeSessionId);
          if (existing === undefined) return sessions;
          return new Map(sessions).set(intakeSessionId, update(existing));
        });

      /**
       * The per-session event sink. `seq` is stamped HERE — one place, the same
       * place that later orders the sweep's verdicts — which is how the runner
       * keeps its half of ADR 0014 §4's bargain: ordinals are the client's to
       * derive, ordering is the runner's to guarantee. Two components each
       * numbering their own events would eventually let the wait narrate a
       * sequence the card contradicts.
       */
      const makeIntakeSink = (intakeSessionId: string): IntakeToolEventSink => ({
        emit: (event) =>
          Effect.gen(function* () {
            const sessions = yield* Ref.get(intakeSessionsRef);
            const session = sessions.get(intakeSessionId);
            // A session torn down mid-flight simply stops narrating. Dropping the
            // event is correct: events are live-only, and a client that is not
            // watching misses them by design.
            if (session === undefined) return;
            const toolEvent: IntakeToolEvent = {
              seq: session.nextSeq,
              tool: event.tool,
              ...(event.subject === undefined ? {} : { subject: event.subject }),
            };
            yield* updateIntakeSession(intakeSessionId, (s) => ({ ...s, nextSeq: s.nextSeq + 1 }));
            yield* PubSub.publish(session.events, toolEvent);
          }),
      });

      /**
       * Intake's quota gate (ADR 0014 §4, amending ADR 0011 §8). It **fails
       * loudly instead of deferring**, and that is the whole point: ADR 0011
       * deferred a quota-starved run on the grounds that "nothing is
       * user-blocking", and Intake is the counterexample — the only
       * user-blocking run in the app, and the first thing a cold user ever does.
       * Queuing it would tell a brand-new user to come back later, and since
       * abandoning discards the draft, "later" means "start over". An honest
       * failure is actionable; a queue position is not.
       *
       * The deferral queue above is untouched, so the three fire-and-forget
       * cadences keep queueing exactly as they did.
       */
      const requireQuota: Effect.Effect<void, IntakeQuotaExhaustedError> = Effect.gen(function* () {
        const isLow = yield* quota.isQuotaLow;
        if (isLow) return yield* Effect.fail(new IntakeQuotaExhaustedError());
      });

      const toTurn = (reply: IntakeAgentReply, revision: number): IntakeTurn => ({
        revision,
        draftPlan: reply.draftPlan,
        rationale: reply.rationale,
        citations: reply.citations,
        calibrationNote: reply.calibrationNote,
        ...(reply.openQuestion === undefined ? {} : { openQuestion: reply.openQuestion }),
        usage: reply.usage,
      });

      const startIntake = (
        input: StartIntakeInput,
      ): Effect.Effect<
        { readonly intakeSessionId: string; readonly turn: IntakeTurn },
        IntakeQuotaExhaustedError | IntakeTurnFailedError
      > =>
        Effect.gen(function* () {
          yield* requireQuota;

          // The Intake session id doubles as the ledger's `runId` — every
          // stage this ONE Intake session produces (cold draft, turns, the
          // convergence sweep) shares it, which is what makes "cold-draft
          // tokens vs per-turn tokens" (UAT watchlist entry 2) a single
          // grouped query rather than a reconstruction.
          const intakeSessionId = crypto.randomUUID();
          const { model, effort } = yield* store.getCadenceModel("intake");
          const effortOrUndefined = asEffort(effort);

          const seedInputs = yield* seedInputsProvider.buildSeedInputs({
            cadence: "intake",
            snapshotDbPath: "(no snapshot — cold-start Intake, the database is empty by definition)",
          });
          // The catalog is a closed set the Accept path enforces, so the coach
          // is handed it rather than left to guess ids that look right (issue
          // #93 — the first live Intake guessed, and Accept rejected the plan).
          const catalog = yield* store.getExerciseCatalog;
          const seed = assembleIntakeSeed(
            seedInputs,
            {
              goal: input.goal,
              daysPerWeek: input.daysPerWeek,
              equipment: input.equipment,
              ...(input.lifts === undefined ? {} : { lifts: input.lifts }),
            },
            catalog.exercises,
          );

          // The event hub exists BEFORE the cold draft runs, because the cold
          // wait is the longest one in the app and the activity line has to be
          // able to narrate it from the first tool call.
          const events = yield* PubSub.unbounded<IntakeToolEvent>();
          const sink = makeIntakeSink(intakeSessionId);

          const opened = yield* sessionAgent
            .open({
              seed,
              sink,
              ...(model === undefined ? {} : { model }),
              ...(effortOrUndefined === undefined ? {} : { effort: effortOrUndefined }),
            })
            .pipe(
            Effect.mapError(
              (error) => new IntakeTurnFailedError({ intakeSessionId, detail: error.detail }),
            ),
          );

          yield* recordLedgerUsage(
            intakeSessionId,
            "intake",
            "intake-draft",
            model,
            opened.reply.usage,
            opened.reply.costUsd,
          );

          // Note the ordering: the session is registered only once a real draft
          // exists. A cold draft that failed leaves NOTHING behind — no session
          // to resume, no half-alive state to reconcile — and the client puts the
          // user back on their form with every value intact (ADR 0014 §8).
          const turn = toTurn(opened.reply, 1);
          yield* Ref.update(intakeSessionsRef, (sessions) =>
            new Map(sessions).set(intakeSessionId, {
              handle: opened.handle,
              turn,
              nextSeq: 0,
              events,
              committedProposalId: undefined,
              model,
              effort: effortOrUndefined,
              evidenceRoster: seedInputs.evidenceRoster,
            }),
          );

          return { intakeSessionId, turn };
        });

      const turnIntake = (params: {
        readonly intakeSessionId: string;
        readonly answer: string;
      }): Effect.Effect<
        { readonly turn: IntakeTurn },
        IntakeSessionNotFoundError | IntakeQuotaExhaustedError | IntakeTurnFailedError
      > =>
        Effect.gen(function* () {
          const session = yield* getIntakeSession(params.intakeSessionId);
          yield* requireQuota;

          const reply = yield* sessionAgent
            .send({
              handle: session.handle,
              answer: params.answer,
              sink: makeIntakeSink(params.intakeSessionId),
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new IntakeTurnFailedError({
                    intakeSessionId: params.intakeSessionId,
                    detail: error.detail,
                  }),
              ),
            );

          yield* recordLedgerUsage(
            params.intakeSessionId,
            "intake",
            "intake-turn",
            session.model,
            reply.usage,
            reply.costUsd,
          );

          // Turns are cheap by construction: no re-seed (the session carried its
          // own context), no sweep, no Decision row, no lock ceremony. The only
          // state that moves is the draft on screen — so a failure above leaves
          // the previous draft exactly where it was, which is the valuable thing.
          const turn = toTurn(reply, session.turn.revision + 1);
          yield* updateIntakeSession(params.intakeSessionId, (s) => ({ ...s, turn }));
          return { turn };
        });

      const convergeIntake = (params: {
        readonly intakeSessionId: string;
      }): Effect.Effect<
        ConvergeIntakeResult,
        IntakeSessionNotFoundError | IntakeQuotaExhaustedError | IntakeSweepRejectedError
      > =>
        Effect.gen(function* () {
          const session = yield* getIntakeSession(params.intakeSessionId);
          yield* requireQuota;

          const draft = session.turn;

          // The sweep is scoped to the citations THIS plan accumulated, not the
          // session's running set. Converging straight off the cold draft is
          // legitimate — the coach's questions are optional and an impatient
          // first-time user taps through — and sweeping the fully-argued set
          // would disclose removing sources they never saw.
          const swept = yield* sweepAgent
            .run({
              draftPlan: draft.draftPlan,
              rationale: draft.rationale,
              citations: draft.citations,
              evidenceRoster: session.evidenceRoster,
              sink: makeIntakeSink(params.intakeSessionId),
              ...(session.model === undefined ? {} : { model: session.model }),
              ...(session.effort === undefined ? {} : { effort: session.effort }),
            })
            .pipe(
              // A sweep that could not RUN is the one case where no Proposal may
              // be offered at all (ADR 0014 §8): an unverified plan cannot be
              // accepted, and the sweep is never skipped to get past it. Note
              // this is NOT the gutted case — a sweep that struck out every
              // source succeeds above, with a disclosure, because that is the
              // machinery working and the user may still accept it.
              //
              // The session is deliberately left alive: the user retries, or
              // keeps tweaking, rather than losing the plan they just shaped.
              Effect.mapError(
                () => new IntakeSweepRejectedError({ intakeSessionId: params.intakeSessionId }),
              ),
            );

          yield* recordLedgerUsage(
            params.intakeSessionId,
            "intake",
            "sweep",
            session.model,
            swept.usage,
            swept.costUsd,
          );

          // ADR 0011 §1/§6: what gets committed is the SWEEP's output. The
          // prescription is the user's — the sweep's signature cannot reach it —
          // and the justification below is the sweep's rewrite, never the
          // deliberator's draft.
          const rationaleText = swept.rationale.map((line) => line.text).join(" ");
          const uncited = swept.rationale
            .filter((line) => line.citationId === undefined)
            .map((line) => line.text);

          const proposal: DeliberationRunOutput["decisions"][number] = {
            kind: "proposal",
            summary: draft.draftPlan.headline,
            // The calibration note is carried into the committed Decision (ADR
            // 0014 §7) so it stays permanently readable beside the plan it
            // qualifies, rather than dying with the takeover.
            rationale: `${rationaleText} ${draft.calibrationNote}`.trim(),
            citations: swept.citations.map((citation) => ({
              claim: citation.claim,
              source_url: citation.source_url,
              trust: citation.trust,
            })),
            reasoning_only_points: uncited,
            surface: true,
          };

          // #38 item 2: the sweep used to downgrade a zero-citation Proposal to
          // an Observation, which meant a plan whose sources all failed came back
          // as something the user could not accept at all. ADR 0014 §8 is
          // explicit that a gutted plan is the machinery working, not an error —
          // "the prescription stands, the rationale is thinner, and the user CAN
          // still accept it" — so no downgrade happens here. Honest disclosure
          // means deciding WITH that knowledge, not being protected from it.

          const dataWindow: DeliberationDataWindow = {
            cadence: "intake",
            ran_at: new Date().toISOString(),
            session_ids_considered: [],
            evidence_roster_version: "seed-1",
          };

          const result = yield* store.commitDeliberationOutput({
            runOutput: {
              decisions: [proposal],
              // Re-converging after reopening the exchange replaces the artifact
              // the user was previously shown. The store honours this only
              // against a still-pending INTAKE Proposal, so the id below cannot
              // reach any other row.
              observation_directives:
                session.committedProposalId === undefined
                  ? []
                  : [{ id: session.committedProposalId as never, action: "supersede" as const }],
            },
            dataWindow,
            intakeRun: { draftPlan: draft.draftPlan },
          });

          const proposalId = result.decisionIds[0];
          if (proposalId === undefined) {
            // The sweep left nothing committable. ADR 0014 §8: no Proposal is
            // offered, because an unverified plan cannot be accepted — but the
            // session STAYS ALIVE so the user can retry or keep tweaking rather
            // than losing the plan they just spent four turns on.
            return yield* Effect.fail(
              new IntakeSweepRejectedError({ intakeSessionId: params.intakeSessionId }),
            );
          }

          yield* updateIntakeSession(params.intakeSessionId, (s) => ({
            ...s,
            committedProposalId: proposalId as string,
          }));

          return {
            proposalId,
            revision: draft.revision,
            draftPlan: draft.draftPlan,
            rationale: swept.rationale,
            citations: swept.citations,
            calibrationNote: draft.calibrationNote,
            disclosure: { verdicts: swept.verdicts },
            usage: swept.usage,
          };
        });

      /**
       * The activity-line subscription (ADR 0014 §4). Live-only: it replays
       * nothing, because there is no persisted event log to replay from and
       * inventing one would be a recovery subsystem for a flow that runs once
       * (§8). The stream ends when the session does.
       */
      const intakeEvents = (params: {
        readonly intakeSessionId: string;
      }): Stream.Stream<IntakeToolEvent, IntakeSessionNotFoundError> =>
        Stream.unwrap(
          getIntakeSession(params.intakeSessionId).pipe(
            Effect.map((session) => Stream.fromPubSub(session.events)),
          ),
        );

      /**
       * Ends a session and tears the SDK session down — reached from a dropped
       * client connection, from abandonment, and from the client closing the
       * takeover after Accept.
       *
       * It writes nothing and cleans nothing up beyond the in-memory entry,
       * which is the payoff of "interim turns write nothing": abandonment is
       * genuinely free at every point, and that is what lets the form stay short
       * and the exchange stay uncapped. Idempotent, because a reload can easily
       * race a converge.
       */
      const abandonIntake = (params: { readonly intakeSessionId: string }): Effect.Effect<void> =>
        Effect.gen(function* () {
          const sessions = yield* Ref.get(intakeSessionsRef);
          const session = sessions.get(params.intakeSessionId);
          if (session === undefined) return;
          yield* Ref.update(intakeSessionsRef, (map) => {
            const next = new Map(map);
            next.delete(params.intakeSessionId);
            return next;
          });
          yield* PubSub.shutdown(session.events);
          yield* sessionAgent.close(session.handle);
        });

      const runNow: Effect.Effect<CommitDeliberationOutputResult> = runWithCadence("on-demand", []);

      const runSessionReview = (params: {
        readonly sessionIdsConsidered: ReadonlyArray<string>;
      }): Effect.Effect<CommitDeliberationOutputResult> =>
        runWithCadence("session-review", params.sessionIdsConsidered);

      /**
       * The Session-review drain (issue #132) — the ONE path that ever runs a
       * Session review, reached both by `finishWorkout` (forked, so the review
       * starts immediately) and by the background schedule (polled, so a
       * failed or restart-dropped review is retried).
       *
       * Funnelling both callers through one claim-guarded function is what
       * makes "immediate latency" and "restart recovery" coexist without
       * double-reviewing: a finish that forks this while a tick is already
       * working the same session finds it claimed and skips it.
       *
       * Four properties, each load-bearing:
       *
       * - **The work list is durable, not held here.** Every call re-reads
       *   `listSessionsPendingReview`. There is no in-memory queue to lose, so
       *   a restart mid-review resumes from the rows (the old in-memory
       *   `deferralQueue` losing a deferred review with the session already
       *   `finished` is half of #132).
       * - **The claim is in-memory and the marker is durable, deliberately.**
       *   The claim only prevents two *concurrent* fibers reviewing one
       *   session; it must NOT survive a crash, or a run killed mid-flight
       *   would leave the session claimed-but-unreviewed and invisible
       *   forever. Crash safety comes from the row staying `pending`.
       * - **Strictly sequential.** Sessions are reviewed one at a time, so a
       *   three-session backlog (exactly what the live DB holds) is three runs
       *   in order, not three concurrent Opus runs racing for quota.
       * - **`markSessionReviewed` only after a committed run.** A failed
       *   review leaves the row `pending` and the next tick retries it. The
       *   worst case is a duplicate review, never a lost one — and a duplicate
       *   is something a human can see in the feed and dismiss, which a loss
       *   is not.
       *
       * A failed run is logged and swallowed per session, so one bad session
       * cannot strand the rest of the backlog behind it — the same posture
       * `runDueCycleReview` takes, and for the same reason: `executeRun` has
       * already surfaced the failure on `runState` (#90).
       */
      const reviewPendingSessions: Effect.Effect<{ readonly reviewed: number }> = Effect.gen(
        function* () {
          const pending = yield* store.listSessionsPendingReview;
          let reviewed = 0;
          for (const loggedSessionId of pending) {
            const id = loggedSessionId as string;
            const claimed = yield* Ref.modify(reviewClaimsRef, (current) =>
              current.has(id) ? [false, current] : [true, new Set(current).add(id)],
            );
            if (!claimed) continue;
            yield* Effect.gen(function* () {
              yield* Effect.logInfo(`[session-review] reviewing pending session ${id}`);
              // Awaited, not forked: sequential is the anti-stampede guard.
              yield* runSessionReview({ sessionIdsConsidered: [id] });
              // Only now — a committed run is the precondition for the marker.
              yield* store.markSessionReviewed(loggedSessionId);
              reviewed += 1;
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(
                  `[session-review] session ${id} stays pending after a failed run: ${Cause.pretty(cause)}`,
                ),
              ),
              // The claim is released either way. It is concurrency control,
              // not failure bookkeeping — the durable marker is what remembers
              // that this session still owes a review.
              Effect.ensuring(
                Ref.update(reviewClaimsRef, (current) => {
                  const next = new Set(current);
                  next.delete(id);
                  return next;
                }),
              ),
            );
          }
          return { reviewed };
        },
      );

      // Forked into `layerScope` — the runner's own scope, not the calling
      // request's, so the review outlives the `finishWorkout` response. A
      // fiber forked into the request scope would be interrupted as soon as
      // the RPC replied, silently losing the run.
      const nudgeSessionReviewDrain: Effect.Effect<void> = Effect.forkIn(layerScope)(
        reviewPendingSessions.pipe(Effect.catchCause(() => Effect.void)),
      ).pipe(Effect.asVoid);

      const runCycleReview: Effect.Effect<CommitDeliberationOutputResult> = runWithCadence("cycle-review", []);

      // --- Revise (ADR 0013, issue #66 slice 2) -----------------------------

      const reviseProposal = (params: {
        readonly proposalId: string;
        readonly prose: string;
      }): Effect.Effect<
        ReviseProposalResult,
        ProposalNotFoundError | ProposalAlreadyResolvedError | RevisionAlreadyInFlightError
      > =>
        Effect.gen(function* () {
          const decisionOpt = yield* store.getDecision(params.proposalId);
          if (Option.isNone(decisionOpt) || decisionOpt.value.kind !== "proposal") {
            return yield* Effect.fail(
              new ProposalNotFoundError({ proposalId: params.proposalId as never }),
            );
          }
          if (decisionOpt.value.status !== "pending") {
            return yield* Effect.fail(
              new ProposalAlreadyResolvedError({
                proposalId: params.proposalId as never,
                status: decisionOpt.value.status as never,
              }),
            );
          }

          // ADR 0013 §4/§5 — only ONE Revision run in flight per Proposal.
          // Checked (and reserved, below) atomically in the same `Ref.modify`
          // so two concurrent Revise calls on the same Proposal cannot both
          // observe "nothing in flight" and both proceed.
          const cancelledRef = yield* Ref.make(false);
          const alreadyInFlight = yield* Ref.modify(revisionControlRef, (current) => {
            if (current.has(params.proposalId)) return [true, current];
            const next = new Map(current).set(params.proposalId, {
              status: "queued" as const,
              cancelledRef,
              fiber: undefined,
            });
            return [false, next];
          });
          if (alreadyInFlight) {
            return yield* Effect.fail(
              new RevisionAlreadyInFlightError({ proposalId: params.proposalId as never }),
            );
          }
          // Keep the public projection in step with the reservation above.
          yield* SubscriptionRef.update(revisionStatesRef, (m) =>
            new Map(m).set(params.proposalId, "queued" as const),
          );

          // Starts in the BACKGROUND (ADR 0013 §5): this RPC returns
          // immediately; the card observes progress via
          // `subscribeProposalExchanges`'s overlay of `revisionStates` rather
          // than holding the request open for the minutes a run can take.
          // Forked into the RUNNER's own scope (`layerScope`), not the
          // calling request's — the fiber must outlive this one RPC.
          yield* Effect.forkIn(layerScope)(
            Effect.gen(function* () {
              const isLow = yield* quota.isQuotaLow;
              if (isLow) {
                const deferred = yield* Deferred.make<CommitDeliberationOutputResult, never>();
                yield* Queue.offer(deferralQueue, {
                  deferred,
                  cadence: "revision-run" as const,
                  sessionIdsConsidered: [],
                  cancelledRef,
                  revision: { proposalId: params.proposalId, prose: params.prose },
                });
                yield* SubscriptionRef.update(runStateRef, (s) => ({
                  ...s,
                  queuedCount: s.queuedCount + 1,
                }));
              } else {
                yield* runRevisionExecution(params.proposalId, params.prose, cancelledRef);
              }
            }).pipe(Effect.catchCause(() => Effect.void)),
          );

          return { proposalId: params.proposalId as never };
        });

      const cancelRevision = (params: {
        readonly proposalId: string;
      }): Effect.Effect<CancelRevisionResult, ProposalNotFoundError> =>
        Effect.gen(function* () {
          const decisionOpt = yield* store.getDecision(params.proposalId);
          if (Option.isNone(decisionOpt) || decisionOpt.value.kind !== "proposal") {
            return yield* Effect.fail(
              new ProposalNotFoundError({ proposalId: params.proposalId as never }),
            );
          }

          const current = yield* Ref.get(revisionControlRef);
          const entry = current.get(params.proposalId);
          if (entry === undefined) {
            return { cancelled: false }; // idempotent — nothing was in flight
          }

          // Belt: flip the flag `executeRevisionRun` re-checks immediately
          // before its only write-back. Braces: interrupt the fiber, if one
          // is already running. Either way NO rows are written (ADR 0013 §5).
          yield* Ref.set(entry.cancelledRef, true);
          if (entry.fiber !== undefined) {
            yield* Fiber.interrupt(entry.fiber);
          }

          // Clear the lock IMMEDIATELY rather than waiting for the queue/fiber
          // to notice — the card unlocks and a fresh Revise is accepted right
          // away (ADR 0013 §5's "cancelling clears the in-flight state").
          yield* clearRevisionControlIfCurrent(params.proposalId, entry.cancelledRef);

          return { cancelled: true };
        });

      return DeliberationRunner.of({
        runNow,
        runSessionReview,
        reviewPendingSessions,
        nudgeSessionReviewDrain,
        runCycleReview,
        runState: runStateRef,
        startIntake,
        turnIntake,
        convergeIntake,
        intakeEvents,
        abandonIntake,
        reviseProposal,
        cancelRevision,
        revisionStates: revisionStatesRef,
      });
    }),
  );
}

/**
 * Wires the canned `DeliberationAgent` under `DeliberationRunner.layer`
 * against a given `Store` layer.
 *
 * The Intake session agent defaults to the **unwired** one, which fails every
 * call. That is deliberate for the unit rungs: a suite exercising the deferral
 * queue has no business holding a working Intake coach, and one that fails
 * loudly if reached is how that stays true. The dev-server overrides it with
 * `CannedIntakeSessionAgent` (#82) — see that layer's own note for why the
 * "no canned interactive coach" position did not survive contact with rung 2.
 */
export const makeCannedDeliberationRunnerLayer = <E, R>(
  storeLayer: Layer.Layer<Store, E, R>,
  /**
   * Overrides for the two ports the dev-server's rung-2 levers replace
   * (`testLevers.ts`, issue #77): a deliberator that can be held mid-run, and
   * a quota service that can be driven low. Everything else stays canned, and
   * defaulting them here is what keeps the two wirings from drifting apart.
   */
  overrides?: {
    readonly deliberationAgent?: Layer.Layer<DeliberationAgent>;
    readonly quotaService?: Layer.Layer<QuotaService>;
    readonly intakeSessionAgent?: Layer.Layer<IntakeSessionAgent>;
  },
): Layer.Layer<DeliberationRunner, E, R> =>
  DeliberationRunner.layer.pipe(
    Layer.provide(overrides?.deliberationAgent ?? CannedDeliberationAgent),
    Layer.provide(CannedDeliberationSweepAgent),
    Layer.provide(overrides?.intakeSessionAgent ?? UnwiredIntakeSessionAgent),
    Layer.provide(CannedIntakeSweepAgent),
    Layer.provide(NoopDeliberationSnapshotForTest),
    Layer.provide(SeedInputsProviderLive),
    Layer.provide(overrides?.quotaService ?? QuotaServiceAlwaysAvailable),
    Layer.provide(storeLayer),
  );

/**
 * Applies the commissioned working directory (issue #93) to one agent's
 * session config. An explicit `cwd` on the passed config wins — that is a
 * caller saying something deliberate — and with no `agentCwd` at all the
 * config is handed through untouched, so nothing here can quietly invent a
 * directory for a harness that meant to inherit the process's.
 */
export const withAgentCwd = <C extends AgentSdkSessionConfig>(
  config: C | undefined,
  agentCwd: string | undefined,
): C | undefined => {
  if (agentCwd === undefined) return config;
  const base = config ?? (DEFAULT_AGENT_SDK_SESSION_CONFIG as C);
  if (base.cwd !== undefined) return base;
  return { ...base, cwd: agentCwd };
};

/**
 * Wires the REAL agents — the one-shot deliberator and sweep for the three
 * fire-and-forget cadences, plus the held-open Intake session and the
 * Intake sweep — under `DeliberationRunner.layer` against a given `Store` layer
 * and the live DB's filesystem path. This is what `makeProductionServer`
 * provides.
 */
export const makeRealDeliberationRunnerLayer = <E, R>(
  storeLayer: Layer.Layer<Store, E, R>,
  options: {
    readonly liveDbPath: string;
    /**
     * Working directory every real Agent SDK session runs from (issue #93).
     * Applied to all four agents so they cannot drift apart on it; a config
     * that sets its own `cwd` still wins, since that is an explicit choice.
     * Absent (tests, harnesses) means the sessions inherit the process's cwd,
     * which is exactly what production must never do — see
     * `agentWorkingDirectory.ts`.
     */
    readonly agentCwd?: string;
    readonly agentConfig?: RealDeliberationAgentConfig;
    readonly sweepAgentConfig?: RealDeliberationSweepAgentConfig;
    readonly intakeSessionConfig?: RealIntakeSessionAgentConfig;
    readonly intakeSweepConfig?: RealIntakeSweepAgentConfig;
    /**
     * Overrides the live quota poller (issue #88). Production leaves it alone;
     * it exists so a harness can wire a reader it controls without having to
     * rebuild this whole layer around a private default.
     */
    readonly quotaService?: Layer.Layer<QuotaService>;
    /**
     * What actually runs the four Agent SDK sessions (issue #95). Production
     * leaves it alone and gets live sessions; a replay or recording transport
     * swaps only the network call, so the prompts, the kill guard's consumers
     * and every decode stay exactly what production runs. Passed to ALL FOUR
     * adapters for the same reason `agentCwd` is: a mode that applied to three
     * of them would be a mode nobody could reason about.
     */
    readonly transport?: AgentSdkTransport;
  },
): Layer.Layer<DeliberationRunner, E, R> =>
  DeliberationRunner.layer.pipe(
    Layer.provide(RealDeliberationAgent(withAgentCwd(options.agentConfig, options.agentCwd), options.transport)),
    Layer.provide(
      RealDeliberationSweepAgent(withAgentCwd(options.sweepAgentConfig, options.agentCwd), options.transport),
    ),
    Layer.provide(
      RealIntakeSessionAgent(withAgentCwd(options.intakeSessionConfig, options.agentCwd), options.transport),
    ),
    Layer.provide(RealIntakeSweepAgent(withAgentCwd(options.intakeSweepConfig, options.agentCwd), options.transport)),
    Layer.provide(DeliberationSnapshotLive(options.liveDbPath)),
    Layer.provide(SeedInputsProviderLive),
    // The REAL quota signal (issue #88). Everything above this line spends
    // subscription quota (ADR 0005), so this is the layer that makes ADR 0011
    // §8's deferral queue mean something in production instead of being
    // structural-but-inert: with `QuotaServiceAlwaysAvailable` here, no run
    // ever deferred and the queue was unreachable code.
    Layer.provide(options.quotaService ?? QuotaServiceLive()),
    Layer.provide(storeLayer),
  );
