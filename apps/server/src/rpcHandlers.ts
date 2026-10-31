import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { nextUpSession } from "@repcoach/client-runtime/plan";
import {
  DecisionNotFoundError,
  type IsoDateTime,
  LoggedSessionNotFoundError,
  PrescribedSessionNotFoundError,
  RepCoachRpcGroup,
  type SessionId,
} from "@repcoach/contracts";
// The subpath, not the barrel — see `./store.ts`'s note: the root export
// transitively loads `node:sqlite`, which this module must not require.
import { toDecisionWorking } from "@repcoach/persistence/decisionWorking";

import { SERVER_BUILD_REF } from "./buildRef.ts";
import { DeliberationRunner } from "./deliberation/deliberationRunner.ts";
import { ModelCatalog } from "./agents/modelCatalog.ts";
import { Store } from "./store.ts";

/** How many finished workouts `logging.getNextUp` reads per page while looking for its anchor. */
const NEXT_UP_PAGE_SIZE = 20;

/**
 * Handlers for the Task 1 `RepCoachRpcGroup` against the in-memory `Store`
 * (issue #16 / Task 2). Mirrors t3code's `WsRpcGroup.of({...})` handler-map
 * style — see `apps/server/src/ws.ts` in the reference repo.
 */
export const RpcHandlersLayer = RepCoachRpcGroup.toLayer(
  Effect.gen(function* () {
    const store = yield* Store;
    const deliberationRunner = yield* DeliberationRunner;
    const modelCatalog = yield* ModelCatalog;

    return RepCoachRpcGroup.of({
      "server.getConfig": () =>
        Effect.succeed({
          serverName: "repcoach-dev-server",
          serverVersion: "0.0.0",
          protocolVersion: "1",
          // Issue #111 — the client compares this against the commit its own
          // bundle was built from. Read once at boot (`buildRef.ts`).
          buildRef: SERVER_BUILD_REF,
        }),

      "session.getPrescribed": (input) =>
        store.getPrescribedSession(input.sessionId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new PrescribedSessionNotFoundError({ sessionId: input.sessionId })),
              onSome: Effect.succeed,
            }),
          ),
        ),

      "session.start": (input) => store.startSession(input.prescribedSessionId),

      "logging.logSetActual": (input) => store.logSetActual(input),

      // A retraction (#83, ADR 0019) — "this Set was not performed after
      // all", idempotent by `commandId` exactly like `logSetActual` above,
      // with no rejectable-error arm.
      "logging.unlogSetActual": (input) => store.unlogSetActual(input),

      // Swap (#131, ADR 0019) — a pure actual-side annotation, never a Plan
      // edit, idempotent by `commandId` exactly like `logSetActual` above.
      "logging.swapEntryExercise": (input) => store.swapEntryExercise(input),

      "logging.getLoggedSession": (input) =>
        store.getLoggedSession(input.loggedSessionId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new LoggedSessionNotFoundError({ loggedSessionId: input.loggedSessionId })),
              onSome: Effect.succeed,
            }),
          ),
        ),

      // "Finish Workout" (ADR 0011 §4, 2B slice 4 — issue #29; decoupled by
      // issue #132): finalizes the session — the ONLY status transition,
      // `logging.logSetActual` above never calls `finalizeSession` — which in
      // the same write marks it `pending` review, then returns IMMEDIATELY and
      // lets the drain do the run in the background.
      //
      // **Why the run is no longer awaited here.** It used to be, and that is
      // the #132 bug in one line: the transition committed, the synchronous run
      // failed, and because `transitioned` was the only guard on re-running,
      // every retry reported `transitioned: false` and skipped the review
      // forever. Three sessions and 103 logged sets were never reviewed.
      // Whether a review is owed is now a durable fact about the row, not a
      // property of an in-flight request, so nothing can drop it: a failed run,
      // a low-quota deferral and a server restart all leave the row `pending`
      // and the next drain picks it up.
      //
      // Two consequences worth stating, because they replace things this
      // handler used to provide:
      //
      // - **`transitioned` no longer gates anything.** The drain is driven by
      //   `review_status`, so a double-tap cannot double-review even though
      //   both taps now reach the drain — the claim guard and the marker
      //   handle it. #29's guarantee survives; its mechanism changed.
      // - **The RPC no longer returns the review.** The run's progress is on
      //   the status strip (`subscribeDeliberationActivity`) and its output
      //   arrives on `subscribeCoachingFeed`/`subscribeProposals`, exactly as
      //   for every other cadence. Revise made this same trade for the same
      //   reason (ADR 0013 §5).
      //
      // Forked into the RUNNER's scope, not this request's, so the fiber
      // outlives the RPC — same construction `reviseProposal` uses.
      "logging.finishWorkout": (input) =>
        Effect.gen(function* () {
          const finalized = yield* store.finalizeSession(input.loggedSessionId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new LoggedSessionNotFoundError({ loggedSessionId: input.loggedSessionId })),
                onSome: Effect.succeed,
              }),
            ),
          );
          // A session already `reviewed` owes nothing — a genuine double-tap
          // after the coach has been. Anything still `pending` gets a drain
          // nudge, whether this call is what finalized it or a retry of one
          // whose review never ran.
          if (finalized.reviewStatus === "pending") {
            yield* deliberationRunner.nudgeSessionReviewDrain;
          }
          return {
            loggedSessionId: finalized.loggedSessionId,
            status: finalized.status,
            reviewStatus: finalized.reviewStatus,
          };
        }),

      // "Cancel session" (issue #114 Part 1) — never routes through
      // `finalizeSession`/the Deliberation runner, unlike `finishWorkout`
      // above: cancelling must trigger no Session review.
      "logging.cancelSession": (input) =>
        store.cancelSession(input.loggedSessionId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new LoggedSessionNotFoundError({ loggedSessionId: input.loggedSessionId })),
              onSome: Effect.succeed,
            }),
          ),
        ),

      "logging.listSessions": (input) => store.listSessions(input),

      // Tier-2 one-tap ✓ seed (issue #149): "what did I last lift on this
      // Exercise". Read-only, no error channel — a never-performed Exercise
      // is an empty `perMetric`.
      "logging.lastActualForExercise": (input) => store.lastActualForExercise(input),
      // "Which Logged Sessions are still in flight" (issue #147) — the
      // server-side source of truth for Resume-vs-picker that the client
      // reconciles its device-local `repcoach.inFlightSession` pointer
      // against. Straight read, no error channel, exactly like `listSessions`.
      "logging.listActiveSessions": () => store.listActiveSessions,
      // "Next up" (ADR 0023) — derived on every read, stored nowhere. Walks the
      // finished history newest first, a page at a time, only as far as the
      // first workout whose Prescribed Session is still in the Plan: usually
      // the first row of the first page.
      "logging.getNextUp": () =>
        Effect.gen(function* () {
          const plan = yield* store.getPlan;
          const inPlan = new Set<string>(plan.sessions.map((session) => session.id));
          let anchor: SessionId | undefined;
          let before: IsoDateTime | undefined;
          while (anchor === undefined) {
            const page = yield* store.listSessions({
              limit: NEXT_UP_PAGE_SIZE,
              ...(before === undefined ? {} : { before }),
            });
            anchor = page.sessions.find((row) => inPlan.has(row.prescribedSessionId))?.prescribedSessionId;
            if (page.sessions.length < NEXT_UP_PAGE_SIZE) break;
            before = page.sessions.at(-1)!.finishedAt;
          }
          const prescribedSessionId = nextUpSession(
            plan.sessions,
            anchor === undefined ? [] : [anchor],
          );
          return prescribedSessionId === undefined ? {} : { prescribedSessionId };
        }),

      "stats.getDailySetCounts": (input) => store.getDailySetCounts(input),

      // "Export my data" — a read-only dump of every table.
      "data.export": () => store.exportData,

      // The Progress surface — swap-aware, net-state history per Exercise.
      "stats.getExerciseProgress": () => store.getExerciseProgress,

      // Bodyweight — one reading per local day, an upsert.
      "bodyweight.log": (input) => store.logBodyweight(input),
      "bodyweight.remove": (input) => store.removeBodyweight(input),
      "bodyweight.list": () => store.listBodyweight,

      // Imported history (Strong / Hevy CSV), parsed on the device.
      "data.importWorkouts": (input) => store.importWorkouts(input),

      subscribeCoachingFeed: () => store.subscribeCoachingFeed,

      subscribeProposals: () => store.subscribeProposals,

      subscribePlan: () => store.subscribePlan,

      "proposals.resolve": (input) => store.resolveProposal(input),

      // ADR 0013 / issue #66 slice 2 — Revise, fully wired: `proposals.revise`
      // and `proposals.cancelRevision` call straight through to the runner
      // (which owns the deferral queue, the one-in-flight-per-Proposal lock,
      // and the cancellation path); `proposals.subscribeExchanges` overlays
      // the runner's LIVE `revisionStates` onto the store's stream, since the
      // store itself only ever emits `"idle"` (`ProposalRevisionStatus`'s doc
      // in `feed.ts` — the store has no visibility into the deferral queue).
      //
      // `Stream.zipLatest` re-emits on EITHER side changing: a store mutation
      // (a new turn, a resolved Proposal) OR a revision's status flipping
      // queued -> running -> idle. Without the second trigger, the card's
      // lock would only appear/clear on the NEXT store mutation rather than
      // the instant the run actually starts/finishes — reading as a stuck
      // spinner until something unrelated nudges the stream.
      "proposals.subscribeExchanges": () =>
        Stream.zipLatest(
          store.subscribeProposalExchanges,
          SubscriptionRef.changes(deliberationRunner.revisionStates),
        ).pipe(
          Stream.map(([exchange, revisionStates]) => ({
            ...exchange,
            revisionStatus: revisionStates.get(exchange.proposalId) ?? "idle",
          })),
        ),

      "proposals.revise": (input) =>
        deliberationRunner.reviseProposal({ proposalId: input.proposalId, prose: input.text }),

      "proposals.cancelRevision": (input) =>
        deliberationRunner.cancelRevision({ proposalId: input.proposalId }),

      // The whole Plan-authoring surface is this one method (#71) — the
      // narrow Set-target edit and every structural operation come through
      // it, so there is one place to validate and one Change per call.
      "plan.applyUserChange": (input) => store.applyUserPlanChange(input),

      // One-shot Plan read (#71), the sibling of `subscribePlan`. An empty
      // Plan is a valid snapshot, never an error — that is the state the
      // first-Session flow is offered from.
      "plan.get": () => store.getPlan,

      // The Exercise catalog (#72 user story 29) — the picker's source, and
      // the same rows the authoring context is built from.
      "catalog.getExercises": () => store.getExerciseCatalog,

      // The catalog's two writes (#102, ADR 0016). Deliberately NOT members
      // of the Plan operation union: a catalog row is not part of the Plan,
      // so neither mints a Change and neither touches the Decision log.
      "catalog.createExercise": (input) => store.createExercise(input),
      "catalog.renameExercise": (input) => store.renameExercise(input),

      // The working behind one Decision (#79) — what a Proposal card or a
      // Coach feed item expands into. Thin on purpose: the decode lives in
      // `toDecisionWorking` at the store boundary, so both Store layers
      // answer this identically.
      "decisions.get": (input) =>
        store.getDecision(input.decisionId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new DecisionNotFoundError({ decisionId: input.decisionId })),
              onSome: (record) => Effect.succeed(toDecisionWorking(record)),
            }),
          ),
        ),

      "deliberation.runNow": () => deliberationRunner.runNow,

      // Cycle-review trigger seam (ADR 0011 §4, 2B slice 6 — issue #31): the
      // monthly schedule fires this to enqueue + run a Cycle review
      // (long-history framing + the cycle-review-configured model) via the
      // SAME runner mechanism `runNow`/Session review use. No wall-clock cron
      // here — a scheduler (or a test) invokes the RPC; it also serves an
      // on-demand "run a Cycle review now" (ADR 0002/0011 §4).
      "deliberation.runCycleReview": () => deliberationRunner.runCycleReview,

      // Per-cadence model settings (ADR 0011 §4, issue #31): persist a model
      // choice per cadence; the runner reads it (`Store.getCadenceModel`) each
      // run and passes it to that cadence's deliberator.
      "settings.setCadenceModel": (input) =>
        store.setCadenceModel(input).pipe(Effect.map((setting) => ({ setting }))),

      "settings.getCadenceModel": (input) =>
        store
          .getCadenceModel(input.cadence)
          // The Store layer does not re-validate `effort` against the
          // contract's literal union — the trust boundary is the contract
          // (Schema decode on the wire), not the store (same posture as
          // `cadence` itself; see `cadenceModelSettings.adversarial.test.ts`).
          .pipe(Effect.map(({ model, effort }) => ({ model: model ?? null, effort: (effort ?? null) as never }))),

      // The selectable model catalog, read live from the Agent SDK rather
      // than authored in the client (issue #81 follow-up). Never fails: an
      // unreadable catalog comes back empty with a reason, and the Settings
      // surface falls back to its free-text model field.
      "settings.listModels": () => modelCatalog.list,

      // The run ledger's read (ADR 0011 §8 amendment, issue #81) — one RPC,
      // grouped server-side. See `Store.getSpendSummary`/`summarizeRunLedger`.
      "settings.getSpendSummary": () => store.getSpendSummary,

      // The RPE capture control (#63, issue #81) — three states, stored
      // server-side because it changes what the Plan prescribes.
      "settings.setRpeCaptureMode": (input) =>
        store.setRpeCaptureMode(input.mode).pipe(Effect.map((mode) => ({ mode }))),

      "settings.getRpeCaptureMode": () => store.getRpeCaptureMode.pipe(Effect.map((mode) => ({ mode }))),

      // Real user-authored seed-input write paths (ADR 0011 §2, issue #34).
      "goal.set": (input) => store.setGoal(input).pipe(Effect.map((goal) => ({ goal }))),

      "standingConstraints.add": (input) =>
        store.addStandingConstraint(input).pipe(Effect.map((constraint) => ({ constraint }))),

      "standingConstraints.remove": (input) => store.removeStandingConstraint(input),

      "checkIns.add": (input) => store.addCheckIn(input).pipe(Effect.map((checkIn) => ({ checkIn }))),

      "contextNotes.add": (input) => store.addContextNote(input).pipe(Effect.map((note) => ({ note }))),

      // In-place rewrite of a note the Entry already has (UAT: the sheet's
      // note item edits rather than appends). An unknown `noteId` answers
      // `{ commandId }` with no `note` — a no-op success, so a stale queued
      // edit cannot wedge the outbox behind it.
      "contextNotes.edit": (input) =>
        store.editContextNote(input).pipe(
          Effect.map((note) => (note === undefined ? { commandId: input.commandId } : { commandId: input.commandId, note })),
        ),

      // Run-visibility subscription (ADR 0011 §8, 2B slice 7 — issue #32):
      // emits the current Deliberation run state — running / queued / idle —
      // and the run's token usage. Subscribes to the runner's `runState`
      // SubscriptionRef, which emits on every state transition.
      "deliberation.subscribeState": () =>
        SubscriptionRef.changes(deliberationRunner.runState).pipe(
          Stream.map((state) => state),
        ),

      // The Coach record's run history (ADR 0011 §8) — every run the store has
      // a row for, with the Decisions each emitted, newest first.
      //
      // Off the STORE, not off the runner, and that is the point of the whole
      // feature: `deliberation.subscribeState` above is the runner's live
      // in-memory snapshot, which knows only about the run happening now and
      // forgets it on restart. This reads rows, so a run that emitted nothing
      // and a run that died are both still here tomorrow.
      "deliberation.subscribeRuns": () => store.subscribeDeliberationRuns,

      // The Intake takeover (ADR 0011 §7 as amended by ADR 0014 — issue #70):
      // one held-open session, many turns, swept once at convergence. Note the
      // absence of an `intake.accept`: the committed Proposal is resolved
      // through `proposals.resolve` like any other, which is what makes it
      // genuinely the same Proposal card (§6).
      "intake.start": (input) => deliberationRunner.startIntake(input),

      "intake.turn": (input) =>
        deliberationRunner.turnIntake({
          intakeSessionId: input.intakeSessionId,
          answer: input.answer,
        }),

      "intake.converge": (input) =>
        deliberationRunner.convergeIntake({ intakeSessionId: input.intakeSessionId }),

      // The activity line (§4) — and the session's liveness signal. The stream's
      // lifetime IS the client's: a reload or tab close ends the subscription,
      // whose finalizer tears the session down, so ADR 0014 §8's "reload or tab
      // close ends the session cleanly, with no half-alive state" is enforced by
      // the connection rather than by a heartbeat the client has to remember to
      // send. Converge deliberately does NOT tear down — the exchange stays
      // reopenable from the final card (§5).
      "intake.events": (input) =>
        deliberationRunner
          .intakeEvents({ intakeSessionId: input.intakeSessionId })
          .pipe(
            Stream.ensuring(
              deliberationRunner.abandonIntake({ intakeSessionId: input.intakeSessionId }),
            ),
          ),
    });
  }),
);
