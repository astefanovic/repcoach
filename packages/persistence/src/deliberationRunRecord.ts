import type {
  DeliberationCadence,
  DeliberationDataWindow,
  DeliberationRunDecision,
  DeliberationRunOutcome,
  DeliberationRunRecord,
  DeliberationRunStage,
  DeliberationRunStageState,
} from "@repcoach/contracts";

/**
 * Assembling the Coach record's run history out of the three things that
 * record a run: the `deliberation_run` row, the Decisions it committed, and
 * the run-ledger rows its agent sessions left behind.
 *
 * Shared by both `Store` layers for the same reason `summarizeRunLedger` is:
 * the SQL store is what the dev-server and production run on, the in-memory
 * store is what most tests run on, and a record that grouped runs differently
 * in the two would make every test about it a test of the wrong thing.
 *
 * The interesting work is not the grouping — it is the **two kinds of history
 * this has to present as one list**:
 *
 * - Runs with a row of their own, which can say they emitted nothing, or that
 *   they failed, or that they are happening right now.
 * - Runs that predate the row and can only be **reconstructed** from the
 *   `data_window_json` every Decision they committed carries. Those are
 *   recoverable exactly when they committed something — which is why the row
 *   exists at all, and why a reconstruction never pretends to more than it has
 *   (no stages, always `committed`, always at least one Decision).
 */

/** One `deliberation_run` row, in the shape both stores can hand over. */
export interface DeliberationRunRecordInput {
  readonly runId: string;
  readonly cadence: DeliberationCadence;
  readonly status: "running" | "committed" | "failed";
  readonly failureReason: string | undefined;
  readonly dataWindowJson: string | undefined;
  readonly startedAt: string;
  readonly finishedAt: string | undefined;
}

/** One committed Decision, as the grouping needs to see it. */
export interface DeliberationRunDecisionInput {
  readonly decisionId: string;
  readonly kind: string;
  readonly status: string;
  readonly summary: string;
  readonly createdAt: string;
  /** The run it belongs to, or `undefined` for every row written before run rows existed. */
  readonly runId: string | undefined;
  /** Verbatim `data_window_json` — the only thing that can reconstruct a pre-run-row run. */
  readonly dataWindowJson: string | undefined;
  /** The user's Revise prose (ADR 0013 §1/§9), stamped on every row of a Revision run. */
  readonly reviseProse: string | undefined;
}

/**
 * The stages a review or Revision run is made of (ADR 0011 §1) — always both,
 * always in this order, because "the sweep never ran" is a thing the record
 * has to be able to say, and a stage list built only from the ledger rows that
 * exist could never say it.
 */
const REVIEW_STAGES: ReadonlyArray<DeliberationRunStage> = ["deliberator", "sweep"];

/**
 * A `data_window_json` string parsed back into an envelope, or `undefined` if
 * it is not one.
 *
 * The `undefined` case is load-bearing rather than defensive: `decision` also
 * holds `kind='change'` rows whose `data_window_json` is a plain
 * `{acceptedProposalId}` or `{setId,target}` marker (ADR 0008's applied-change
 * rows), and those are the *effect* of a Decision, not the output of a
 * Deliberation run. Keying on the envelope's own required fields is what keeps
 * them out without a second column to ask.
 */
export const parseDeliberationDataWindow = (
  json: string | undefined,
): DeliberationDataWindow | undefined => {
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Partial<DeliberationDataWindow>;
  return typeof candidate.cadence === "string" &&
    typeof candidate.ran_at === "string" &&
    Array.isArray(candidate.session_ids_considered)
    ? (candidate as DeliberationDataWindow)
    : undefined;
};

/**
 * How far each stage of a run got, from which stages left a ledger row.
 *
 * The three outcomes read the same evidence differently, and each reading is a
 * claim the surface then makes out loud:
 *
 * - **running** — a stage with a ledger row is `done`, the first one without is
 *   what the run is doing *now*, and anything after it has not started.
 * - **committed** — every stage ran, whatever the ledger says. The ledger write
 *   is best-effort by ADR 0011 §6 (it must never fail the run it records), so a
 *   missing row means the bookkeeping was dropped, not that the sweep was
 *   skipped — and the sweep is never skipped (ADR 0011 §8). Reporting `not-run`
 *   here would turn a lost cost row into a false claim about the trust floor.
 * - **failed** — the opposite reading, for the opposite reason: the run did not
 *   finish, so a stage with no row is one that genuinely never completed.
 */
const stageStates = (
  status: DeliberationRunOutcome,
  ledgerStages: ReadonlySet<string>,
): ReadonlyArray<{ readonly stage: DeliberationRunStage; readonly state: DeliberationRunStageState }> => {
  let runningAssigned = false;
  return REVIEW_STAGES.map((stage) => {
    if (ledgerStages.has(stage)) return { stage, state: "done" as const };
    if (status === "committed") return { stage, state: "done" as const };
    if (status === "running" && !runningAssigned) {
      runningAssigned = true;
      return { stage, state: "running" as const };
    }
    return { stage, state: "not-run" as const };
  });
};

const toRunDecision = (input: DeliberationRunDecisionInput): DeliberationRunDecision =>
  ({
    decisionId: input.decisionId,
    kind: input.kind,
    status: input.status,
    summary: input.summary,
    createdAt: input.createdAt,
  }) as DeliberationRunDecision;

const byCreatedAt = (a: DeliberationRunDecisionInput, b: DeliberationRunDecisionInput) =>
  a.createdAt.localeCompare(b.createdAt) || a.decisionId.localeCompare(b.decisionId);

/**
 * Every run the store can account for, newest first.
 *
 * Ordering is on `startedAt`, which puts a run in flight at the top — the
 * prototype's whole claim about this surface, that watching a run and reading
 * it afterwards are the same list, depends on the live run being the first
 * element rather than a separate banner above the list.
 *
 * One honest imprecision, named rather than hidden: a **reconstructed** run's
 * `startedAt` is its `ran_at`, which is stamped at commit time and so sits
 * minutes after the run actually began. It only ever affects the relative
 * order of two runs that started within one run's duration of each other, and
 * only among history old enough to predate run rows — the alternative would be
 * inventing a start time no one recorded.
 */
export const assembleDeliberationRuns = (
  runs: ReadonlyArray<DeliberationRunRecordInput>,
  decisions: ReadonlyArray<DeliberationRunDecisionInput>,
  /** `runId` → the stages that left a ledger row, from `deliberation_run_ledger`. */
  ledgerStagesByRun: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyArray<DeliberationRunRecord> => {
  const decisionsByRun = new Map<string, Array<DeliberationRunDecisionInput>>();
  /** Keyed by the verbatim `data_window_json` the run's rows share. */
  const reconstructed = new Map<string, Array<DeliberationRunDecisionInput>>();

  for (const decision of decisions) {
    if (decision.runId !== undefined) {
      const existing = decisionsByRun.get(decision.runId);
      if (existing === undefined) decisionsByRun.set(decision.runId, [decision]);
      else existing.push(decision);
      continue;
    }
    // No run row to belong to. It can still be grouped if it carries a real
    // provenance envelope — every Decision one run committed carries the SAME
    // one, byte for byte, because the runner assembles it once per run and
    // hands the same object to every insert.
    if (decision.dataWindowJson === undefined) continue;
    if (parseDeliberationDataWindow(decision.dataWindowJson) === undefined) continue;
    const existing = reconstructed.get(decision.dataWindowJson);
    if (existing === undefined) reconstructed.set(decision.dataWindowJson, [decision]);
    else existing.push(decision);
  }

  const records: Array<DeliberationRunRecord> = [];

  for (const run of runs) {
    const own = (decisionsByRun.get(run.runId) ?? []).slice().sort(byCreatedAt);
    const dataWindow = parseDeliberationDataWindow(run.dataWindowJson);
    const revisionProse = own.find((d) => d.reviseProse !== undefined)?.reviseProse;
    records.push({
      runId: run.runId,
      cadence: run.cadence,
      outcome: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      ...(run.failureReason === undefined ? {} : { failureReason: run.failureReason }),
      ...(dataWindow === undefined ? {} : { dataWindow }),
      ...(revisionProse === undefined ? {} : { revisionProse }),
      stages: stageStates(run.status, ledgerStagesByRun.get(run.runId) ?? new Set()),
      decisions: own.map(toRunDecision),
    } as DeliberationRunRecord);
  }

  for (const group of reconstructed.values()) {
    const ordered = group.slice().sort(byCreatedAt);
    const first = ordered[0];
    if (first === undefined) continue;
    const dataWindow = parseDeliberationDataWindow(first.dataWindowJson);
    if (dataWindow === undefined) continue;
    const revisionProse = ordered.find((d) => d.reviseProse !== undefined)?.reviseProse;
    records.push({
      // Derived from the run's earliest Decision rather than minted fresh, so
      // the id is stable across reads. A client accumulating by `runId` would
      // otherwise grow a duplicate node on every re-emission.
      runId: `reconstructed:${first.decisionId}`,
      cadence: dataWindow.cadence,
      outcome: "committed",
      startedAt: dataWindow.ran_at,
      finishedAt: dataWindow.ran_at,
      dataWindow,
      ...(revisionProse === undefined ? {} : { revisionProse }),
      // Nothing recorded them, so nothing is claimed about them.
      stages: [],
      decisions: ordered.map(toRunDecision),
    } as DeliberationRunRecord);
  }

  return records.sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId),
  );
};
