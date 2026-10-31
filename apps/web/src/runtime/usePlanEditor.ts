import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Outbox, Plan as PlanRuntime } from "@repcoach/client-runtime";
import type { CatalogExercise, PlanOperation, PlanSnapshot } from "@repcoach/contracts";

import { enqueuePlanEdit } from "./commands.ts";
import { describeFailure } from "./rpc.ts";
import { useRuntime } from "./RuntimeProvider.tsx";

/**
 * The Plan editor's write side (#72 user stories 26–28, #80 stories 1–2).
 *
 * Three things happen on every edit, in this order, and the order is the
 * design:
 *
 * 1. **Validate locally** with `validatePlanOperation` — the same function
 *    the server applies, so a stale tap fails instantly and identically
 *    rather than after a round trip.
 * 2. **Apply optimistically** with `applyPlanOperation`, which also produces
 *    the human summary the ledger shows. There is no save button (ADR 0008
 *    auto-applies), so the edit has to appear to land at the speed of the
 *    tap or the absence of the button reads as the edit being lost.
 * 3. **Enqueue** on the outbox, and reconcile against `subscribePlan`.
 *
 * **Step 3 is what #80 changed, and it is what makes step 2 honest.** It used
 * to be "send the RPC, reconcile with the echo, and roll the optimistic Plan
 * back if the send failed". Offline that produced the worst possible sequence:
 * the edit visibly landed, then silently un-landed, and the user was told
 * through an error banner that something they had watched happen had not. In a
 * dead spot that is indistinguishable from data loss — and per the project's
 * local-first value it *was* loss, because nothing retried.
 *
 * Enqueueing removes the rollback entirely. There is no failure at this point
 * to roll back *from*: the command is durable before `apply` returns, and the
 * flusher delivers it whenever the session next exists. The optimistic Plan is
 * therefore no longer a guess about what the server will accept — the local
 * validator already decided that — it is simply the Plan, slightly ahead of
 * the server's copy of it.
 *
 * Local rejection is unchanged and is still the only way an edit is refused:
 * `applyPlanOperation` fails, nothing is enqueued, nothing appears to happen,
 * and `lastError` says why. That path never depended on connectivity.
 *
 * Undo is `invertPlanOperation` sent as a new edit (#71: undo is not a new
 * primitive). Operations with no expressible inverse — `deleteSession`,
 * which would need a multi-operation restore — are recorded as
 * **not undoable**, so the ledger does not offer a free undo it cannot
 * honour.
 */
export interface AppliedChange {
  readonly id: number;
  readonly origin: "user-direct";
  readonly summary: string;
  readonly at: string;
  /** `undefined` when the operation has no single-operation inverse. */
  readonly inverse: PlanOperation | undefined;
}

export interface PlanEditor {
  /** The Plan to render: the server's snapshot, or the optimistic one if an edit is in flight. */
  readonly plan: PlanSnapshot;
  readonly changes: ReadonlyArray<AppliedChange>;
  /** Applies an operation. Returns false when it was rejected locally and nothing was sent. */
  readonly apply: (operation: PlanOperation) => boolean;
  /**
   * Teaches the editor about a catalog row that exists on the server but has
   * not reached this hook's `catalog` prop yet (#102).
   *
   * Creating a User-authored exercise and adding it to the Session is one
   * gesture but two writes (ADR 0016), and the second is an `addEntry` this
   * editor validates against its authoring context. The catalog arrives here
   * as a prop, so the freshly created row is a React state update away —
   * a whole render behind the tap. Without this the `addEntry` fired in the
   * same tick is rejected as an unknown exercise.
   *
   * Synchronous, and for the same reason `currentPlan` is a ref: the point is
   * that the very next `apply` sees it.
   */
  readonly registerExercise: (exercise: CatalogExercise) => void;
  readonly undoLast: () => void;
  readonly canUndo: boolean;
  /** Set when the last edit was rejected — locally or by the server. */
  readonly lastError: string | undefined;
  readonly dismissError: () => void;
}

export function usePlanEditor(
  serverPlan: PlanSnapshot,
  catalog: ReadonlyArray<CatalogExercise>,
): PlanEditor {
  const runtime = useRuntime();
  const [optimistic, setOptimistic] = useState<PlanSnapshot | undefined>(undefined);
  const [changes, setChanges] = useState<ReadonlyArray<AppliedChange>>([]);
  const [lastError, setLastError] = useState<string | undefined>(undefined);

  /**
   * The Plan `apply` validates against, kept in a ref rather than read off
   * render state.
   *
   * Two operations can be dispatched in the same tick — "add exercise" is
   * `addEntry` followed by `replaceEntrySets` seeding its first run — and a
   * `useState` value does not change until React re-renders. The second
   * operation would therefore validate against a Plan that does not yet
   * contain the Entry the first just created, and be rejected as
   * `not-found`. The ref advances synchronously, which is what lets a
   * sequence of operations compose.
   */
  const currentPlan = useRef<PlanSnapshot>(serverPlan);

  /**
   * Enqueues are **serialised**, for the same reason `currentPlan` is a ref:
   * two operations dispatched together are ordered, and the outbox drains
   * strictly in enqueue order. Firing both at once would race their `enqueue`
   * calls, and `replaceEntrySets` could be persisted — and therefore
   * delivered — ahead of the `addEntry` that creates the Entry it names.
   *
   * Before #80 this chained the RPCs themselves and the risk was the same one
   * a step further out; the fix is unchanged, it just guards a shorter and far
   * more reliable operation now (a local durable write rather than a network
   * round trip).
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * Rows registered through `registerExercise` — server-confirmed catalog
   * entries the `catalog` prop has not caught up with. Kept until it does,
   * at which point the merge below simply finds them twice and the prop's
   * copy wins.
   */
  const registered = useRef<ReadonlyArray<CatalogExercise>>([]);

  const context = useMemo<PlanRuntime.PlanAuthoringContext>(
    () => ({
      exercises: [
        ...registered.current.filter(
          (extra) => !catalog.some((exercise) => exercise.id === extra.id),
        ),
        ...catalog,
      ].map((exercise) => ({
        id: exercise.id,
        name: exercise.name,
        trackedMetrics: exercise.trackedMetrics,
      })),
    }),
    [catalog],
  );

  /**
   * The context `apply` validates against, in a ref so a registration lands
   * before the next operation in the same tick rather than one render later
   * — see `registerExercise` and `currentPlan` for the same argument.
   */
  const currentContext = useRef<PlanRuntime.PlanAuthoringContext>(context);
  useEffect(() => {
    currentContext.current = context;
  }, [context]);

  const registerExercise = useCallback((exercise: CatalogExercise) => {
    registered.current = [
      ...registered.current.filter((existing) => existing.id !== exercise.id),
      exercise,
    ];
    currentContext.current = {
      exercises: [
        ...currentContext.current.exercises.filter((existing) => existing.id !== exercise.id),
        {
          id: exercise.id,
          name: exercise.name,
          trackedMetrics: exercise.trackedMetrics,
        },
      ],
    };
  }, []);

  // The optimistic snapshot is only trusted while it is *ahead* of the
  // server's. Once the queue has drained and a fresh subscription emission
  // arrives, the server is authoritative — it has seen edits from other
  // devices and from accepted Proposals that this client never applied.
  const plan = optimistic ?? serverPlan;

  // Keep the ref in step with whatever is on screen, including a server
  // snapshot that arrived with no local edit behind it.
  useEffect(() => {
    currentPlan.current = plan;
  }, [plan]);

  /**
   * How the optimistic overlay is retired, now that there is no echo to
   * retire it.
   *
   * Both conditions are required, and each rules out a specific way of being
   * wrong. **Queue empty** means the server has received every edit this
   * device made, so its Plan is no longer behind ours — dropping the overlay
   * while an edit is still queued would un-render an edit that is merely
   * undelivered, which is precisely the disappearing-edit behaviour #80
   * exists to remove. **A `serverPlan` that is not the one we started from**
   * closes the flicker window: clearing the instant the queue empties would
   * briefly show the pre-edit Plan between the server's ack and its
   * `subscribePlan` push, making a successful edit blink away.
   *
   * The second check is reference identity, so it is a *liveness* guard, not
   * proof that the emission contains our edits — an unrelated push (another
   * device, an accepted Proposal) also satisfies it. That is acceptable
   * precisely because the first condition already holds: with the queue empty
   * the server has our edits, so any snapshot it sends from that point is at
   * least as new as ours. Deferring to it is correct even if it was prompted
   * by something else.
   */
  const pendingPlanEdits = usePendingPlanEditCount(runtime.outbox);
  const serverPlanAtOverlay = useRef<PlanSnapshot | undefined>(undefined);

  useEffect(() => {
    if (optimistic === undefined) return;
    if (pendingPlanEdits > 0) return;
    if (serverPlan === serverPlanAtOverlay.current) return;
    setOptimistic(undefined);
    serverPlanAtOverlay.current = undefined;
  }, [optimistic, pendingPlanEdits, serverPlan]);

  /**
   * The one way an edit still fails after it has been shown as applied: the
   * server evaluated the operation and **refused** it.
   *
   * This is rare — the local validator is the same function, so an operation
   * that passed here almost always passes there — but it is reachable, because
   * the two run at different times against different Plans. An edit queued in
   * a dead spot on Tuesday can name a Session that another device deleted on
   * Wednesday.
   *
   * It is also the only case the overlay-retirement rule above cannot resolve
   * on its own: a refused operation changes nothing server-side, so no new
   * `serverPlan` ever arrives to defer to, and the overlay would otherwise
   * show the refused edit forever with no error. Dropping straight back to the
   * server's Plan is the honest answer — the local Plan was built on top of an
   * operation that does not exist.
   */
  useEffect(() => {
    const fiber = Effect.runFork(
      SubscriptionRef.changes(runtime.outbox.rejections).pipe(
        Stream.runForEach((items) => {
          // Only Plan edits are this hook's to handle — the Logging surface now
          // subscribes to the same stream for its own rejected swaps (#148), so
          // taking `items[0]` unconditionally would let this hook consume and
          // acknowledge a swap rejection, flashing "Edit could not be applied"
          // for a swap and clearing it before Logging ever saw it.
          const rejection = items.find((item) => item.command.kind === "applyPlanEdit");
          if (rejection === undefined) return Effect.void;
          return Effect.sync(() => {
            setOptimistic(undefined);
            serverPlanAtOverlay.current = undefined;
            setLastError(`Edit could not be applied — ${rejection.reason}`);
          }).pipe(Effect.andThen(runtime.outbox.acknowledgeRejection(rejection.commandId)));
        }),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [runtime]);

  const send = useCallback(
    (operation: PlanOperation, next: PlanSnapshot) => {
      currentPlan.current = next;
      serverPlanAtOverlay.current ??= serverPlan;
      setOptimistic(next);
      // `settled` rather than `then` so one failed enqueue does not strand
      // every later one behind a permanently-rejected chain.
      const settled = queue.current.then(
        () => enqueuePlanEdit(runtime, operation),
        () => enqueuePlanEdit(runtime, operation),
      );
      queue.current = settled;
      void settled.catch((cause: unknown) => {
        // There is no rollback here any more, and its absence is the point.
        // The operation already passed the same validator the server runs, so
        // the edit on screen is legal; reaching this branch means the *local
        // durable write* failed (storage evicted, quota, a broken IndexedDB),
        // not that the edit was refused. Undoing the user's work because the
        // browser's storage misbehaved would destroy the very thing we failed
        // to protect. Keep it on screen, say that it is not saved.
        setLastError(describeFailure(cause));
      });
    },
    [runtime, serverPlan],
  );

  const apply = useCallback(
    (operation: PlanOperation): boolean => {
      const before = currentPlan.current;
      const result = PlanRuntime.applyPlanOperation(before, operation, currentContext.current);
      if (!result.ok) {
        setLastError(result.reason);
        return false;
      }
      const inverse = PlanRuntime.invertPlanOperation(before, operation);
      setChanges((current) => [
        {
          id: current.length + 1,
          origin: "user-direct",
          summary: result.summary,
          at: "just now",
          inverse,
        },
        ...current,
      ]);
      setLastError(undefined);
      send(operation, result.plan);
      return true;
    },
    [send],
  );

  const undoLast = useCallback(() => {
    // Strictly the most recent Change, never "the most recent *undoable* one"
    // (story 28: "undo my last edit"). Skipping past a `deleteSession` to
    // reverse something older would undo an edit the user was not looking at
    // — worse than refusing, because it is silent.
    const last = changes[0];
    if (last === undefined) return;
    const inverse = last.inverse;
    if (inverse === undefined) return;
    const result = PlanRuntime.applyPlanOperation(currentPlan.current, inverse, currentContext.current);
    if (!result.ok) {
      setLastError(result.reason);
      return;
    }
    // The undone Change leaves the ledger rather than gaining an "undone"
    // marker: the ledger answers "what did my edits do to the Plan", and an
    // edit that has been reversed did nothing. The server-side history is a
    // separate, append-only record and keeps both.
    setChanges((current) => current.filter((change) => change.id !== last.id));
    setLastError(undefined);
    send(inverse, result.plan);
  }, [changes, send]);

  return {
    plan,
    changes,
    apply,
    registerExercise,
    undoLast,
    canUndo: changes[0]?.inverse !== undefined,
    lastError,
    dismissError: useCallback(() => setLastError(undefined), []),
  };
}

/**
 * How many Plan edits are still queued — the signal that tells the editor
 * whether the server has caught up with this device.
 *
 * Counts only `applyPlanEdit` commands. A queued logged Set says nothing about
 * whether the Plan has been delivered, and counting it would pin the optimistic
 * overlay open for the whole of an offline workout.
 */
function usePendingPlanEditCount(outbox: Outbox.OutboxManager): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const fiber = Effect.runFork(
      SubscriptionRef.changes(outbox.queued).pipe(
        Stream.runForEach((items) =>
          Effect.sync(() => setCount(items.filter(Outbox.isQueuedPlanEdit).length)),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [outbox]);

  return count;
}
