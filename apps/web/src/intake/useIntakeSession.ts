import { useCallback, useEffect, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { Connection, Intake, Rpc } from "@repcoach/client-runtime";
import {
  RPC_METHODS,
  type ConvergeIntakeResult,
  type IntakeToolEvent,
  type IntakeTurn,
} from "@repcoach/contracts";

import type { RepCoachRuntime } from "../runtime/RuntimeProvider.tsx";
import { callRpc } from "../runtime/rpc.ts";

/**
 * The Intake takeover, driven by the real runner (#74) — the held-open session
 * from #70, its live tool events, the convergence/accept split, and every one
 * of ADR 0014 §8's failures.
 *
 * This hook owns the *conversation with the server*; every decision about what
 * the surface says or derives lives in `@repcoach/client-runtime`'s `Intake`
 * module instead, because rung 1 runs with no DOM (`vitest.config.ts` is
 * `environment: "node"` by design — the browser adapters are proven by the
 * Playwright flows instead), so a decision left in JSX is one no test can
 * reach.
 *
 * **Mortality is deliberate (§8).** There is no persistence, no resurrection
 * and no reconnect recovery: reload or tab-close ends the session and discards
 * the draft. That is why Intake state is the one write path in the app that is
 * *not* in the outbox — a once-per-lifetime flow does not earn a recovery
 * subsystem.
 */

export type IntakePhase =
  /** The four-field form — and where a failed cold draft returns to, values intact. */
  | "form"
  /** §4's cold wait: the worst moment in the app, carried entirely by the activity line. */
  | "cold"
  | "exchange"
  /** §4's turn wait — a pause, not a screen change: the draft stays, the input disables. */
  | "turn"
  | "sweeping"
  | "proposal"
  | "accepted";

export interface IntakeSessionState {
  readonly phase: IntakePhase;
  /** The cold draft, then every revision — the last one is what the hero renders. */
  readonly turn: IntakeTurn | undefined;
  readonly ledger: ReadonlyArray<Intake.IntakeLedgerEntry>;
  /** Live tool events for whichever wait is running. Cleared when a wait starts. */
  readonly events: ReadonlyArray<IntakeToolEvent>;
  /** The citations the plan carries *now* — the scope the sweep's wait and card both read. */
  readonly citationScope: ReadonlyArray<string>;
  readonly converged: ConvergeIntakeResult | undefined;
  readonly spend: Intake.IntakeSpend;
  readonly model: string | undefined;
  /** §8's three failure sites, kept apart because each one returns the user somewhere different. */
  readonly formFailure: Intake.IntakeFailureMessage | undefined;
  readonly turnFailure: Intake.IntakeFailureMessage | undefined;
  readonly sweepFailure: Intake.IntakeFailureMessage | undefined;
  readonly acceptFailure: string | undefined;
}

export interface IntakeSessionActions {
  readonly start: (values: Intake.IntakeFormValues) => void;
  readonly answer: (text: string) => void;
  readonly converge: () => void;
  /** §5: the exchange stays reopenable; finishing again re-sweeps. */
  readonly reopen: () => void;
  readonly accept: () => void;
}

const initialState: IntakeSessionState = {
  phase: "form",
  turn: undefined,
  ledger: [],
  events: [],
  citationScope: [],
  converged: undefined,
  spend: Intake.noIntakeSpend,
  model: undefined,
  formFailure: undefined,
  turnFailure: undefined,
  sweepFailure: undefined,
  acceptFailure: undefined,
};

export function useIntakeSession(
  runtime: RepCoachRuntime,
  onAccepted: () => void,
): readonly [IntakeSessionState, IntakeSessionActions] {
  const [state, setState] = useState<IntakeSessionState>(initialState);

  /** The live session id. A ref, not state: the RPC callbacks need the current value, not a rendered one. */
  const sessionId = useRef<string | undefined>(undefined);
  /** The cold draft and every answered turn, in order — the ledger's input. */
  const coldTurn = useRef<IntakeTurn | undefined>(undefined);
  const answered = useRef<ReadonlyArray<Intake.AnsweredIntakeTurn>>([]);
  const eventFiber = useRef<Fiber.Fiber<unknown, unknown> | undefined>(undefined);

  /**
   * The provenance footer's model. Read once, best-effort: a footer naming the
   * wrong model would be worse than one naming none, so a failed read simply
   * leaves it out.
   */
  useEffect(() => {
    let live = true;
    void callRpc(runtime, RPC_METHODS.getCadenceModel, { cadence: "intake" } as never)
      .then((result) => {
        const model = (result as { readonly model: string | null }).model;
        if (live && model !== null) setState((current) => ({ ...current, model }));
      })
      .catch(() => {
        // Best-effort: the footer simply omits the model.
      });
    return () => {
      live = false;
    };
  }, [runtime]);

  /**
   * The activity line's subscription. Forked per wait rather than held for the
   * whole takeover, because the list is *this wait's* evidence — carrying the
   * cold draft's lines into the sweep would narrate work that already finished.
   */
  const watchEvents = useCallback(
    (intakeSessionId: string) => {
      const fiber = Effect.runFork(
        Rpc.subscribe(RPC_METHODS.subscribeIntakeEvents, { intakeSessionId }).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() =>
              setState((current) => ({ ...current, events: [...current.events, event] })),
            ),
          ),
          Effect.provideService(Connection.EnvironmentSupervisor, runtime.supervisor),
          Effect.catchCause(() => Effect.void),
        ),
      );
      eventFiber.current = fiber;
    },
    [runtime],
  );

  const stopWatching = useCallback(() => {
    const fiber = eventFiber.current;
    eventFiber.current = undefined;
    if (fiber !== undefined) Effect.runFork(Fiber.interrupt(fiber));
  }, []);

  // The takeover's mortality, made real: leaving the screen tears the
  // subscription down, and the runner ends the session with it.
  useEffect(() => stopWatching, [stopWatching]);

  const applyTurn = useCallback((turn: IntakeTurn, answer?: string) => {
    if (answer === undefined) {
      coldTurn.current = turn;
      answered.current = [];
    } else {
      answered.current = [...answered.current, { answer, turn }];
    }
    const cold = coldTurn.current;
    setState((current) => ({
      ...current,
      turn,
      ledger: cold === undefined ? [] : Intake.deriveIntakeLedger(cold, answered.current),
      citationScope: Intake.turnCitationIds(turn),
      spend: Intake.addIntakeSpend(current.spend, turn.usage, {
        countsAsTurn: answer !== undefined,
      }),
    }));
  }, []);

  /* ------------------------------------------------------------ cold start */

  const start = useCallback(
    (values: Intake.IntakeFormValues) => {
      setState((current) => ({ ...current, phase: "cold", events: [], formFailure: undefined }));
      void callRpc(runtime, RPC_METHODS.startIntake, Intake.toStartIntakeInput(values) as never)
        .then((value) => {
          const result = value as { readonly intakeSessionId: string; readonly turn: IntakeTurn };
          sessionId.current = result.intakeSessionId;
          applyTurn(result.turn);
          setState((current) => ({ ...current, phase: "exchange" }));
        })
        .catch((cause: unknown) => {
          // §8: the form comes back with every value intact — losing what was
          // typed is the one unforgivable version of this failure.
          setState((current) => ({
            ...current,
            phase: "form",
            formFailure: Intake.coldDraftFailureMessage(cause),
          }));
        });
      // NOTE — the cold wait has no activity line, and cannot have one today.
      // `intake.events` is keyed on the session id, and `intake.start` is what
      // mints it: the id does not exist until the cold draft has already
      // finished. #70's own suite records this ("the cold draft's events
      // precede any possible subscriber"). The wait therefore says what it is
      // doing in words and shows a pulse, and **fabricates nothing** — no
      // invented lines, no percentage — which is §4's actual rule. Closing the
      // gap means the runner minting the id before it drafts, which is a
      // server change and belongs to #70, not here.
    },
    [applyTurn, runtime],
  );

  /* ----------------------------------------------------------------- turns */

  const answer = useCallback(
    (text: string) => {
      const intakeSessionId = sessionId.current;
      if (intakeSessionId === undefined) return;
      setState((current) => ({ ...current, phase: "turn", turnFailure: undefined, sweepFailure: undefined }));
      void callRpc(runtime, RPC_METHODS.intakeTurn, { intakeSessionId, answer: text } as never)
        .then((value) => {
          applyTurn((value as { readonly turn: IntakeTurn }).turn, text);
          setState((current) => ({ ...current, phase: "exchange" }));
        })
        .catch((cause: unknown) => {
          // §2 + §8: a failed turn is a genuine no-op — interim turns write
          // nothing, so the draft on screen is still exactly the draft.
          setState((current) => ({
            ...current,
            phase: "exchange",
            turnFailure: Intake.turnFailureMessage(cause),
          }));
        });
    },
    [applyTurn, runtime],
  );

  /* ----------------------------------------------------------------- sweep */

  const converge = useCallback(() => {
    const intakeSessionId = sessionId.current;
    if (intakeSessionId === undefined) return;
    setState((current) => ({ ...current, phase: "sweeping", events: [], sweepFailure: undefined }));
    watchEvents(intakeSessionId);
    void callRpc(runtime, RPC_METHODS.convergeIntake, { intakeSessionId } as never)
      .then((value) => {
        stopWatching();
        const result = value as ConvergeIntakeResult;
        setState((current) => ({
          ...current,
          phase: "proposal",
          converged: result,
          spend: Intake.addIntakeSpend(current.spend, result.usage),
        }));
      })
      .catch((cause: unknown) => {
        stopWatching();
        // §8: no Proposal is offered. The exchange is where the user lands,
        // because retry and keep-tweaking are the only two honest doors.
        setState((current) => ({
          ...current,
          phase: "exchange",
          sweepFailure: Intake.sweepFailureMessage(cause),
        }));
      });
  }, [runtime, stopWatching, watchEvents]);

  const reopen = useCallback(() => {
    setState((current) => ({ ...current, phase: "exchange", converged: undefined }));
  }, []);

  /* ---------------------------------------------------------------- accept */

  const accept = useCallback(() => {
    const converged = state.converged;
    if (converged === undefined) return;
    setState((current) => ({ ...current, acceptFailure: undefined }));
    // Accept is NOT an Intake RPC (§5/§6): converge already committed the one
    // pending Intake Proposal, so accepting travels the ordinary
    // `proposals.resolve` path — which is what makes "it is genuinely the same
    // Proposal card" true at the contract level and not only visually.
    void callRpc(runtime, RPC_METHODS.resolveProposal, {
      proposalId: converged.proposalId,
      decision: "accepted",
    } as never)
      .then(() => {
        setState((current) => ({ ...current, phase: "accepted" }));
        onAccepted();
      })
      .catch(() => {
        setState((current) => ({
          ...current,
          acceptFailure:
            "The plan couldn't be saved — the coach lost its connection. Nothing was lost; try accepting again.",
        }));
      });
  }, [onAccepted, runtime, state.converged]);

  return [state, { start, answer, converge, reopen, accept }] as const;
}

