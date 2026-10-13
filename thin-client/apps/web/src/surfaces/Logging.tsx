// The Logging surface (#72), on the real runtime.
//
// The presentation is the reference build's, unchanged — the design is settled
// in `docs/design/ui-surfaces.md` and #72 is explicitly not a redesign. What
// changed is everything underneath: every derivation this file used to do by
// hand now comes from `@repcoach/client-runtime`, and confirming a set writes
// to the outbox instead of to `useState`.
//
//   hand-listed metrics per exercise  ->  Logging.deriveSetFields
//   fmtTarget                         ->  Logging.formatGhostText
//   resolve (range to top)            ->  Logging.resolveGhostActual
//   block visibility branch           ->  Logging.isBlockWrapperVisible
//   drop-set indentation branch       ->  Logging.groupSetsWithContinuations
//   per-metric deviation by hand      ->  Logging.metricDeviation
//   the rest countdown by hand        ->  Timer.*
//   logSet writing useState           ->  commands.confirmSet + the outbox
//
// The presentation decisions the prototype recorded still hold and are still
// the reason the markup looks the way it does:
//
// 1. THE REST TIMER IS A PILL AT THE BOTTOM, not a band under the strip — two
//    coloured single-line bands 24px apart carrying unrelated meanings (system
//    state vs workout state) is what #42 already deleted from Today.
// 2. THE SET ROW IS A MAP OVER THE CATALOG'S METRICS. There is no reps/load
//    pair in this file. A plank renders duration; a carry renders load and
//    distance. `deriveSetFields` is what makes that true rather than a
//    convention this file is trusted to keep.
// 3. DEVIATION IS TYPED BY TAPPING THE NUMBER. The ghost prescription is
//    itself the input: one tap on ✓ commits the row as prescribed, one tap on
//    a value opens a stepper AND a keypad over that field only (#113 item 3 —
//    ±1 rep wants a stepper, 20kg to 60kg wants digits). No edit mode.
// 4. BLOCKS ARE A LEFT RULE AND A LABEL. In a card-less language a wrapper
//    cannot be a container, so it is a margin mark.
// 5. SPECIAL SET TYPES SIT BEHIND ONE PER-ENTRY AFFORDANCE, so the straight-set
//    case stays uncluttered.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { Logging as Grid, Plan as PlanRuntime, Stats, Timer, Units } from "@repcoach/client-runtime";
import type {
  ActualMetricMap,
  BlockId,
  CatalogExercise,
  EntryId,
  ExerciseId,
  MetricName,
  PlanOperation,
  PlanSnapshot,
  PrescribedBlock,
  PrescribedEntry,
  PrescribedSet,
  SetId,
  SetType,
} from "@repcoach/contracts";

import {
  notifyRestCompletionInBrowser,
  requestNotificationPermissionIfNeeded,
  scheduleRestNotificationInWorker,
} from "../platform/restNotifier.ts";
import { useScreenWakeLock } from "../platform/wakeLock.ts";
import {
  addEntryNote,
  cancelSession,
  confirmSet,
  editEntryNote,
  enqueuePlanEdit,
  finishWorkout,
  swapExercise,
  unlogSet,
} from "../runtime/commands.ts";
import { makeEntryId, makeSetId } from "../runtime/ids.ts";
import { useLastExerciseActuals, type LastExerciseUse } from "../runtime/useLastExerciseActuals.ts";
import { useRestTimerNotifyPreference } from "../runtime/restNotifyPreference.ts";
import { describeFailure } from "../runtime/rpc.ts";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { usePlateSetup } from "../runtime/plateSetup.ts";
import { useWeightUnit } from "../runtime/weightUnit.ts";
import type { EntryNote, EntrySwap, LoggedSessionModel } from "../runtime/useLoggedSession.ts";
import { EQUIPMENT_GROUPS, useExerciseLibrary } from "../exerciseLibrary/library.ts";
import { ExerciseDemo, ExercisePicker } from "./ExercisePicker.tsx";
import type { CatalogAuthoring } from "./Plan.tsx";
import { exerciseName, metricUi, mmss, type StripState } from "../ui/chrome.ts";
import { Sheet, SheetItem } from "../ui/Sheet.tsx";
import { ModeShell } from "../ui/Shell.tsx";

/** `ExercisePicker`'s `taken` set has no meaning in a swap context — reused as a constant so it never allocates per render. */
const EMPTY_TAKEN: ReadonlySet<string> = new Set();

const allSets = (session: LoggedSessionModel["session"]): ReadonlyArray<PrescribedSet> =>
  session.blocks.flatMap((block) => block.entries.flatMap((entry) => entry.sets));

/**
 * The note the Entry's note item would rewrite: the most recent one.
 *
 * An Entry can still hold several — every note written before the item
 * started editing rather than appending is still on the record, and none of
 * them is deleted retroactively. "The latest" is the only answer that keeps
 * the item's meaning stable ("this is the note for this exercise") whichever
 * side of that change the notes were written on.
 */
export function editableNote(notes: ReadonlyArray<EntryNote>): EntryNote | undefined {
  return notes.length === 0 ? undefined : notes[notes.length - 1];
}

/**
 * Row labels for one Entry's Sets, keyed by Set id: warmups "W",
 * continuations "↳", working Sets numbered from 1.
 *
 * Shared rather than inlined in the row loop because the remove-a-set sheet
 * has to name a Set the way the user is looking at it — "drop 2" is not a
 * thing anyone can point at, "↳ under 2" is. Two independent numberings would
 * be a way to remove the wrong Set.
 */
export function setRowLabels(sets: ReadonlyArray<PrescribedSet>): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  let workingNumber = 0;
  for (const group of Grid.groupSetsWithContinuations(sets)) {
    for (const set of [group.anchor, ...group.continuations]) {
      labels.set(
        set.id,
        set.setType === "warmup"
          ? "W"
          : Grid.isContinuationSetType(set.setType)
            ? "↳"
            : String(++workingNumber),
      );
    }
  }
  return labels;
}

/**
 * Extends each Entry's `sets` with unplanned Sets (#115 item 1, ADR 0017) —
 * rows added this session via the sheet (`extraSets`, keyed by Entry, not yet
 * necessarily confirmed) plus rows reconstructed after a reload from actuals
 * whose `setId` names no prescribed Set. `EntrySection`/`SetRow` need no
 * changes beyond this: from their point of view, an unplanned Set is just
 * another `PrescribedSet` with a ghost prescription echoed from the Entry's
 * last working Set.
 */
export function withUnplannedSets(
  session: LoggedSessionModel["session"],
  extraSets: ReadonlyMap<EntryId, ReadonlyArray<PrescribedSet>>,
  actuals: LoggedSessionModel["actuals"],
): LoggedSessionModel["session"] {
  return {
    ...session,
    blocks: session.blocks.map((block) => ({
      ...block,
      entries: block.entries.map((entry) => {
        const local = extraSets.get(entry.id) ?? [];
        const known = new Set([...entry.sets, ...local].map((set) => set.id));
        const orphans = [...actuals]
          .filter(([setId, logged]) => logged.entryId === entry.id && !known.has(setId))
          // A still-queued orphan has no `appliedAt` yet — sort it after every
          // acked one rather than losing the order entirely.
          .sort(([, a], [, b]) => (a.appliedAt ?? "￿").localeCompare(b.appliedAt ?? "￿"))
          // Reconstructed with the recorded `setType` (#129 item 2), not
          // always as another straight set — a drop set logged and then
          // reloaded must come back as a drop, not silently downgrade.
          .map(([setId, logged]) => Grid.anotherSetOfType(logged.setType, entry.sets, setId));
        return local.length === 0 && orphans.length === 0
          ? entry
          : { ...entry, sets: [...entry.sets, ...local, ...orphans] };
      }),
    })),
  };
}

/** Rows an added exercise opens with. More come from the pencil's "Another straight set", as on any Entry. */
const ADDED_ENTRY_SETS = 3;

/**
 * Extends the session with the exercises added mid-workout (UAT), and says
 * which Entries those are.
 *
 * An added exercise needs no new contract: it is a client-minted Entry id
 * with a swap naming its exercise (ADR 0019's annotation, on an Entry the
 * frozen prescription never held) and Sets logged against it by value, like
 * any unplanned Set (ADR 0017). The coach's `logged_set_net` view already
 * reads such a Set as performed on the swap's exercise with no prescribed
 * one. So the Entry is rebuilt here from `swaps` on every render, after a
 * reload included, the same way `withUnplannedSets` rebuilds orphan Sets.
 *
 * Each sits in its own straight Block after the plan's, in the order it was
 * added, with the rest the session's last prescribed Set uses so the timer
 * still runs.
 */
export function withAddedEntries(
  session: LoggedSessionModel["session"],
  swaps: ReadonlyMap<EntryId, EntrySwap>,
  catalog: ReadonlyArray<CatalogExercise>,
): { readonly session: LoggedSessionModel["session"]; readonly added: ReadonlySet<EntryId> } {
  const prescribed = new Set(session.blocks.flatMap((block) => block.entries.map((entry) => entry.id)));
  const added = [...swaps].filter(([entryId]) => !prescribed.has(entryId));
  if (added.length === 0) return { session, added: new Set() };
  const restSec = [...allSets(session)].reverse().find((set) => set.restSec !== undefined)?.restSec;
  return {
    session: {
      ...session,
      blocks: [
        ...session.blocks,
        ...added.map(([entryId, swap]): PrescribedBlock => ({
          id: `${entryId}:block` as BlockId,
          format: "straight",
          entries: [
            Grid.addedEntry({
              entryId,
              exerciseId: swap.exerciseId,
              trackedMetrics: catalog.find((row) => row.id === swap.exerciseId)?.trackedMetrics ?? [],
              setCount: ADDED_ENTRY_SETS,
              restSec,
            }),
          ],
        })),
      ],
    },
    added: new Set(added.map(([entryId]) => entryId)),
  };
}

/** A swap from this workout that could become the Plan's prescription. */
export interface PlanSwapCandidate {
  readonly entryId: EntryId;
  readonly fromExerciseId: ExerciseId;
  readonly toExerciseId: ExerciseId;
}

/**
 * The swaps worth offering as a Plan edit once the workout is finished.
 *
 * Only an Entry the Plan still prescribes exactly as this workout froze it:
 * if the Plan has moved since (the Entry removed, or already pointed at
 * something else, perhaps by an earlier answer to this same prompt), offering
 * the swap would overwrite an edit the user made after starting. An exercise
 * added mid-workout has no prescribed Entry in the Plan to replace, so it is
 * not offered either.
 */
export function planSwapCandidates(
  session: LoggedSessionModel["session"],
  swaps: ReadonlyMap<EntryId, EntrySwap>,
  plan: PlanSnapshot | undefined,
): ReadonlyArray<PlanSwapCandidate> {
  if (plan === undefined) return [];
  const planExercise = new Map(
    plan.sessions.flatMap((s) => s.blocks.flatMap((block) => block.entries.map((e) => [e.id, e.exerciseId] as const))),
  );
  return session.blocks.flatMap((block) =>
    block.entries.flatMap((entry): ReadonlyArray<PlanSwapCandidate> => {
      const swap = swaps.get(entry.id);
      if (swap === undefined || swap.exerciseId === entry.exerciseId) return [];
      if (planExercise.get(entry.id) !== entry.exerciseId) return [];
      return [{ entryId: entry.id, fromExerciseId: entry.exerciseId, toExerciseId: swap.exerciseId }];
    }),
  );
}

/* ============================================================ the surface === */

export function Logging({
  model,
  catalog,
  authoring,
  strip,
  onRecord,
  onUnlogged: onUnloggedFromModel,
  onRecordNote,
  onRecordNoteEdit,
  onSwapped,
  onSwapRejected,
  onExit,
  onFinished,
  onCancelled,
  plan,
}: {
  readonly model: LoggedSessionModel;
  /** The Exercise catalog, for display names. Empty until it loads — see `exerciseName`. */
  readonly catalog: ReadonlyArray<CatalogExercise>;
  /** The catalog's write side (#131, ADR 0019) — the same `CatalogAuthoring` the Plan editor's picker uses, reused unchanged. */
  readonly authoring: CatalogAuthoring;
  readonly strip: StripState;
  /** Told about every confirmed set, so the row survives the outbox draining. */
  readonly onRecord: (setId: SetId, entryId: EntryId, actual: ActualMetricMap, setType: SetType) => void;
  /** Told about every un-logged set (#83, ADR 0019), the retraction-side twin of `onRecord`. */
  readonly onUnlogged: (setId: SetId) => void;
  /** Told about every note added (issue #130), the note-side twin of `onRecord`. */
  readonly onRecordNote: (note: EntryNote) => void;
  /** Told about every note rewritten (UAT), the edit-side twin of `onRecordNote`. */
  readonly onRecordNoteEdit: (noteId: string, text: string) => void;
  /** Told about every swap the moment it's queued (#131), so the Entry renders swapped before the outbox drains. */
  readonly onSwapped: (entryId: EntryId, exerciseId: ExerciseId) => void;
  /** Told when the server *refused* a queued swap (#148) — the optimistic swap echo for the Entry must be dropped so a swap the server never took stops showing. */
  readonly onSwapRejected: (entryId: EntryId) => void;
  readonly onExit: () => void;
  readonly onFinished: () => void;
  /** Cancel (issue #114 Part 1) — unmakes an accidentally-started session. */
  readonly onCancelled: () => void;
  /** The Plan as it stands, for the after-finish "swap this in the plan?" prompt. `undefined` until it loads, and then nothing is offered. */
  readonly plan: PlanSnapshot | undefined;
}) {
  const runtime = useRuntime();
  /**
   * Backfill is "this session is no longer active" (story 22: a past session
   * reopens in the same surface). Everything that pretends the user is
   * mid-workout keys off this — chiefly the rest timer, which story 23 says
   * must not run.
   */
  const live = model.active;
  // The screen stays on while the workout is live, and only then — an unlock
  // per ✓ is the tap one-tap exists to save. See `useScreenWakeLock`.
  useScreenWakeLock(live);

  // `now` is the instant the state was last read at, carried alongside it so
  // the pill's digits and the pill's status are derived from the SAME instant
  // — a readout that called `Date.now()` for itself could disagree with the
  // status by a tick boundary and render `0:00` on a timer already overrun.
  const [rest, setRest] = useState<{
    readonly state: Timer.RestTimerState;
    /**
     * The Entry whose Set raised this pill — kept, not its name, so the title
     * is read through `displayName` at render and follows a swap (UAT) made
     * before or during the rest.
     */
    readonly entry: PrescribedEntry;
    readonly now: number;
    /** Which Set raised this pill (#83, ADR 0019) — un-logging THIS Set is what dismisses it. */
    readonly setId: SetId;
  } | null>(null);
  const [sheetFor, setSheetFor] = useState<PrescribedEntry | null>(null);
  const [noteFor, setNoteFor] = useState<PrescribedEntry | null>(null);
  /** The Entry whose added-this-session Sets are being pruned (UAT) — the removal-side twin of the specials that add them. */
  const [removeFor, setRemoveFor] = useState<PrescribedEntry | null>(null);
  const [noteSaving, setNoteSaving] = useState<"idle" | "running" | { readonly error: string }>(
    "idle",
  );
  /** The Entry currently picking its swapped-to Exercise (#131) — the ExercisePicker sheet, opened from `SpecialSetSheet`. */
  const [swapFor, setSwapFor] = useState<PrescribedEntry | null>(null);
  const [swapping, setSwapping] = useState<"idle" | "running" | { readonly error: string }>("idle");
  /** The "Add exercise" picker (UAT) — the same ExercisePicker a swap opens, wired to add instead. */
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState<"idle" | "running" | { readonly error: string }>("idle");
  /** Swaps offered as Plan edits once the workout is finished; `null` until then, or when there were none. */
  const [planSwaps, setPlanSwaps] = useState<ReadonlyArray<PlanSwapCandidate> | null>(null);
  const [planSwapStatus, setPlanSwapStatus] = useState<
    ReadonlyMap<EntryId, "running" | "done" | { readonly error: string }>
  >(() => new Map());
  const [finishing, setFinishing] = useState<"idle" | "running" | { readonly error: string }>(
    "idle",
  );
  const [cancelSheetOpen, setCancelSheetOpen] = useState(false);
  const [cancelling, setCancelling] = useState<"idle" | "running" | { readonly error: string }>(
    "idle",
  );
  /**
   * Unplanned Sets added this mount via the "+" sheet (#115 item 1), keyed by
   * Entry. Once confirmed they stay here too — this is what avoids ever
   * having to reconcile a local row against its own reconstruction from
   * `model.actuals`. Reset only by remounting (i.e. leaving and reopening the
   * surface), same as `rest`/`local` in `useLoggedSession`.
   */
  const [extraSets, setExtraSets] = useState<ReadonlyMap<EntryId, ReadonlyArray<PrescribedSet>>>(
    () => new Map(),
  );
  const addSpecialSet = (entry: PrescribedEntry, setType: SetType) => {
    const set = Grid.anotherSetOfType(setType, entry.sets, makeSetId());
    setExtraSets((current) => {
      const next = new Map(current);
      next.set(entry.id, [...(next.get(entry.id) ?? []), set]);
      return next;
    });
  };

  /**
   * The inverse of `addSpecialSet` (UAT): a drop set added by mistake had no
   * way off the Entry short of leaving the surface and coming back.
   *
   * Local only, and that is not a shortcut — it is the whole scope of what
   * "remove" can honestly mean here. A Set the user has *logged* is a
   * recorded fact and comes off through the retraction path (#83, ADR 0019),
   * not by deletion; a prescribed Set belongs to the Logged Session's frozen
   * copy, which the actual side never rewrites (ADR 0006/0007). What is left
   * is exactly this: a row added this session that nothing has been recorded
   * against yet, which has never existed anywhere but `extraSets`.
   *
   * An added Set that HAS been logged therefore takes two taps in the order
   * the user already knows — un-log it, then remove the empty row — and a
   * reload needs neither: an un-logged reconstruction is not in `extraSets`
   * at all and drops out of `withUnplannedSets` on its own.
   */
  const removeExtraSet = (entry: PrescribedEntry, setId: SetId) => {
    setExtraSets((current) => {
      const remaining = (current.get(entry.id) ?? []).filter((set) => set.id !== setId);
      const next = new Map(current);
      if (remaining.length === 0) next.delete(entry.id);
      else next.set(entry.id, remaining);
      return next;
    });
  };

  /** The Sets on an Entry `removeExtraSet` can actually take back — added this session, nothing recorded against them. */
  const removableSets = (entry: PrescribedEntry): ReadonlyArray<PrescribedSet> => {
    const added = new Set((extraSets.get(entry.id) ?? []).map((set) => set.id));
    return entry.sets.filter((set) => added.has(set.id) && !model.actuals.has(set.id as SetId));
  };

  /**
   * Swap (#131, ADR 0019): a pure actual-side annotation, through the
   * outbox exactly like `confirmSet`. `onSwapped` is called the moment the
   * command is enqueued — before any server ack — so the Entry renders
   * swapped immediately (same "optimistic, then reconciled" shape
   * `recordLocal` already gives confirmed Sets).
   */
  const swap = (entry: PrescribedEntry, exercise: CatalogExercise) => {
    setSwapping("running");
    void swapExercise(runtime, {
      loggedSessionId: model.loggedSessionId,
      entryId: entry.id as EntryId,
      exerciseId: exercise.id,
    }).then(
      (command) => {
        setSwapping("idle");
        onSwapped(command.entryId, command.exerciseId);
        setSwapFor(null);
      },
      (cause: unknown) => setSwapping({ error: describeFailure(cause) }),
    );
  };

  /**
   * A queued swap the server later **refused** (#148, `EntryAlreadyLoggedError`
   * — a `logSetActual` for the same Entry won the race the offline outbox
   * created). The synchronous `swap` path above only ever sees a transport
   * failure; a permanent refusal surfaces here, on `outbox.rejections`, the same
   * stream the Plan editor watches for its own refused edits.
   *
   * Without this the refusal was completely silent: the strip read
   * `synced · idle`, the optimistic swap stayed on screen, and it reverted only
   * on the next reload. So: drop the optimistic echo (`onSwapRejected`) and say
   * so, reusing the same "could not swap" line the synchronous failure uses.
   */
  useEffect(() => {
    const fiber = Effect.runFork(
      SubscriptionRef.changes(runtime.outbox.rejections).pipe(
        Stream.runForEach((items) => {
          const rejection = items.find(
            (item) =>
              item.command.kind === "swapExercise" &&
              item.command.loggedSessionId === model.loggedSessionId,
          );
          if (rejection === undefined || rejection.command.kind !== "swapExercise") {
            return Effect.void;
          }
          const entryId = rejection.command.entryId;
          const reason = rejection.reason;
          return Effect.sync(() => {
            onSwapRejected(entryId);
            setSwapFor(null);
            setSwapping({ error: reason });
          }).pipe(Effect.andThen(runtime.outbox.acknowledgeRejection(rejection.commandId)));
        }),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [runtime, model.loggedSessionId, onSwapRejected]);

  /**
   * What an Entry is CALLED right now — the performed exercise once swapped
   * (ADR 0019), the prescribed one otherwise. Every sheet opened off an Entry
   * titles itself with this, so a sheet reached from "More for Leg Press" is
   * never headed "Back Squat".
   */
  const displayName = (entry: PrescribedEntry): string => {
    const entrySwap = model.swaps.get(entry.id);
    return entrySwap === undefined
      ? exerciseName(catalog, entry.exerciseId)
      : exerciseName(catalog, entrySwap.exerciseId);
  };

  const withAdded = useMemo(
    () => withAddedEntries(model.session, model.swaps, catalog),
    [model.session, model.swaps, catalog],
  );
  const session = useMemo(
    () => withUnplannedSets(withAdded.session, extraSets, model.actuals),
    [withAdded.session, extraSets, model.actuals],
  );

  /**
   * Add an exercise to the workout (UAT): mint an Entry id and record which
   * exercise it is through the swap command. That is the whole write, since
   * an added exercise is an Entry the prescription never held, named by a
   * swap (see `withAddedEntries`). It goes through the outbox like every
   * other capture, so it works offline for an exercise already in the
   * catalog; typing a new name needs the server, and the picker says so.
   */
  const addExercise = (exercise: CatalogExercise) => {
    setAdding("running");
    void swapExercise(runtime, {
      loggedSessionId: model.loggedSessionId,
      entryId: makeEntryId(),
      exerciseId: exercise.id,
    }).then(
      (command) => {
        setAdding("idle");
        onSwapped(command.entryId, command.exerciseId);
        setAddOpen(false);
      },
      (cause: unknown) => setAdding({ error: describeFailure(cause) }),
    );
  };

  /** What the picker marks "already in this session": every exercise an Entry here is performed as. */
  const inSession = useMemo(
    () =>
      new Set<string>(
        session.blocks.flatMap((block) =>
          block.entries.map((entry) => model.swaps.get(entry.id)?.exerciseId ?? entry.exerciseId),
        ),
      ),
    [session, model.swaps],
  );

  // Grouped by Entry once per render rather than filtered per-Entry in the
  // tree, same reasoning as `allSets`/`done` below — a single pass over
  // `model.notes`, not one per `EntrySection`.
  const notesByEntry = useMemo(() => {
    const byEntry = new Map<EntryId, Array<EntryNote>>();
    for (const note of model.notes.values()) {
      const list = byEntry.get(note.entryId) ?? [];
      list.push(note);
      byEntry.set(note.entryId, list);
    }
    for (const list of byEntry.values()) list.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    return byEntry;
  }, [model.notes]);

  /**
   * The note item writes ONE note per Entry (UAT): with a note already there
   * this rewrites it, and only an Entry with none adds. #130 shipped it
   * append-only, and daily-driving showed why that reads wrong — an
   * observation gets refined mid-workout ("elbow twinged" → "elbow twinged,
   * fine after the warmup"), and appending turned one thought into a stack of
   * near-duplicate lines under the exercise name, which is both noise on
   * screen and noise in the coach's context.
   *
   * Both halves are optimistic-then-reconciled through the outbox, so the
   * branch is over which command to enqueue and nothing else.
   */
  const saveNote = (entry: PrescribedEntry, text: string) => {
    setNoteSaving("running");
    const existing = editableNote(notesByEntry.get(entry.id as EntryId) ?? []);
    if (existing !== undefined) {
      void editEntryNote(runtime, {
        loggedSessionId: model.loggedSessionId,
        entryId: entry.id as EntryId,
        noteId: existing.id,
        text,
      }).then(
        (command) => {
          onRecordNoteEdit(command.noteId, command.text);
          setNoteSaving("idle");
          setNoteFor(null);
        },
        (cause: unknown) => setNoteSaving({ error: describeFailure(cause) }),
      );
      return;
    }
    void addEntryNote(runtime, {
      loggedSessionId: model.loggedSessionId,
      entryId: entry.id as EntryId,
      text,
    }).then(
      (command) => {
        // `pending: false` here, matching `recordLocal`'s convention for a
        // confirmed Set: this is the LOCAL echo, not the live queue state.
        // It becomes a permanent "not queued" default the moment the outbox
        // acks and drains the item — only the live `queuedNotes` list
        // (subscribed continuously) promotes a still-outstanding note back
        // to pending while it genuinely still is.
        onRecordNote({
          id: command.commandId,
          entryId: entry.id as EntryId,
          text: command.text,
          recordedAt: command.recordedAt,
          pending: false,
        });
        setNoteSaving("idle");
        setNoteFor(null);
      },
      (cause: unknown) => setNoteSaving({ error: describeFailure(cause) }),
    );
  };

  const restNotify = useRestTimerNotifyPreference();

  // The countdown is a `setInterval` re-reading `tickRestTimer` against the
  // clock and nothing else — every transition it can make is in the runtime
  // module, which is what lets Rung 1 exercise them with a fake clock. The
  // off-tab notification (#116 part 2) rides the same read:
  // `restTimerJustCompleted` catches the one tick where `running` becomes
  // `overrun`, and the browser call itself is a platform seam so this effect
  // stays about scheduling, not decisions.
  //
  // The interval is a REPAINT schedule, not the timer. The state holds an
  // absolute deadline, so a firing the browser skips costs nothing: a phone
  // that suspends the page on screen-lock (measured: 62s of wall time, 2s of
  // old-style countdown) resumes reading the correct time on whichever tick
  // arrives next. `visibilitychange` and `pageshow` force one of those
  // immediately rather than making the user watch a stale pill for up to a
  // second — `pageshow` because a phone restoring the page from the
  // back/forward cache fires that and not the other.
  useEffect(() => {
    if (rest === null || !Timer.isRestTimerActive(rest.state)) return;

    const read = () =>
      setRest((current) => {
        if (current === null) return null;
        const now = Date.now();
        const nextState = Timer.tickRestTimer(current.state, now);
        if (Timer.restTimerJustCompleted(current.state, nextState)) {
          notifyRestCompletionInBrowser(restNotify.enabled, displayName(current.entry));
        }
        return { ...current, state: nextState, now };
      });

    const interval = setInterval(read, 1000);
    // Each on its own target: `visibilitychange` is dispatched at the
    // document, `pageshow` at the window.
    document.addEventListener("visibilitychange", read);
    window.addEventListener("pageshow", read);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("pageshow", read);
    };
  }, [rest, restNotify.enabled]);

  // The same deadline, handed to the rest-timer worker (`public/rest-sw.js`):
  // a locked phone suspends this page, so the tick above only notices zero
  // once the user is already back. Keyed on the deadline itself rather than
  // on `rest`, so a tick (or running → overrun) re-sends nothing; start, +30s,
  // skip, the next set replacing the pill and leaving the surface all do.
  const restEndsAt = rest !== null && Timer.isRestTimerActive(rest.state) ? rest.state.endsAt : null;
  const restExercise = rest === null ? null : displayName(rest.entry);
  useEffect(() => {
    if (restEndsAt === null || restExercise === null || !restNotify.enabled) return;
    scheduleRestNotificationInWorker({ endsAt: restEndsAt, exercise: restExercise });
    return () => scheduleRestNotificationInWorker(null);
  }, [restEndsAt, restExercise, restNotify.enabled]);

  const onConfirmed = (set: PrescribedSet, entry: PrescribedEntry) => {
    const now = Date.now();
    const state = Timer.restTimerForSet(set, { live, now });
    if (state.status !== "absent") {
      // Lazy (#116): the permission prompt fires on the first rest timer the
      // user actually starts, never on load and never before they have done
      // anything.
      requestNotificationPermissionIfNeeded();
    }
    setRest(
      state.status === "absent"
        ? null
        : { state, entry, now, setId: set.id as SetId },
    );
  };

  /**
   * Un-logging dismisses the rest timer THIS Set's confirm raised (#83, ADR
   * 0019) — `Timer.shouldDismissRestTimerOnUnlog` is the decision, made in
   * the runtime module rather than here (#118's rule); this is only the
   * "which Set" identity check plus the local echo `onUnlogged` (from
   * `useLoggedSession`) already handles for the grid itself.
   */
  const onUnlogged = (setId: SetId) => {
    onUnloggedFromModel(setId);
    setRest((current) =>
      current !== null && current.setId === setId && Timer.shouldDismissRestTimerOnUnlog(current.state)
        ? null
        : current,
    );
  };

  const sets = allSets(session);
  const done = sets.filter((set) => model.actuals.has(set.id)).length;

  const finish = () => {
    setFinishing("running");
    // Taken before the round trip, from the Plan the user saw while finishing.
    const candidates = planSwapCandidates(model.session, model.swaps, plan);
    void finishWorkout(runtime, model.loggedSessionId).then(
      () => {
        if (candidates.length === 0) {
          onFinished();
          return;
        }
        setFinishing("idle");
        setPlanSwaps(candidates);
      },
      (cause: unknown) => setFinishing({ error: describeFailure(cause) }),
    );
  };

  /**
   * "Swap this in the plan" — one user-direct Plan edit per tap, through the
   * outbox like any edit from the Plan screen (ADR 0008: auto-applied, recorded
   * as a Change). Separate from the swap itself, which only ever recorded what
   * was done (ADR 0019); this is the user deciding the Plan should follow.
   */
  const swapInPlan = (candidate: PlanSwapCandidate) => {
    if (plan === undefined) return;
    const operation: PlanOperation = {
      _tag: "setEntryExercise",
      entryId: candidate.entryId,
      exerciseId: candidate.toExerciseId,
    };
    const verdict = PlanRuntime.validatePlanOperation(plan, operation, { exercises: catalog });
    if (!verdict.ok) {
      setPlanSwapStatus((current) => new Map(current).set(candidate.entryId, { error: verdict.reason }));
      return;
    }
    setPlanSwapStatus((current) => new Map(current).set(candidate.entryId, "running"));
    void enqueuePlanEdit(runtime, operation).then(
      () => setPlanSwapStatus((current) => new Map(current).set(candidate.entryId, "done")),
      (cause: unknown) =>
        setPlanSwapStatus((current) => new Map(current).set(candidate.entryId, { error: describeFailure(cause) })),
    );
  };

  // Cancel is offered only while the session has zero confirmed sets (the
  // owner's rule) — `Grid.canCancelSession` below is the client half of
  // that, the server's `LoggedSessionHasActualsError` guard is the other.
  const cancel = () => {
    setCancelling("running");
    void cancelSession(runtime, model.loggedSessionId).then(
      () => {
        setCancelling("idle");
        setCancelSheetOpen(false);
        onCancelled();
      },
      (cause: unknown) => setCancelling({ error: describeFailure(cause) }),
    );
  };

  return (
    <ModeShell strip={strip} stripRight={live ? undefined : "editing a past session"}>
      <div className="relative flex min-h-full flex-col">
        <Header
          model={model}
          live={live}
          done={done}
          total={sets.length}
          onExit={onExit}
          onCancel={
            Grid.canCancelSession({ live, confirmedCount: done })
              ? () => setCancelSheetOpen(true)
              : undefined
          }
        />

        <div className="mx-auto w-full max-w-3xl flex-1 px-4 pb-40 @2xl:px-8">
          {session.blocks.length === 0 ? (
            <EmptyState live={live} />
          ) : (
            session.blocks.map((block) => (
              <BlockSection key={block.id} block={block}>
                {block.entries.map((entry) => (
                  <EntrySection
                    key={entry.id}
                    model={model}
                    entry={entry}
                    catalog={catalog}
                    inBlock={Grid.isBlockWrapperVisible(block)}
                    added={withAdded.added.has(entry.id as EntryId)}
                    notes={notesByEntry.get(entry.id) ?? []}
                    onRecord={onRecord}
                    onUnlogged={onUnlogged}
                    onConfirmed={onConfirmed}
                    onOpenSheet={() => setSheetFor(entry)}
                  />
                ))}
              </BlockSection>
            ))
          )}

          {/* Adding an exercise is a plain outlined row under the last Entry,
              where the next exercise would go. It is not on the pencil
              sheet, because that sheet acts on one Entry and this adds
              another. */}
          <button
            onClick={() => {
              setAdding("idle");
              setAddOpen(true);
            }}
            className="mt-6 h-tap w-full rounded-control border border-dashed border-border-strong px-4 font-numeric text-xs font-semibold tracking-widest text-text-muted uppercase active:bg-surface-sunken"
          >
            + Add exercise
          </button>

          {/* Finishing is a plain rule-and-text action, not a floating FAB —
              the rest pill already owns the floating layer. */}
          <div className="mt-6 border-t-2 border-border-strong pt-4">
            <button
              onClick={finish}
              disabled={finishing === "running"}
              className="h-tap w-full rounded-control bg-confirm px-4 font-numeric text-xs font-semibold tracking-widest text-canvas uppercase disabled:opacity-50"
            >
              {finishing === "running" ? "Finishing…" : live ? "Finish session" : "Done"}
            </button>
            <p className="mt-2 text-center font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
              {done} of {sets.length} sets logged · never touches the plan
            </p>
            {typeof finishing === "object" && (
              // Finish is the one place where failing silently would be
              // dishonest: the coach never learns the session ended, and the
              // user would have no way to know.
              <p className="mt-2 text-center font-numeric text-[0.625rem] tracking-wide text-deviation uppercase">
                could not finish · {finishing.error}
              </p>
            )}
          </div>
        </div>

        {/* The pill leaves the screen on Skip, or when the next confirmed set
            replaces it — never by running out (#113 item 2). */}
        {rest !== null && Timer.isRestTimerActive(rest.state) && (
          <RestPill
            state={rest.state}
            now={rest.now}
            from={displayName(rest.entry)}
            onSkip={() =>
              setRest((current) =>
                current === null ? null : { ...current, state: Timer.skipRestTimer(current.state) },
              )
            }
            onAdd={() =>
              setRest((current) => {
                if (current === null) return null;
                // Extending reads the clock afresh rather than reusing the
                // last tick's `now`: "+30s" means thirty seconds from the tap,
                // and on an overrun timer (which restarts rather than adds)
                // a stale instant would be thirty seconds from up to a second
                // ago.
                const now = Date.now();
                return { ...current, state: Timer.extendRestTimer(current.state, 30, now), now };
              })
            }
          />
        )}

        {sheetFor !== null && (
          <SpecialSetSheet
            title={displayName(sheetFor)}
            swapEligible={Grid.canSwapEntry(sheetFor.id, model.actuals.values())}
            hasNote={editableNote(notesByEntry.get(sheetFor.id as EntryId) ?? []) !== undefined}
            removableCount={removableSets(sheetFor).length}
            onAddSpecialSet={(setType) => addSpecialSet(sheetFor, setType)}
            onOpenNote={() => {
              setNoteFor(sheetFor);
              setSheetFor(null);
            }}
            onOpenRemove={() => {
              setRemoveFor(sheetFor);
              setSheetFor(null);
            }}
            onOpenSwap={() => {
              setSwapFor(sheetFor);
              setSheetFor(null);
            }}
            onClose={() => setSheetFor(null)}
          />
        )}

        {removeFor !== null && (
          <RemoveSetSheet
            title={displayName(removeFor)}
            sets={removableSets(removeFor)}
            // Labelled against the WHOLE Entry, not just the removable
            // subset: "↳" and "3" only mean anything relative to every row
            // on screen.
            labels={setRowLabels(removeFor.sets)}
            onRemove={(setId) => {
              removeExtraSet(removeFor, setId);
              // Closes on the tap rather than staying open for a second
              // removal: the sheet's own list is now stale, and re-deriving
              // it in place would shuffle rows under the user's thumb.
              setRemoveFor(null);
            }}
            onClose={() => setRemoveFor(null)}
          />
        )}

        {noteFor !== null && (
          <NoteComposeSheet
            entry={noteFor}
            catalog={catalog}
            existing={editableNote(notesByEntry.get(noteFor.id as EntryId) ?? [])}
            saving={noteSaving}
            onSave={(text) => saveNote(noteFor, text)}
            onClose={() => {
              setNoteFor(null);
              setNoteSaving("idle");
            }}
          />
        )}
        {swapFor !== null && (
          <ExercisePicker
            catalog={catalog}
            authoring={authoring}
            // "already in this session" has no meaning for a swap target —
            // any catalog exercise, including ones elsewhere in this
            // Session, is a legitimate substitute.
            taken={EMPTY_TAKEN}
            pickLabel="Swap to this"
            onPick={(exercise) => swap(swapFor, exercise)}
            onCreate={async (name, libraryId) => {
              const exercise = await authoring.create(name, libraryId);
              swap(swapFor, exercise);
            }}
            onClose={() => setSwapFor(null)}
          />
        )}
        {addOpen && (
          <ExercisePicker
            catalog={catalog}
            authoring={authoring}
            taken={inSession}
            pickLabel="Add to workout"
            onPick={addExercise}
            onCreate={async (name, libraryId) => {
              const exercise = await authoring.create(name, libraryId);
              addExercise(exercise);
            }}
            onClose={() => setAddOpen(false)}
          />
        )}
        {typeof adding === "object" && (
          <p className="fixed inset-x-0 bottom-3 z-50 mx-auto max-w-sm rounded-control border border-deviation/40 bg-canvas px-3 py-2 text-center font-numeric text-[0.625rem] tracking-wide text-deviation uppercase shadow-panel">
            could not add · {adding.error}
          </p>
        )}
        {typeof swapping === "object" && (
          <p className="fixed inset-x-0 bottom-3 z-50 mx-auto max-w-sm rounded-control border border-deviation/40 bg-canvas px-3 py-2 text-center font-numeric text-[0.625rem] tracking-wide text-deviation uppercase shadow-panel">
            could not swap · {swapping.error}
          </p>
        )}

        {planSwaps !== null && (
          <Sheet title="Update the plan?" onClose={onFinished}>
            <p className="px-4 py-3 text-sm leading-normal text-text-muted">
              You swapped {planSwaps.length === 1 ? "an exercise" : "exercises"} this workout. Swap{" "}
              {planSwaps.length === 1 ? "it" : "them"} in the plan too, so next time starts with what you
              did? Sets and targets stay as they are. Close keeps the plan unchanged.
            </p>
            {planSwaps.map((candidate) => {
              const status = planSwapStatus.get(candidate.entryId);
              return (
                <div key={candidate.entryId}>
                  <SheetItem
                    label={`${exerciseName(catalog, candidate.fromExerciseId)} → ${exerciseName(catalog, candidate.toExerciseId)}`}
                    hint={status === "done" ? "in the plan ✓" : status === "running" ? "saving…" : "swap in plan"}
                    disabled={status === "done" || status === "running"}
                    onClick={() => swapInPlan(candidate)}
                  />
                  {typeof status === "object" && (
                    <p className="px-4 pb-3 font-numeric text-[0.625rem] tracking-wide text-deviation uppercase">
                      could not update the plan · {status.error}
                    </p>
                  )}
                </div>
              );
            })}
          </Sheet>
        )}

        {cancelSheetOpen && (
          <Sheet title="Cancel session" onClose={() => setCancelSheetOpen(false)}>
            <p className="px-4 py-3 text-sm leading-normal text-text-muted">
              No sets have been logged yet. Cancelling removes this session — it never touches the
              plan.
            </p>
            <SheetItem
              label={cancelling === "running" ? "Cancelling…" : "Cancel session"}
              tone="danger"
              onClick={cancel}
            />
            {typeof cancelling === "object" && (
              <p className="px-4 pb-3 font-numeric text-[0.625rem] tracking-wide text-deviation uppercase">
                could not cancel · {cancelling.error}
              </p>
            )}
          </Sheet>
        )}
      </div>
    </ModeShell>
  );
}

/* ------------------------------------------------------------------- header */

function Header({
  model,
  live,
  done,
  total,
  onExit,
  onCancel,
}: {
  readonly model: LoggedSessionModel;
  readonly live: boolean;
  readonly done: number;
  readonly total: number;
  readonly onExit: () => void;
  /** Present only when the session is `active` with zero confirmed sets — absent, not disabled-with-a-tooltip. */
  readonly onCancel: (() => void) | undefined;
}) {
  const started = model.startedAt === undefined ? undefined : new Date(model.startedAt);
  return (
    <div className="sticky top-0 z-10 border-b border-border-strong bg-canvas">
      <div className="mx-auto flex max-w-3xl items-center gap-2 px-2 py-2 @2xl:px-6">
        {/* the one explicit back affordance to Today (#42) */}
        <button
          onClick={onExit}
          className="grid size-tap shrink-0 place-items-center rounded-control text-lg active:bg-surface-sunken"
          aria-label="Back to Today"
        >
          ←
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[0.9375rem] leading-tight font-semibold">
            {model.session.name ?? "Session"}
          </h1>
          <p className="font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
            {live ? (
              started === undefined ? (
                "in progress"
              ) : (
                started.toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })
              )
            ) : (
              <span className="text-deviation">
                Backfill{started === undefined ? "" : ` · ${started.toLocaleDateString()}`}
              </span>
            )}
            {model.offline ? " · offline copy" : ""}
          </p>
        </div>
        {onCancel !== undefined && (
          <button
            onClick={onCancel}
            className="shrink-0 font-numeric text-[0.625rem] tracking-widest text-deviation uppercase underline underline-offset-4"
          >
            Cancel
          </button>
        )}
        <span className="shrink-0 font-numeric text-xs tabular-nums text-text-muted">
          {done}/{total}
        </span>
      </div>
      {/* progress as a 2px hairline, not a bar with a label — it is ambient */}
      <div className="h-0.5 bg-border">
        <div
          className="h-full bg-confirm transition-[width] duration-300"
          style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- block */

/**
 * The wrapper appears only because the Block groups more than one exercise or
 * uses a timed format (user story 18) — `isBlockWrapperVisible` is the whole
 * rule, and an ordinary straight day renders no wrapper at all, just the
 * Entries.
 */
function BlockSection({
  block,
  children,
}: {
  readonly block: PrescribedBlock;
  readonly children: React.ReactNode;
}) {
  if (!Grid.isBlockWrapperVisible(block)) {
    return <>{children}</>;
  }
  const rounds = block.params?.targetRounds;
  return (
    <section className="mt-6">
      <div className="flex items-baseline gap-2 border-b border-border-strong pb-1">
        {/* structural, not semantic — red stays reserved for the coach's
            proposed change, and a superset is not one */}
        <span className="font-numeric text-[0.625rem] font-semibold tracking-widest uppercase">
          [{Grid.blockWrapperLabel(block)}]
        </span>
        {rounds !== undefined && (
          <span className="font-numeric text-[0.625rem] tracking-widest text-text-faint uppercase">
            {rounds} rounds
          </span>
        )}
      </div>
      {/* the wrapper IS the left rule. No container, no card, no elevation. */}
      <div className="border-l-2 border-border-strong pl-3">{children}</div>
    </section>
  );
}

/**
 * The per-Entry affordance's icon. Inline SVG rather than the "✏" character
 * on purpose: that codepoint renders as a full-colour emoji on iOS, which is
 * the one platform this app is used on, and a colour glyph in a surface whose
 * only colour carries meaning (red = deviation) is exactly the promotion the
 * design forbids. `currentColor` keeps it in the same ink as the border it
 * sits in.
 */
function PencilGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11.2 2.3a1.4 1.4 0 0 1 2 2L5.6 11.9l-2.7.8.8-2.7 7.5-7.7Z" />
      <path d="M2.5 14.2h11" />
    </svg>
  );
}

/* -------------------------------------------------------------------- entry */

function EntrySection({
  model,
  entry,
  catalog,
  inBlock,
  added,
  notes,
  onRecord,
  onUnlogged,
  onConfirmed,
  onOpenSheet,
}: {
  readonly model: LoggedSessionModel;
  readonly entry: PrescribedEntry;
  readonly catalog: ReadonlyArray<CatalogExercise>;
  readonly inBlock: boolean;
  /** Added mid-workout (UAT): there is no prescribed exercise to say it was swapped from. */
  readonly added: boolean;
  /** Notes recorded against this Entry (issue #130), oldest first. */
  readonly notes: ReadonlyArray<EntryNote>;
  readonly onRecord: (setId: SetId, entryId: EntryId, actual: ActualMetricMap, setType: SetType) => void;
  /** Told about every un-logged set (#83, ADR 0019), the retraction-side twin of `onRecord`. */
  readonly onUnlogged: (setId: SetId) => void;
  readonly onConfirmed: (set: PrescribedSet, entry: PrescribedEntry) => void;
  readonly onOpenSheet: () => void;
}) {
  const prescribedName = exerciseName(catalog, entry.exerciseId);
  // A swap (#131, ADR 0019) is a typography decision, not a new card: the
  // PERFORMED exercise takes the title position — it is what actually
  // happened, and what the coach needs to read first — while the prescribed
  // one stays visible as a small line underneath. `entry.exerciseId` itself
  // is never touched.
  const swap = model.swaps.get(entry.id);
  const name = swap === undefined ? prescribedName : exerciseName(catalog, swap.exerciseId);
  // Last time (issue #149 tier-2 seed, and the per-Set suggestions): keyed on
  // the PERFORMED exercise — the swap's when there is one, the prescribed one
  // otherwise — so a swapped Entry reads the exercise actually being done,
  // never the frozen prescription. `undefined` offline; the plan's range
  // covers the rows until it arrives.
  const performedId = swap?.exerciseId ?? (entry.exerciseId as ExerciseId);
  const lastUse = useLastExerciseActuals(performedId);
  const libraryId = catalog.find((exercise) => exercise.id === performedId)?.libraryId;
  // Continuations are grouped by the runtime rather than by an indentation
  // branch here: a drop set reads as a continuation of the set it follows
  // (story 19) because `groupSetsWithContinuations` says which set that is.
  const groups = Grid.groupSetsWithContinuations(entry.sets);
  // Rest is stated once per Entry when every Set agrees on it, which is the
  // shape the Plan's "rest default for this exercise" control writes. Where
  // they disagree the Entry says nothing and each Set's own rest governs the
  // timer — the header is a summary, not a source of truth.
  const restSec = entry.sets[0]?.restSec;
  const uniformRest =
    restSec !== undefined && entry.sets.every((set) => set.restSec === restSec)
      ? restSec
      : undefined;

  // Row labels ("W" / "↳" / 1, 2, 3) — the same numbering the remove-a-set
  // sheet names its choices by, so the two cannot disagree about which Set
  // "2" is.
  const labels = setRowLabels(entry.sets);

  return (
    <section className={inBlock ? "pt-4" : "pt-6"}>
      <div
        className={`flex items-baseline gap-2 pb-1 ${inBlock ? "border-b border-border" : "border-b border-border-strong"}`}
      >
        {/* The PERFORMED exercise's animation, like the title beside it. */}
        <ExerciseDemo
          exercise={catalog.find((row) => row.id === (swap?.exerciseId ?? entry.exerciseId))}
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[1.0625rem] leading-tight font-semibold tracking-tight">
            {name}
          </h2>
          {swap !== undefined && (
            <p className="truncate font-numeric text-[0.5625rem] tracking-widest text-text-faint uppercase">
              {added ? "added this workout" : `swapped from ${prescribedName}`}
              {swap.pending ? " · queued" : ""}
            </p>
          )}
        </div>
        <span className="shrink-0 font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
          {/* rest is stated only when the Plan tracks it — silence, not "—" */}
          {uniformRest === undefined ? "" : `rest ${mmss(uniformRest)}`}
        </span>
        {/* THE single per-Entry affordance (story 21). Everything spontaneous
            lives here: extra straight set, drop, rest-pause, myo-cluster,
            remove a set, swap, note.

            A pencil rather than the "+" it opened with (UAT): the sheet stopped
            being only-additive the moment it grew "Remove a set" and a note
            item that rewrites, and a "+" over a menu whose items take things
            away misreads at a glance. The accessible name is unchanged —
            "More for <exercise>" was always the honest description of what the
            control opens, and it is what every rung-2 flow reaches it by. */}
        <button
          onClick={onOpenSheet}
          aria-label={`More for ${name}`}
          className="grid size-tap shrink-0 place-items-center rounded-control border border-border text-text-muted active:bg-surface-sunken"
        >
          <PencilGlyph />
        </button>
      </div>

      {/* The indicator IS the note, read inline — no accordion, no card, no
          colour promotion (a note is not a deviation, #113 item 2). An Entry
          with a note must still read as an Entry (ui-surfaces.md). */}
      {notes.length > 0 && (
        <p className="pt-1 text-xs leading-snug text-text-muted">
          {notes.map((note) => (
            <span key={note.id} className="block">
              {note.text}
              {note.pending && (
                <span className="ml-1 font-numeric text-[0.5625rem] tracking-widest text-text-faint uppercase">
                  queued
                </span>
              )}
            </span>
          ))}
        </p>
      )}

      <div>
        {groups.flatMap((group) =>
          [group.anchor, ...group.continuations].map((set) => {
            const label = labels.get(set.id) ?? "";
            return (
              <SetRow
                key={set.id}
                model={model}
                entry={entry}
                set={set}
                label={label}
                lastUse={lastUse}
                libraryId={libraryId}
                onRecord={onRecord}
                onUnlogged={onUnlogged}
                onConfirmed={() => onConfirmed(set, entry)}
              />
            );
          }),
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ set row */

function SetRow({
  model,
  entry,
  set,
  label,
  lastUse,
  libraryId,
  onRecord,
  onUnlogged,
  onConfirmed,
}: {
  readonly model: LoggedSessionModel;
  readonly entry: PrescribedEntry;
  readonly set: PrescribedSet;
  readonly label: string;
  /** Last time this Entry's performed Exercise was done: the #149 seed and each row's suggestion (UAT). `undefined` offline. */
  readonly lastUse: LastExerciseUse | undefined;
  /** The performed exercise's Exercise library row, when it has one — decides whether a load is plate-loaded. */
  readonly libraryId: string | undefined;
  readonly onRecord: (setId: SetId, entryId: EntryId, actual: ActualMetricMap, setType: SetType) => void;
  /** Told about this row's own retraction (#83, ADR 0019). */
  readonly onUnlogged: (setId: SetId) => void;
  readonly onConfirmed: () => void;
}) {
  const runtime = useRuntime();
  const weightUnit = useWeightUnit();
  const [editing, setEditing] = useState<MetricName | null>(null);
  const logged = model.actuals.get(set.id);
  const done = logged !== undefined;
  const warmup = set.setType === "warmup";
  const continuation = Grid.isContinuationSetType(set.setType);

  const fields = Grid.deriveSetFields(set.target);
  /** What one tap on ✓ would write: ranges resolve to their TOP (story 9). */
  const asPrescribed = useMemo(() => Grid.resolveGhostActual(set.target), [set.target]);
  /**
   * What one tap on ✓ actually writes (issue #149, decision (a)): the
   * prescribed resolution, plus a seed for every rendered metric the
   * prescription leaves open. The prescription always wins; a metric with
   * neither bound nor seed stays absent.
   */
  const oneTap = useMemo(
    () =>
      Grid.oneTapActual(set.target, entry.sets, set.id, model.actuals, lastUse?.perMetric, lastUse?.sets),
    [set.target, entry.sets, set.id, model.actuals, lastUse],
  );

  const write = (actual: ActualMetricMap) => {
    void confirmSet(runtime, {
      loggedSessionId: model.loggedSessionId,
      sessionId: model.prescribedSessionId,
      entryId: entry.id as EntryId,
      setId: set.id as SetId,
      setType: set.setType,
      actual,
    });
    onRecord(set.id as SetId, entry.id as EntryId, actual, set.setType);
    // Rest starts on the transition from UNLOGGED to LOGGED, and only there
    // (#113 item 1). Re-committing a value on a set that is already logged is
    // a *correction* — the load was wrong, the reps were miscounted, the RPE
    // came after the fact — and the user is not resting from it. Firing the
    // timer here restarted a fresh countdown for a set finished twenty minutes
    // ago, which is the one thing the pill must never claim.
    if (!done) onConfirmed();
  };

  /**
   * Un-log (#83, ADR 0019): tapping an already-logged Set's confirm again
   * retracts it — the settled reversal for the one-tap confirm's mis-tap
   * cost, and what un-blocks backfill's undo. `onUnlogged` both records the
   * local echo (so the row un-ticks before the outbox drains) and dismisses
   * the rest timer this Set's confirm raised, if it's still up.
   */
  const unlog = () => {
    void unlogSet(runtime, {
      loggedSessionId: model.loggedSessionId,
      entryId: entry.id as EntryId,
      setId: set.id as SetId,
    });
    onUnlogged(set.id as SetId);
  };

  // Deviation is per-METRIC, not per-row: hitting 8 reps at the wrong load is
  // a load problem and the yellow should say so. The comparison is against
  // the prescribed *interval*, so an actual inside a range is not a miss.
  const misses = Grid.setDeviations(set.target, logged?.actual).filter((field) =>
    Grid.isDeviated(field.deviation),
  );

  /**
   * RPE appears only on the sets the Plan flagged — an `rpe` key in the
   * target map, typically the open `rpe: {}` that means "report effort, no
   * target" — and only once the set is logged, so it can never cost the
   * unflagged majority a tap (story 20).
   */
  const wantsEffort = set.target.rpe !== undefined && done && logged.actual.rpe === undefined;

  /**
   * A personal record: this Set's estimated one-rep max beats the best of
   * every finished session on the performed Exercise. Green, because a
   * record is something that landed; never on a warmup, and never the first
   * time an Exercise is done (a baseline is not a record). Offline there is
   * no history to measure against, so there is no badge — an absent badge is
   * honest, a wrong one is not.
   */
  const personalRecord = done && Stats.isPersonalRecord(logged.actual, set.setType, lastUse?.bestE1rm);

  return (
    <div
      className={`border-b border-border ${warmup ? "opacity-60" : ""} ${continuation ? "pl-4" : ""}`}
    >
      <div className="flex items-center gap-1.5 py-1">
        <span className="w-6 shrink-0 font-numeric text-xs tabular-nums text-text-faint">
          {label}
        </span>

        {/* THE metric map. No reps/load anywhere — this is the whole point.
            RPE is the one field held back until the set is logged: it is the
            after-the-fact question of story 20, not a field to tab through. */}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {fields
            .filter((metric) => metric !== "rpe" || done)
            .map((metric) => (
              <MetricField
                key={metric}
                metric={metric}
                weightUnit={weightUnit}
                libraryId={libraryId}
                ghost={Grid.formatGhostText(
                  metric,
                  metric === "load" && set.target.load !== undefined
                    ? Units.intervalToDisplay(set.target.load, weightUnit)
                    : set.target[metric],
                )}
                resolved={asPrescribed[metric]}
                // UAT: what this Set's counterpart lifted last time, or the
                // previous Set this session once the user departed from it.
                // It replaces the plan's range on the row, and ✓ writes it.
                suggested={Grid.suggestMetric(entry.sets, set.id, metric, model.actuals, lastUse?.sets)}
                // The seed for an unprescribed metric (issue #149): tier 1 is
                // the previous Set this session, tier 2 the last time this
                // Exercise was performed. Decision (a): rendered on the row as
                // `~N` and written by ✓.
                seed={Grid.seedUnprescribedMetric(entry.sets, set.id, metric, model.actuals, lastUse?.perMetric)}
                value={logged?.actual[metric]}
                done={done}
                deviated={Grid.isDeviated(
                  Grid.metricDeviation(set.target[metric], logged?.actual[metric]),
                )}
                editing={editing === metric}
                onOpen={() => setEditing(metric)}
                onCommit={(next) => {
                  setEditing(null);
                  write({ ...(done ? logged.actual : oneTap), [metric]: next });
                }}
                onCancel={() => setEditing(null)}
              />
            ))}
        </div>

        <div className="flex w-14 shrink-0 flex-col items-end gap-0.5">
          {set.setType !== "working" && set.setType !== "warmup" && (
            <span className="font-numeric text-[0.5625rem] font-semibold tracking-widest uppercase">
              {set.setType}
            </span>
          )}
          {misses.map(({ metric, deviation }) => {
            const delta = Grid.deviationDelta(deviation);
            return (
              <span
                key={metric}
                className="font-numeric text-[0.5625rem] font-semibold tracking-widest text-deviation uppercase"
              >
                {delta > 0 ? "+" : "−"}
                {metric === "load" ? Units.kgToDisplay(Math.abs(delta), weightUnit) : Math.abs(delta)}{" "}
                {metric === "reps" && Math.abs(delta) === 1 ? "rep" : metricUi(metric, weightUnit).unit}
              </span>
            );
          })}
          {personalRecord && (
            <span
              aria-label="Personal record"
              className="font-numeric text-[0.5625rem] font-semibold tracking-widest text-confirm uppercase"
            >
              PR
            </span>
          )}
          {logged?.pending === true && (
            <span className="font-numeric text-[0.5625rem] tracking-widest text-text-faint uppercase">
              queued
            </span>
          )}
        </div>

        {/* One-tap confirm. Tapping it again un-logs the Set (#63, ADR 0019)
            — a retraction, not a delete: see ADR 0019 for why. Correcting a
            LOGGED value is what tapping the value itself does (a new actual
            for the same Set); tapping the ✓ toggles logged/not-logged. */}
        <button
          onClick={() => {
            if (done) {
              unlog();
            } else if (Object.keys(oneTap).length === 0) {
              // Nothing to log: every field is open and nothing suggests a
              // number (an exercise added mid-workout, never done before).
              // Writing `{}` logged a Set of nothing, so the tap opens the
              // first field to type into instead.
              setEditing(fields.find((metric) => metric !== "rpe") ?? null);
            } else {
              write(oneTap);
            }
          }}
          aria-label={done ? "Logged" : "Log as prescribed"}
          aria-pressed={done}
          className={`grid size-tap shrink-0 place-items-center rounded-control text-lg leading-none ${
            done
              ? "text-confirm"
              : "border-2 border-border-strong font-semibold text-text-ghost active:bg-confirm active:text-canvas"
          }`}
        >
          ✓
        </button>
      </div>

      {wantsEffort && (
        <div className="flex items-center gap-1 pb-1.5 pl-7">
          <span className="font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase">
            RPE
          </span>
          {[6, 7, 8, 9, 10].map((value) => (
            <button
              key={value}
              onClick={() => write({ ...logged.actual, rpe: value })}
              className="h-8 min-w-8 rounded-control border border-border font-numeric text-xs tabular-nums active:bg-accent active:text-on-accent"
            >
              {value}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One metric cell: ghost prescription when unlogged, actual when logged, a
 * stepper *and a keypad* when tapped. The ghost IS the input — there is no
 * edit mode.
 *
 * **Both affordances, not one (#113 item 3).** The stepper is right for ±1
 * rep and wrong for 20kg → 60kg, which was eight taps at the load step. So the
 * value in the middle of the popover is an `inputMode="decimal"` field — that
 * attribute, not `type="number"`, is what raises the phone's keypad, and
 * `type="number"` would bring spinners this popover already has better
 * versions of — with `−`/`+` still flanking it. Enter commits down the same
 * path as ✓; Escape cancels.
 */
function MetricField({
  metric,
  weightUnit,
  libraryId,
  ghost,
  resolved,
  suggested,
  seed,
  value,
  done,
  deviated,
  editing,
  onOpen,
  onCommit,
  onCancel,
}: {
  readonly metric: MetricName;
  /**
   * The unit a load is SHOWN and typed in. Every number this field is handed
   * and every number it commits is stored kg; the conversion happens here, at
   * the edge, and nowhere else on the row.
   */
  readonly weightUnit: Units.WeightUnit;
  /** For the plate readout: the performed exercise's library row, if any. */
  readonly libraryId: string | undefined;
  /** `formatGhostText`'s rendering of the prescribed interval — "8-10", "8+", "<=8 RPE" — already in the display unit. */
  readonly ghost: string;
  /** What one tap on ✓ would write for this metric; absent for an open interval. */
  readonly resolved: number | undefined;
  /**
   * What the row suggests (UAT, `Grid.suggestMetric`): last time's number
   * for this Set, or the previous Set's once the user departed from last
   * time. Outranks `resolved`, since it is what one tap on ✓ writes, and it
   * is shown in place of the plan's range.
   */
  readonly suggested: number | undefined;
  /**
   * The seed for an unprescribed metric (issue #149,
   * `Grid.seedUnprescribedMetric`): tier 1 is the previous Set's actual this
   * session, tier 2 the last time this Exercise was performed. Decision (a):
   * it **is** rendered on the row — as `~N`, italic, distinct from a
   * prescribed ghost — and one tap on ✓ writes it. `–` only when there is no
   * seed at all.
   */
  readonly seed: number | undefined;
  readonly value: number | undefined;
  readonly done: boolean;
  /** This metric specifically missed its prescription — carries the yellow. */
  readonly deviated: boolean;
  readonly editing: boolean;
  readonly onOpen: () => void;
  readonly onCommit: (value: number) => void;
  readonly onCancel: () => void;
}) {
  const spec = metricUi(metric, weightUnit);
  const isLoad = metric === "load";
  const shown = (stored: number | undefined): number | undefined =>
    stored === undefined || !isLoad ? stored : Units.kgToDisplay(stored, weightUnit);
  const shownValue = shown(value);
  const shownSuggested = shown(suggested);
  const shownSeed = shown(seed);
  // Logged value, else the row's suggestion (last time, or the previous set),
  // else the prescription, else what this exercise's previous set actually
  // took — the prescription still outranks the seed, which only fills the
  // silence.
  const start = shownValue ?? shownSuggested ?? shown(resolved) ?? shownSeed ?? 0;
  // The draft is a STRING, not a number: a keypad passes through states no
  // number can hold — "" while the field is cleared, "6." mid-decimal — and
  // coercing those to 0 as they are typed would fight the user's thumb.
  const [draft, setDraft] = useState(String(start));
  const ref = useRef<HTMLDivElement>(null);

  // The draft takes `start` when the editor OPENS, and only then, before the
  // browser paints. `start` can move while it is open: the previous Set's
  // log lands a moment after the tap and changes this row's suggestion.
  // Re-copying it then, or copying it after paint as a plain effect did,
  // overwrote what the user had already typed, so Save wrote the suggestion
  // instead of their number.
  const wasEditing = useRef(false);
  useLayoutEffect(() => {
    if (editing && !wasEditing.current) setDraft(String(start));
    wasEditing.current = editing;
  }, [editing, start]);

  // A comma is a decimal separator on most phone keypads outside the
  // en-US default, and rejecting "62,5" would be rejecting the number the
  // keyboard offered. `parseMetricDraft` is `undefined` for empty,
  // non-numeric, or negative drafts — ✓ and Enter both refuse those.
  const parsed = Grid.parseMetricDraft(draft);
  const committable = parsed !== undefined;
  const commit = () => {
    if (committable) onCommit(isLoad ? Units.displayToKg(parsed, weightUnit) : parsed);
  };
  const nudge = (delta: number) =>
    setDraft(
      String(
        isLoad
          ? Units.nudgeDisplayLoad(parsed ?? start, delta, weightUnit)
          : Grid.nudgeMetricValue(parsed, start, delta),
      ),
    );

  if (editing) {
    return (
      <div ref={ref} className={`${spec.width} relative shrink-0`}>
        <div className="absolute -top-1 left-0 z-30 rounded-control border border-border-strong bg-surface p-1 shadow-panel">
          <div className="flex items-center gap-1">
            <button
              onClick={() => nudge(-spec.step)}
              className="grid size-9 place-items-center rounded-control border border-border text-base"
              aria-label={`Decrease ${metric}`}
            >
              −
            </button>
            <input
              // The popover exists because the user just tapped this number;
              // making them tap it a second time to raise the keypad would be
              // the tap #113 item 3 is about removing.
              autoFocus
              // `decimal`, not `numeric`: load and RPE are fractional, and a
              // keypad without a decimal point cannot express 62.5kg.
              inputMode="decimal"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              // Select-all on focus, so the first digit REPLACES the ghost
              // rather than appending to it — the common case is a different
              // number, not an edit of this one.
              onFocus={(event) => event.target.select()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  onCancel();
                }
              }}
              // Duration is seconds here even where it reads back as m:ss —
              // said out loud rather than left for the user to discover by
              // typing 1:30 and getting 1.
              placeholder={metric === "duration" ? "seconds" : spec.unit}
              aria-label={`${metric} value`}
              className="w-12 rounded-control bg-transparent text-center font-numeric text-base tabular-nums outline-none"
            />
            <button
              onClick={() => nudge(spec.step)}
              className="grid size-9 place-items-center rounded-control border border-border text-base"
              aria-label={`Increase ${metric}`}
            >
              +
            </button>
            <button
              onClick={commit}
              disabled={!committable}
              className="grid size-9 place-items-center rounded-control bg-confirm text-base text-canvas disabled:opacity-40"
              aria-label="Save"
            >
              ✓
            </button>
            <button
              onClick={onCancel}
              className="grid size-9 place-items-center rounded-control text-base text-text-muted"
              aria-label="Cancel"
            >
              ✕
            </button>
          </div>
          {isLoad && parsed !== undefined && (
            <PlateReadout load={parsed} weightUnit={weightUnit} libraryId={libraryId} />
          )}
        </div>
      </div>
    );
  }

  // "The prescription writes no number for this metric" — an open `{}` target
  // ("report" / "report effort"), or a metric with no target entry at all.
  // `resolved === undefined` is the one reliable signal for both.
  const boundless = !done && resolved === undefined;
  // Before it is logged, the row shows what ✓ writes and nothing under it
  // (UAT): the "✓ logs N" line under each value was one more thing to read
  // between sets. So a suggestion (last time, or the previous set) replaces
  // the plan's number outright, and the range shows only for an exercise
  // with no history, where ✓ resolves it to its top.
  //
  // Issue #149, decision (a), is kept: a value on a metric the plan leaves
  // open reads `~N`, italic, as "from last time" rather than a prescription.
  // A boundless metric with nothing to suggest keeps its "report" ghost; a
  // metric with no target at all still shows `–`.
  const proposal = done ? undefined : (shownSuggested ?? (boundless ? shownSeed : undefined));
  const seeded = boundless && proposal !== undefined;
  const noGhost = ghost === "" && !done;

  return (
    <button
      onClick={onOpen}
      aria-label={`${metric} — ${
        done
          ? `logged ${shownValue ?? "nothing"}`
          : seeded
            ? `seeded ${proposal} from last time`
            : proposal !== undefined && String(proposal) !== ghost
              ? `suggested ${proposal}, prescribed ${ghost}`
              : noGhost
                ? "not prescribed"
                : `prescribed ${ghost}`
      }${deviated ? ", missed prescription" : ""}, tap to change`}
      className={`${spec.width} h-tap flex shrink-0 items-center rounded-control px-1 text-left active:bg-surface-sunken`}
    >
      <span className="flex items-baseline gap-1">
        <span
          className={`font-numeric text-lg leading-none tabular-nums ${
            deviated
              ? "font-semibold text-deviation"
              : done
                ? "text-text"
                : seeded
                  ? "text-text-ghost italic"
                  : "text-text-ghost"
          }`}
        >
          {done ? (shownValue ?? "–") : seeded ? `~${proposal}` : (proposal ?? (noGhost ? "–" : ghost))}
        </span>
        <span className="font-numeric text-[0.625rem] leading-none text-text-faint">
          {spec.unit}
        </span>
      </span>
    </button>
  );
}

/* -------------------------------------------------------- plate calculator */

/** Library equipment a plate calculator applies to: the Barbell group, plus the Smith machine's bar. */
const PLATE_LOADED_EQUIPMENT: ReadonlySet<string> = new Set([
  ...(EQUIPMENT_GROUPS.find((group) => group.label === "Barbell")?.values ?? []),
  "smith machine",
]);

/**
 * What goes on each side of the bar for the load being typed — the plate
 * calculator, read live under the load editor rather than opened as a
 * sheet of its own: the question ("what do I put on the bar?") is asked at
 * exactly the moment a load is being chosen, and answering it there costs no
 * tap. The bar and plates are this device's (Settings → Plates), in the
 * display unit, so a lb user's 45 lb bar is never converted through kg.
 */
function PlateReadout({
  load,
  weightUnit,
  libraryId,
}: {
  readonly load: number;
  readonly weightUnit: Units.WeightUnit;
  readonly libraryId: string | undefined;
}) {
  const setup = usePlateSetup(weightUnit);
  const library = useExerciseLibrary();
  // Plates only mean something on a bar. An exercise the library files under
  // dumbbell, cable, machine or kettlebell gets no readout; one with no
  // library row (typed by name) gets it, since the calculator cannot know and
  // a stray line is cheaper than a missing one under a barbell lift.
  const equipment =
    libraryId !== undefined && library.status === "ready" ? library.library.byId.get(libraryId)?.equipment : undefined;
  if (equipment !== undefined && !PLATE_LOADED_EQUIPMENT.has(equipment)) return null;
  const loadout = Units.loadPlates(load, setup);
  return (
    <p role="status" className="mt-1 px-1 font-numeric text-[0.6875rem] leading-snug text-text-muted">
      {loadout.kind === "bar-only"
        ? `Empty bar (${loadout.bar} ${weightUnit})`
        : loadout.perSide.length === 0
          ? `No plates fit — bar is ${setup.bar} ${weightUnit}`
          : `Each side: ${Units.formatPerSide(loadout.perSide)}`}
      {loadout.kind === "plates" && loadout.shortBy > 0 && (
        <span className="text-deviation">
          {" "}
          · makes {loadout.total} {weightUnit}
        </span>
      )}
    </p>
  );
}

/* --------------------------------------------------------------- rest pill */

function RestPill({
  state,
  now,
  from,
  onSkip,
  onAdd,
}: {
  readonly state: Timer.ActiveRestTimerState;
  /** The instant the state was read at — see the `rest` state's own note. */
  readonly now: number;
  readonly from: string;
  readonly onSkip: () => void;
  readonly onAdd: () => void;
}) {
  // Overrun stays in the CONFIRM colour family (#113 item 2). Yellow is spent
  // on deviation from the prescription, and taking longer over your rest than
  // the Plan suggested is not one — promoting it would blunt the one meaning
  // the colour has.
  const readout = Timer.restTimerReadout(state, now);
  return (
    <div className="pointer-events-none sticky bottom-3 z-20 flex justify-center px-3">
      <div className="pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-control border border-confirm/40 bg-confirm-quiet">
        {/* the bar drains left-to-right INSIDE the pill, so the timer needs no
            second element and the colour stays confined to one object */}
        <div
          className="absolute inset-y-0 left-0 bg-confirm/20 transition-[width] duration-1000 ease-linear"
          style={{ width: `${readout.fraction * 100}%` }}
        />
        <div className="relative flex items-center gap-2 px-3 py-2">
          <span className="font-numeric text-lg tabular-nums text-confirm">
            {readout.over ? "−" : ""}
            {mmss(readout.seconds)}
          </span>
          <span className="min-w-0 flex-1 truncate font-numeric text-[0.625rem] tracking-wide text-confirm/80 uppercase">
            rest · {from}
          </span>
          <button
            onClick={onAdd}
            className="h-tap rounded-control px-2 font-numeric text-[0.625rem] font-semibold tracking-widest text-confirm uppercase"
          >
            +30s
          </button>
          <button
            onClick={onSkip}
            className="h-tap rounded-control border border-confirm/40 px-2.5 font-numeric text-[0.625rem] font-semibold tracking-widest text-confirm uppercase"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------- special set-type sheet */

/**
 * The per-Entry affordance's contents (story 21). "Another straight set"
 * (#115 item 1, ADR 0017) and the three continuations — drop, rest-pause,
 * myo-cluster (#129 item 1) — are wired: none of them needed a new command,
 * because `logSetActual` already carries `entryId`/`setId`/`setType` by
 * value with no lookup against the prescribed tree — an unplanned Set is
 * captured through the exact same path as a prescribed one, just with a
 * client-minted id and a `setType`-appropriate echoed target
 * (`Grid.anotherSetOfType`). "Add a note" (#130) and "Swap this exercise"
 * (#131, ADR 0019) are wired too, but neither is a Set, so each opens a
 * second sheet layered on this one rather than writing on tap:
 * `NoteComposeSheet` for prose, `ExercisePicker` for a swap target. A swap
 * is additionally offered only while the Entry has zero logged Sets.
 *
 * "Remove a set" (UAT) is the seventh, and the first item here that takes
 * something away — the sheet grew four ways to add a Set before it grew any
 * way to undo one, which is what daily-driving found. It needs no command
 * either, for a stricter reason than the others: what it removes has only
 * ever existed in this surface's own `extraSets` (see `removeExtraSet`). Like
 * the note and swap items it layers a second sheet rather than acting on tap.
 *
 * Every item is wired now, so nothing here closes silently on a tap the app
 * cannot honour — the failure this list's `wired` flag existed to prevent.
 */
const SPECIALS = [
  { id: "straight", label: "Another straight set", hint: "same prescription again", wired: true },
  { id: "drop", label: "Drop set", hint: "immediately, reduced load, no rest", wired: true },
  { id: "rest-pause", label: "Rest-pause set", hint: "short pause, same load, to failure", wired: true },
  { id: "myo-cluster", label: "Myo-cluster", hint: "activation set then mini-clusters", wired: true },
  { id: "remove", label: "Remove a set", hint: "a set added here, before it's logged", wired: true },
  { id: "swap", label: "Swap this exercise", hint: "links back to the prescribed slot", wired: true },
  { id: "note", label: "Add a note", hint: "recorded against this entry", wired: true },
] as const;

/** Maps a wired special's sheet id to the `setType` its echo builder produces — the one place the sheet's labels and `Grid.anotherSetOfType`'s dispatch agree. */
const SPECIAL_SET_TYPES: Partial<Record<(typeof SPECIALS)[number]["id"], SetType>> = {
  straight: "working",
  drop: "drop",
  "rest-pause": "rest-pause",
  "myo-cluster": "myo-cluster",
};

function SpecialSetSheet({
  title,
  swapEligible,
  hasNote,
  removableCount,
  onAddSpecialSet,
  onOpenNote,
  onOpenRemove,
  onOpenSwap,
  onClose,
}: {
  /** The Entry's current display name (performed once swapped, ADR 0019) — matches the pencil button's own label. */
  readonly title: string;
  /** Grid.canSwapEntry's result for this Entry (ADR 0019) — a swap is offered only before any Set on the Entry is logged. */
  readonly swapEligible: boolean;
  /** Whether the Entry already carries a note — the item edits rather than adds when it does (UAT). */
  readonly hasNote: boolean;
  /** How many Sets `removeExtraSet` could take back; zero disables the item rather than hiding it. */
  readonly removableCount: number;
  readonly onAddSpecialSet: (setType: SetType) => void;
  readonly onOpenNote: () => void;
  readonly onOpenRemove: () => void;
  readonly onOpenSwap: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      {SPECIALS.map((special) => {
        const swapDisabled = special.id === "swap" && !swapEligible;
        const removeDisabled = special.id === "remove" && removableCount === 0;
        // The note item says which of the two things it will do, because the
        // difference is the whole point of the UAT change — "Add a note" on
        // an Entry that already has one promised a second note.
        const label =
          special.id === "note" && hasNote ? "Edit the note" : special.label;
        const hint = !special.wired
          ? `${special.hint} · not yet wired`
          : swapDisabled
            ? `${special.hint} · already logged`
            : removeDisabled
              ? "nothing added here to remove"
              : special.id === "note" && hasNote
                ? "rewrites the note on this entry"
                : special.hint;
        return (
          <SheetItem
            key={special.id}
            label={label}
            hint={hint}
            disabled={swapDisabled || removeDisabled}
            onClick={() => {
              if (special.id === "remove") {
                // Layered like the note and swap items rather than acting on
                // tap: which Set is being removed is a choice, and a
                // destructive one taken on the wrong row is not undoable.
                if (removableCount > 0) onOpenRemove();
                return;
              }
              if (special.id === "note") {
                // Opens the compose sheet instead of closing outright — a note
                // is prose, not a one-tap write.
                onOpenNote();
                return;
              }
              if (special.id === "swap") {
                // Same shape as a note: the caller opens the picker and
                // dismisses this sheet itself, so a tap that is not eligible
                // leaves the user exactly where they were.
                if (swapEligible) onOpenSwap();
                return;
              }
              const setType = SPECIAL_SET_TYPES[special.id];
              if (setType !== undefined) onAddSpecialSet(setType);
              onClose();
            }}
          />
        );
      })}
    </Sheet>
  );
}

/* ------------------------------------------------------------ note sheet */

/**
 * "Add a note" (#130), and its rewrite (UAT): free text against this Entry,
 * minimal per `ui-surfaces.md` — a title, a textarea, one Save action. No
 * draft persistence across a close/reopen: closing without saving discards
 * the text, the same way cancelling a set edit does.
 *
 * Editing is the same sheet with `existing` filled in, not a second one. The
 * textarea opens on the current text — a note you cannot see while rewriting
 * is a note you retype from memory — and the action still reads "Save note",
 * because from where the user is standing there is one note and they are
 * saving it.
 */
function NoteComposeSheet({
  entry,
  catalog,
  existing,
  saving,
  onSave,
  onClose,
}: {
  readonly entry: PrescribedEntry;
  readonly catalog: ReadonlyArray<CatalogExercise>;
  /** The note being rewritten, or `undefined` when this Entry has none yet. */
  readonly existing: EntryNote | undefined;
  readonly saving: "idle" | "running" | { readonly error: string };
  readonly onSave: (text: string) => void;
  readonly onClose: () => void;
}) {
  const [text, setText] = useState(existing?.text ?? "");
  const trimmed = text.trim();
  return (
    <Sheet title={`Note · ${exerciseName(catalog, entry.exerciseId)}`} onClose={onClose}>
      <div className="px-4 py-3">
        <textarea
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="left elbow twinged on set 3…"
          rows={3}
          className="w-full resize-none rounded-control border border-border bg-transparent p-2 text-sm leading-normal outline-none placeholder:text-text-faint"
        />
        <button
          onClick={() => onSave(trimmed)}
          // Unchanged text is not a save: enqueueing a rewrite that rewrites
          // nothing would mark the note "queued" on screen for a round trip
          // that changes no byte on the server.
          disabled={trimmed.length === 0 || trimmed === existing?.text || saving === "running"}
          className="mt-2 h-tap w-full rounded-control bg-confirm px-4 font-numeric text-xs font-semibold tracking-widest text-canvas uppercase disabled:opacity-50"
        >
          {saving === "running" ? "Saving…" : "Save note"}
        </button>
        {typeof saving === "object" && (
          <p className="mt-2 text-center font-numeric text-[0.625rem] tracking-wide text-deviation uppercase">
            could not save · {saving.error}
          </p>
        )}
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------ remove sheet */

/**
 * "Remove a set" (UAT): which of the Sets added on this Entry to take back.
 *
 * Only ever lists Sets `removeExtraSet` can honestly remove, so there is no
 * disabled row here to explain — the *item* on the sheet behind carries that
 * explanation when there is nothing to list. Each row names the Set the way
 * the Entry names it (`setRowLabels`) plus its type, because "↳" alone
 * appears more than once on an Entry with two drop sets.
 *
 * `danger` toning, and one tap: the row IS the confirmation. A second
 * "are you sure" over a row the user picked from a list of three would be
 * ceremony, and what it guards is one re-tap of "Drop set".
 */
function RemoveSetSheet({
  title,
  sets,
  labels,
  onRemove,
  onClose,
}: {
  readonly title: string;
  readonly sets: ReadonlyArray<PrescribedSet>;
  readonly labels: ReadonlyMap<string, string>;
  readonly onRemove: (setId: SetId) => void;
  readonly onClose: () => void;
}) {
  return (
    <Sheet title={`Remove · ${title}`} onClose={onClose}>
      {sets.map((set) => (
        <SheetItem
          key={set.id}
          label={`${labels.get(set.id) ?? ""} · ${SET_TYPE_LABELS[set.setType] ?? set.setType}`}
          hint="added here · not logged"
          tone="danger"
          onClick={() => onRemove(set.id as SetId)}
        />
      ))}
    </Sheet>
  );
}

/** How a Set's type reads to the user — the same words the specials sheet offers them under. */
const SET_TYPE_LABELS: Partial<Record<SetType, string>> = {
  working: "Straight set",
  warmup: "Warm-up set",
  drop: "Drop set",
  "rest-pause": "Rest-pause set",
  "myo-cluster": "Myo-cluster",
};

/* ------------------------------------------------------------ empty state */

function EmptyState({ live }: { readonly live: boolean }) {
  return (
    <div className="border-b border-border py-10 text-center">
      <p className="font-numeric text-[0.6875rem] tracking-widest text-text-faint uppercase">
        {live ? "no exercises prescribed" : "nothing was logged"}
      </p>
      <p className="mx-auto mt-2 max-w-xs text-sm leading-snug text-text-muted">
        {live
          ? "This session has no entries yet. Add them in the Plan — logging never writes to it."
          : "This session was started but never logged against."}
      </p>
    </div>
  );
}
