// Plan authoring (#72), on the real Plan contracts and the #71 runtime module.
//
// The design is #45's, settled and unchanged. What moved underneath it: the
// prototype's `Template`/`SetGroup`/`Target` model is gone, replaced by
// `PrescribedSession` and the runtime's `SetRun`; every mutation is now a
// `PlanOperation` validated and applied by `applyPlanOperation` — the same
// function the server runs — instead of a hand-written array splice.
//
// The decisions this surface encodes, all of them still true:
//
// 1. YOU AUTHOR SET *RUNS*, NOT SET ROWS. "4 × 5–8 reps @ 80 kg" is one thing
//    with a count. It is the only way nested set editing fits at 412px, and it
//    is how a person says it out loud. The Plan stores rows; `coalesceSetRuns`
//    and `expandSetRuns` are what let the editor never see them. A run of one
//    is just a set, so nothing is lost.
//
// 2. REORDERING IS A MODE, NOT A GESTURE (story 30). Long-press-drag on a
//    nested list at 412px is undiscoverable and fights the scroll container. A
//    per-list "Reorder" toggle swaps rows for ↑/↓ controls: explicit,
//    one-handed, survives fat fingers, and leaves the resting state clean.
//
// 3. EDITING IS INLINE AND HAS NO SAVE BUTTON, because ADR 0008 auto-applies.
//    To make that trustworthy rather than alarming, the change ledger is
//    VISIBLE (story 27) — a running list of what you just did, each stamped
//    `user-direct`, with undo. The absence of a save button is only safe if
//    the app can show you what it saved.
//
// 4. BLOCKS ARE MADE BY ADJACENCY, NOT SELECTION. "Group with the exercise
//    below" on the Entry's own menu — which is exactly what `groupEntries`
//    accepts, and it enforces the adjacency rule rather than trusting this
//    file to.
//
// 5. DEFERRED IS STATED, NOT HIDDEN. EMOM/AMRAP authoring, prescribed warmups
//    and progression rules are out of scope per ADR 0007 — the editor says so
//    where you would look for them, so their absence reads as a decision.
//
// 6. COLOUR CARRIES THE SAME MEANINGS IT DOES IN LOGGING.
//      green   settled or go: the session you are editing, an applied Change,
//              an affordance that is ON, the button that finishes the job.
//      yellow  something that cannot be run as written — a Session with no
//              exercises, a run with a metric left unprescribed.
//      red     ABSENT. Plan authoring contains no coach proposals; when the
//              coach proposes a change it arrives as a diff, and THAT is red.
import { useEffect, useRef, useState } from "react";

import { Plan as PlanRuntime, Units } from "@repcoach/client-runtime";
import type {
  CatalogExercise,
  EntryId,
  ExerciseId,
  MetricName,
  PrescribedBlock,
  PrescribedEntry,
  PrescribedMetricMap,
  PrescribedSession,
  SessionId,
  SetType,
} from "@repcoach/contracts";

import { makeBlockId, makeEntryId, makeSessionId, makeSetId } from "../runtime/ids.ts";
import { describeFailure } from "../runtime/rpc.ts";
import type { AppliedChange, PlanEditor } from "../runtime/usePlanEditor.ts";
import { useWeightUnit } from "../runtime/weightUnit.ts";
import { exerciseName, metricUi, mmss, plural } from "../ui/chrome.ts";
import { Sheet, SheetItem, Stepper } from "../ui/Sheet.tsx";
import { ExercisePicker } from "./ExercisePicker.tsx";

/** The metrics this Entry's rows will ask for — the catalog fact, with the Sets as fallback. */
function trackedMetrics(
  entry: PrescribedEntry,
  catalog: ReadonlyArray<CatalogExercise>,
): ReadonlyArray<MetricName> {
  const declared =
    entry.trackedMetrics ?? catalog.find((exercise) => exercise.id === entry.exerciseId)?.trackedMetrics;
  if (declared !== undefined && declared.length > 0) return declared;
  const seen = new Set<MetricName>();
  for (const set of entry.sets) {
    for (const metric of Object.keys(set.target) as MetricName[]) seen.add(metric);
  }
  return [...seen];
}

const entriesOf = (session: PrescribedSession): ReadonlyArray<PrescribedEntry> =>
  session.blocks.flatMap((block) => block.entries);

/* ============================================================== the surface */

/**
 * The catalog's write side, as the picker needs it (#102, ADR 0016).
 *
 * Creating an exercise is NOT a Plan operation — it mints no Change and
 * writes nothing to the Decision log, because no Plan changed — so it does
 * not travel through `PlanEditor` and arrives here as its own seam. That also
 * makes it the one thing on this surface that is **connected-only**: the Plan
 * editor works offline through the outbox, the catalog does not exist offline
 * at all, so `offline` disables the affordance with a reason rather than
 * queueing a write against a catalog the client cannot show.
 */
export interface CatalogAuthoring {
  readonly create: (name: string, libraryId?: string) => Promise<CatalogExercise>;
  readonly rename: (exerciseId: ExerciseId, name: string) => Promise<CatalogExercise>;
  readonly offline: boolean;
}

export function Plan({
  editor,
  catalog,
  authoring,
  selectedId,
  onSelect,
}: {
  readonly editor: PlanEditor;
  readonly catalog: ReadonlyArray<CatalogExercise>;
  readonly authoring: CatalogAuthoring;
  readonly selectedId: SessionId | undefined;
  readonly onSelect: (sessionId: SessionId) => void;
}) {
  const { plan } = editor;
  const [reordering, setReordering] = useState(false);
  const listRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  const selected = plan.sessions.find((session) => session.id === selectedId);

  const createSession = () => {
    const sessionId = makeSessionId();
    const name = `Session ${plan.sessions.length + 1}`;
    if (editor.apply({ _tag: "createSession", sessionId, name })) onSelect(sessionId);
  };

  const moveSession = (index: number, delta: number) => {
    const ids = plan.sessions.map((session) => session.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target]!, next[index]!];
    // Whole-value: the operation carries the entire ordered list, so it is
    // idempotent and last-write-wins — no index drift on replay (#71).
    editor.apply({ _tag: "orderSessions", sessionIds: next });
  };

  // On phone the editor is stacked BELOW the list (#42: column order equals
  // phone stacking order), so picking a session has to bring it into view —
  // otherwise every edit begins with a scroll past the list you just used.
  //
  // Whether it IS stacked is a container-query outcome, so it cannot be read
  // off the window: measure the boxes instead. The measurement has to happen
  // AFTER React commits the new selection, so it is an effect rather than a
  // callback — a rAF inside the click handler runs against the old tree.
  const pendingScroll = useRef(false);
  const select = (sessionId: SessionId) => {
    pendingScroll.current = true;
    onSelect(sessionId);
  };

  useEffect(() => {
    if (!pendingScroll.current) return;
    pendingScroll.current = false;
    const list = listRef.current?.getBoundingClientRect();
    const editorBox = editorRef.current?.getBoundingClientRect();
    if (list !== undefined && editorBox !== undefined && editorBox.top > list.top + 40) {
      editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedId]);

  if (plan.sessions.length === 0) {
    return <PlanEmptyState onCreate={createSession} error={editor.lastError} />;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pb-10 @2xl:px-8">
      <header className="border-b border-border-strong pt-5 pb-3">
        <h1 className="text-2xl font-semibold tracking-tight @2xl:text-3xl">Plan</h1>
        <p className="mt-0.5 font-numeric text-[0.6875rem] tracking-wide text-text-faint uppercase">
          {plural(plan.sessions.length, "session")} · {plan.planModel} · edits apply immediately
        </p>
      </header>

      {editor.lastError !== undefined && <EditError editor={editor} />}

      {/* NOTE — this deviates from #42's stated 1fr / 30rem split. On Today the
          fixed column is the coach output and the flexible one is the spine.
          On Plan the right column is an EDITOR, and giving the ordered list the
          growing column spends width on the least dense thing on the screen.
          Fixed-left / flexible-right keeps column order (= phone stacking
          order) intact while putting the width where the work is. */}
      <div className="@2xl:grid @2xl:grid-cols-[20rem_1fr] @2xl:gap-10">
        <section ref={listRef}>
          <ListRule
            label="Prescribed sessions"
            reordering={reordering}
            onToggleReorder={() => setReordering((current) => !current)}
          />
          <ul>
            {plan.sessions.map((session, index) => (
              <SessionRow
                key={session.id}
                summary={PlanRuntime.summarizePlanSession(session, index)}
                selected={session.id === selectedId}
                reordering={reordering}
                first={index === 0}
                last={index === plan.sessions.length - 1}
                onSelect={() => select(session.id)}
                onMove={(delta) => moveSession(index, delta)}
                onRename={(name) => editor.apply({ _tag: "renameSession", sessionId: session.id, name })}
                onDelete={() => editor.apply({ _tag: "deleteSession", sessionId: session.id })}
              />
            ))}
          </ul>
          <button
            onClick={createSession}
            className="mt-3 h-tap w-full rounded-control border border-dashed border-border-strong font-numeric text-[0.6875rem] tracking-wider text-text-muted uppercase active:bg-surface-sunken"
          >
            + New prescribed session
          </button>
        </section>

        <section ref={editorRef} className="mt-10 scroll-mt-12 @2xl:mt-0">
          {selected !== undefined ? (
            <SessionEditor
              key={selected.id}
              session={selected}
              index={plan.sessions.findIndex((candidate) => candidate.id === selected.id)}
              editor={editor}
              catalog={catalog}
              authoring={authoring}
            />
          ) : (
            <p className="border-t-2 border-border-strong pt-6 text-center font-numeric text-[0.6875rem] tracking-widest text-text-faint uppercase">
              Pick a session to edit it
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * A rejected edit is stated, not swallowed. `applyPlanOperation` rejects a
 * stale tap — grouping Entries that are no longer adjacent, reordering a list
 * something was just removed from — and silently doing nothing would look
 * exactly like a missed tap.
 */
function EditError({ editor }: { readonly editor: PlanEditor }) {
  return (
    <p className="mt-3 flex items-baseline gap-2 border-b border-border py-2 font-numeric text-[0.6875rem] tracking-wide text-deviation uppercase">
      <span className="min-w-0 flex-1">edit not applied · {editor.lastError}</span>
      <button onClick={editor.dismissError} className="shrink-0 underline underline-offset-4">
        Dismiss
      </button>
    </p>
  );
}

function ListRule({
  label,
  reordering,
  onToggleReorder,
}: {
  readonly label: string;
  readonly reordering: boolean;
  readonly onToggleReorder: () => void;
}) {
  return (
    <h2 className="mt-6 mb-1 flex items-baseline gap-2 border-b border-border-strong pb-1 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">
      {label}
      <button
        onClick={onToggleReorder}
        className={`ml-auto tracking-wider underline underline-offset-4 ${reordering ? "font-semibold text-confirm" : "text-text-muted"}`}
      >
        {reordering ? "Done" : "Reorder"}
      </button>
    </h2>
  );
}

/* --------------------------------------------------------------- session row */

function SessionRow({
  summary,
  selected,
  reordering,
  first,
  last,
  onSelect,
  onMove,
  onRename,
  onDelete,
}: {
  readonly summary: PlanRuntime.PlanSessionSummary;
  readonly selected: boolean;
  readonly reordering: boolean;
  readonly first: boolean;
  readonly last: boolean;
  readonly onSelect: () => void;
  readonly onMove: (delta: number) => void;
  readonly onRename: (name: string) => void;
  readonly onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(summary.title);

  if (renaming) {
    const commit = () => {
      const name = draft.trim();
      if (name !== "") onRename(name);
      setRenaming(false);
    };
    return (
      <li className="flex items-center gap-1.5 border-b border-border py-2">
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setRenaming(false);
          }}
          className="h-tap min-w-0 flex-1 rounded-control border border-border-strong bg-surface px-2 text-[1.0625rem]"
        />
        <button
          onClick={commit}
          className="grid size-tap place-items-center rounded-control bg-confirm text-lg text-canvas"
          aria-label="Save name"
        >
          ✓
        </button>
      </li>
    );
  }

  return (
    <li>
      {/* the session you are editing is the live one — green left rule, the
          same "this is the active thing" green as Logging's confirmed set */}
      <div
        className={`flex items-center gap-1.5 border-b border-border border-l-2 py-2.5 pl-1 ${
          selected ? "border-l-confirm bg-confirm-quiet/40" : "border-l-transparent"
        }`}
      >
        {/* reorder mode replaces the row's affordances rather than adding to
            them, so the resting state carries no ↑/↓ noise */}
        {reordering ? (
          <>
            <span className="pl-1 font-numeric text-xs text-text-faint">⠿</span>
            <span className="min-w-0 flex-1 truncate pl-1 text-[1.0625rem] font-medium">
              {summary.title}
            </span>
            {/* Named with the row (#82). Reorder mode puts a pair of these on
                every row, and a bare "Move up" repeated N times tells a screen
                reader user — and an acceptance test — only that *something*
                moves, never which thing. */}
            <button
              onClick={() => onMove(-1)}
              disabled={first}
              className="grid size-tap place-items-center rounded-control border border-border text-base disabled:opacity-25"
              aria-label={`Move ${summary.title} up`}
            >
              ↑
            </button>
            <button
              onClick={() => onMove(1)}
              disabled={last}
              className="grid size-tap place-items-center rounded-control border border-border text-base disabled:opacity-25"
              aria-label={`Move ${summary.title} down`}
            >
              ↓
            </button>
          </>
        ) : (
          <>
            <button onClick={onSelect} className="min-w-0 flex-1 py-1 pl-1 text-left">
              <span className="block truncate text-[1.0625rem] leading-tight font-medium">
                {summary.title}
              </span>
              {/* a session with no exercises cannot be run — yellow, because it
                  is not an error, it is something you would want to know
                  before Thursday */}
              {summary.isEmpty ? (
                <span className="mt-0.5 block font-numeric text-xs text-deviation">
                  empty — nothing to run yet
                </span>
              ) : (
                <span className="mt-0.5 block font-numeric text-xs text-text-muted">
                  {plural(summary.entryCount, "exercise")} · {plural(summary.setCount, "set")}
                </span>
              )}
            </button>
            {selected && (
              <span className="font-numeric text-[0.5625rem] font-semibold tracking-widest text-confirm uppercase">
                editing
              </span>
            )}
            <button
              onClick={() => setMenu(true)}
              aria-label={`More for ${summary.title}`}
              className="grid size-8 shrink-0 place-items-center rounded-control border border-border text-sm text-text-muted"
            >
              ⋯
            </button>
          </>
        )}
      </div>

      {menu && (
        <Sheet title={summary.title} onClose={() => setMenu(false)}>
          <SheetItem
            label="Rename"
            onClick={() => {
              setDraft(summary.title);
              setRenaming(true);
              setMenu(false);
            }}
          />
          <SheetItem
            label="Delete session"
            tone="danger"
            // Stated because it is true and because it is the reassurance that
            // makes deleting a Session thinkable: instantiation is a copy
            // (ADR 0006/0007), so nothing you already logged is at risk.
            hint="past workouts are copies and are kept"
            onClick={() => {
              onDelete();
              setMenu(false);
            }}
          />
        </Sheet>
      )}
    </li>
  );
}

/* ----------------------------------------------------------- session editor */

function SessionEditor({
  session,
  index,
  editor,
  catalog,
  authoring,
}: {
  readonly session: PrescribedSession;
  readonly index: number;
  readonly editor: PlanEditor;
  readonly catalog: ReadonlyArray<CatalogExercise>;
  readonly authoring: CatalogAuthoring;
}) {
  const [reordering, setReordering] = useState(false);
  const [picking, setPicking] = useState(false);
  const summary = PlanRuntime.summarizePlanSession(session, index);

  /* Reordering has exactly two levels, and the unit of the outer one is the
     BLOCK — a Block moves as a single object carrying its Entries. That is the
     only model where "move the superset below the carries" is one action
     instead of two moves through an illegal intermediate state.

     The inner level exists because A1/A2 order inside a superset is real
     prescription, not presentation. Entries inside a Block move only among
     their siblings; leaving a Block is a different intent with its own words
     in the menu. */
  const moveBlock = (blockIndex: number, delta: number) => {
    const ids = session.blocks.map((block) => block.id);
    const target = blockIndex + delta;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[blockIndex], next[target]] = [next[target]!, next[blockIndex]!];
    editor.apply({ _tag: "orderBlocks", sessionId: session.id, blockIds: next });
  };

  const moveEntryInBlock = (block: PrescribedBlock, entryIndex: number, delta: number) => {
    const ids = block.entries.map((entry) => entry.id);
    const target = entryIndex + delta;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[entryIndex], next[target]] = [next[target]!, next[entryIndex]!];
    editor.apply({ _tag: "orderEntries", blockId: block.id, entryIds: next });
  };

  /** Blocks are made by adjacency: fuse this Block's Entry with the next one. */
  const groupWithNext = (blockIndex: number) => {
    const here = session.blocks[blockIndex];
    const next = session.blocks[blockIndex + 1];
    if (here === undefined || next === undefined) return;
    if (next.format !== "straight") {
      // Joining an existing group is how a circuit grows past two exercises —
      // otherwise "circuit" would be a lie.
      const entry = here.entries[0];
      if (entry === undefined) return;
      editor.apply({
        _tag: "moveEntryToBlock",
        entryId: entry.id,
        blockId: next.id,
        position: 0,
      });
      return;
    }
    editor.apply({
      _tag: "groupEntries",
      sessionId: session.id,
      blockId: makeBlockId(),
      entryIds: [...here.entries.map((entry) => entry.id), ...next.entries.map((entry) => entry.id)],
      format: "superset",
    });
  };

  const addExercise = (exercise: CatalogExercise) => {
    const entryId = makeEntryId();
    if (
      !editor.apply({
        _tag: "addEntry",
        sessionId: session.id,
        // A fresh Block id creates a straight Block to hold the new Entry;
        // naming an existing one would join it instead.
        blockId: makeBlockId(),
        entryId,
        exerciseId: exercise.id,
      })
    ) {
      return;
    }
    // A new Entry arrives with no Sets. Seeding it with one run is what makes
    // "add exercise" a complete action rather than a two-step one — and the
    // targets come from the catalog's declared metrics, not from a reps/load
    // guess.
    editor.apply({
      _tag: "replaceEntrySets",
      entryId,
      sets: PlanRuntime.expandSetRuns(
        [
          {
            count: 3,
            setType: "working",
            target: seedTarget(openingMetrics(exercise)),
            restSec: 120,
            setIds: [],
          },
        ],
        makeSetId,
      ),
    });
  };

  /**
   * One gesture, two writes (ADR 0016): mint the catalog row, then add it to
   * this Session. They are separate on purpose — a catalog row is not part of
   * the Plan, so creating one mints no Change — and the seam is visible here
   * as the `await` between them.
   *
   * `registerExercise` sits in the middle because `addEntry` is validated
   * against the editor's authoring context, and the row this just created is
   * a React state update away from reaching it.
   *
   * A failure between the two leaves an **orphan catalog row** — an exercise
   * nothing references. ADR 0016 tolerates that rather than build the
   * reference count a sweep would need; the row simply sits in the picker,
   * and taking it again adds it properly.
   */
  const createAndAdd = async (name: string, libraryId?: string) => {
    const exercise = await authoring.create(name, libraryId);
    editor.registerExercise(exercise);
    addExercise(exercise);
  };

  return (
    <div>
      <div className="flex items-baseline gap-2 border-b-2 border-border-strong pt-6 pb-1.5 @2xl:pt-0">
        <h2 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
          {summary.title}
        </h2>
        <span className="shrink-0 font-numeric text-[0.625rem] tracking-widest text-text-faint uppercase">
          {plural(summary.entryCount, "exercise")} · {plural(summary.setCount, "set")}
        </span>
      </div>

      {session.blocks.length > 0 && (
        <div className="flex items-center border-b border-border py-1">
          <span className="font-numeric text-[0.625rem] tracking-widest text-text-faint uppercase">
            edits apply immediately
          </span>
          <button
            onClick={() => setReordering((current) => !current)}
            className={`ml-auto font-numeric text-[0.6875rem] tracking-wider uppercase underline underline-offset-4 ${
              reordering ? "font-semibold text-confirm" : "text-text-muted"
            }`}
          >
            {reordering ? "Done reordering" : "Reorder exercises"}
          </button>
        </div>
      )}

      {session.blocks.length === 0 ? (
        <p className="border-b border-border py-8 text-center text-sm text-text-muted">
          No exercises yet. Add the first one below.
        </p>
      ) : (
        session.blocks.map((block, blockIndex) =>
          // A plain single-Entry straight Block is a real node but never a
          // wrapper — the same `isBlockWrapperVisible` rule the logging grid
          // obeys, so a Block looks identical in the surface that authors it
          // and the one that runs it.
          block.format === "straight" && block.entries.length <= 1 ? (
            block.entries.map((entry) => (
              <EntryEditor
                key={entry.id}
                entry={entry}
                editor={editor}
                catalog={catalog}
                reordering={reordering}
                first={blockIndex === 0}
                last={blockIndex === session.blocks.length - 1}
                canGroup={session.blocks[blockIndex + 1] !== undefined}
                groupTarget={
                  session.blocks[blockIndex + 1]?.format === "straight"
                    ? "the exercise below"
                    : "the group below"
                }
                onMove={(delta) => moveBlock(blockIndex, delta)}
                onGroupWithNext={() => groupWithNext(blockIndex)}
              />
            ))
          ) : (
            <section key={block.id} className="mt-5">
              <div className="flex items-baseline gap-2 border-b border-border-strong pb-1">
                {/* structural, not semantic — a Block is not a coach proposal,
                    so it gets weight and a rule rather than the reserved red */}
                <span className="font-numeric text-[0.625rem] font-semibold tracking-widest uppercase">
                  [{block.format}]
                </span>
                {reordering ? (
                  <>
                    {/* In reorder mode the Block header carries the move
                        controls, because the header IS the whole group. */}
                    <span className="font-numeric text-[0.625rem] tracking-widest text-text-faint uppercase">
                      moves as one
                    </span>
                    <span className="ml-auto flex gap-1.5">
                      <button
                        onClick={() => moveBlock(blockIndex, -1)}
                        disabled={blockIndex === 0}
                        className="grid size-tap place-items-center rounded-control border border-border text-base disabled:opacity-25"
                        aria-label={`Move ${block.format} up`}
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveBlock(blockIndex, 1)}
                        disabled={blockIndex === session.blocks.length - 1}
                        className="grid size-tap place-items-center rounded-control border border-border text-base disabled:opacity-25"
                        aria-label={`Move ${block.format} down`}
                      >
                        ↓
                      </button>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-numeric text-[0.625rem] tracking-widest text-text-faint uppercase">
                      <Stepper
                        value={block.params?.targetRounds ?? 1}
                        min={1}
                        onChange={(targetRounds) =>
                          editor.apply({
                            _tag: "setBlockParams",
                            blockId: block.id,
                            format: block.format,
                            params: { ...block.params, targetRounds },
                          })
                        }
                      />
                    </span>
                    <button
                      onClick={() => editor.apply({ _tag: "ungroupBlock", blockId: block.id })}
                      className="ml-auto font-numeric text-[0.625rem] tracking-wider text-text-muted uppercase underline underline-offset-4"
                    >
                      Ungroup
                    </button>
                  </>
                )}
              </div>
              {/* the same margin-mark wrapper Logging uses — a Block must look
                  identical in the surface that authors it and the one that
                  runs it, or you cannot tell you built the right thing */}
              <div className="border-l-2 border-border-strong pl-3">
                {block.entries.map((entry, entryIndex) => (
                  <EntryEditor
                    key={entry.id}
                    entry={entry}
                    editor={editor}
                    catalog={catalog}
                    inBlock
                    reordering={reordering}
                    first={entryIndex === 0}
                    last={entryIndex === block.entries.length - 1}
                    canGroup={false}
                    onMove={(delta) => moveEntryInBlock(block, entryIndex, delta)}
                    onGroupWithNext={() => {}}
                    blockName={block.format}
                    onLeaveBlock={
                      block.entries.length > 1
                        ? () => {
                            // Out of the group and into a fresh straight Block
                            // of its own; the vacated Block collapses per the
                            // operation's own rules (a Block of one is not a
                            // Block).
                            editor.apply({
                              _tag: "removeEntryFromBlock",
                              entryId: entry.id,
                              blockId: makeBlockId(),
                            });
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            </section>
          ),
        )
      )}

      <button
        onClick={() => setPicking(true)}
        className="mt-5 h-tap w-full rounded-control border border-dashed border-border-strong font-numeric text-[0.6875rem] tracking-wider text-text-muted uppercase active:bg-surface-sunken"
      >
        + Add exercise from catalog
      </button>

      {/* ADR 0007's deferrals, stated where you would go looking for them */}
      <p className="mt-3 font-numeric text-[0.625rem] leading-relaxed tracking-wide text-text-faint uppercase">
        Not in v1: EMOM / AMRAP authoring · prescribed warmups · progression rules. Every target
        here is hand-entered.
      </p>

      <ChangeLedger changes={editor.changes} canUndo={editor.canUndo} onUndo={editor.undoLast} />

      {picking && (
        <ExercisePicker
          catalog={catalog}
          authoring={authoring}
          taken={new Set(entriesOf(session).map((entry) => entry.exerciseId))}
          pickLabel="Add to session"
          onPick={(exercise) => {
            addExercise(exercise);
            setPicking(false);
          }}
          onCreate={createAndAdd}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/**
 * A new Entry's opening prescription. Every declared metric gets an interval
 * so the run is runnable as written — a metric left absent is what the editor
 * marks "incomplete", and offering that as the *starting* state would be
 * picking a fight with the user on their first tap.
 */
/**
 * What a newly added Entry prescribes when its exercise declares nothing —
 * the User-authored case (#102, ADR 0016): the row is name-only until the
 * coach enriches it, so the catalog has no answer yet.
 *
 * Reps and load, because that is what almost every lift a person types in is,
 * and because the alternative is worse in both directions: an Entry with no
 * targets at all is one the editor immediately marks incomplete and logging
 * renders no fields for, so "add the exercise" would leave the user with
 * nothing to log against. The targets are ordinary prescription and editable
 * on the spot, and the keys are exactly what the logging grid falls back to
 * when the catalog declares no tracked metrics.
 */
function openingMetrics(exercise: CatalogExercise): ReadonlyArray<MetricName> {
  return exercise.trackedMetrics.length > 0 ? exercise.trackedMetrics : ["reps", "load"];
}

function seedTarget(metrics: ReadonlyArray<MetricName>): PrescribedMetricMap {
  const target: Record<string, { min?: number; max?: number }> = {};
  for (const metric of metrics) {
    switch (metric) {
      case "reps":
        target.reps = { min: 8, max: 12 };
        break;
      case "load":
        target.load = { min: 20, max: 20 };
        break;
      case "duration":
        target.duration = { min: 30, max: 30 };
        break;
      case "distance":
        target.distance = { min: 20, max: 20 };
        break;
      case "rpe":
        // The open interval: "report effort, no target" — which is what an
        // effort field means before anyone has decided a cap.
        target.rpe = {};
        break;
      case "tempo":
        target.tempo = {};
        break;
    }
  }
  return target as PrescribedMetricMap;
}

/* ------------------------------------------------------------- entry editor */

function EntryEditor({
  entry,
  editor,
  catalog,
  inBlock,
  reordering,
  first,
  last,
  canGroup,
  groupTarget,
  onMove,
  onGroupWithNext,
  onLeaveBlock,
  blockName,
}: {
  readonly entry: PrescribedEntry;
  readonly editor: PlanEditor;
  readonly catalog: ReadonlyArray<CatalogExercise>;
  readonly inBlock?: boolean;
  readonly reordering: boolean;
  readonly first: boolean;
  readonly last: boolean;
  readonly canGroup: boolean;
  readonly groupTarget?: string;
  readonly onMove: (delta: number) => void;
  readonly onGroupWithNext: () => void;
  /** only set for Entries inside a visible Block */
  readonly onLeaveBlock?: () => void;
  readonly blockName?: string;
}) {
  const name = exerciseName(catalog, entry.exerciseId);
  const metrics = trackedMetrics(entry, catalog);
  const [menu, setMenu] = useState(false);
  const [restOpen, setRestOpen] = useState(false);

  // Runs are DERIVED from the stored Sets on every render rather than held in
  // state. That is the whole reason `coalesceSetRuns` exists: two adjacent
  // runs the user edits into agreement merge by themselves, which storing
  // them could never do.
  const runs = PlanRuntime.coalesceSetRuns(entry.sets);

  const writeRuns = (next: ReadonlyArray<PlanRuntime.SetRun>) =>
    editor.apply({
      _tag: "replaceEntrySets",
      entryId: entry.id as EntryId,
      // Existing Set ids are reused positionally, so changing a count does not
      // renumber the Sets that did not change.
      sets: PlanRuntime.expandSetRuns(next, makeSetId),
    });

  const patchRun = (index: number, fn: (run: PlanRuntime.SetRun) => PlanRuntime.SetRun) =>
    writeRuns(runs.map((run, position) => (position === index ? fn(run) : run)));

  const addRun = (setType: SetType) =>
    writeRuns([
      ...runs,
      {
        count: setType === "working" ? 3 : 1,
        setType,
        target: runs.at(-1)?.target ?? seedTarget(metrics),
        // A drop set follows immediately — no rest is the point of it.
        ...(setType === "drop" ? { restSec: 0 } : {}),
        setIds: [],
      },
    ]);

  // Rest lives on the Set and nowhere else (CONTEXT `Set`), so the Entry-level
  // "default" is a summary: it shows a value only when every run agrees.
  const restSummary = PlanRuntime.summarizeRunsRest(runs);
  const uniformRest = restSummary.kind === "tracked" ? restSummary.restSec : undefined;

  return (
    <section className={inBlock ? "pt-4" : "pt-5"}>
      <div
        className={`flex items-center gap-1.5 pb-1 ${inBlock ? "border-b border-border" : "border-b border-border-strong"}`}
      >
        <h3 className="min-w-0 flex-1 truncate text-[1.0625rem] leading-tight font-semibold tracking-tight">
          {name}
        </h3>
        {reordering ? (
          <>
            {/* Named with the exercise (#82) — same reason as the session list,
                and it matters more here: #45's sharpest claim is that reordering
                has two levels and the outer unit is the NODE, which is
                unassertable and unhearable while every arrow is called the same
                thing. */}
            <button
              onClick={() => onMove(-1)}
              disabled={first}
              className="grid size-tap place-items-center rounded-control border border-border text-base disabled:opacity-25"
              aria-label={`Move ${name} up`}
            >
              ↑
            </button>
            <button
              onClick={() => onMove(1)}
              disabled={last}
              className="grid size-tap place-items-center rounded-control border border-border text-base disabled:opacity-25"
              aria-label={`Move ${name} down`}
            >
              ↓
            </button>
          </>
        ) : (
          <>
            <span className="shrink-0 font-numeric text-[0.5625rem] tracking-widest text-text-faint uppercase">
              {metrics.join(" · ")}
            </span>
            <button
              onClick={() => setMenu(true)}
              aria-label={`More for ${name}`}
              className="grid size-8 shrink-0 place-items-center rounded-control border border-border text-sm text-text-muted"
            >
              ⋯
            </button>
          </>
        )}
      </div>

      {/* Entry-level rest default. Stated as a row rather than buried in the
          menu, because it is the value every set inherits and the logging
          timer is silent without it. */}
      <button
        onClick={() => setRestOpen((current) => !current)}
        className="flex w-full items-center gap-2 border-b border-border py-1.5 text-left"
      >
        <span className="font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase">
          rest default
        </span>
        <span
          className={`font-numeric text-sm tabular-nums ${uniformRest === undefined ? "text-text-ghost" : "text-text"}`}
        >
          {restSummary.kind === "tracked"
            ? mmss(restSummary.restSec)
            : restSummary.kind === "not-tracked"
              ? "not tracked"
              : "varies by set"}
        </span>
        <span className="ml-auto font-numeric text-[0.625rem] text-text-faint">
          {restOpen ? "▾" : "▸"}
        </span>
      </button>
      {restOpen && (
        <div className="flex items-center gap-2 border-b border-border py-2">
          <Stepper
            value={uniformRest ?? 0}
            step={15}
            suffix="s"
            label="rest default"
            onChange={(seconds) => writeRuns(PlanRuntime.withRestAcrossRuns(runs, seconds))}
          />
          <button
            onClick={() => writeRuns(PlanRuntime.withRestAcrossRuns(runs, undefined))}
            className="ml-auto font-numeric text-[0.625rem] tracking-wider text-text-muted uppercase underline underline-offset-4"
          >
            Don't track rest here
          </button>
        </div>
      )}

      {runs.map((run, index) => (
        <RunEditor
          key={`${run.setType}-${run.setIds[0] ?? index}`}
          run={run}
          metrics={metrics}
          onPatch={(fn) => patchRun(index, fn)}
          onRemove={() => writeRuns(runs.filter((_, position) => position !== index))}
        />
      ))}

      <div className="flex gap-1.5 pt-1.5">
        <button
          onClick={() => addRun("working")}
          className="h-9 flex-1 rounded-control border border-border font-numeric text-[0.625rem] tracking-wider text-text-muted uppercase active:bg-surface-sunken"
        >
          + Set group
        </button>
        <button
          onClick={() => setMenu(true)}
          className="h-9 flex-1 rounded-control border border-border font-numeric text-[0.625rem] tracking-wider text-text-muted uppercase active:bg-surface-sunken"
        >
          + Drop / rest-pause / myo
        </button>
      </div>

      {menu && (
        <Sheet title={name} onClose={() => setMenu(false)}>
          <SheetItem
            label="Add drop set"
            hint="reduced load, no rest"
            onClick={() => {
              addRun("drop");
              setMenu(false);
            }}
          />
          <SheetItem
            label="Add rest-pause set"
            hint="short pause, same load"
            onClick={() => {
              addRun("rest-pause");
              setMenu(false);
            }}
          />
          <SheetItem
            label="Add myo-cluster"
            hint="activation then clusters"
            onClick={() => {
              addRun("myo-cluster");
              setMenu(false);
            }}
          />
          {canGroup && (
            <SheetItem
              label={`Group with ${groupTarget ?? "the exercise below"}`}
              hint={groupTarget === "the exercise below" ? "makes a superset" : "joins it"}
              onClick={() => {
                onGroupWithNext();
                setMenu(false);
              }}
            />
          )}
          {onLeaveBlock !== undefined && (
            <SheetItem
              label={`Take out of ${blockName ?? "the group"}`}
              hint="back to its own slot"
              onClick={() => {
                onLeaveBlock();
                setMenu(false);
              }}
            />
          )}
          <SheetItem
            label="Remove exercise"
            tone="danger"
            hint={plural(entry.sets.length, "set")}
            onClick={() => {
              editor.apply({ _tag: "removeEntry", entryId: entry.id as EntryId });
              setMenu(false);
            }}
          />
        </Sheet>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- run editor */

function RunEditor({
  run,
  metrics,
  onPatch,
  onRemove,
}: {
  readonly run: PlanRuntime.SetRun;
  readonly metrics: ReadonlyArray<MetricName>;
  readonly onPatch: (fn: (run: PlanRuntime.SetRun) => PlanRuntime.SetRun) => void;
  readonly onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const weightUnit = useWeightUnit();
  // A run missing a target for a metric the exercise records cannot be run as
  // written — the same yellow Logging uses for a missed prescription.
  const incomplete = PlanRuntime.isRunIncomplete(run, metrics);
  const asksForEffort = run.target.rpe !== undefined;

  const setInterval_ = (metric: MetricName, interval: { min?: number; max?: number }) =>
    onPatch((current) => ({ ...current, target: { ...current.target, [metric]: interval } }));

  return (
    <div className={`border-b border-border ${run.setType !== "working" ? "pl-4" : ""}`}>
      {/* the resting state is the sentence: "4 × 5–8 reps @ 80 kg", rendered by
          the runtime so the Plan and the logging grid can never disagree about
          what "8+" or "<=8 RPE" means */}
      <button
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 py-2 text-left"
      >
        <span
          className={`font-numeric text-[0.9375rem] tabular-nums ${incomplete ? "text-deviation" : ""}`}
        >
          {PlanRuntime.formatSetRun(run, weightUnit)}
        </span>
        {incomplete && (
          <span className="font-numeric text-[0.5625rem] font-semibold tracking-widest text-deviation uppercase">
            incomplete
          </span>
        )}
        {run.restSec !== undefined && (
          <span className="font-numeric text-[0.5625rem] tracking-widest text-text-muted uppercase">
            rest {mmss(run.restSec)}
          </span>
        )}
        <span className="ml-auto font-numeric text-[0.625rem] text-text-faint">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="border-t border-border py-2 pl-1">
          <Field label="sets">
            <Stepper
              value={run.count}
              min={1}
              label="sets"
              onChange={(count) => onPatch((current) => ({ ...current, count }))}
            />
          </Field>

          {metrics
            .filter((metric) => metric !== "rpe")
            .map((metric) => (
              <TargetField
                key={metric}
                metric={metric}
                interval={run.target[metric]}
                weightUnit={weightUnit}
                onChange={(interval) => setInterval_(metric, interval)}
              />
            ))}

          <Field label="rest">
            <Stepper
              value={run.restSec ?? 0}
              step={15}
              suffix="s"
              label="rest"
              onChange={(restSec) => onPatch((current) => ({ ...current, restSec }))}
            />
            {run.restSec !== undefined && (
              <button
                onClick={() =>
                  onPatch(({ restSec: _dropped, ...rest }) => rest as PlanRuntime.SetRun)
                }
                className="ml-2 font-numeric text-[0.625rem] tracking-wider text-text-muted uppercase underline underline-offset-4"
              >
                no rest
              </button>
            )}
          </Field>

          {/* "Ask for RPE on these sets" IS an open `rpe: {}` in the target
              map — the same key logging reads to decide whether to ask. There
              is no separate `reportEffort` flag, because there was never a
              second fact. */}
          <Field label="effort">
            <button
              onClick={() =>
                onPatch((current) => {
                  if (current.target.rpe === undefined) {
                    return { ...current, target: { ...current.target, rpe: {} } };
                  }
                  const { rpe: _dropped, ...target } = current.target;
                  return { ...current, target };
                })
              }
              className={`h-9 rounded-control border px-3 font-numeric text-[0.625rem] tracking-wider uppercase ${
                asksForEffort
                  ? "border-confirm bg-confirm font-semibold text-canvas"
                  : "border-border text-text-muted"
              }`}
            >
              {asksForEffort ? "asks for RPE" : "no RPE"}
            </button>
          </Field>

          <button
            onClick={onRemove}
            className="mt-1 font-numeric text-[0.625rem] tracking-wider text-danger uppercase underline underline-offset-4"
          >
            Remove this group
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-14 shrink-0 font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * One metric's prescribed **interval**. Any metric can be a range — that is
 * what the contract says, and the prototype's "only reps may be ranged" was a
 * restriction of its own weaker model, not of the domain. A range whose bounds
 * are equal is the exact case, which is why "single" simply collapses them.
 */
function TargetField({
  metric,
  interval: stored,
  weightUnit,
  onChange: onStoredChange,
}: {
  readonly metric: MetricName;
  /** Stored units — a load is kg. */
  readonly interval: { readonly min?: number; readonly max?: number } | undefined;
  /** What a load is shown and stepped in; converted back to kg on the way out. */
  readonly weightUnit: Units.WeightUnit;
  readonly onChange: (interval: { min?: number; max?: number }) => void;
}) {
  const { step, unit } = metricUi(metric, weightUnit);
  const isLoad = metric === "load";
  const interval = isLoad && stored !== undefined ? Units.intervalToDisplay(stored, weightUnit) : stored;
  // A bound the user did not touch goes back as the kg it came in as: 80 kg
  // shows as 176.4 lb, and converting 176.4 back would store 80.014.
  const toStored = (shown: number | undefined, previous: number | undefined): number | undefined => {
    if (shown === undefined) return undefined;
    if (previous !== undefined && Units.kgToDisplay(previous, weightUnit) === shown) return previous;
    return Units.displayToKg(shown, weightUnit);
  };
  const onChange = (next: { min?: number; max?: number }) => {
    if (!isLoad) return onStoredChange(next);
    const min = toStored(next.min, stored?.min);
    const max = toStored(next.max, stored?.max);
    onStoredChange({ ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
  };
  const loadProps = isLoad
    ? {
        suffix: unit,
        nudge: (current: number, delta: number) => Units.nudgeDisplayLoad(current, delta, weightUnit),
      }
    : {};
  const min = interval?.min ?? 0;
  const max = interval?.max ?? min;
  const ranged = interval !== undefined && interval.min !== interval.max;

  return (
    <Field label={metric}>
      {/* Ranged, the two ends are named separately (#82). "The stepper next to
          the other stepper" was the only way to reach the ceiling of a rep
          range, which is a position rather than a thing — and a position is
          exactly what neither a screen reader nor an acceptance test can use. */}
      {ranged ? (
        <span className="flex flex-wrap items-center gap-1">
          <Stepper
            value={min}
            step={step}
            {...loadProps}
            label={`${metric} from`}
            onChange={(next) => onChange({ min: Math.min(next, max), max })}
          />
          <span className="font-numeric text-xs text-text-faint">–</span>
          <Stepper
            value={max}
            step={step}
            {...loadProps}
            label={`${metric} to`}
            onChange={(next) => onChange({ min, max: Math.max(next, min) })}
          />
        </span>
      ) : (
        <Stepper
          value={min}
          step={step}
          {...loadProps}
          label={metric}
          onChange={(next) => onChange({ min: next, max: next })}
        />
      )}
      <button
        onClick={() =>
          onChange(ranged ? { min: max, max } : { min: Math.max(0, max - 3 * step), max })
        }
        aria-label={ranged ? `Make ${metric} a single target` : `Make ${metric} a range`}
        className="ml-auto font-numeric text-[0.625rem] tracking-wider text-text-muted uppercase underline underline-offset-4"
      >
        {ranged ? "single" : "range"}
      </button>
    </Field>
  );
}

/* ------------------------------------------------------------ change ledger */

function ChangeLedger({
  changes,
  canUndo,
  onUndo,
}: {
  readonly changes: ReadonlyArray<AppliedChange>;
  readonly canUndo: boolean;
  readonly onUndo: () => void;
}) {
  // The editor has no save button because ADR 0008 auto-applies. That is only
  // trustworthy if the app can show you what it just did — so it does.
  if (changes.length === 0) return null;
  return (
    <section className="mt-8 border-t-2 border-border-strong pt-2">
      <h4 className="flex items-baseline gap-2 font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase">
        Applied changes
        <span className="text-text-faint">{changes.length}</span>
        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="ml-auto tracking-wider underline underline-offset-4 disabled:no-underline disabled:opacity-40"
        >
          Undo last
        </button>
      </h4>
      <ul className="mt-1">
        {changes.slice(0, 4).map((change) => (
          <li
            key={change.id}
            className="flex items-baseline gap-2 border-b border-border py-1.5 text-sm leading-snug"
          >
            {/* green because it LANDED — the ledger's whole job is to make the
                missing save button feel like a decision rather than a risk */}
            <span className="shrink-0 font-numeric text-[0.5625rem] font-semibold tracking-widest text-confirm uppercase">
              [{change.origin}]
            </span>
            <span className="min-w-0 flex-1">{change.summary}</span>
            <span className="shrink-0 font-numeric text-[0.5625rem] tracking-wide text-text-faint uppercase">
              {change.inverse === undefined ? "not undoable" : change.at}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* --------------------------------------------------------------- empty state */

export function PlanEmptyState({
  onCreate,
  error,
}: {
  readonly onCreate: () => void;
  readonly error: string | undefined;
}) {
  return (
    <div className="mx-auto max-w-md px-4 pt-16 pb-10 text-center">
      <p className="font-numeric text-[0.6875rem] tracking-widest text-text-faint uppercase">
        No plan yet
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Your plan is a list of sessions you wrote
      </h1>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-normal text-text-muted">
        Each one is a prescribed session: the exercises, in order, with the sets you intend to do.
        You pick one from Today when you train, and starting it makes a copy — what you log never
        touches the plan. Nothing here is automatic; every target is yours until you ask the coach
        to change it.
      </p>
      <button
        onClick={onCreate}
        className="mt-6 h-tap w-full rounded-control bg-confirm px-4 font-numeric text-xs font-semibold tracking-widest text-canvas uppercase"
      >
        Create the first session
      </button>
      {error !== undefined && (
        <p className="mt-3 font-numeric text-[0.625rem] tracking-wide text-deviation uppercase">
          {error}
        </p>
      )}
      {/* #42: Today's empty state is the Intake invitation; this is the manual
          alternative path, so it must point at the other door without stealing
          the hero from it. */}
      <p className="mt-4 font-numeric text-[0.625rem] leading-relaxed tracking-wide text-text-faint uppercase">
        Or answer a few questions on Today and let the coach draft one for you
      </p>
    </div>
  );
}
