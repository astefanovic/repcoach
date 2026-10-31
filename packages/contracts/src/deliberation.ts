import * as Schema from "effect/Schema";

import {
  DecisionId,
  ExerciseId,
  FeedEntryId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { MetricName, PrescribedMetricMap, SetType } from "./metrics.ts";
import { PlanOperation } from "./planEdit.ts";

/**
 * The Deliberation run-output contract (ADR 0011 §6, issue #26 — 2B slice
 * 1): the single structured object a run emits. The runner is a dumb,
 * reliable mapper that owns every machine field (`id`/`status`/
 * `created_at`/`origin`) — the agent never sets those.
 *
 * Field names inside `DecisionDraft`/`Citation`/`ObservationDirective`
 * mirror the ADR's JSON literally (snake_case `source_url`,
 * `reasoning_only_points`, `observation_directives`) because this is the
 * agent's structured-output wire shape — a producer/consumer contract with
 * the model, not the RPC-facing camelCase style used elsewhere in this
 * package (`feed.ts` etc.). `CommitDeliberationOutputInput`/`Result` (the
 * `Store.commitDeliberationOutput` seam and the "run now" RPC's
 * payload/success) stay camelCase, consistent with the rest of the RPC
 * surface.
 */

/**
 * `answer` is the third kind (ADR 0013 §2): a Decision that replies without
 * proposing a Change — the coach's cited response to a **Revise**. Every
 * Revision run emits exactly one, whether or not it also revises. It is a
 * first-class `decision` row (immutable, cited, its own Data window) because
 * ADR 0002 holds that amendments are new Decisions, never edits in place.
 */
export const DecisionKind = Schema.Literals(["observation", "proposal", "answer"]);
export type DecisionKind = typeof DecisionKind.Type;

/**
 * The status axis of a `decision` ROW, which is wider than a Change's
 * (`ChangeStatus` in `feed.ts`) — a Proposal moves through the Change
 * statuses, but an Observation is born `open` and closes as `escalated` or
 * `expired` (ADR 0011 §5), and an Answer is born `answered` — none of which
 * is a Change state at all.
 *
 * Kept as its own literal set rather than widening `ChangeStatus`, because
 * the two answer different questions: `ChangeStatus` is "what happened to
 * this proposed change", and this is "what state is this log entry in".
 * `Proposal.status` deliberately keeps the narrower one.
 */
export const DecisionStatus = Schema.Literals([
  "pending",
  "accepted",
  "rejected",
  "applied",
  "superseded",
  "open",
  "answered",
  "escalated",
  "expired",
]);
export type DecisionStatus = typeof DecisionStatus.Type;

export const CitationTrust = Schema.Literals(["corpus-verified", "retrieved-unverified"]);
export type CitationTrust = typeof CitationTrust.Type;

/** A citation as a value-snapshot (ADR 0003): claim + source + trust as-of-now. */
export const Citation = Schema.Struct({
  claim: TrimmedNonEmptyString,
  source_url: TrimmedNonEmptyString,
  trust: CitationTrust,
});
export type Citation = typeof Citation.Type;

/**
 * Token usage for a single agent session (SDK usage counts, not a dollar bill
 * — ADR 0005). **Four fields, not two** (issue #81, ADR 0011 §8 amendment):
 * the Agent SDK's `input_tokens` is the *uncached remainder only* — cache
 * reads and cache creations are reported separately and priced roughly an
 * order of magnitude apart from a fresh input token — so a `{prompt,
 * completion}` pair silently discarded `cache_read_input_tokens`/
 * `cache_creation_input_tokens` and understated every run, worst on a
 * held-open session (Intake) where cache reads dominate.
 *
 * Named `input`/`output` (not `prompt`/`completion`) to match the SDK's own
 * `input_tokens`/`output_tokens` naming rather than translating it.
 */
export const TokenUsage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheCreation: Schema.Number,
});
export type TokenUsage = typeof TokenUsage.Type;

/** A `TokenUsage` with every field zero — the identity for summing usage across rows. */
export const ZERO_TOKEN_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/** Adds two `TokenUsage` values field-by-field — the one place summing logic lives. */
export const addTokenUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheCreation: a.cacheCreation + b.cacheCreation,
});

/** Every token field summed — the one number a footer or a card wants when it does not care about the breakdown. */
export const totalTokens = (usage: TokenUsage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheCreation;

/**
 * One measurement the claim rests on, as the card renders it: a label, the
 * series as an already-formatted sentence ("142.5 → 148.4 kg"), and a delta
 * carrying its own sign and unit ("+4.1%", "4/4", "±0").
 *
 * Strings rather than numbers, deliberately. A measurement is whatever the
 * run actually looked at — an e1RM trend, a rep count against a range
 * ceiling, a bar-speed proxy that did not move — and those do not share a
 * unit, a cardinality or an axis. Typing them numerically would force the
 * runner to know how to render every kind of evidence the coach might ever
 * cite; leaving them as the coach's own phrasing keeps the working legible
 * without the contract having to anticipate it.
 */
export const DecisionMeasurement = Schema.Struct({
  label: TrimmedNonEmptyString,
  series: TrimmedNonEmptyString,
  delta: TrimmedNonEmptyString,
});
export type DecisionMeasurement = typeof DecisionMeasurement.Type;

/**
 * A catalog row a review-cadence Proposal needs to exist before its
 * `plan_operations` can reference it (ADR 0016).
 *
 * The asymmetry this closes: Intake drafts a whole Plan and
 * `materializeDraftPlan` mints a row for every `exerciseId` the draft names
 * that the catalog lacks, so the coach has always been free to author an
 * Exercise at cold start. A review cadence proposes OPERATIONS instead, and
 * `addEntry` carries an `exerciseId` and nothing else — so an operation naming
 * a movement the catalog has never held had no row to point at, and used to
 * apply anyway into an Entry whose id joined to nothing.
 *
 * **Not a Plan operation, and deliberately outside the union** (ADR 0016 §3,
 * CONTEXT `User-authored exercise`): creating an Exercise does not change the
 * Plan and mints no Change, so it cannot ride in a vocabulary where every
 * member does. It is the same two-writes shape the user's own path has —
 * create the row, then reference it — with the two writes named in one
 * Proposal so accepting it is still one tap.
 *
 * **Applied at Accept, not at run time.** Enrichment writes back the moment
 * the run commits, because it describes a row that already exists; these rows
 * do not exist yet, and catalog rows are permanent (never deleted, because
 * past Logged Sessions reference them). Writing them when the run commits
 * would leave a permanent row behind every Proposal the user REJECTS.
 *
 * Idempotent on `exercise_id`, exactly as `CreateExerciseInput` is: an id the
 * catalog already holds is skipped rather than overwriting a name the user has
 * since fixed.
 */
export const ProposedCatalogExercise = Schema.Struct({
  exercise_id: ExerciseId,
  name: TrimmedNonEmptyString,
  /**
   * What logging renders for this exercise. Optional, and absent is the
   * ordinary un-enriched state (`CreateExerciseInput` writes `[]`) — the next
   * Session review's enrichment roster picks the row up and fills it in.
   */
  tracked_metrics: Schema.optionalKey(Schema.Array(MetricName)),
});
export type ProposedCatalogExercise = typeof ProposedCatalogExercise.Type;

/**
 * One Decision draft in a run's output. `surface` only governs Observations
 * (ADR 0011 §6: "Observations only: feed-worthy?") — a Proposal always gets
 * a `coaching_feed_entry` regardless of this flag; the runner is the one
 * that applies that rule (`commitDeliberationOutput`), not the agent.
 *
 * **The working (issue #79).** `measurements`, `rule` and `uncertainty` are
 * the three parts of the layered explanation CONTEXT's Decision log promises
 * — "deeper evidence and the rule that fired underneath" — plus the #43
 * design's standing commitment that the coach names a place it might be
 * wrong. They are **optional**, and that is the whole safety of the
 * addition: a run that has nothing honest to put in a slot omits it, and the
 * card renders one fewer block. An absent field must never be back-filled
 * with an empty string or an empty array by anything downstream, because
 * "the coach said nothing here" and "the coach said nothing useful here"
 * would then be indistinguishable.
 */
export const DecisionDraft = Schema.Struct({
  kind: DecisionKind,
  summary: TrimmedNonEmptyString,
  rationale: TrimmedNonEmptyString,
  citations: Schema.Array(Citation),
  reasoning_only_points: Schema.Array(Schema.String),
  surface: Schema.Boolean,
  /** The numbers the claim rests on — shown, not summarised away. */
  measurements: Schema.optionalKey(Schema.Array(DecisionMeasurement)),
  /** The named principle that fired, stated as a rule rather than as prose. */
  rule: Schema.optionalKey(TrimmedNonEmptyString),
  /** The concrete thing that would falsify this — never a hedge. */
  uncertainty: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * **The Change this Proposal proposes** (issue #86, ADR 0008/0015).
   *
   * A Proposal is a Change in the `pending` state, so it has to carry the
   * change — otherwise accepting it can only apply a stand-in, and a real
   * deliberator becomes *worse* than a canned one: plausible prose attached to
   * an arbitrary mutation. These are the ADR 0015 operations verbatim, not a
   * second bespoke payload shape, so there is **one applier, one set of
   * structural rules**, and the coach is held to exactly the validation a
   * user-direct edit is (`applyPlanOperation`).
   *
   * Applied in order, all-or-nothing: `Store.resolveProposal` folds them over
   * the standing Plan and refuses the whole acceptance if any one is rejected,
   * leaving the Proposal `pending` and the Plan untouched. The card renders
   * the same fold as a diff before the user ever taps Accept.
   *
   * Optional, and absent is a real state: an Observation-shaped finding, or an
   * `answer` (ADR 0013 §2), proposes no Plan change at all and resolves
   * cleanly with no mutation. Meaningful only on `kind: 'proposal'`.
   *
   * Not the Intake path. At cold start there is no prior Plan to diff against
   * (ADR 0014 §6), so the Intake Proposal carries a whole draft Plan
   * (`CommitDeliberationOutputInput.intakeRun`) instead — the one special case,
   * runner-supplied and outside this contract.
   */
  plan_operations: Schema.optionalKey(Schema.Array(PlanOperation)),
  /**
   * The catalog rows this Proposal's operations need to exist first (ADR
   * 0016) — see `ProposedCatalogExercise`. Written at Accept, immediately
   * before the operations are applied, so an `addEntry` naming a movement the
   * catalog has never held resolves against a real row rather than dangling.
   *
   * Optional, and absent is the common case: a Proposal that only changes
   * loads, sets or structure introduces no new Exercise. Meaningful only on
   * `kind: 'proposal'`, exactly as `plan_operations` is.
   *
   * Not the Intake path, for the same reason `plan_operations` is not: an
   * Intake Proposal carries a whole draft Plan, and `materializeDraftPlan`
   * already mints a row per unknown `exerciseId` in it.
   */
  catalog_exercises: Schema.optionalKey(Schema.Array(ProposedCatalogExercise)),
});
export type DecisionDraft = typeof DecisionDraft.Type;

/**
 * `escalate`/`close` act on open Observations (ADR 0011 §5). `supersede`
 * (ADR 0013 §3) acts on the pending Proposal a **Revision run** was invoked
 * against, and on nothing else — the store honours it only when the named id
 * matches `CommitDeliberationOutputInput.reviseTargetProposalId` and that row
 * is still `pending`.
 */
export const DecisionDirectiveAction = Schema.Literals(["escalate", "close", "supersede"]);
export type DecisionDirectiveAction = typeof DecisionDirectiveAction.Type;

/**
 * A status directive against an EXISTING `decision` row (ADR 0011 §5, widened
 * by ADR 0013 §3). The runner applies these as `status` flips only —
 * `rationale`/`citations`/`data_window` on the referenced row stay immutable.
 *
 * The wire field is still named `observation_directives` (below) even though
 * `supersede` names a Proposal: it is the agent-facing key already fixed by
 * ADR 0011 §6, and renaming it would churn the model-facing contract for no
 * behavioural gain. The *scope* of each action is enforced by the store, not
 * by the field name.
 */
export const DecisionDirective = Schema.Struct({
  id: DecisionId,
  action: DecisionDirectiveAction,
});
export type DecisionDirective = typeof DecisionDirective.Type;

// --- Catalog enrichment (ADR 0016, issue #104) ------------------------------

/**
 * One un-enriched catalog row as the seed names it (#104, ADR 0016): a
 * **User-authored exercise** carrying only the name the user typed, plus a
 * row whose metadata a rename emptied. Id and name and nothing else — the
 * metadata is precisely what the coach is being asked to supply, so putting
 * a half-filled version of it in the seed would invite the coach to echo
 * rather than author.
 */
export const UnenrichedExercise = Schema.Struct({
  id: ExerciseId,
  name: TrimmedNonEmptyString,
});
export type UnenrichedExercise = typeof UnenrichedExercise.Type;

/**
 * The metadata a Session review fills into one un-enriched catalog row (ADR
 * 0016 §"Enrichment is a plain write, not a Decision").
 *
 * **Not a `DecisionDraft`.** Which muscles a Zercher squat trains is lookup,
 * not judgment about the user's training: it needs no approval and no audit
 * trail, so it is a plain write and leaves nothing in the Decision log. It
 * rides this contract rather than getting its own agent call because it rides
 * Session review rather than getting its own run.
 *
 * **Every metadata field is optional, and that is the failure mode's
 * design.** A run that can say what a lift trains but not what to name its
 * movement pattern lands the muscles and omits the rest; a run that returns
 * nothing at all leaves the row name-only and usable. Requiring the fields
 * would make one unanswerable lookup fail the whole review's contract decode
 * — throwing away finished reasoning about the user's training over an
 * exercise's anatomy. `exercise_id` alone is required, because an enrichment
 * that does not say which row it is for is not an enrichment.
 *
 * `tracked_metrics` is the field the logging grid reads, and empty is the
 * un-enriched marker (`CreateExerciseInput`), so a row enriched with muscles
 * but no metrics correctly stays on the roster and is offered again next
 * review.
 */
export const CatalogEnrichment = Schema.Struct({
  exercise_id: ExerciseId,
  /** What logging renders for this exercise — absent leaves the target-key fallback in place. */
  tracked_metrics: Schema.optionalKey(Schema.Array(MetricName)),
  /** The muscles the exercise trains — the join that makes per-muscle volume derivable. */
  muscles: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  movement_pattern: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CatalogEnrichment = typeof CatalogEnrichment.Type;

/**
 * The single structured object a Deliberation run emits (ADR 0011 §6).
 *
 * `catalog_enrichments` (#104) is the one field here that is **not** routed
 * through the adversarial sweep. The sweep verifies citations and may rewrite
 * a Decision's evidentiary basis; an enrichment carries no citation and is
 * not a Decision, so there is nothing for it to verify and it is not
 * described in the sweep's prompt. The runner therefore reads enrichments off
 * the DELIBERATOR's draft and the decisions off the sweep's output — the one
 * place those two outputs are treated differently, and it is deliberate.
 *
 * Optional: a run with no un-enriched rows is never told the field exists,
 * and its output is byte-identical to what it emitted before this feature.
 */
export const DeliberationRunOutput = Schema.Struct({
  decisions: Schema.Array(DecisionDraft),
  observation_directives: Schema.Array(DecisionDirective),
  catalog_enrichments: Schema.optionalKey(Schema.Array(CatalogEnrichment)),
});
export type DeliberationRunOutput = typeof DeliberationRunOutput.Type;

/**
 * The run's cadence (ADR 0011 §4). `on-demand` is always available ("run
 * now"); `session-review`/`cycle-review` are the two scheduled framings —
 * neither is wired to a scheduler in this slice.
 *
 * `revision-run` (ADR 0013 §6) is a **log-provenance label, not a mechanism**:
 * a Revision run *is* the Session-review runner under a third prompt framing,
 * sharing its seed, tools, sweep and configured model. It is a distinct value
 * only so the Decision log can answer "was this raised, or was it argued into
 * existence?". It deliberately has **no** model setting of its own — see
 * `CadenceModelSetting`.
 */
export const DeliberationCadence = Schema.Literals([
  "session-review",
  "cycle-review",
  "on-demand",
  "intake",
  "revision-run",
]);
export type DeliberationCadence = typeof DeliberationCadence.Type;

/**
 * A per-cadence model choice (ADR 0011 §4, issue #31 — 2B slice 6): "the
 * model per cadence is configurable in settings — e.g. a cheaper/faster model
 * for the frequent Session review, a stronger one for the rare Cycle review."
 * Persisted per cadence (`Store.setCadenceModel`) and read by the runner
 * (`Store.getCadenceModel`), which passes it to that cadence's deliberator.
 * `model` is an opaque SDK model identifier — the contract does not enumerate
 * the valid set (that is an Agent-SDK concern, and pinning it here would
 * couple the persisted setting to a model list that churns).
 *
 * **Not every cadence gets a selector.** ADR 0013 §6 settled that a Revision
 * run uses the Session review's configured model — there is no third selector
 * in settings, because arguing with the coach must not be the most expensive
 * thing in the app. Callers resolving a model for `revision-run` should read
 * `session-review`.
 */
/**
 * Reasoning-effort levels the Agent SDK's `query()` accepts on its `effort`
 * option (issue #81's "also give the model selector an effort option where
 * applicable" — the issue author's follow-up comment). Mirrors the SDK's own
 * `EffortLevel` literally rather than re-deriving it, so a value this
 * contract accepts is guaranteed to be one `runAgentSdkSession` can pass
 * straight through.
 */
export const DeliberationEffort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type DeliberationEffort = typeof DeliberationEffort.Type;

export const CadenceModelSetting = Schema.Struct({
  cadence: DeliberationCadence,
  model: TrimmedNonEmptyString,
  /**
   * Optional per-cadence reasoning-effort override. Absent means "let the
   * model/SDK default apply" — not every model supports every level (or any
   * level at all), so this is never required, and the runner passes it
   * through to the SDK verbatim rather than validating it against a
   * per-model capability list this contract has no way to know.
   */
  effort: Schema.optionalKey(DeliberationEffort),
});
export type CadenceModelSetting = typeof CadenceModelSetting.Type;

/** Sets/replaces the model for one cadence — a per-cadence singleton, keyed by `cadence`. */
export const SetCadenceModelInput = CadenceModelSetting;
export type SetCadenceModelInput = typeof SetCadenceModelInput.Type;

export const SetCadenceModelResult = Schema.Struct({
  setting: CadenceModelSetting,
});
export type SetCadenceModelResult = typeof SetCadenceModelResult.Type;

export const GetCadenceModelInput = Schema.Struct({
  cadence: DeliberationCadence,
});
export type GetCadenceModelInput = typeof GetCadenceModelInput.Type;

/** `model: null` when no per-cadence choice has been persisted — the runner falls back to the agent's default model. `effort: null` means no override is set, independent of whether a model is. */
export const GetCadenceModelResult = Schema.Struct({
  model: Schema.NullOr(TrimmedNonEmptyString),
  effort: Schema.NullOr(DeliberationEffort),
});
export type GetCadenceModelResult = typeof GetCadenceModelResult.Type;

/**
 * One model the Agent SDK says this installation can actually run (issue #81
 * follow-up).
 *
 * The contract still refuses to *enumerate* models — nothing here pins a set
 * — but it does describe the SHAPE of a model the SDK reported, so the list
 * can come from the SDK's own catalog (`Query.supportedModels()`) at read
 * time instead of a hand-authored array in the client. The distinction
 * matters: a curated list in the UI goes stale silently and offers models the
 * signed-in account may have no access to, whereas the SDK's answer is
 * per-installation and per-account by construction.
 *
 * `supportsEffort`/`effortLevels` come from the same row, which is what lets
 * the effort control be shown only where it means something rather than
 * offering five levels against a model that honours none of them.
 */
export const AvailableModel = Schema.Struct({
  /** The identifier to persist and hand back to the SDK (may be an alias such as `"opus"`). */
  id: TrimmedNonEmptyString,
  displayName: Schema.String,
  description: Schema.String,
  supportsEffort: Schema.Boolean,
  /** Empty when the model reports no effort support, or reported none specifically. */
  effortLevels: Schema.Array(DeliberationEffort),
});
export type AvailableModel = typeof AvailableModel.Type;

/**
 * The model catalog as of this read.
 *
 * `unavailableReason` is present instead of a failure because a catalog the
 * client could not fetch must not take the whole Settings surface down with
 * it: the model selector degrades to its free-text field (which was always
 * the escape hatch for an unlisted model id), the persisted setting is still
 * shown and still editable, and the reason is stated on screen rather than
 * leaving an empty dropdown to be interpreted.
 */
export const ListModelsResult = Schema.Struct({
  models: Schema.Array(AvailableModel),
  unavailableReason: Schema.NullOr(Schema.String),
});
export type ListModelsResult = typeof ListModelsResult.Type;

// --- The run ledger (ADR 0011 §8 amendment, issue #81) ----------------------

/**
 * One row's stage discriminator (ADR 0011 §8 amendment): the ledger is keyed
 * one row per agent SESSION, not per run, because a run is not one session —
 * a fire-and-forget run is a deliberator session plus a sweep session, and an
 * Intake run is a cold-draft session, N turn sessions, and one convergence
 * sweep. `intake-draft` is the cold draft only; every subsequent turn is
 * `intake-turn`; `sweep` covers the adversarial sweep for every cadence
 * (fire-and-forget or Intake alike) since it is the same kind of session
 * regardless of which cadence it swept.
 */
export const DeliberationRunStage = Schema.Literals(["deliberator", "sweep", "intake-draft", "intake-turn"]);
export type DeliberationRunStage = typeof DeliberationRunStage.Type;

/**
 * One ledger row as read back — a persisted agent-session cost record (ADR
 * 0011 §8 amendment). `runId` groups every row a single Deliberation run (or
 * Intake session) produced, so a UI can compare "tokens per Revision run" or
 * "cold-draft tokens vs per-turn tokens" (the two run-ledger questions the
 * UAT watchlist could not previously ask, entries 1 and 2) — a total across
 * `cadence` alone would confound "this kind of run is expensive" with "there
 * were a lot of them".
 *
 * `costUsd` is carried on every row (stored off the SDK's `total_cost_usd`
 * for free) but is a **write-only** field for now — ADR 0011 §8 is explicit
 * it is not rendered, since under subscription OAuth (ADR 0005) it is
 * imputed rather than billed and the risk actually being watched is quota,
 * not dollars. It still travels on this contract so a future screen does not
 * need a migration to show it.
 */
export const RunLedgerRow = Schema.Struct({
  runId: TrimmedNonEmptyString,
  cadence: DeliberationCadence,
  stage: DeliberationRunStage,
  model: Schema.NullOr(TrimmedNonEmptyString),
  usage: TokenUsage,
  costUsd: Schema.Number,
  ranAt: IsoDateTime,
});
export type RunLedgerRow = typeof RunLedgerRow.Type;

/** One cadence's aggregate over the whole ledger — the "spend, broken down by cadence" half of Settings. */
export const CadenceSpendBreakdown = Schema.Struct({
  cadence: DeliberationCadence,
  runCount: Schema.Number,
  usage: TokenUsage,
});
export type CadenceSpendBreakdown = typeof CadenceSpendBreakdown.Type;

/**
 * One run, summarised for the recent-runs list — the half that actually
 * retires UAT watchlist entries 1/2, which ask PER-RUN comparisons an
 * aggregate cannot answer. `stages` is the same run's rows broken out by
 * stage, which is what makes "cold-draft tokens vs per-turn tokens" and "was
 * the sweep a meaningful share of this run" legible from one entry instead of
 * requiring a second lookup.
 */
export const RecentRunSummary = Schema.Struct({
  runId: TrimmedNonEmptyString,
  cadence: DeliberationCadence,
  model: Schema.NullOr(TrimmedNonEmptyString),
  ranAt: IsoDateTime,
  usage: TokenUsage,
  stages: Schema.Array(
    Schema.Struct({
      stage: DeliberationRunStage,
      model: Schema.NullOr(TrimmedNonEmptyString),
      usage: TokenUsage,
    }),
  ),
});
export type RecentRunSummary = typeof RecentRunSummary.Type;

/**
 * How many rows the recent-runs list carries (ui-surfaces.md Settings:
 * "~10-15 rows"). Fixed on the server side of the RPC (not a client
 * parameter) so the grouping-by-run-id work — the part actually worth
 * testing at the runtime level per the issue's Testing Decisions — has one
 * shape to test rather than an open-ended page size.
 */
export const RECENT_RUNS_LIMIT = 15;

/** One RPC, grouped server-side (per-cadence breakdown + recent runs) — see `ui-surfaces.md` Settings. */
export const GetSpendSummaryResult = Schema.Struct({
  perCadence: Schema.Array(CadenceSpendBreakdown),
  recentRuns: Schema.Array(RecentRunSummary),
});
export type GetSpendSummaryResult = typeof GetSpendSummaryResult.Type;

// --- The RPE capture setting (#63, issue #81) --------------------------------

/**
 * Three states, not a toggle (#81): #63 settled that RPE appears only on
 * flagged sets and only after logging — `"flagged-only"` is that default and
 * keeps the unflagged majority one-tap. `"off"` and `"every-set"` are
 * opposite controls neither the original toggle nor "off" alone could
 * express. Stored server-side (like the model settings), because
 * `ui-surfaces.md` has this setting change what the Plan *prescribes* — it
 * must not live in one browser's `localStorage`.
 */
export const RpeCaptureMode = Schema.Literals(["off", "flagged-only", "every-set"]);
export type RpeCaptureMode = typeof RpeCaptureMode.Type;

export const DEFAULT_RPE_CAPTURE_MODE: RpeCaptureMode = "flagged-only";

export const SetRpeCaptureModeInput = Schema.Struct({ mode: RpeCaptureMode });
export type SetRpeCaptureModeInput = typeof SetRpeCaptureModeInput.Type;

export const SetRpeCaptureModeResult = Schema.Struct({ mode: RpeCaptureMode });
export type SetRpeCaptureModeResult = typeof SetRpeCaptureModeResult.Type;

export const GetRpeCaptureModeResult = Schema.Struct({ mode: RpeCaptureMode });
export type GetRpeCaptureModeResult = typeof GetRpeCaptureModeResult.Type;

/**
 * The run's provenance envelope (ADR 0011 §6/§8) — stored verbatim as every
 * row's `data_window_json` so a Decision is auditable ("provenance-
 * reconstructable, not output-reproducible") without a run-transcript
 * record.
 */
// --- Run visibility & token usage (ADR 0011 §8, issue #32 — 2B slice 7) ----

/**
 * The status of the Deliberation runner — idle / running / queued / failed
 * (ADR 0011 §8, issue #90). `"failed"` covers a run that was killed (turn
 * cap, wall clock), could not start, or produced output the sweep/deliberator
 * could not parse — surfaced instead of silently vanishing (a coach that
 * silently produces nothing is otherwise indistinguishable from one that is
 * deliberately restrained, ADR 0011 §4).
 */
export const RunStatus = Schema.Literals(["idle", "running", "queued", "failed"]);
export type RunStatus = typeof RunStatus.Type;

/**
 * The current state of one Deliberation run slot (ADR 0011 §8): the status,
 * which cadence is running/queued, and the token usage of the last completed
 * run. Surfaces the deferral queue honestly rather than silently delaying.
 *
 * `failureReason` (issue #90) is only ever present when `status` is
 * `"failed"` — a human-readable line naming which of the run's failure modes
 * fired (hit the turn cap, hit the wall clock, could not parse the output,
 * or the session could not start), so the status strip can say something
 * more useful than "something went wrong".
 */
export const RunState = Schema.Struct({
  status: RunStatus,
  cadence: Schema.optionalKey(DeliberationCadence),
  tokenUsage: Schema.optionalKey(TokenUsage),
  queuedCount: Schema.Number,
  failureReason: Schema.optionalKey(Schema.String),
});
export type RunState = typeof RunState.Type;

// --- Intake (ADR 0011 §7 as amended by ADR 0014, issue #70) -----------------

/**
 * Raised when a turn/converge references an Intake session id that is not live
 * (never started, already converged, or torn down when its client connection
 * dropped — ADR 0014 §8 keeps no resurrection path). Modelled as a typed error
 * on the RPC's error channel rather than thrown from inside `Effect.gen`, so
 * the failure travels the Effect error channel end-to-end (client included).
 */
export class IntakeSessionNotFoundError extends Schema.TaggedErrorClass<IntakeSessionNotFoundError>()(
  "IntakeSessionNotFoundError",
  {
    intakeSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `No active Intake session found for id ${this.intakeSessionId}`;
  }
}

/**
 * The adversarial sweep rejected the final Intake plan outright — it committed
 * no Decision (ADR 0008: a rejected plan is not committed; ADR 0014 §8: "the
 * sweep fails to run → no Proposal is offered"). Surfaced as a typed error
 * rather than a fabricated success so the caller learns nothing was persisted;
 * the Intake session is KEPT alive so the user can keep tweaking and retry.
 *
 * Note what this is NOT: a sweep that *guts* the plan — strips most citations
 * but leaves a committable Proposal — is the machinery working (ADR 0014 §8),
 * not an error. That path commits, with a disclosure.
 */
export class IntakeSweepRejectedError extends Schema.TaggedErrorClass<IntakeSweepRejectedError>()(
  "IntakeSweepRejectedError",
  {
    intakeSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `The adversarial sweep rejected the Intake plan for session ${this.intakeSessionId}; nothing was committed — keep tweaking and retry`;
  }
}

/**
 * Subscription quota is exhausted, so Intake cannot run (ADR 0014 §4, which
 * amends ADR 0011 §8). **Intake is the one run that fails loudly instead of
 * deferring**: it is the only user-blocking run in the app, and since
 * abandoning discards the draft, "come back later" means "start over". The
 * three fire-and-forget cadences keep queueing exactly as they did.
 *
 * The client renders this as plain language with a Retry and a pointer at Plan
 * view's manual empty state — the path that needs no agent at all.
 */
export class IntakeQuotaExhaustedError extends Schema.TaggedErrorClass<IntakeQuotaExhaustedError>()(
  "IntakeQuotaExhaustedError",
  {},
) {
  override get message(): string {
    return "The coach is out of subscription quota, so Intake cannot run right now — retry, or build a first Plan by hand";
  }
}

/**
 * The deliberator's reply could not be read as an Intake turn (ADR 0014 §8's
 * "cold draft fails" / "a turn fails"). There is deliberately **no fallback
 * stub plan**: slice 8 substituted a fabricated one-exercise "Unknown" plan on
 * a decode failure, which silently handed the user a plan the coach never
 * drafted. A draft that cannot be decoded is a failure the user is told about,
 * with the form returned intact.
 */
export class IntakeTurnFailedError extends Schema.TaggedErrorClass<IntakeTurnFailedError>()(
  "IntakeTurnFailedError",
  {
    intakeSessionId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `The coach's Intake reply could not be read (session ${this.intakeSessionId}): ${this.detail}`;
  }
}

// --- The drafted Plan ------------------------------------------------------

/**
 * One prescribed Set inside a drafted Plan. Targets are
 * `PrescribedMetricMap` — the SAME interval shape the Plan itself uses
 * (`scaffold.ts`), not the `targetReps`/`targetLoad` strings slice 8 carried.
 * The strings could not express a one-sided bound ("8+"), an open `rpe: {}`,
 * or the four tracked metrics beyond reps/load that the catalog declares — a
 * plank and a loaded carry are undraftable through a reps/load pair.
 */
export const IntakeDraftSet = Schema.Struct({
  setType: SetType,
  target: PrescribedMetricMap,
  restSec: Schema.optionalKey(NonNegativeInt),
});
export type IntakeDraftSet = typeof IntakeDraftSet.Type;

/** One drafted Entry: a catalog Exercise and its ordered prescribed Sets. */
export const IntakeDraftEntry = Schema.Struct({
  exerciseId: ExerciseId,
  exerciseName: TrimmedNonEmptyString,
  trackedMetrics: Schema.optionalKey(Schema.Array(MetricName)),
  sets: Schema.Array(IntakeDraftSet),
});
export type IntakeDraftEntry = typeof IntakeDraftEntry.Type;

export const IntakeDraftSession = Schema.Struct({
  label: TrimmedNonEmptyString,
  entries: Schema.Array(IntakeDraftEntry),
});
export type IntakeDraftSession = typeof IntakeDraftSession.Type;

/**
 * The Plan being drafted through the Intake exchange — **the prescription, and
 * only the prescription**. The justification lives in `IntakeTurn.rationale`,
 * and citations attach only there. Keeping the two apart at the type level is
 * what makes ADR 0014 §5's "the sweep governs the justification, never the
 * prescription" enforceable rather than a convention: the sweep is handed the
 * rationale and cannot reach the sets and reps the user converged on.
 */
export const IntakeDraftPlan = Schema.Struct({
  planModel: TrimmedNonEmptyString,
  /** The plan in one line ("Upper / lower, four days a week") — the card's hero. */
  headline: TrimmedNonEmptyString,
  sessions: Schema.Array(IntakeDraftSession),
});
export type IntakeDraftPlan = typeof IntakeDraftPlan.Type;

// --- The exchange ----------------------------------------------------------

/**
 * A citation the coach has made mid-exchange, before the sweep has touched it
 * (ADR 0014 §3). It carries **no `trust`**, and that absence is the contract:
 * an interim citation is provisional *by construction*, so the client cannot
 * render an unearned badge and no code path can mistake one for a verified
 * source. Trust arrives only on `IntakeVerifiedCitation`, after convergence.
 */
export const IntakeProvisionalCitation = Schema.Struct({
  id: TrimmedNonEmptyString,
  claim: TrimmedNonEmptyString,
  source_url: TrimmedNonEmptyString,
});
export type IntakeProvisionalCitation = typeof IntakeProvisionalCitation.Type;

/** A citation the single adversarial sweep has ruled on — badge-bearing (ADR 0014 §5). */
export const IntakeVerifiedCitation = Schema.Struct({
  id: TrimmedNonEmptyString,
  claim: TrimmedNonEmptyString,
  source_url: TrimmedNonEmptyString,
  trust: CitationTrust,
});
export type IntakeVerifiedCitation = typeof IntakeVerifiedCitation.Type;

/**
 * One line of justification for the draft. `citationId` is the ONLY place a
 * citation may attach (see `IntakeDraftPlan`) — a line without one is the
 * coach reasoning uncited, which is a legitimate and labelled state, not a
 * missing field.
 */
export const IntakeRationaleLine = Schema.Struct({
  text: TrimmedNonEmptyString,
  citationId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type IntakeRationaleLine = typeof IntakeRationaleLine.Type;

/**
 * A question the COACH asks back (ADR 0014 §2) — at cold start it is the coach
 * that holds the missing information ("dumbbells only — no bench either?"), the
 * inversion that separates Intake from Revise.
 *
 * `options` is the closed set, rendered as quick-reply chips; empty means the
 * answer is open and only free text makes sense. **A chip is an answer, not a
 * second channel**: tapping one submits the identical `IntakeTurnInput` a typed
 * answer would, which is why the options live on the question rather than on a
 * parallel reply mechanism.
 */
export const IntakeOpenQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(TrimmedNonEmptyString),
});
export type IntakeOpenQuestion = typeof IntakeOpenQuestion.Type;

/**
 * One coach turn in the Intake exchange: the current draft, the justification
 * behind it, and at most ONE open question.
 *
 * **At most one** is deliberate and structural (the #64 prototype's central
 * finding): exactly one question on screen, directly under the thing it is
 * about, is what keeps the surface reading as a plan being revised rather than
 * a chat accumulating. A list of pending questions would make the chat shape
 * the easy one to build.
 *
 * `revision` numbers the draft (`draft 1` for the cold draft, `verified` after
 * the sweep). It is the cheapest available signal that the object on screen is
 * the *same* object as a turn ago, changed — without it four revisions read as
 * four messages.
 *
 * `usage` is this turn's OWN spend, not a running total. The footer accumulates
 * client-side (ADR 0014 §4), and cost is reported per returned run rather than
 * estimated live, because a counter ticking during a run it cannot measure is a
 * lie the surface would be telling.
 */
export const IntakeTurn = Schema.Struct({
  revision: NonNegativeInt,
  draftPlan: IntakeDraftPlan,
  rationale: Schema.Array(IntakeRationaleLine),
  citations: Schema.Array(IntakeProvisionalCitation),
  /**
   * The Calibration-phase note (ADR 0014 §7): arrives WITH the draft, in the
   * coach's voice, naming what unlocks real coaching. Carried on every turn so
   * it stays attached to the concrete plan it qualifies, and it survives into
   * the accepted Decision.
   */
  calibrationNote: TrimmedNonEmptyString,
  openQuestion: Schema.optionalKey(IntakeOpenQuestion),
  usage: TokenUsage,
});
export type IntakeTurn = typeof IntakeTurn.Type;

/**
 * One tool event from the live Intake session (ADR 0014 §4's activity line).
 *
 * **Discrete and ordered, not a current-status field.** The activity line only
 * carries the app's longest wait because past lines *stay*, dimmed, while the
 * current one pulses; a single string mutating in place is the "spinner with
 * extra words" §4 was written to avoid, and it is also the only thing that
 * gives the wait texture when one retrieval step runs long — which real ones
 * do. A client cannot rebuild the list from a status field, so the runner emits
 * every event and the client keeps them.
 *
 * **Structured, not prose.** The runner forwards what the SDK reports — the
 * tool's name plus whatever the SDK gives as its subject (a URL, a query) — and
 * phrasing "reading up on training frequency" is the client's job. Copy stays
 * out of the server, and a tool nobody has phrased yet still renders honestly
 * off `subject` rather than blanking.
 *
 * **Ordinals are the client's job; ordering is the runner's.** The client holds
 * the citations, so it derives "source 3 of 5" itself. What the runner
 * guarantees is `seq` order, and that the sweep emits one event per citation in
 * the same order as the disclosure it later returns — otherwise the wait
 * narrates a sequence the card then contradicts.
 *
 * Events are **live-only and never persisted** (ADR 0014 §8's mortality rule):
 * a client that is not watching misses them, which is correct for a session
 * that dies with its tab.
 */
export const IntakeToolEvent = Schema.Struct({
  seq: NonNegativeInt,
  tool: TrimmedNonEmptyString,
  subject: Schema.optionalKey(Schema.String),
});
export type IntakeToolEvent = typeof IntakeToolEvent.Type;

// --- Starting, turning, converging -----------------------------------------

/**
 * The four-field form (ADR 0014 §1) — only what a model cannot guess.
 *
 * `goal` is deliberately un-validated free text ("get stronger", "put on
 * size"): sharpening it into measured targets is the coach's job, so demanding
 * precision here would ask the user to do the thing they came for.
 *
 * `equipment` is a multi-select — "dumbbells and a rack" has to be expressible
 * — and `lifts` is **optional free text**, because §1 makes it skippable and
 * "I haven't been training" is a common and honest answer. Interpreting
 * "squat 100, bench 70" is the coach's judgment call, which is exactly what
 * ADR 0011 §7 puts it in the interactive pass for; a structured
 * name/weight array forced the user to do that parsing instead.
 */
export const StartIntakeInput = Schema.Struct({
  goal: TrimmedNonEmptyString,
  daysPerWeek: NonNegativeInt,
  equipment: Schema.Array(TrimmedNonEmptyString),
  lifts: Schema.optionalKey(Schema.String),
});
export type StartIntakeInput = typeof StartIntakeInput.Type;

export const StartIntakeResult = Schema.Struct({
  intakeSessionId: Schema.String,
  turn: IntakeTurn,
});
export type StartIntakeResult = typeof StartIntakeResult.Type;

/**
 * One user turn against the live session (ADR 0014 §2). Turns are cheap: no
 * re-seed, no sweep, no Decision row, no lock ceremony — so a failed turn is a
 * genuine no-op and there is deliberately no per-turn Cancel (Cancel here means
 * abandoning Intake, which is already free).
 *
 * `answer` carries a typed sentence or a tapped chip's text indifferently —
 * they are the same turn by construction, not two code paths that have to be
 * kept in step.
 */
export const IntakeTurnInput = Schema.Struct({
  intakeSessionId: Schema.String,
  answer: TrimmedNonEmptyString,
});
export type IntakeTurnInput = typeof IntakeTurnInput.Type;

export const IntakeTurnResult = Schema.Struct({
  turn: IntakeTurn,
});
export type IntakeTurnResult = typeof IntakeTurnResult.Type;

/**
 * "Review the sources" (ADR 0014 §5) — ends the exchange and fires the single
 * adversarial sweep. A distinct act from Accept: putting the sweep behind
 * Accept would have the user agree to a plan whose citations were never
 * checked and then have its rationale rewritten underneath them.
 */
export const ConvergeIntakeInput = Schema.Struct({
  intakeSessionId: Schema.String,
});
export type ConvergeIntakeInput = typeof ConvergeIntakeInput.Type;

/** What the sweep did to one citation. `why` is stated for removals — a disclosure without the reason is worthless. */
export const IntakeCitationVerdictOutcome = Schema.Literals([
  "corpus-verified",
  "retrieved-unverified",
  "removed",
]);
export type IntakeCitationVerdictOutcome = typeof IntakeCitationVerdictOutcome.Type;

export const IntakeCitationVerdict = Schema.Struct({
  citationId: TrimmedNonEmptyString,
  claim: TrimmedNonEmptyString,
  source_url: TrimmedNonEmptyString,
  outcome: IntakeCitationVerdictOutcome,
  why: Schema.optionalKey(TrimmedNonEmptyString),
});
export type IntakeCitationVerdict = typeof IntakeCitationVerdict.Type;

/**
 * What the single sweep changed (ADR 0014 §5) — "two sources didn't hold up and
 * were removed" is the feature working in public, on the exact surface where
 * the user decides whether to trust the plan at all.
 *
 * `verdicts` carries EVERY citation the swept plan held, not only the removals,
 * so "all sources held" is legible as a fact rather than inferred from an empty
 * list — the two need different copy, and the reassurance that the prescription
 * was untouched should only appear when something *was* removed, or it denies
 * an accusation nobody made.
 *
 * **Scoped to the citations that plan actually accumulated.** Converging
 * straight off the cold draft is legitimate — the coach's questions are
 * optional and an impatient first-time user taps through — and a disclosure
 * computed over the fully-argued plan would then report removing sources the
 * user never saw. The verdict order is also the order the sweep emitted its
 * tool events in, so the wait can never narrate a count the card contradicts.
 */
export const IntakeSweepDisclosure = Schema.Struct({
  verdicts: Schema.Array(IntakeCitationVerdict),
});
export type IntakeSweepDisclosure = typeof IntakeSweepDisclosure.Type;

/**
 * The swept output — **the thing the user is shown and accepts**, never the
 * deliberator's draft (ADR 0011 §1/§6, ADR 0014 §5). Converge has already
 * committed it as the one pending Intake Proposal, so `proposalId` is
 * resolvable through the ordinary `proposals.resolve` path (ADR 0008): Accept
 * is not an Intake RPC, which is what makes "it is genuinely the same Proposal
 * card" true at the contract level rather than only visually.
 *
 * `draftPlan` is the prescription the user converged on, untouched by the
 * sweep. `rationale`/`citations` are the sweep's rewrite of the justification.
 */
export const ConvergeIntakeResult = Schema.Struct({
  proposalId: DecisionId,
  revision: NonNegativeInt,
  draftPlan: IntakeDraftPlan,
  rationale: Schema.Array(IntakeRationaleLine),
  citations: Schema.Array(IntakeVerifiedCitation),
  calibrationNote: TrimmedNonEmptyString,
  disclosure: IntakeSweepDisclosure,
  usage: TokenUsage,
});
export type ConvergeIntakeResult = typeof ConvergeIntakeResult.Type;

export const SubscribeIntakeEventsInput = Schema.Struct({
  intakeSessionId: Schema.String,
});
export type SubscribeIntakeEventsInput = typeof SubscribeIntakeEventsInput.Type;

export const DeliberationDataWindow = Schema.Struct({
  cadence: DeliberationCadence,
  ran_at: IsoDateTime,
  window_from: Schema.optionalKey(IsoDateTime),
  window_to: Schema.optionalKey(IsoDateTime),
  session_ids_considered: Schema.Array(Schema.String),
  evidence_roster_version: TrimmedNonEmptyString,
});
export type DeliberationDataWindow = typeof DeliberationDataWindow.Type;

// --- The run as a record of itself (ADR 0011 §8, the Coach run history) -----

/**
 * What became of one Deliberation run. Three outcomes, and the middle one is
 * why the run has a row at all:
 *
 * - `running` — in flight right now. Durable rather than live-only, so the
 *   surface that shows a run being watched and the surface that shows it
 *   afterwards are the same list.
 * - `committed` — both stages ran and the runner wrote the run's output back.
 *   **This includes a run that committed nothing.** A run that read the data
 *   and judged that nothing cleared the bar is the anti-twitchy mechanism
 *   working (ADR 0011 §4/§5), and it is only visible because the run itself is
 *   recorded — its zero Decisions write zero rows.
 * - `failed` — the run died before committing. Nothing part-formed was
 *   written (ADR 0011 §6), and `failureReason` names which way it went.
 */
export const DeliberationRunOutcome = Schema.Literals(["running", "committed", "failed"]);
export type DeliberationRunOutcome = typeof DeliberationRunOutcome.Type;

/**
 * How far one stage of a run got. Derived, never stored: a stage is `done`
 * once the run ledger (migration 012) holds a row for it, `running` when it is
 * the next stage of a run that is still in flight, and `not-run` otherwise —
 * which reads as "not yet" on a live run and "never did" on a failed one.
 *
 * Derived on purpose. The ledger already records exactly one row per agent
 * session, so a second stored copy of "did this stage happen" could disagree
 * with the one the spend screen reads, and a record that contradicts itself is
 * worse than one that says less.
 */
export const DeliberationRunStageState = Schema.Literals(["done", "running", "not-run"]);
export type DeliberationRunStageState = typeof DeliberationRunStageState.Type;

/**
 * One stage of a run, as the record shows it.
 *
 * No model, no tokens, no cost — deliberately, and not for lack of the data
 * (the ledger row this is derived from carries all three). Those belong to
 * Settings' spend section, which is about what the coach costs; this surface
 * is about how the coach reasoned. Putting a token count on it would turn an
 * explainability surface into a telemetry one, and the two want different
 * things from the same rows.
 */
export const DeliberationRunStageView = Schema.Struct({
  stage: DeliberationRunStage,
  state: DeliberationRunStageState,
});
export type DeliberationRunStageView = typeof DeliberationRunStageView.Type;

/**
 * A Decision as it appears *under its run* — the headline only.
 *
 * Deliberately not a `DecisionWorking`. The working stays behind
 * `decisions.get`, fetched on expand (ADR 0011 §5 freezes it, so there is
 * nothing to stream), and a history of thirty runs must not carry thirty
 * runs' worth of rationale and citations to render a rail of dots.
 */
export const DeliberationRunDecision = Schema.Struct({
  decisionId: DecisionId,
  kind: DecisionKind,
  status: DecisionStatus,
  summary: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type DeliberationRunDecision = typeof DeliberationRunDecision.Type;

/**
 * One Deliberation run, with what came out of it — the unit the Coach record
 * is a list of.
 *
 * `dataWindow` is absent only while a run is still in flight: the envelope is
 * assembled at commit time, so a live run genuinely does not have one yet, and
 * the surface shows what it is doing instead of what it read.
 *
 * `stages` is **empty for a run that predates the `deliberation_run` table**.
 * Those runs are reconstructed by grouping older Decisions on the
 * `data_window_json` they all share, which recovers the runs that emitted
 * something and cannot recover the ones that did not — so a reconstructed run
 * is always `committed`, always has at least one Decision, and honestly claims
 * nothing about its stages rather than asserting two that were never recorded.
 *
 * `revisionProse` is the user's own **Revise** wording (ADR 0013 §1/§9), the
 * only run whose trigger is a sentence rather than an event.
 */
export const DeliberationRunRecord = Schema.Struct({
  runId: TrimmedNonEmptyString,
  cadence: DeliberationCadence,
  outcome: DeliberationRunOutcome,
  startedAt: IsoDateTime,
  finishedAt: Schema.optionalKey(IsoDateTime),
  failureReason: Schema.optionalKey(TrimmedNonEmptyString),
  dataWindow: Schema.optionalKey(DeliberationDataWindow),
  revisionProse: Schema.optionalKey(TrimmedNonEmptyString),
  stages: Schema.Array(DeliberationRunStageView),
  decisions: Schema.Array(DeliberationRunDecision),
});
export type DeliberationRunRecord = typeof DeliberationRunRecord.Type;

/**
 * Input to `Store.commitDeliberationOutput` — the runner's ONLY write-back
 * (ADR 0011 §3/§6). `runOutput` is the agent's structured object;
 * `dataWindow` is the provenance envelope the runner assembles itself
 * (cadence/timestamps/session ids), not something the agent emits.
 *
 * `reviseTargetProposalId` is the Proposal a **Revision run** was invoked
 * against (ADR 0013). Present only for `cadence: 'revision-run'`, and set by
 * the runner — the agent never supplies it. It does two things, both of them
 * scope enforcement the agent cannot reach past:
 *
 * 1. It is the **only** id a `supersede` directive may name (ADR 0013 §3).
 *    The agent may judge that its revision replaces the Proposal; it may not
 *    choose *which* Proposal, so a reasoning slip cannot kill an unrelated
 *    pending row or flip an already-`accepted` one.
 * 2. Every row the run commits is stamped with it as `inResponseToId`,
 *    building the **Proposal lineage** (ADR 0013 §9) that lets the card
 *    render a revision alongside the objection that produced it.
 *
 * `revisionProse` is the user's own **Revise** prose that produced this run
 * (ADR 0013 §1/§9, issue #66 slice 1) — runner-supplied only, same posture as
 * `reviseTargetProposalId`, which it always accompanies (present only for
 * `cadence: 'revision-run'`; the agent never supplies it, so it appears
 * nowhere in the agent's structured-output contract). ADR 0013 §1 calls this
 * prose the highest-signal input the coach will ever get about the user's
 * preferences, and §9 requires the Proposal card to render it as part of the
 * exchange, so both `Store` layers stamp it onto every row this run commits —
 * exactly as they already stamp `inResponseToId` — rather than leaving it to
 * live only in the runner's memory for the duration of one run.
 *
 * `intakeRun` is the **Intake marker** (ADR 0014 §6), following that precedent
 * exactly: the runner alone supplies it, it does not appear anywhere in the
 * agent's structured-output contract, and the *store* — not the runner —
 * enforces what it means. Its presence marks the commit as the one Decision an
 * Intake produces, and the store then:
 *
 * 1. stamps the row so the Intake Proposal is identifiable afterwards;
 * 2. **withholds it from the pending-Proposal and Coaching-feed surfaces while
 *    it is still `pending`**, satisfying §6's "never pending on Today, never in
 *    the Coach badge" — it is decided in place, before Today is ever populated,
 *    and asking the user to decide twice on it would be the app forgetting what
 *    just happened;
 * 3. honours a `supersede` directive under this marker only when it names a
 *    still-`pending` Intake Proposal, which is how re-converging after
 *    reopening the exchange replaces the prior artifact without an agent
 *    reasoning slip being able to reach any other row.
 *
 * It also **carries the drafted Plan** as structured data. Slice 8 smuggled the
 * whole Plan through as a JSON string inside `reasoning_only_points`, so the
 * Proposal card could only render it by string surgery on a prose field; the
 * Plan is a first-class payload of the Intake Proposal, so it travels as one.
 */
export const CommitDeliberationOutputInput = Schema.Struct({
  runOutput: DeliberationRunOutput,
  dataWindow: DeliberationDataWindow,
  /**
   * The `deliberation_run` row every Decision this commit writes belongs to
   * (ADR 0011 §8, the Coach run history) — runner-supplied, like every other
   * machine field here, and never part of the agent's output contract.
   *
   * Optional, and it has to stay optional in both directions. Backwards: every
   * Decision written before run rows existed has none, and the record
   * reconstructs those runs from `dataWindow` instead. Forwards: writing the
   * run row is best-effort by ADR 0011 §6 — a run whose bookkeeping write
   * failed must still commit its Decisions, and a commit that refused to
   * proceed without a run id would have inverted exactly the rule that says
   * losing the record of a Decision must never cost the Decision.
   */
  runId: Schema.optionalKey(TrimmedNonEmptyString),
  reviseTargetProposalId: Schema.optionalKey(DecisionId),
  revisionProse: Schema.optionalKey(TrimmedNonEmptyString),
  intakeRun: Schema.optionalKey(Schema.Struct({ draftPlan: IntakeDraftPlan })),
});
export type CommitDeliberationOutputInput = typeof CommitDeliberationOutputInput.Type;

/** What committing produced — the runner-assigned ids, for callers/tests to key off of. */
export const CommitDeliberationOutputResult = Schema.Struct({
  decisionIds: Schema.Array(DecisionId),
  feedEntryIds: Schema.Array(FeedEntryId),
});
export type CommitDeliberationOutputResult = typeof CommitDeliberationOutputResult.Type;
