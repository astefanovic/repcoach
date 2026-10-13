import { useCallback, useEffect, useMemo, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { Outbox } from "@repcoach/client-runtime";
import {
  foldNetActuals,
  RPC_METHODS,
  type ActualMetricMap,
  type EntryId,
  type ExerciseId,
  type LoggedSession,
  type LoggedSessionId,
  type PrescribedSession,
  type SessionId,
  type SetId,
  type SetType,
} from "@repcoach/contracts";

import { callRpc, describeFailure } from "./rpc.ts";
import { useRuntime, type RepCoachRuntime } from "./RuntimeProvider.tsx";
import { useRpcSessionEpoch } from "./useRpcSessionEpoch.ts";

/**
 * A Logged Session as the Logging surface needs it (#72 user stories 6, 12,
 * 13).
 *
 * Three sources are merged here so no component has to know there were
 * three:
 *
 * 1. **the server's Logged Session** — the frozen prescription it was
 *    instantiated from, plus every actual already applied;
 * 2. **the prescription cache** — the same frozen prescription, durably, for
 *    the reload that happens in a dead spot (ADR 0009 gate 3);
 * 3. **the outbox** — actuals captured on this device that the server has
 *    not acked yet.
 *
 * A set that is *pending* is still a logged set to the user (story 13: it is
 * queued, not lost), so it renders logged; the strip is what says how much
 * is in flight. The outbox wins over the server for the same `setId`,
 * because it is by definition the more recent capture.
 *
 * There is a fourth, local source, and it exists because of a gap between
 * the other three: a set confirmed while **connected** leaves the outbox as
 * soon as the flusher acks it — seconds later, or immediately — and the
 * server copy this hook read at mount does not know about it. Without
 * `recordLocal` the row would tick, then silently untick. Local entries are
 * the weakest source and are overwritten by any later server read.
 */
export interface LoggedSetActual {
  readonly actual: ActualMetricMap;
  /** Which Entry this actual belongs to — needed to bucket an unplanned Set (#115, ADR 0017), which has no prescribed node to look this up on, back to its Entry. */
  readonly entryId: EntryId;
  /** What kind of Set this was confirmed as — needed to reconstruct an unplanned continuation (#129 item 2) with its recorded type, not always as a straight set, the exact same omission ADR 0017 found and fixed for `entryId`. */
  readonly setType: SetType;
  /** Captured here, not yet acked by the server. */
  readonly pending: boolean;
  /** Server-assigned, so ordering multiple unplanned Sets in the same Entry survives a reload. Absent for a local/queued actual not yet acked. */
  readonly appliedAt: string | undefined;
}

/**
 * A recorded swap (#131, ADR 0019), as the Logging surface needs it — the
 * merged view over the same three sources `actuals` above merges: the
 * server's `getLoggedSession.swaps`, a local optimistic record, and the
 * outbox's still-queued swap commands.
 */
export interface EntrySwap {
  readonly exerciseId: ExerciseId;
  /** Queued but not yet acked by the server — still shown, per the same "pending is still real" rule `actuals` follows. */
  readonly pending: boolean;
}

export interface LoggedSessionModel {
  readonly loggedSessionId: LoggedSessionId;
  readonly prescribedSessionId: SessionId;
  /** The frozen prescribed tree the workout is being logged against. */
  readonly session: PrescribedSession;
  readonly startedAt: string | undefined;
  /** `false` once the workout has been finished — a reopened past session (story 22). */
  readonly active: boolean;
  readonly actuals: ReadonlyMap<SetId, LoggedSetActual>;
  /** Entry-anchored notes (issue #130), keyed by their own id — the `note` sheet item. */
  readonly notes: ReadonlyMap<string, EntryNote>;
  /** One swap per swapped Entry, keyed by `entryId` (ADR 0019) — absent means the Entry is still prescribed-as-logged. */
  readonly swaps: ReadonlyMap<EntryId, EntrySwap>;
  /** True when the prescription came from the durable cache rather than the server. */
  readonly offline: boolean;
}

/** One "Add a note" (issue #130). Not a Set — no `setId`/`setType`, keyed by note id instead. */
export interface EntryNote {
  readonly id: string;
  readonly entryId: EntryId;
  readonly text: string;
  readonly recordedAt: string;
  /** Captured here, not yet acked by the server — same meaning as `LoggedSetActual.pending`. */
  readonly pending: boolean;
}

interface LocalActual {
  readonly actual: ActualMetricMap;
  readonly entryId: EntryId;
  readonly setType: SetType;
}

/**
 * Net state (#83, ADR 0019): folds the server's ordered `actuals` stream —
 * logs and retractions interleaved — down to "what is still logged". The
 * last entry per `setId` wins; a retraction in that position drops the Set
 * from the result. `log -> un-log -> log` and `log -> log -> un-log` differ
 * only by this fold. The fold itself is `foldNetActuals` in
 * `@repcoach/contracts` — the single definition the server's swap guard shares
 * — and this is the thin web-client projection of it onto the surface's shape.
 */
export function foldServerActuals(actuals: LoggedSession["actuals"]): ReadonlyMap<
  SetId,
  { readonly actual: ActualMetricMap; readonly entryId: EntryId; readonly setType: SetType; readonly appliedAt: string }
> {
  const result = new Map<
    SetId,
    { readonly actual: ActualMetricMap; readonly entryId: EntryId; readonly setType: SetType; readonly appliedAt: string }
  >();
  for (const [setId, entry] of foldNetActuals(actuals)) {
    // Every survivor of the fold is a log, never a retraction — narrow so the
    // log-only fields below are reachable.
    if (entry.retraction) continue;
    result.set(setId, {
      actual: entry.actual,
      entryId: entry.entryId,
      setType: entry.setType,
      appliedAt: entry.appliedAt,
    });
  }
  return result;
}

/** The server's copy of a Logged Session, folded into the shape the hook merges over. */
interface ServerCopy {
  readonly status: "ready";
  readonly session: PrescribedSession;
  readonly prescribedSessionId: SessionId;
  readonly startedAt: string | undefined;
  readonly active: boolean;
  readonly serverActuals: ReadonlyMap<
    SetId,
    {
      readonly actual: ActualMetricMap;
      readonly entryId: EntryId;
      readonly setType: SetType;
      readonly appliedAt: string;
    }
  >;
  readonly serverNotes: ReadonlyMap<string, EntryNote>;
  readonly serverSwaps: ReadonlyMap<EntryId, ExerciseId>;
  readonly offline: boolean;
}

async function readServerCopy(
  runtime: RepCoachRuntime,
  loggedSessionId: LoggedSessionId,
): Promise<ServerCopy> {
  const logged = await callRpc(runtime, RPC_METHODS.getLoggedSession, { loggedSessionId });
  return {
    status: "ready",
    session: logged.session,
    prescribedSessionId: logged.prescribedSessionId,
    startedAt: logged.startedAt,
    active: logged.status === "active",
    serverActuals: foldServerActuals(logged.actuals),
    serverNotes: new Map(
      logged.notes
        .filter((note) => note.entryId !== undefined)
        .map((note) => [
          note.id,
          {
            id: note.id,
            entryId: note.entryId as EntryId,
            text: note.text,
            recordedAt: note.recordedAt,
            pending: false,
          },
        ]),
    ),
    // `swaps` is already ordered by `swappedAt` (server) — building the Map
    // by iterating it in order means a later swap of the same Entry
    // naturally wins, with no extra sort needed here.
    serverSwaps: new Map(logged.swaps.map((swap) => [swap.entryId, swap.exerciseId])),
    offline: false,
  };
}

export type LoggedSessionState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly model: LoggedSessionModel }
  | { readonly status: "failed"; readonly reason: string };

export function useLoggedSession(loggedSessionId: LoggedSessionId): {
  readonly state: LoggedSessionState;
  /** Re-reads the server copy — what a manual retry calls. */
  readonly refresh: () => void;
  /** Records a set the user just confirmed, so the row stays ticked after the outbox drains. */
  readonly recordLocal: (setId: SetId, entryId: EntryId, actual: ActualMetricMap, setType: SetType) => void;
  /** Records a set the user just un-logged (#83, ADR 0019) — the retraction-side twin of `recordLocal`, so the row un-ticks immediately rather than waiting on the outbox drain. */
  readonly recordLocalUnlog: (setId: SetId) => void;
  /** Records a note the user just added (issue #130) — the note-side twin of `recordLocal`. */
  readonly recordLocalNote: (note: EntryNote) => void;
  /** Records a note the user just rewrote (UAT) — the edit-side twin of `recordLocalNote`, keyed by the note's own id. */
  readonly recordLocalNoteEdit: (noteId: string, text: string) => void;
  /** Records a swap the user just made (#131), so the Entry renders swapped before the outbox drains. */
  readonly recordLocalSwap: (entryId: EntryId, exerciseId: ExerciseId) => void;
  /** Drops the optimistic swap echo for an Entry (#148) — what a rejected `swapEntryExercise` calls so the swap the server refused stops showing on screen. */
  readonly forgetLocalSwap: (entryId: EntryId) => void;
} {
  const runtime = useRuntime();
  const [attempt, setAttempt] = useState(0);
  const [local, setLocal] = useState<ReadonlyMap<SetId, LocalActual>>(() => new Map());
  /** Optimistic retraction echoes (#83) — mutually exclusive with `local` per `setId`; whichever call happened most recently clears the other side. */
  const [localRetractions, setLocalRetractions] = useState<ReadonlySet<SetId>>(() => new Set());
  const [localNotes, setLocalNotes] = useState<ReadonlyMap<string, EntryNote>>(() => new Map());
  /** Optimistic note-rewrite echoes (UAT), keyed by the edited note's id — text only, since an edit changes nothing else about the note. */
  const [localNoteEdits, setLocalNoteEdits] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [localSwaps, setLocalSwaps] = useState<ReadonlyMap<EntryId, ExerciseId>>(() => new Map());
  const [loaded, setLoaded] = useState<
    | { readonly status: "loading" }
    | ServerCopy
    | { readonly status: "failed"; readonly reason: string }
  >({ status: "loading" });

  useEffect(() => {
    let disposed = false;
    setLoaded({ status: "loading" });
    // A re-read is authoritative over anything captured locally before it.
    setLocal(new Map());
    setLocalRetractions(new Set());
    setLocalNotes(new Map());
    setLocalNoteEdits(new Map());
    setLocalSwaps(new Map());

    void (async () => {
      try {
        const server = await readServerCopy(runtime, loggedSessionId);
        if (disposed) return;
        setLoaded(server);
      } catch (cause) {
        if (disposed) return;
        // Offline resume (story 13 + ADR 0009 gate 3): the prescription the
        // workout was started against is the one thing that was durably
        // cached, and everything logged since is in the outbox. That is a
        // complete surface — so this is a fallback, not a degradation.
        const cached = await Effect.runPromise(
          SubscriptionRef.get(runtime.prescriptions.current),
        ).catch(() => Option.none());
        if (disposed) return;
        if (Option.isSome(cached)) {
          const entry = cached.value;
          setLoaded({
            status: "ready",
            session: entry.session,
            prescribedSessionId: entry.sessionId,
            startedAt: undefined,
            active: true,
            serverActuals: new Map(),
            serverNotes: new Map(),
            serverSwaps: new Map(),
            offline: true,
          });
          return;
        }
        setLoaded({ status: "failed", reason: describeFailure(cause) });
      }
    })();

    return () => {
      disposed = true;
    };
  }, [runtime, loggedSessionId, attempt]);

  // The offline copy is a fallback for a read that could not reach the
  // server, and nothing used to replace it once the server came back. That
  // was the "workout comes back empty" bug: a phone that discards a
  // backgrounded tab reloads the page on return, the surface mounts before
  // the socket has connected, `getLoggedSession` fails at once, and the
  // cached prescription renders with none of the Sets the server already
  // acked — they are no longer in the outbox, so nothing marks them logged.
  // Leaving for Today and resuming re-mounted the surface into a live
  // session, which is why that was the only way out.
  //
  // So an offline copy (or a failed open) re-reads every time the session
  // comes up. Quietly: it keeps the copy on screen until the server's
  // answers, rather than dropping back to "Opening the session" and
  // unmounting the surface's own state, and it keeps the local echoes. A Set
  // confirmed against the offline copy may not have been flushed yet when
  // this read lands, and its echo is what keeps it ticked until it is.
  const sessionEpoch = useRpcSessionEpoch(runtime);
  const needsServerCopy =
    loaded.status === "failed" || (loaded.status === "ready" && loaded.offline);
  useEffect(() => {
    if (!needsServerCopy || sessionEpoch === 0) return;
    let disposed = false;
    void readServerCopy(runtime, loggedSessionId).then(
      (server) => {
        if (!disposed) setLoaded(server);
      },
      // Still unreachable: what is on screen stays, and the next connect retries.
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [needsServerCopy, sessionEpoch, runtime, loggedSessionId]);

  const queued = useOutboxItems(runtime.outbox, loggedSessionId);
  const queuedUnlogs = useOutboxUnlogItems(runtime.outbox, loggedSessionId);
  const queuedNotes = useOutboxNoteItems(runtime.outbox, loggedSessionId);
  const queuedSwaps = useOutboxSwapItems(runtime.outbox, loggedSessionId);
  const queuedNoteEdits = useOutboxNoteEditItems(runtime.outbox, loggedSessionId);

  const state = useMemo<LoggedSessionState>(() => {
    if (loaded.status !== "ready") return loaded;
    const actuals = new Map<SetId, LoggedSetActual>();
    for (const [setId, entry] of loaded.serverActuals) {
      actuals.set(setId, {
        actual: entry.actual,
        entryId: entry.entryId,
        setType: entry.setType,
        pending: false,
        appliedAt: entry.appliedAt,
      });
    }
    for (const [setId, entry] of local) {
      actuals.set(setId, {
        actual: entry.actual,
        entryId: entry.entryId,
        setType: entry.setType,
        pending: false,
        appliedAt: undefined,
      });
    }
    // A local retraction echo (#83) drops the row immediately — the same
    // "un-tick without waiting on the outbox" story `local` above tells for
    // a fresh log, mirrored for its reverse.
    for (const setId of localRetractions) {
      actuals.delete(setId);
    }
    // Last, so a set still in the queue is marked pending even though the
    // local record already made it render as logged — and a log/unlog racing
    // in the SAME queue is applied in `seq` order (the outbox's own
    // enqueue-order key) rather than "all logs then all unlogs", so a rapid
    // log -> un-log -> log (or the reverse) ends on the right side.
    const queuedOps = [
      ...queued.map((item) => ({ seq: item.seq, op: "log" as const, item })),
      ...queuedUnlogs.map((item) => ({ seq: item.seq, op: "unlog" as const, item })),
    ].sort((a, b) => a.seq - b.seq);
    for (const opEntry of queuedOps) {
      if (opEntry.op === "unlog") {
        actuals.delete(opEntry.item.setId);
        continue;
      }
      actuals.set(opEntry.item.setId, {
        actual: opEntry.item.actual,
        entryId: opEntry.item.entryId,
        setType: opEntry.item.setType,
        pending: true,
        appliedAt: undefined,
      });
    }

    const notes = new Map<string, EntryNote>();
    for (const [id, note] of loaded.serverNotes) notes.set(id, note);
    for (const [id, note] of localNotes) notes.set(id, note);
    // Last, same reasoning as `actuals`: a note still queued renders as
    // pending even though `localNotes` already shows it.
    for (const item of queuedNotes) {
      notes.set(item.commandId, {
        id: item.commandId,
        entryId: item.entryId,
        text: item.text,
        recordedAt: item.recordedAt,
        pending: true,
      });
    }

    // Rewrites land last, on top of whichever source produced the note: a
    // rewrite is by definition newer than the text the server has, and newer
    // than the local echo of the add it follows. The queue goes after the
    // local echo for the same reason it does for `actuals` — it is what
    // knows the write is still owed — and its `seq` order is the queue's, so
    // the last rewrite of a note wins even when several are outstanding. A
    // rewrite whose note is not here at all is dropped rather than
    // materialised: a note that existed only as a rewrite would be one the
    // coach never gets the anchor for.
    for (const [id, note] of localNoteEdits) {
      const existing = notes.get(id);
      if (existing === undefined) continue;
      notes.set(id, { ...existing, text: note });
    }
    for (const item of queuedNoteEdits) {
      const existing = notes.get(item.noteId);
      if (existing === undefined) continue;
      notes.set(item.noteId, { ...existing, text: item.text, pending: true });
    }

    // Same three-source merge as `actuals` above, at Entry granularity
    // instead of Set granularity (ADR 0019: a swap is offered only before
    // any Set is logged, so at most one swap ever exists per Entry).
    const swaps = new Map<EntryId, EntrySwap>();
    for (const [entryId, exerciseId] of loaded.serverSwaps) {
      swaps.set(entryId, { exerciseId, pending: false });
    }
    for (const [entryId, exerciseId] of localSwaps) {
      swaps.set(entryId, { exerciseId, pending: false });
    }
    for (const item of queuedSwaps) {
      swaps.set(item.entryId, { exerciseId: item.exerciseId, pending: true });
    }


    return {
      status: "ready",
      model: {
        loggedSessionId,
        prescribedSessionId: loaded.prescribedSessionId,
        session: loaded.session,
        startedAt: loaded.startedAt,
        active: loaded.active,
        actuals,
        notes,
        swaps,
        offline: loaded.offline,
      },
    };
  }, [
    loaded,
    local,
    localRetractions,
    localNotes,
    localNoteEdits,
    localSwaps,
    queued,
    queuedUnlogs,
    queuedNotes,
    queuedNoteEdits,
    queuedSwaps,
    loggedSessionId,
  ]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  const recordLocal = useCallback((setId: SetId, entryId: EntryId, actual: ActualMetricMap, setType: SetType) => {
    setLocal((current) => new Map(current).set(setId, { actual, entryId, setType }));
    // A fresh log supersedes any earlier local retraction echo for this Set.
    setLocalRetractions((current) => {
      if (!current.has(setId)) return current;
      const next = new Set(current);
      next.delete(setId);
      return next;
    });
  }, []);

  const recordLocalUnlog = useCallback((setId: SetId) => {
    setLocalRetractions((current) => new Set(current).add(setId));
    // The retraction supersedes any earlier local log echo for this Set.
    setLocal((current) => {
      if (!current.has(setId)) return current;
      const next = new Map(current);
      next.delete(setId);
      return next;
    });
  }, []);

  const recordLocalNote = useCallback(
    (note: EntryNote) => setLocalNotes((current) => new Map(current).set(note.id, note)),
    [],
  );

  const recordLocalNoteEdit = useCallback(
    (noteId: string, text: string) =>
      setLocalNoteEdits((current) => new Map(current).set(noteId, text)),
    [],
  );

  const recordLocalSwap = useCallback(
    (entryId: EntryId, exerciseId: ExerciseId) =>
      setLocalSwaps((current) => new Map(current).set(entryId, exerciseId)),
    [],
  );

  const forgetLocalSwap = useCallback((entryId: EntryId) => {
    setLocalSwaps((current) => {
      if (!current.has(entryId)) return current;
      const next = new Map(current);
      next.delete(entryId);
      return next;
    });
  }, []);

  return {
    state,
    refresh,
    recordLocal,
    recordLocalUnlog,
    recordLocalNote,
    recordLocalNoteEdit,
    recordLocalSwap,
    forgetLocalSwap,
  };
}

/**
 * The outbox's queued **logged Sets** for one Logged Session, subscribed
 * rather than polled.
 *
 * Since #80 the queue also carries Plan edits, so the `kind` narrowing is not
 * cosmetic: without it a queued Plan edit — which has no `loggedSessionId` at
 * all — would be considered for a Set row it has nothing to do with.
 */
function useOutboxItems(
  outbox: Outbox.OutboxManager,
  loggedSessionId: LoggedSessionId,
): ReadonlyArray<Outbox.QueuedSetActual> {
  const [items, setItems] = useState<ReadonlyArray<Outbox.QueuedSetActual>>([]);

  useEffect(() => {
    const fiber = Effect.runFork(
      SubscriptionRef.changes(outbox.queued).pipe(
        Stream.runForEach((all) =>
          Effect.sync(() =>
            setItems(
              all.filter(
                (item): item is Outbox.QueuedSetActual =>
                  Outbox.isQueuedSetActual(item) && item.loggedSessionId === loggedSessionId,
              ),
            ),
          ),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [outbox, loggedSessionId]);

  return items;
}

/**
 * The outbox's queued **retractions** (#83, ADR 0019) for one Logged
 * Session — the un-log twin of `useOutboxItems` above, same `kind` narrowing
 * reasoning.
 */
function useOutboxUnlogItems(
  outbox: Outbox.OutboxManager,
  loggedSessionId: LoggedSessionId,
): ReadonlyArray<Outbox.QueuedUnlogSetActual> {
  const [items, setItems] = useState<ReadonlyArray<Outbox.QueuedUnlogSetActual>>([]);

  useEffect(() => {
    const fiber = Effect.runFork(
      SubscriptionRef.changes(outbox.queued).pipe(
        Stream.runForEach((all) =>
          Effect.sync(() =>
            setItems(
              all.filter(
                (item): item is Outbox.QueuedUnlogSetActual =>
                  Outbox.isQueuedUnlogSetActual(item) && item.loggedSessionId === loggedSessionId,
              ),
            ),
          ),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [outbox, loggedSessionId]);

  return items;
}

/**
 * The outbox's queued **notes** (issue #130) for one Logged Session — the
 * note-side twin of `useOutboxItems` above, same reasoning: `kind` narrowing
 * matters because a queued `logSetActual`/`applyPlanEdit` has no `entryId`
 * meaningful to a note row.
 */
function useOutboxNoteItems(
  outbox: Outbox.OutboxManager,
  loggedSessionId: LoggedSessionId,
): ReadonlyArray<Outbox.QueuedAddEntryNote> {
  const [items, setItems] = useState<ReadonlyArray<Outbox.QueuedAddEntryNote>>([]);

  useEffect(() => {
    const fiber = Effect.runFork(
      SubscriptionRef.changes(outbox.queued).pipe(
        Stream.runForEach((all) =>
          Effect.sync(() =>
            setItems(
              all.filter(
                (item): item is Outbox.QueuedAddEntryNote =>
                  Outbox.isQueuedAddEntryNote(item) && item.loggedSessionId === loggedSessionId,
              ),
            ),
          ),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [outbox, loggedSessionId]);

  return items;
}

/** The outbox's queued **note rewrites** (UAT) — the edit-side sibling of `useOutboxNoteItems` above. */
function useOutboxNoteEditItems(
  outbox: Outbox.OutboxManager,
  loggedSessionId: LoggedSessionId,
): ReadonlyArray<Outbox.QueuedEditEntryNote> {
  const [items, setItems] = useState<ReadonlyArray<Outbox.QueuedEditEntryNote>>([]);

  useEffect(() => {
    const fiber = Effect.runFork(
      SubscriptionRef.changes(outbox.queued).pipe(
        Stream.runForEach((all) =>
          Effect.sync(() =>
            setItems(
              all.filter(
                (item): item is Outbox.QueuedEditEntryNote =>
                  Outbox.isQueuedEditEntryNote(item) && item.loggedSessionId === loggedSessionId,
              ),
            ),
          ),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [outbox, loggedSessionId]);

  return items;
}

/** The outbox's queued **swaps** (#131) for one Logged Session — the sibling of `useOutboxItems` above. */
function useOutboxSwapItems(
  outbox: Outbox.OutboxManager,
  loggedSessionId: LoggedSessionId,
): ReadonlyArray<Outbox.QueuedSwapExercise> {
  const [items, setItems] = useState<ReadonlyArray<Outbox.QueuedSwapExercise>>([]);

  useEffect(() => {
    const fiber = Effect.runFork(
      SubscriptionRef.changes(outbox.queued).pipe(
        Stream.runForEach((all) =>
          Effect.sync(() =>
            setItems(
              all.filter(
                (item): item is Outbox.QueuedSwapExercise =>
                  Outbox.isQueuedSwapExercise(item) && item.loggedSessionId === loggedSessionId,
              ),
            ),
          ),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [outbox, loggedSessionId]);

  return items;
}
