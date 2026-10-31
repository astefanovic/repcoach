import type {
  ActualMetricMap,
  CommandId,
  EntryId,
  ExerciseId,
  LoggedSessionId,
  MetricName,
  PrescribedBlock,
  PrescribedEntry,
  PrescribedSet,
  PrescribedTargetInterval,
  SessionId,
  SetId,
  SetType,
} from "@repcoach/contracts";

import type { NewQueuedSetActual, NewQueuedSwapExercise, NewQueuedUnlogSetActual } from "../outbox/model.ts";

/**
 * Task 6 (issue #20) — the logging grid's pure presentation/interaction
 * logic, pulled out of the React layer so Rung 1 (vitest) can exercise it
 * directly. `apps/web` (excluded from vitest's DOM-less environment) only
 * wires these functions to DOM components; every decision that matters —
 * ghost-text formatting, field layout, Block visibility, special-set
 * grouping, confirm -> outbox mapping — lives here.
 */

/** Ordered so a rendered row's fields follow a stable, predictable layout. */
const METRIC_ORDER: ReadonlyArray<MetricName> = [
  "reps",
  "load",
  "duration",
  "distance",
  "rpe",
  "tempo",
] as const;

/**
 * Field layout is driven by the declared metrics on the Set's prescribed
 * target map (CONTEXT `Exercise catalog`: "a set row renders exactly the
 * metrics the catalog declares") — a metric is only rendered when its key is
 * present, whether or not it carries a bound (an open `{}` still means
 * "tracked, report only").
 */
export function deriveSetFields(target: PrescribedSet["target"]): ReadonlyArray<MetricName> {
  return METRIC_ORDER.filter((metric) => target[metric] !== undefined);
}

/**
 * Ghost-text formatting for a prescribed target interval (CONTEXT `Set`):
 * both bounds equal -> exact ("8"); differing -> a range ("8-10"); only a
 * lower bound -> "8+"; only an upper bound -> a cap ("<=10" for most
 * metrics, "<=8 RPE" for effort so the cap reads naturally); entirely open
 * `{}` -> "report effort" (no numeric target — logging still shows the field
 * so the user can record it).
 */
export function formatGhostText(
  metric: MetricName,
  interval: PrescribedTargetInterval | undefined,
): string {
  if (interval === undefined) {
    return "";
  }
  const { min, max } = interval;
  if (min === undefined && max === undefined) {
    return metric === "rpe" ? "report effort" : "report";
  }
  if (min !== undefined && max !== undefined) {
    return min === max ? `${min}` : `${min}-${max}`;
  }
  if (min !== undefined) {
    return `${min}+`;
  }
  return metric === "rpe" ? `<=${max} RPE` : `<=${max}`;
}

/**
 * One-tap confirm (ui-surfaces.md "Logging (in-workout)"): resolves to the
 * **top of the range** for double-progression intent (min===max is the exact
 * case, both resolve the same); a one-sided lower bound ("8+") has no upper
 * bound to resolve to, so it falls back to the lower bound itself; an open
 * interval (`{}`, "report effort, no target") has nothing to fill and is
 * left absent — the user must type a value.
 */
export function resolveGhostActual(
  target: PrescribedSet["target"],
): ActualMetricMap {
  const actual: Record<string, number> = {};
  for (const metric of deriveSetFields(target)) {
    const interval = target[metric];
    if (interval === undefined) continue;
    const value = interval.max ?? interval.min;
    if (value !== undefined) {
      actual[metric] = value;
    }
  }
  return actual as ActualMetricMap;
}

/**
 * Where the editor OPENS for a metric the prescription says nothing about
 * (#113 item 4): the most recent actual the user logged for that metric on an
 * *earlier Set of the same Entry*.
 *
 * An unprescribed load used to open the stepper at 0 on every set, so a
 * three-set exercise with no prescribed load cost the user the whole climb
 * three times. Where the prescription is silent, the last thing they actually
 * did is the best guess available.
 *
 * Three boundaries, all deliberate:
 *
 * - **Same Entry only.** A bench load is not a curl load, and the nearest
 *   logged number from a different exercise is worse than no number at all.
 * - **This logged Session only.** The cross-session question ("what did I lift
 *   last week") is a history read, and this is a client-side derivation over
 *   the sets already on screen — no RPC, no new prescription copy.
 * - **A seed, not a ghost.** This is where the editor starts, and nothing
 *   more: the row still renders `–` for an unprescribed metric (nothing is
 *   being suggested), and one tap on ✓ still must not write a load nobody
 *   prescribed. Only a user who opens the editor and commits ever turns this
 *   number into an actual, which is what keeps it a convenience rather than
 *   the app quietly authoring prescription.
 */
export function seedFromPreviousSet(
  sets: ReadonlyArray<PrescribedSet>,
  setId: PrescribedSet["id"],
  metric: MetricName,
  actuals: ReadonlyMap<PrescribedSet["id"], { readonly actual: ActualMetricMap }>,
): number | undefined {
  return previousSeedSet(sets, setId, metric, actuals)?.value;
}

/** An earlier Set of this Entry and the value it logged for one metric — what both "repeat the previous Set" walks return, so `suggestMetric` can ask which Set a carried number came from. */
interface PreviousLogged {
  readonly set: PrescribedSet;
  readonly value: number;
}

function previousSeedSet(
  sets: ReadonlyArray<PrescribedSet>,
  setId: PrescribedSet["id"],
  metric: MetricName,
  actuals: ReadonlyMap<PrescribedSet["id"], { readonly actual: ActualMetricMap }>,
): PreviousLogged | undefined {
  const index = sets.findIndex((set) => set.id === setId);
  if (index < 0) {
    return undefined;
  }
  // Backwards from the set BEFORE this one — "most recent" is the nearest
  // earlier set that carries the metric, not the first one that does.
  for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
    const candidate = sets[earlier];
    if (candidate === undefined) continue;
    const logged = actuals.get(candidate.id)?.actual[metric];
    if (logged !== undefined) {
      return { set: candidate, value: logged };
    }
  }
  return undefined;
}

/**
 * The seed for a metric the prescription does **not** bound (issue #149),
 * two tiers, tier 1 winning:
 *
 * 1. **`seedFromPreviousSet`** — the most recent actual for this metric on an
 *    earlier Set of this Entry, this session. Offline, no RPC.
 * 2. **`lastUse`** — the most recent actual for this metric the last time
 *    this Exercise was *performed* (swap-aware, ADR 0019), from
 *    `logging.lastActualForExercise`. A finished-session read; `undefined`
 *    when offline or unreachable, which just means tier 1 (or nothing)
 *    governs.
 *
 * `undefined` when neither tier has a value — the row then still renders `–`
 * and one tap on ✓ writes nothing for that metric.
 *
 * This is the single seeding entry point (#149 constraint: "reuse
 * `seedFromPreviousSet` rather than growing a second seeding path"); tier 2
 * is a fallback *under* it, not a parallel path.
 */
export function seedUnprescribedMetric(
  sets: ReadonlyArray<PrescribedSet>,
  setId: PrescribedSet["id"],
  metric: MetricName,
  actuals: ReadonlyMap<PrescribedSet["id"], { readonly actual: ActualMetricMap }>,
  lastUse: ReadonlyMap<MetricName, number> | undefined,
): number | undefined {
  return seedFromPreviousSet(sets, setId, metric, actuals) ?? lastUse?.get(metric);
}

/**
 * What ✓ writes for a PRESCRIBED metric once an earlier Set of this Entry has
 * been logged (UAT): the previous Set's actual, not the prescription again.
 * Logging 62.5kg × 9 against "60kg × 8-10" and then tapping ✓ on the next Set
 * means "same again" far more often than "back to the plan", and writing 60 ×
 * 10 made every set after an adjustment cost the same edits twice.
 *
 * Carries only between Sets that were prescribed alike, so it never
 * overrides a prescription that deliberately moved:
 *
 * - **Same Set type.** A warmup's load is not a working set's, and a drop
 *   set's is lighter by definition.
 * - **Same target for this metric.** A ramp or a pyramid prescribes a
 *   different number per Set on purpose; there, the plan's number stands.
 * - **Not RPE.** Effort is reported after the fact, never repeated.
 *
 * Unprescribed metrics are not this function's business — `oneTapActual`
 * seeds those through `seedUnprescribedMetric` (#149), unchanged.
 */
export function carryForwardPrescribedMetric(
  sets: ReadonlyArray<PrescribedSet>,
  setId: PrescribedSet["id"],
  metric: MetricName,
  actuals: ReadonlyMap<PrescribedSet["id"], { readonly actual: ActualMetricMap }>,
): number | undefined {
  return previousCarrySet(sets, setId, metric, actuals)?.value;
}

function previousCarrySet(
  sets: ReadonlyArray<PrescribedSet>,
  setId: PrescribedSet["id"],
  metric: MetricName,
  actuals: ReadonlyMap<PrescribedSet["id"], { readonly actual: ActualMetricMap }>,
): PreviousLogged | undefined {
  if (metric === "rpe") return undefined;
  const index = sets.findIndex((set) => set.id === setId);
  const current = sets[index];
  if (current === undefined) return undefined;
  const target = current.target[metric];
  if (!isBounded(target)) {
    return undefined;
  }
  for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
    const candidate = sets[earlier];
    if (candidate === undefined || candidate.setType !== current.setType) continue;
    const candidateTarget = candidate.target[metric];
    if (candidateTarget?.min !== target.min || candidateTarget?.max !== target.max) continue;
    const logged = actuals.get(candidate.id)?.actual[metric];
    if (logged !== undefined) return { set: candidate, value: logged };
  }
  return undefined;
}

/** Whether a prescription writes a number for this metric — `false` for an absent metric and for an open `{}` ("report"). */
function isBounded(interval: PrescribedTargetInterval | undefined): interval is PrescribedTargetInterval {
  return interval !== undefined && (interval.min !== undefined || interval.max !== undefined);
}

/**
 * One Set from the last time an Exercise was performed, in the order it sat
 * on its Entry — `logging.lastActualForExercise`'s `sets`.
 */
export interface LastTimeSet {
  readonly setType: SetType;
  readonly actual: ActualMetricMap;
  /** What that Set was prescribed that day; absent for a Set the prescription never held. */
  readonly target?: PrescribedSet["target"];
}

/**
 * What this Set's counterpart lifted last time (UAT): the Set of the same
 * type at the same position among this Entry's Sets of that type. Working
 * Set 2 reads last time's working Set 2, the first warmup reads last time's
 * first warmup, a drop reads last time's drop.
 *
 * Positional because a session is usually a descent (10, 9, 8 at one load).
 * One "last value" for every row would suggest the tired final Set for all of
 * them, or a drop set's load for a working Set. Past the end of last time's
 * Sets of this type, the last one repeats: a fourth working Set where last
 * time had three is "the third again".
 *
 * `undefined` when there is no history (never performed, offline, still
 * loading) or last time had no Set of this type.
 */
export function lastTimeActual(
  sets: ReadonlyArray<PrescribedSet>,
  setId: PrescribedSet["id"],
  lastTime: ReadonlyArray<LastTimeSet> | undefined,
): ActualMetricMap | undefined {
  return lastTimeSet(sets, setId, lastTime)?.actual;
}

function lastTimeSet(
  sets: ReadonlyArray<PrescribedSet>,
  setId: PrescribedSet["id"],
  lastTime: ReadonlyArray<LastTimeSet> | undefined,
): LastTimeSet | undefined {
  if (lastTime === undefined) return undefined;
  const index = sets.findIndex((set) => set.id === setId);
  const current = sets[index];
  if (current === undefined) return undefined;
  const ordinal = sets.slice(0, index).filter((set) => set.setType === current.setType).length;
  const sameType = lastTime.filter((set) => set.setType === current.setType);
  if (sameType.length === 0) return undefined;
  return sameType[Math.min(ordinal, sameType.length - 1)];
}

/**
 * Last time's value for one metric of one Set, unless the plan has moved
 * that metric since (UAT). When the Set's prescription for the metric is not
 * what it was the day last time's number was lifted, the plan changed on
 * purpose (an accepted Proposal raising the load, or the user's own edit),
 * and repeating last time would hide the change the user just agreed to. So
 * the plan's number shows instead. A Set last time that the prescription
 * never held (unplanned, or an added exercise) has nothing to compare with
 * and keeps its history.
 */
function historyValue(
  sets: ReadonlyArray<PrescribedSet>,
  setId: PrescribedSet["id"],
  metric: MetricName,
  lastTime: ReadonlyArray<LastTimeSet> | undefined,
): number | undefined {
  const then = lastTimeSet(sets, setId, lastTime);
  if (then === undefined) return undefined;
  if (then.target !== undefined) {
    const before = then.target[metric];
    const after = sets.find((set) => set.id === setId)?.target[metric];
    if (before?.min !== after?.min || before?.max !== after?.max) return undefined;
  }
  return then.actual[metric];
}

/**
 * The number a row suggests for one metric before it is logged (UAT): what
 * was lifted last time, not the plan's range.
 *
 * Two sources, and which one wins is the whole decision:
 *
 * - **Last time** (`lastTimeActual`): this Set's counterpart from the last
 *   time the Exercise was performed.
 * - **This session's previous Set**: the same walk ✓ already used to repeat
 *   the last set (`carryForwardPrescribedMetric` for a prescribed metric,
 *   `seedFromPreviousSet` for an open one).
 *
 * Last time gives way to the plan for any metric whose prescription has
 * moved since that day (`historyValue`): an accepted Proposal's new load is
 * what the row shows.
 *
 * While the user is matching last time, each Set keeps its own history, so a
 * 10-9-8 descent is suggested as 10-9-8 and not 10-10-10. Once they depart
 * from it (the previous Set logged something other than *its* last time),
 * the departure carries forward: a heavier load on set 1 usually means "same
 * again", not "back to last week's". With no history for the previous Set it
 * carries exactly as it did before history existed.
 *
 * Never effort. RPE is reported after the fact, and a number from last time
 * would be answering the question for the user.
 */
export function suggestMetric(
  sets: ReadonlyArray<PrescribedSet>,
  setId: PrescribedSet["id"],
  metric: MetricName,
  actuals: ReadonlyMap<PrescribedSet["id"], { readonly actual: ActualMetricMap }>,
  lastTime: ReadonlyArray<LastTimeSet> | undefined,
): number | undefined {
  if (metric === "rpe") return undefined;
  const current = sets.find((set) => set.id === setId);
  if (current === undefined) return undefined;
  const own = historyValue(sets, setId, metric, lastTime);
  const previous = isBounded(current.target[metric])
    ? previousCarrySet(sets, setId, metric, actuals)
    : previousSeedSet(sets, setId, metric, actuals);
  if (previous !== undefined) {
    const previousOwn = historyValue(sets, previous.set.id, metric, lastTime);
    if (own === undefined || previousOwn === undefined || previous.value !== previousOwn) {
      return previous.value;
    }
  }
  return own;
}

/**
 * The Entry for an exercise added mid-workout (UAT). Nothing is prescribed
 * behind it, so every metric the catalog tracks is open (`{}`, "report") and
 * the numbers come from `suggestMetric`: last time, or nothing.
 *
 * Its Set ids are derived from the Entry id rather than minted, so the rows
 * rebuilt after a reload are the same rows the actuals were logged against.
 * Effort stays off the target because RPE is asked after the fact, as on
 * every other Set. A catalog row nobody has described yet (a user-authored
 * name, ADR 0016) tracks nothing, and reps and load is the honest default for
 * a lift.
 */
export function addedEntry(args: {
  readonly entryId: EntryId;
  readonly exerciseId: ExerciseId;
  readonly trackedMetrics: ReadonlyArray<MetricName>;
  readonly setCount: number;
  readonly restSec?: number | undefined;
}): PrescribedEntry {
  const tracked = args.trackedMetrics.filter((metric) => metric !== "rpe");
  const metrics: ReadonlyArray<MetricName> = tracked.length > 0 ? tracked : ["reps", "load"];
  const target = Object.fromEntries(metrics.map((metric) => [metric, {}])) as PrescribedSet["target"];
  return {
    id: args.entryId,
    exerciseId: args.exerciseId,
    sets: Array.from({ length: Math.max(1, args.setCount) }, (_, index) => ({
      id: `${args.entryId}:${index + 1}` as SetId,
      setType: "working" as const,
      target,
      ...(args.restSec === undefined ? {} : { restSec: args.restSec }),
    })),
  };
}

/**
 * What one tap on ✓ writes (issue #149, decision (a)): the prescribed
 * resolution (`resolveGhostActual` — ranges to their top) for every metric
 * the prescription bounds, plus a **seed** for every rendered metric it
 * leaves open, from `seedUnprescribedMetric`. A seed only ever fills a
 * metric `resolveGhostActual` left absent.
 *
 * What outranks the prescription (UAT) is `suggestMetric`: what this Set's
 * counterpart lifted last time, or what the previous like-prescribed Set
 * logged this session once the user has departed from last time. The plan's
 * range is only the answer for an exercise with no history.
 *
 * A metric with neither a bound nor a seed is still absent from the result —
 * ✓ never invents a number for it (the row shows `–`, and the user must type
 * one).
 */
export function oneTapActual(
  target: PrescribedSet["target"],
  sets: ReadonlyArray<PrescribedSet>,
  setId: PrescribedSet["id"],
  actuals: ReadonlyMap<PrescribedSet["id"], { readonly actual: ActualMetricMap }>,
  lastUse: ReadonlyMap<MetricName, number> | undefined,
  lastTime?: ReadonlyArray<LastTimeSet> | undefined,
): ActualMetricMap {
  const resolved = resolveGhostActual(target);
  const out: Record<string, number> = { ...resolved };
  for (const metric of deriveSetFields(target)) {
    const suggested = suggestMetric(sets, setId, metric, actuals, lastTime);
    if (suggested !== undefined) out[metric] = suggested;
    if (out[metric] !== undefined) continue;
    const seed = seedUnprescribedMetric(sets, setId, metric, actuals, lastUse);
    if (seed !== undefined) out[metric] = seed;
  }
  return out as ActualMetricMap;
}

/**
 * Block wrapper visibility (CONTEXT `Block`): a plain single-exercise
 * straight Block is a real data node but never shown as a wrapper in the UI —
 * it surfaces only when it groups multiple exercises (superset/circuit) or
 * uses a timed format (EMOM/AMRAP), even if that timed Block happens to hold
 * only one Entry.
 */
export function isBlockWrapperVisible(block: PrescribedBlock): boolean {
  if (block.format !== "straight") {
    return true;
  }
  return block.entries.length > 1;
}

/** Human-readable label for a visible Block's wrapper header. */
export function blockWrapperLabel(block: PrescribedBlock): string {
  switch (block.format) {
    case "superset":
      return "Superset";
    case "circuit":
      return "Circuit";
    case "emom":
      return "EMOM";
    case "amrap":
      return "AMRAP";
    case "straight":
      return "";
  }
}

/** Set-types that are read as a continuation of the nearest preceding working Set (CONTEXT `Set`). */
const CONTINUATION_SET_TYPES: ReadonlySet<SetType> = new Set(["drop", "rest-pause", "myo-cluster"]);

export function isContinuationSetType(setType: SetType): boolean {
  return CONTINUATION_SET_TYPES.has(setType);
}

/** A working Set plus any special-type Sets that continue it (adjacency + tag, CONTEXT `Set`). */
export interface SetGroup {
  readonly anchor: PrescribedSet;
  readonly continuations: ReadonlyArray<PrescribedSet>;
}

/**
 * Groups an Entry's ordered prescribed Sets into working-Set anchors plus
 * their trailing continuations (drop / rest-pause / myo-cluster). A
 * continuation appearing before any working Set (malformed prescription) is
 * kept as its own anchorless group rather than dropped, so nothing silently
 * disappears from the grid.
 */
export function groupSetsWithContinuations(
  sets: ReadonlyArray<PrescribedSet>,
): ReadonlyArray<SetGroup> {
  const groups: SetGroup[] = [];
  for (const set of sets) {
    if (isContinuationSetType(set.setType) && groups.length > 0) {
      const last = groups[groups.length - 1]!;
      groups[groups.length - 1] = { ...last, continuations: [...last.continuations, set] };
      continue;
    }
    groups.push({ anchor: set, continuations: [] });
  }
  return groups;
}

/**
 * "Another straight set" (#115 item 1, ADR 0017): an unplanned Set that
 * echoes the Entry's last working Set's prescription verbatim — same target,
 * same rest, a fresh id supplied by the caller (client-minted, the same way
 * every other id is). It carries no link back to any prescribed node; the
 * echo is recomputed from `sets` on every call, including after a reload, so
 * nothing about it needs to be persisted beyond the actual itself.
 *
 * The anchor is the *last* Set that is not itself a continuation (drop /
 * rest-pause / myo-cluster), so appending several straight sets in a row, or
 * appending one after a continuation, both echo the true working prescription
 * rather than a drop set's reduced load.
 */
export function anotherStraightSet(sets: ReadonlyArray<PrescribedSet>, setId: SetId): PrescribedSet {
  const anchor = lastWorkingAnchor(sets);
  return {
    id: setId,
    setType: "working",
    target: anchor?.target ?? {},
    ...(anchor?.restSec === undefined ? {} : { restSec: anchor.restSec }),
  };
}

/** The last Set that is not itself a continuation, or the last Set of any type if every Set is one — shared by every echo builder below so a run of continuations always echoes the true working prescription. */
function lastWorkingAnchor(sets: ReadonlyArray<PrescribedSet>): PrescribedSet | undefined {
  return [...sets].reverse().find((set) => !isContinuationSetType(set.setType)) ?? sets[sets.length - 1];
}

/** Fixed short rest for a rest-pause continuation (#129 item 1) — "short pause" is stated relative to the working rest, not derived from it, so it stays short even when the anchor's own `restSec` is long. */
const REST_PAUSE_REST_SEC = 15;

/** Fixed short rest between a myo-cluster's mini-clusters (#129 item 1) — shorter than a rest-pause's, since the whole point of clustering is barely resting at all. */
const MYO_CLUSTER_REST_SEC = 10;

/**
 * "Another drop set" (#129 item 1, ticket's load-bearing question 1): echoes
 * the anchor's target verbatim EXCEPT `load`, which is left open (`{}`) —
 * "reduced load" is the whole point of a drop, and the user has not chosen
 * the reduced number yet, so nothing here should guess it. `restSec` is
 * forced to 0 rather than echoed: a drop is taken immediately, never after
 * the anchor's working rest.
 */
export function anotherDropSet(sets: ReadonlyArray<PrescribedSet>, setId: SetId): PrescribedSet {
  const anchor = lastWorkingAnchor(sets);
  const target = anchor?.target ?? {};
  return {
    id: setId,
    setType: "drop",
    target: target.load === undefined ? target : { ...target, load: {} },
    restSec: 0,
  };
}

/**
 * "Another rest-pause set" (#129 item 1): echoes the anchor's target
 * verbatim — unlike a drop, the load does not change, only the rest does —
 * with `restSec` fixed at `REST_PAUSE_REST_SEC` regardless of the anchor's
 * own rest.
 */
export function anotherRestPauseSet(sets: ReadonlyArray<PrescribedSet>, setId: SetId): PrescribedSet {
  const anchor = lastWorkingAnchor(sets);
  return {
    id: setId,
    setType: "rest-pause",
    target: anchor?.target ?? {},
    restSec: REST_PAUSE_REST_SEC,
  };
}

/**
 * "Another myo-cluster" (#129 item 1): echoes the anchor's target verbatim —
 * same load as a rest-pause — with `restSec` fixed at `MYO_CLUSTER_REST_SEC`,
 * shorter than a rest-pause's, matching the mini-cluster's barely-resting
 * character.
 */
export function anotherMyoClusterSet(sets: ReadonlyArray<PrescribedSet>, setId: SetId): PrescribedSet {
  const anchor = lastWorkingAnchor(sets);
  return {
    id: setId,
    setType: "myo-cluster",
    target: anchor?.target ?? {},
    restSec: MYO_CLUSTER_REST_SEC,
  };
}

/**
 * Dispatches to the right echo builder for a given `setType` — the single
 * seam both the "+" sheet (adding a fresh unplanned Set) and orphan
 * reconstruction after a reload (#129 item 2, mirroring ADR 0017's `entryId`
 * fix, this time for `setType`) go through, so the two can never drift.
 * `warmup` has no echo builder of its own — the sheet never offers it and no
 * continuation reconstructs as one — so it falls back to the straight-set
 * echo like `working` does.
 */
export function anotherSetOfType(
  setType: SetType,
  sets: ReadonlyArray<PrescribedSet>,
  setId: SetId,
): PrescribedSet {
  switch (setType) {
    case "drop":
      return anotherDropSet(sets, setId);
    case "rest-pause":
      return anotherRestPauseSet(sets, setId);
    case "myo-cluster":
      return anotherMyoClusterSet(sets, setId);
    case "working":
    case "warmup":
      return anotherStraightSet(sets, setId);
  }
}

/**
 * Cancel eligibility (issue #114 Part 1, mirrored server-side by
 * `LoggedSessionHasActualsError`): a session may be cancelled only while it
 * is still active and carries zero confirmed Sets. Once either flips —
 * finished, backfilled, or a Set is logged — cancel stops being offered.
 */
export function canCancelSession(args: { readonly live: boolean; readonly confirmedCount: number }): boolean {
  return args.live && args.confirmedCount === 0;
}

/**
 * Parses a metric-field draft (issue #113 item 3's keypad popover) into the
 * value ✓/Enter would commit, or `undefined` when the draft does not commit
 * — empty, non-numeric, or negative. A comma is accepted as a decimal
 * separator (most phone keypads outside en-US default), so "62,5" is not
 * rejected for the punctuation the keyboard itself offered.
 */
export function parseMetricDraft(draft: string): number | undefined {
  const trimmed = draft.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The stepper's ±step nudge: steps from the draft's current committable
 * value, falling back to the field's starting value when the draft does not
 * currently commit (e.g. mid-edit, cleared). Clamped at 0 — no metric goes
 * negative — and rounded to 2 decimals so repeated fractional steps (a 2.5kg
 * plate, say) do not drift on floating-point error.
 */
export function nudgeMetricValue(current: number | undefined, start: number, delta: number): number {
  return Math.max(0, +((current ?? start) + delta).toFixed(2));
}

/**
 * Confirm -> outbox mapping: builds the enqueue-ready command for a logged
 * Set. `makeCommandId` is called **exactly once** per confirm — the caller
 * (the React row) must not regenerate a commandId across re-renders of the
 * same confirm action, since the outbox's exactly-once discipline (Task 4)
 * is keyed on it.
 */
export function buildConfirmCommand(args: {
  readonly makeCommandId: () => CommandId;
  readonly loggedSessionId: LoggedSessionId;
  readonly sessionId: SessionId;
  readonly entryId: EntryId;
  readonly setId: SetId;
  readonly setType: SetType;
  readonly actual: ActualMetricMap;
}): NewQueuedSetActual {
  const commandId = args.makeCommandId();
  return {
    kind: "logSetActual",
    commandId,
    loggedSessionId: args.loggedSessionId,
    sessionId: args.sessionId,
    entryId: args.entryId,
    setId: args.setId,
    setType: args.setType,
    actual: args.actual,
  };
}

/**
 * Confirm -> outbox mapping for a retraction (#83, ADR 0019), mirroring
 * `buildConfirmCommand`: tapping an already-logged Set's confirm again
 * un-logs it. `commandId` is minted **once**, here, by the caller's
 * `makeCommandId` — never regenerated across re-renders of the same tap. No
 * metric map, no `setType`/`sessionId` — a retraction carries only the
 * identity of the Set it retracts (see ADR 0019, migration `020`).
 */
export function buildUnlogCommand(args: {
  readonly makeCommandId: () => CommandId;
  readonly loggedSessionId: LoggedSessionId;
  readonly entryId: EntryId;
  readonly setId: SetId;
}): NewQueuedUnlogSetActual {
  const commandId = args.makeCommandId();
  return {
    kind: "unlogSetActual",
    commandId,
    loggedSessionId: args.loggedSessionId,
    entryId: args.entryId,
    setId: args.setId,
  };
}

/**
 * Swap eligibility (ADR 0019): offered only while the Entry has zero logged
 * Sets — the cheapest defensible answer to "what happens to already-logged
 * Sets" a swap could disturb. `entryId` bucketing over the actuals map is
 * exactly ADR 0017's `entryId`-carried-by-value pattern, reused rather than
 * walking `entry.sets` (which cannot see an unplanned Set's client-minted
 * id).
 */
export function canSwapEntry(
  entryId: EntryId,
  actuals: Iterable<{ readonly entryId: EntryId }>,
): boolean {
  for (const actual of actuals) {
    if (actual.entryId === entryId) return false;
  }
  return true;
}

/**
 * Confirm -> outbox mapping for a swap (ADR 0019), mirroring
 * `buildConfirmCommand`: the `commandId` is minted **once**, here, by the
 * caller's `makeCommandId` — never regenerated across re-renders of the same
 * swap action, since the outbox's exactly-once discipline is keyed on it.
 */
export function buildSwapCommand(args: {
  readonly makeCommandId: () => CommandId;
  readonly loggedSessionId: LoggedSessionId;
  readonly entryId: EntryId;
  readonly exerciseId: ExerciseId;
}): NewQueuedSwapExercise {
  const commandId = args.makeCommandId();
  return {
    kind: "swapExercise",
    commandId,
    loggedSessionId: args.loggedSessionId,
    entryId: args.entryId,
    exerciseId: args.exerciseId,
  };
}
