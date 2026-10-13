import { useCallback, useEffect, useMemo, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { Connection, Rpc } from "@repcoach/client-runtime";
import { RPC_METHODS, type Proposal, type ProposalExchange } from "@repcoach/contracts";

import { callRpc, describeFailure } from "./rpc.ts";
import { useRuntime } from "./RuntimeProvider.tsx";

/**
 * The live Proposal card (ADR 0013, issue #66 slice 3) — the Revise
 * affordance and the Proposal identity/lineage/actions around it. The card's
 * deep "working" blocks (measurements, rule, sources, uncertainty) stay
 * fixture-fed in `CoachOutput.tsx`; this hook only supplies what slice 3 owns.
 *
 * Rides two subscriptions, like `usePlan`/`usePendingProposalCount` do
 * separately rather than one combined feed:
 * - `subscribeProposals` for the Proposal itself (id, summary, rationale,
 *   status) — replayed on reconnect, accumulated by id.
 * - `subscribeProposalExchanges` for the live lock state and the lineage
 *   entries (`rpc.ts`'s doc on that RPC: the card needs both on the same
 *   channel, this hook is simply the client-side join of the two streams).
 *
 * "The" current Proposal is the most recently created `pending` Proposal with
 * no `draftPlan` — the Intake Proposal is a different takeover surface
 * (ADR 0014 §6), and ADR 0013 §2 guarantees at most one pending head per
 * chain, so picking the newest is the one honest choice among however many
 * unprompted Proposals might also be pending.
 */
export type ProposalCardState =
  | { readonly status: "loading" }
  | { readonly status: "empty" }
  | { readonly status: "ready"; readonly proposal: Proposal; readonly exchange: ProposalExchange | undefined }
  | { readonly status: "failed"; readonly reason: string };

export interface ProposalCardActions {
  /** `proposals.revise` — locks the card; see `proposalExchange.ts`'s `isRevisionLocked`. */
  readonly revise: (text: string) => Promise<void>;
  /** `proposals.cancelRevision` — the only escape from the lock (ADR 0013 §5). */
  readonly cancelRevision: () => Promise<void>;
  /** `proposals.resolve` — Accept/Dismiss, unavailable while locked. */
  readonly resolve: (decision: "accepted" | "rejected") => Promise<void>;
  /** The last action's failure, as a line the card can show; cleared on the next attempt. */
  readonly actionError: string | undefined;
  /** True between calling an action and it settling — disables the buttons a second time. */
  readonly actionPending: boolean;
}

export function useProposalCard(): ProposalCardState & ProposalCardActions {
  const runtime = useRuntime();
  const [proposals, setProposals] = useState<ReadonlyMap<string, Proposal>>(new Map());
  const [exchanges, setExchanges] = useState<ReadonlyMap<string, ProposalExchange>>(new Map());
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    const fiber = Effect.runFork(
      Rpc.subscribe(RPC_METHODS.subscribeProposals, {}).pipe(
        Stream.runForEach((proposal) =>
          Effect.sync(() => {
            setProposals((current) => new Map(current).set(proposal.id, proposal));
          }),
        ),
        Effect.provideService(Connection.EnvironmentSupervisor, runtime.supervisor),
        Effect.catchCause((cause) => Effect.sync(() => setFailure(describeFailure(cause)))),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [runtime]);

  useEffect(() => {
    const fiber = Effect.runFork(
      Rpc.subscribe(RPC_METHODS.subscribeProposalExchanges, {}).pipe(
        Stream.runForEach((exchange) =>
          Effect.sync(() => {
            setExchanges((current) => new Map(current).set(exchange.proposalId, exchange));
          }),
        ),
        Effect.provideService(Connection.EnvironmentSupervisor, runtime.supervisor),
        // A dead exchange feed must not blank a Proposal already on screen —
        // same "last good state over a failed one" call `usePlan` makes.
        Effect.catchCause(() => Effect.void),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [runtime]);

  const current = useMemo(() => {
    let best: Proposal | undefined;
    for (const proposal of proposals.values()) {
      if (proposal.status !== "pending" || proposal.draftPlan !== undefined) continue;
      if (best === undefined || proposal.createdAt > best.createdAt) best = proposal;
    }
    return best;
  }, [proposals]);

  const runAction = useCallback(async (action: () => Promise<unknown>) => {
    setActionError(undefined);
    setActionPending(true);
    try {
      await action();
    } catch (cause) {
      setActionError(describeFailure(cause));
    } finally {
      setActionPending(false);
    }
  }, []);

  const revise = useCallback(
    (text: string) => {
      if (current === undefined) return Promise.resolve();
      return runAction(() =>
        callRpc(runtime, RPC_METHODS.reviseProposal, { proposalId: current.id, text } as never),
      );
    },
    [current, runAction, runtime],
  );

  const cancelRevision = useCallback(() => {
    if (current === undefined) return Promise.resolve();
    return runAction(() =>
      callRpc(runtime, RPC_METHODS.cancelRevision, { proposalId: current.id } as never),
    );
  }, [current, runAction, runtime]);

  const resolve = useCallback(
    (decision: "accepted" | "rejected") => {
      if (current === undefined) return Promise.resolve();
      return runAction(() =>
        callRpc(runtime, RPC_METHODS.resolveProposal, { proposalId: current.id, decision } as never),
      );
    },
    [current, runAction, runtime],
  );

  if (failure !== undefined && current === undefined) {
    return { status: "failed", reason: failure, revise, cancelRevision, resolve, actionError, actionPending };
  }
  if (current === undefined) {
    return { status: "empty", revise, cancelRevision, resolve, actionError, actionPending };
  }
  return {
    status: "ready",
    proposal: current,
    exchange: exchanges.get(current.id),
    revise,
    cancelRevision,
    resolve,
    actionError,
    actionPending,
  };
}
