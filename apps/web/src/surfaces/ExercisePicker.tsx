// The exercise picker: the one place an exercise is chosen, for the Plan
// (add an Entry) and for Logging (swap an Entry) alike, and the one place the
// Exercise catalog is authored from.
//
// Three sources, in this order, and the order is the design:
//
// 1. YOUR EXERCISES — the catalog rows. Tapping one picks it, exactly as
//    before: these are exercises you have already used, and their history
//    lives on their id.
// 2. THE LIBRARY — ~1,300 exercises with animations. A library row is NOT yet
//    an exercise of yours; choosing it mints a catalog row linked to it
//    (`libraryId`). Because catalog rows are permanent (ADR 0016 — no delete,
//    past sessions reference them), a library tap opens a preview first and
//    minting is the preview's button: a mis-tap costs a Close, not a row.
//    Library rows already in your catalog are hidden, so the same exercise is
//    never offered twice.
// 3. CREATE — a typed name the library does not have. Last, never first, for
//    the reason ADR 0016 gives: you have to visibly walk past everything that
//    already exists to make a duplicate.
import { useMemo, useState, type ReactNode } from "react";

import { Plan as PlanRuntime } from "@repcoach/client-runtime";
import type { CatalogExercise, ExerciseId } from "@repcoach/contracts";

import {
  animationUrl,
  BODY_PARTS,
  EQUIPMENT_GROUPS,
  LIBRARY_ATTRIBUTION,
  rankLibraryMatch,
  thumbnailUrl,
  useExerciseLibrary,
  type ExerciseLibrary,
  type LibraryExercise,
} from "../exerciseLibrary/library.ts";
import { describeFailure } from "../runtime/rpc.ts";
import { Sheet } from "../ui/Sheet.tsx";
import type { CatalogAuthoring } from "./Plan.tsx";

/** How many library rows render before "Show more" — the whole library is 1,300 rows of images. */
const LIBRARY_PAGE = 40;

interface Filters {
  readonly bodyPart: string | undefined;
  readonly equipment: string | undefined;
}

const passesFilters = (exercise: LibraryExercise, filters: Filters): boolean => {
  if (filters.bodyPart !== undefined && exercise.bodyPart !== filters.bodyPart) return false;
  if (filters.equipment !== undefined) {
    const group = EQUIPMENT_GROUPS.find((candidate) => candidate.label === filters.equipment);
    if (group !== undefined && !group.values.includes(exercise.equipment)) return false;
  }
  return true;
};

/** What the preview sheet is showing: a library exercise, and the catalog row it already is, if any. */
interface Preview {
  readonly exercise: LibraryExercise;
  readonly owned: CatalogExercise | undefined;
}

export function ExercisePicker({
  catalog,
  authoring,
  taken,
  pickLabel,
  onPick,
  onCreate,
  onClose,
}: {
  readonly catalog: ReadonlyArray<CatalogExercise>;
  readonly authoring: CatalogAuthoring;
  readonly taken: ReadonlySet<string>;
  /** The preview sheet's action, in the caller's words ("Add to session", "Swap to this"). */
  readonly pickLabel: string;
  readonly onPick: (exercise: CatalogExercise) => void;
  readonly onCreate: (name: string, libraryId?: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const libraryState = useExerciseLibrary();
  const library = libraryState.status === "ready" ? libraryState.library : undefined;

  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>({ bodyPart: undefined, equipment: undefined });
  const [shown, setShown] = useState(LIBRARY_PAGE);
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [renaming, setRenaming] = useState<ExerciseId | undefined>(undefined);
  const [preview, setPreview] = useState<Preview | undefined>(undefined);

  const trimmed = query.trim();
  const filtering = filters.bodyPart !== undefined || filters.equipment !== undefined;

  // Your exercises, best match first. A filter can only be answered for a row
  // linked to the library — an unlinked row has no body part or equipment on
  // record — so filtering hides unlinked rows rather than guessing.
  const mine = catalog
    .map((exercise) => ({ exercise, rank: PlanRuntime.rankExerciseMatch(exercise.name, query) }))
    .filter((hit): hit is { exercise: CatalogExercise; rank: number } => {
      if (hit.rank === undefined) return false;
      if (!filtering) return true;
      const linked = hit.exercise.libraryId === undefined ? undefined : library?.byId.get(hit.exercise.libraryId);
      return linked !== undefined && passesFilters(linked, filters);
    })
    .sort((a, b) => a.rank - b.rank || a.exercise.name.localeCompare(b.exercise.name))
    .map((hit) => hit.exercise);

  const libraryHits = useMemo(() => {
    if (library === undefined) return [];
    const linked = new Set(catalog.flatMap((exercise) => exercise.libraryId ?? []));
    const owned = new Set(catalog.map((exercise) => PlanRuntime.normalizeExerciseName(exercise.name)));
    return library.exercises
      .filter(
        (exercise) =>
          !linked.has(exercise.id) &&
          !owned.has(PlanRuntime.normalizeExerciseName(exercise.name)) &&
          passesFilters(exercise, filters),
      )
      .map((exercise) => ({ exercise, rank: rankLibraryMatch(exercise, query) }))
      .filter((hit): hit is { exercise: LibraryExercise; rank: number } => hit.rank !== undefined)
      .sort((a, b) => a.rank - b.rank)
      .map((hit) => hit.exercise);
  }, [library, catalog, filters, query]);

  // Exact under normalization — `face pull` must not offer to create a second
  // `Face Pull`, and must not offer to create a library exercise by hand either.
  const alreadyNamed =
    PlanRuntime.findExerciseByName(catalog, trimmed) !== undefined ||
    (library?.exercises.some(
      (exercise) => PlanRuntime.normalizeExerciseName(exercise.name) === PlanRuntime.normalizeExerciseName(trimmed),
    ) ??
      false);
  const offering = trimmed.length > 0 && !alreadyNamed;

  const mint = (name: string, libraryId?: string) => {
    setBusy(true);
    setError(undefined);
    onCreate(name, libraryId).then(
      () => {
        setBusy(false);
        onClose();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(describeFailure(cause));
      },
    );
  };

  const rename = (exerciseId: ExerciseId, name: string) => {
    setBusy(true);
    setError(undefined);
    authoring.rename(exerciseId, name).then(
      () => {
        setBusy(false);
        setRenaming(undefined);
        // The query that found the row was the OLD name, so leaving it in
        // place would filter the row the user just fixed off the screen —
        // rename would read as delete. Follow it instead.
        setQuery(name);
      },
      (cause: unknown) => {
        setBusy(false);
        setError(describeFailure(cause));
      },
    );
  };

  const setFilter = (key: keyof Filters, value: string | undefined) => {
    setFilters((current) => ({ ...current, [key]: current[key] === value ? undefined : value }));
    setShown(LIBRARY_PAGE);
  };

  const header = (
    <div className="border-b border-border">
      <div className="p-2 pb-1.5">
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setShown(LIBRARY_PAGE);
          }}
          placeholder="Search the catalog"
          aria-label="Search the catalog"
          className="h-tap w-full rounded-control border border-border bg-surface px-3 text-[0.9375rem]"
        />
      </div>
      <ChipRow label="Body part">
        {BODY_PARTS.map((part) => (
          <Chip
            key={part.value}
            on={filters.bodyPart === part.value}
            onClick={() => setFilter("bodyPart", part.value)}
          >
            {part.label}
          </Chip>
        ))}
        {/* Equipment folds away (UAT): two always-open chip rows cost the
            list a third of the sheet. The toggle names the active equipment
            filter while collapsed, so a hidden filter never silently narrows
            the list. */}
        <button
          onClick={() => setShowMore((current) => !current)}
          aria-expanded={showMore}
          className="h-7 shrink-0 rounded-control border border-dashed border-border-strong px-2 font-numeric text-[0.625rem] tracking-wider whitespace-nowrap text-text-muted uppercase"
        >
          {showMore ? "Fewer filters" : filters.equipment === undefined ? "More filters" : `More · ${filters.equipment}`}
        </button>
      </ChipRow>
      {showMore && (
        <ChipRow label="Equipment">
          {EQUIPMENT_GROUPS.map((group) => (
            <Chip
              key={group.label}
              on={filters.equipment === group.label}
              onClick={() => setFilter("equipment", group.label)}
            >
              {group.label}
            </Chip>
          ))}
        </ChipRow>
      )}
    </div>
  );

  return (
    <>
      <Sheet title="Exercise catalog" onClose={onClose} header={header} tall>
        {mine.length > 0 && <SectionLabel>Your exercises</SectionLabel>}
        <ul>
          {mine.map((exercise) => {
            const linked =
              exercise.libraryId === undefined ? undefined : library?.byId.get(exercise.libraryId);
            return renaming === exercise.id ? (
              <li key={exercise.id} className="border-b border-border px-4 py-3">
                <RenameRow
                  exercise={exercise}
                  busy={busy}
                  onSave={(name) => rename(exercise.id, name)}
                  onCancel={() => setRenaming(undefined)}
                />
              </li>
            ) : (
              <li key={exercise.id} className="flex items-center border-b border-border">
                <Thumbnail
                  library={library}
                  exercise={linked}
                  name={exercise.name}
                  onClick={linked === undefined ? undefined : () => setPreview({ exercise: linked, owned: exercise })}
                />
                <button
                  onClick={() => onPick(exercise)}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 py-3 pr-2 pl-3 text-left active:bg-surface-sunken"
                >
                  <span className="block w-full truncate text-[0.9375rem] font-medium">{exercise.name}</span>
                  {/* the catalog fact that will drive the set row is visible AT
                      pick time (story 29), so you know what you are about to be
                      asked for. A User-authored exercise has none yet — the
                      coach fills them in — so it says so rather than showing an
                      empty gap. */}
                  <span className="font-numeric text-[0.5625rem] tracking-widest text-text-muted uppercase">
                    {taken.has(exercise.id)
                      ? "already in this session"
                      : exercise.trackedMetrics.length === 0
                        ? "metrics not set yet"
                        : exercise.trackedMetrics.join(" · ")}
                  </span>
                </button>
                {/* Rename is the pressure valve that makes the coach's silent
                    enrichment safe (ADR 0016): a typo'd name would otherwise be
                    enriched into permanent nonsense. The id does not move, so
                    the Plan and every past Logged Session follow the row. */}
                <button
                  onClick={() => {
                    setError(undefined);
                    setRenaming(exercise.id);
                  }}
                  disabled={authoring.offline}
                  aria-label={`Rename ${exercise.name}`}
                  className="h-tap shrink-0 px-3 font-numeric text-[0.5625rem] tracking-widest text-text-muted uppercase underline underline-offset-4 disabled:text-text-faint disabled:no-underline"
                >
                  Rename
                </button>
              </li>
            );
          })}
        </ul>

        <SectionLabel>
          {libraryState.status === "ready"
            ? `Library · ${libraryHits.length} ${libraryHits.length === 1 ? "match" : "matches"}`
            : "Library"}
        </SectionLabel>
        {libraryState.status === "loading" && <Quiet>Loading the exercise library…</Quiet>}
        {libraryState.status === "failed" && (
          <Quiet>The exercise library did not load. Your exercises and creating by name still work.</Quiet>
        )}
        <ul>
          {libraryHits.slice(0, shown).map((exercise) => (
            <li key={exercise.id} className="border-b border-border">
              <button
                onClick={() => setPreview({ exercise, owned: undefined })}
                className="flex w-full items-center text-left active:bg-surface-sunken"
              >
                <Thumbnail library={library} exercise={exercise} name={exercise.name} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-3 pr-4 pl-3">
                  <span className="block truncate text-[0.9375rem]">{exercise.name}</span>
                  <span className="truncate font-numeric text-[0.5625rem] tracking-widest text-text-muted uppercase">
                    {exercise.target} · {exercise.equipment}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {libraryHits.length > shown && (
          <button
            onClick={() => setShown((current) => current + LIBRARY_PAGE)}
            className="h-tap w-full border-b border-border font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase underline underline-offset-4"
          >
            Show {Math.min(LIBRARY_PAGE, libraryHits.length - shown)} more of {libraryHits.length - shown}
          </button>
        )}
        {libraryState.status === "ready" && libraryHits.length === 0 && mine.length === 0 && !offering && (
          <Quiet>{trimmed.length === 0 ? "Nothing matches these filters." : `Nothing matches “${trimmed}”.`}</Quiet>
        )}

        {offering && (
          <>
            <SectionLabel>Not listed?</SectionLabel>
            <ul>
              <li>
                <button
                  onClick={() => mint(trimmed)}
                  disabled={authoring.offline || busy}
                  className="flex w-full items-center gap-2 border-b border-border px-4 py-3 text-left active:bg-surface-sunken disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1 text-[0.9375rem] font-medium">Create “{trimmed}”</span>
                  <span className="shrink-0 font-numeric text-[0.5625rem] tracking-widest text-text-muted uppercase">
                    {authoring.offline ? "needs a connection" : busy ? "creating…" : "custom exercise"}
                  </span>
                </button>
              </li>
            </ul>
          </>
        )}

        {authoring.offline && (
          <p className="border-b border-border px-4 py-2 font-numeric text-[0.625rem] leading-relaxed tracking-wide text-text-muted uppercase">
            New exercises need a connection to home. Your exercises can still be added.
          </p>
        )}
        {error !== undefined && preview === undefined && (
          <p className="border-b border-border px-4 py-2 text-sm text-caution">{error}</p>
        )}
        <p className="px-4 pt-3 font-numeric text-[0.5625rem] tracking-wide text-text-faint uppercase">
          {LIBRARY_ATTRIBUTION}
        </p>
      </Sheet>

      {preview !== undefined && library !== undefined && (
        <ExercisePreview
          library={library}
          exercise={preview.exercise}
          actionLabel={pickLabel}
          disabledReason={
            preview.owned !== undefined
              ? undefined
              : authoring.offline
                ? "Adding a library exercise needs a connection to home"
                : undefined
          }
          busy={busy}
          error={error}
          onAction={() => {
            if (preview.owned !== undefined) onPick(preview.owned);
            else mint(preview.exercise.name, preview.exercise.id);
          }}
          onClose={() => {
            setPreview(undefined);
            setError(undefined);
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ preview */

/**
 * One library exercise, animated, with what it trains and how it is done.
 * Reusable outside the picker — anywhere an Entry's exercise is linked — by
 * leaving `onAction` out.
 */
export function ExercisePreview({
  library,
  exercise,
  actionLabel,
  disabledReason,
  busy = false,
  error,
  onAction,
  onClose,
}: {
  readonly library: ExerciseLibrary;
  readonly exercise: LibraryExercise;
  readonly actionLabel?: string;
  readonly disabledReason?: string | undefined;
  readonly busy?: boolean;
  readonly error?: string | undefined;
  readonly onAction?: () => void;
  readonly onClose: () => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <Sheet title={exercise.name} onClose={onClose}>
      <div className="flex justify-center border-b border-border bg-white py-3">
        {failed ? (
          <p className="grid size-48 place-items-center px-4 text-center font-numeric text-[0.625rem] tracking-wide text-text-muted uppercase">
            The animation needs a connection
          </p>
        ) : (
          <img
            src={animationUrl(library, exercise)}
            alt={`${exercise.name} demonstration`}
            width={192}
            height={192}
            onError={() => setFailed(true)}
            className="size-48"
          />
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-b border-border px-4 py-3 text-sm">
        <Fact term="Target">{exercise.target}</Fact>
        {exercise.secondary.length > 0 && <Fact term="Also">{exercise.secondary.join(", ")}</Fact>}
        <Fact term="Equipment">{exercise.equipment}</Fact>
      </dl>
      {/* The action sits above the steps, so it is reachable without
          scrolling past instructions you may already know by heart. */}
      {onAction !== undefined && (
        <div className="border-b border-border p-3">
          <button
            onClick={onAction}
            disabled={disabledReason !== undefined || busy}
            className="h-tap w-full rounded-control bg-confirm px-4 font-numeric text-xs font-semibold tracking-widest text-canvas uppercase disabled:opacity-50"
          >
            {busy ? "Adding…" : actionLabel}
          </button>
          {disabledReason !== undefined && (
            <p className="mt-2 text-center font-numeric text-[0.625rem] tracking-wide text-text-muted uppercase">
              {disabledReason}
            </p>
          )}
          {error !== undefined && <p className="mt-2 text-center text-sm text-caution">{error}</p>}
        </div>
      )}
      {exercise.steps.length > 0 && (
        <ol className="list-decimal space-y-1.5 border-b border-border py-3 pr-4 pl-9 text-sm leading-normal text-text-muted">
          {exercise.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      )}
      <p className="px-4 pt-3 font-numeric text-[0.5625rem] tracking-wide text-text-faint uppercase">
        {LIBRARY_ATTRIBUTION}
      </p>
    </Sheet>
  );
}

/**
 * The animation affordance for one exercise outside the picker — a small
 * still that opens the preview. Renders nothing for an exercise with no
 * library link, so an unlinked Entry keeps exactly the header it had.
 */
export function ExerciseDemo({ exercise }: { readonly exercise: CatalogExercise | undefined }) {
  const libraryState = useExerciseLibrary();
  const [open, setOpen] = useState(false);
  if (libraryState.status !== "ready" || exercise?.libraryId === undefined) return null;
  const linked = libraryState.library.byId.get(exercise.libraryId);
  if (linked === undefined) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`How to do ${exercise.name}`}
        className="shrink-0 self-center"
      >
        <img
          src={thumbnailUrl(libraryState.library, linked)}
          alt=""
          width={36}
          height={36}
          className="size-9 rounded-control border border-border bg-white object-cover"
        />
      </button>
      {open && (
        <ExercisePreview library={libraryState.library} exercise={linked} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------- pieces */

/**
 * A row's 48px still. Linked rows get the library thumbnail (and, given
 * `onClick`, open the preview); an unlinked row gets its initial, so the
 * column still lines up and "no animation" reads as a fact, not a broken image.
 */
export function Thumbnail({
  library,
  exercise,
  name,
  onClick,
}: {
  readonly library: ExerciseLibrary | undefined;
  readonly exercise: LibraryExercise | undefined;
  readonly name: string;
  readonly onClick?: (() => void) | undefined;
}) {
  const [failed, setFailed] = useState(false);
  const image =
    library !== undefined && exercise !== undefined && !failed ? (
      <img
        src={thumbnailUrl(library, exercise)}
        alt=""
        loading="lazy"
        width={48}
        height={48}
        onError={() => setFailed(true)}
        className="size-12 rounded-control border border-border bg-white object-cover"
      />
    ) : (
      <span
        aria-hidden
        className="grid size-12 place-items-center rounded-control border border-dashed border-border font-numeric text-sm text-text-faint uppercase"
      >
        {name.charAt(0)}
      </span>
    );

  return onClick === undefined ? (
    <span className="shrink-0 py-1.5 pl-4">{image}</span>
  ) : (
    <button onClick={onClick} aria-label={`Preview ${name}`} className="shrink-0 py-1.5 pl-4">
      {image}
    </button>
  );
}

function ChipRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    // Wrapped, not a horizontal scroller: a scroller hid its last chips with
    // nothing on screen saying there was more (UAT).
    <div role="group" aria-label={label} className="flex flex-wrap gap-1 px-2 pb-1.5">
      {children}
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`h-7 shrink-0 rounded-control border px-2 font-numeric text-[0.625rem] tracking-wider whitespace-nowrap uppercase ${
        on ? "border-confirm bg-confirm font-semibold text-canvas" : "border-border text-text-muted"
      }`}
    >
      {children}
    </button>
  );
}

function SectionLabel({ children }: { readonly children: ReactNode }) {
  return (
    <h3 className="border-b border-border bg-surface-sunken px-4 py-1.5 font-numeric text-[0.5625rem] tracking-widest text-text-faint uppercase">
      {children}
    </h3>
  );
}

function Quiet({ children }: { readonly children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-text-muted">{children}</p>;
}

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="font-numeric text-[0.625rem] leading-5 tracking-widest text-text-faint uppercase">{term}</dt>
      <dd className="capitalize">{children}</dd>
    </>
  );
}

/** The inline rename editor for one catalog row. */
function RenameRow({
  exercise,
  busy,
  onSave,
  onCancel,
}: {
  readonly exercise: CatalogExercise;
  readonly busy: boolean;
  readonly onSave: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(exercise.name);
  const trimmed = draft.trim();

  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={`New name for ${exercise.name}`}
        className="h-tap min-w-0 flex-1 rounded-control border border-border bg-surface px-3 text-[0.9375rem]"
      />
      <button
        onClick={() => onSave(trimmed)}
        disabled={busy || trimmed.length === 0 || trimmed === exercise.name}
        className="h-tap shrink-0 px-3 font-numeric text-[0.5625rem] tracking-widest text-confirm uppercase disabled:text-text-faint"
      >
        Save name
      </button>
      <button
        onClick={onCancel}
        className="h-tap shrink-0 px-3 font-numeric text-[0.5625rem] tracking-widest text-text-muted uppercase"
      >
        Cancel
      </button>
    </div>
  );
}
