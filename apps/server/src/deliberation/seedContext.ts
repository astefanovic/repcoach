import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  CheckIn,
  Citation,
  ContextNote,
  DeliberationCadence,
  EvidenceClaim,
  GoalSummary,
  PlanSnapshot,
  ProposalExchangeEntry,
  StandingConstraint,
  UnenrichedExercise,
} from "@repcoach/contracts";

import { Store } from "../store.ts";

// Re-exported so existing call sites (`seedContext.test.ts`/
// `seedContext.adversarial.test.ts`, this module's own `SeedInputs`) keep
// importing `StandingConstraint`/`EvidenceClaim`/`CheckIn`/`ContextNote`/
// `GoalSummary` from `seedContext.ts` unchanged — the canonical shapes now
// live in `@repcoach/contracts` (`coachingInputs.ts`, issue #34) since they
// are also needed by the RPC write path and `@repcoach/persistence`'s row
// mapping. See that module's doc for why `CheckIn` is a rendered-summary
// read shape rather than the structured write shape.
export type { StandingConstraint, EvidenceClaim, CheckIn, ContextNote, GoalSummary };

/**
 * The thin seed-context assembly (ADR 0011 §2, issue #27 — 2B slice 2): the
 * COMPACT, always-injected context every Deliberation run gets up front,
 * before the deliberator pulls anything more via its native tools
 * (`Read`/`Bash`+`sqlite3`/`Grep`/`WebSearch`/`WebFetch`) against the
 * read-only snapshot (`deliberationSnapshot.ts`).
 *
 * Issue #34 (2B "seed-input storage") replaced the walking-skeleton stub:
 * Standing constraints / Check-ins / Context notes / the Goal / the
 * Evidence-base roster are now real, store-backed reads (`Store`'s new
 * seed-input methods, `@repcoach/persistence`) — `SeedInputsProviderLive`
 * below sources ALL six inputs from `Store`, nothing is stubbed anymore.
 * `sessionsSinceLastReview`/`lastCycleReviewAt` are DERIVED from
 * `logged_session`/`decision` timestamps (`Store.getPointerDigestHistory`)
 * rather than a new table.
 */

// --- typed seed-input shapes (CONTEXT.md glossary terms) -------------------
//
// `StandingConstraint`/`EvidenceClaim`/`CheckIn`/`ContextNote`/`GoalSummary`
// now live in `@repcoach/contracts` (re-exported above) — this module no
// longer redefines them.

/** "N sessions since last review, M open Observations, last Cycle review at …" (ADR 0011 §2). */
export interface PointerDigest {
  readonly sessionsSinceLastReview: number;
  readonly openObservationCount: number;
  readonly lastCycleReviewAt: string | undefined;
}

/**
 * One open Observation injected as a PRIOR into the seed (ADR 0011 §5, issue
 * #30 — 2B slice 5): the anti-twitchy accumulation lives in the Decision log
 * itself, so every run queries the open Observations (`kind='observation'
 * AND status='open'`) and injects them here — id + summary + rationale — so
 * the agent can judge, against the fresh data, whether they now clear the
 * soft trend bar and (when they do) name their `id`s in `escalate`/`close`
 * `observation_directives`. Only the seed carries the id; the runner assigns
 * and owns it, the agent merely references it back.
 */
export interface ObservationPrior {
  readonly id: string;
  readonly summary: string;
  readonly rationale: string;
  readonly createdAt: string;
}

/**
 * Everything a run's seed is assembled from. Every field is populated —
 * `SeedInputsProviderLive` is the only place that decides which are real
 * (Plan, `openObservationCount`) vs. stubbed empty (see module doc above).
 */
export interface SeedInputs {
  readonly cadence: DeliberationCadence;
  readonly planSnapshot: PlanSnapshot;
  readonly goal: GoalSummary | undefined;
  readonly standingConstraints: ReadonlyArray<StandingConstraint>;
  readonly evidenceRoster: ReadonlyArray<EvidenceClaim>;
  readonly checkIns: ReadonlyArray<CheckIn>;
  readonly contextNotes: ReadonlyArray<ContextNote>;
  /**
   * The open Observations (`kind='observation' AND status='open'`) injected
   * as priors (ADR 0011 §5, issue #30) — the accumulation the run judges
   * against fresh data. Full list, never truncated: an unseen open
   * Observation can never be escalated or closed, so leaving one out of the
   * seed would silently strand it. Empty on a fresh store (nothing to judge).
   */
  readonly openObservations: ReadonlyArray<ObservationPrior>;
  /**
   * The catalog rows the coach has not filled in yet (#104, ADR 0016) — id
   * and name only, and **only on a Session review**. Empty everywhere else,
   * and empty on a review with nothing outstanding, in which case the seed
   * says nothing about enrichment at all: a run with no un-enriched rows does
   * exactly the work it did before this existed.
   */
  readonly unenrichedExercises: ReadonlyArray<UnenrichedExercise>;
  readonly pointerDigest: PointerDigest;
  /** The read-only snapshot's filesystem path — what the data dictionary's pointers name. */
  readonly snapshotDbPath: string;
}

// --- the compact data dictionary (table -> columns), naming the snapshot ---

/**
 * Table -> column-list pairs, faithful to `@repcoach/persistence`'s
 * migrations (`001_InitialSchema.ts`, `002_LoggedSessionSnapshot.ts`). Kept
 * as a literal here rather than introspected at run time — ADR 0011 §2 asks
 * for a "compact data dictionary", and a hand-maintained one stays short and
 * plain-language; it must be kept in sync by hand when the schema changes.
 */
const DATA_DICTIONARY: ReadonlyArray<{ readonly table: string; readonly columns: string }> = [
  { table: "plan", columns: "id, plan_model, created_at" },
  { table: "prescribed_session", columns: "id, plan_id, order_index, label" },
  { table: "block", columns: "id, prescribed_session_id, order_index, format, params_json" },
  { table: "entry", columns: "id, block_id, order_index, exercise_id" },
  { table: "prescribed_set", columns: "id, entry_id, order_index, set_type, target_json, rest_sec" },
  { table: "exercise_catalog", columns: "id, name, tracked_metrics_json, muscles_json, movement_pattern" },
  {
    table: "logged_session",
    columns: "id, prescribed_session_id, started_at, status, snapshot_json",
  },
  // The view first, and the raw stream labelled as one (migration `023`): a
  // coach that counted `logged_set_actual` rows read three corrected Sets as
  // seven and drafted a set-count increase on volume never performed. Then it
  // counted drop sets as Sets and named swapped-away exercises (migration
  // `024`), so the set count and the performed exercise are columns now.
  {
    table: "logged_set_net",
    columns:
      "logged_session_id, entry_id, set_id, set_type, counts_as_set, prescribed_exercise_id, exercise_id, " +
      "actual_json, applied_at — VIEW: the Sets actually performed, one row per Set with its final values. " +
      "Read Sets HERE. A Set count is SUM(counts_as_set): 1 = a working Set; 0 = a warmup, or a " +
      "drop/rest-pause/myo-cluster continuation of the working Set before it, which is part of that Set, " +
      "never an extra one (say '3 sets, the last with 2 drops', not '5 sets'). exercise_id is what was " +
      "performed, after any swap; name the exercise from it, not from prescribed_exercise_id",
  },
  {
    table: "logged_set_actual",
    columns:
      "id, logged_session_id, session_id, entry_id, set_id, set_type, actual_json, command_id, applied_at, " +
      "retraction — append-only EDIT LOG, not a set list: a corrected Set gets a new row with the same " +
      "set_id, and an un-logged one a row with retraction=1. Never count its rows as Sets or read a " +
      "superseded row as a performed load",
  },
  {
    table: "logged_entry_swap",
    columns:
      "logged_session_id, entry_id, exercise_id, swapped_at — the user performed an Entry's Sets on a " +
      "different exercise than prescribed; the latest swap per Entry wins (already resolved into " +
      "logged_set_net.exercise_id)",
  },
  {
    table: "decision",
    columns:
      "id, kind ('observation'|'proposal'|'answer'|'change'), origin, status, summary, rationale, " +
      "citations_json, data_window_json, created_at, in_response_to_id",
  },
  {
    table: "coaching_feed_entry",
    columns: "id, kind, summary, created_at, proposal_id",
  },
];

// --- assembly ----------------------------------------------------------

const CADENCE_FRAMING: Record<DeliberationCadence, string> = {
  "session-review":
    "Session review — focus on the current cycle / recent data. Prefer Observations; escalate to a " +
    "Proposal only when the evidence clearly clears the bar (a confirmed trend, or an acute/safety finding).",
  "cycle-review":
    "Cycle review — weigh the longer history. Periodization-level Proposals (deloads, volume restructures, " +
    "Plan-model changes) most naturally originate here.",
  "on-demand": "On-demand run — the user tapped \"run now\". No cadence-specific framing; use judgment.",
  "intake":
    "Intake cold-start — the first training Plan when no Log exists yet, and the user is sitting there " +
    "waiting for it. The database is empty by definition: there is no performance data, no Check-ins and no " +
    "prior Decision to re-read, so every judgment call about starting loads and structure is yours to make " +
    "and to say out loud. " +
    "This is ONE held-open session with MANY turns (ADR 0014 §2), not a run per turn: you will be resumed " +
    "with the user's answers, so carry your own context forward and never ask them something they already " +
    "told you. Turns are cheap — no re-seed, no sweep, no Decision row per turn — so a short, concrete " +
    "question is welcome where an assumption would be a guess. " +
    "You may ask questions BACK, at most one at a time, about the concrete draft rather than in the " +
    "abstract: \"dumbbells only — no bench either?\" beats an equipment inventory. " +
    "State the calibration-phase caveat with the first draft and keep it attached to the plan: name " +
    "specifically what changes once roughly a month is logged, because naming what unlocks is what turns a " +
    "disclaimer into a promise. " +
    "Cite as you go and cite honestly — a SINGLE adversarial sweep runs once, when the user asks to review " +
    "the sources, and its verdicts are disclosed on the card they accept. Sources it cannot confirm are " +
    "removed in public. Nothing you emit is committed until the user converges.",
  "revision-run":
    "Revision run — the user pushed back on a Proposal you already drafted (ADR 0013). Their objection, " +
    "question, or request for alternatives is in the seed alongside the target Decision in full and any " +
    "prior turns of this exchange. Treat the objection as evidence, not noise: if it is a claim about the " +
    "DATA (\"I wasn't stalling, I was ill that week\"), go back to the Log and Check-ins and re-examine — " +
    "do not simply restate your original reasoning more politely. " +
    "Emit exactly ONE 'answer' decision, always: a direct, cited reply to what they actually said. " +
    "Emit a revised 'proposal' ONLY if you have genuinely changed your mind — a revision is not owed, and " +
    "an answer that holds the original position is a legitimate outcome. If you do revise, also emit a " +
    "{ \"action\": \"supersede\" } directive naming the target Proposal's id. " +
    "If the objection states a durable rule about the user's life (\"I can never train more than 3 days\"), " +
    "fold a Standing-constraint promotion INTO the revised Proposal itself and say so plainly in its " +
    "summary — never raise it as a separate Proposal. " +
    "STAY ON SUBJECT: unrelated Proposals and directives naming anything other than the target are " +
    "discarded by the runner, and new Observations are recorded but not surfaced.",
};

const renderStandingConstraints = (constraints: ReadonlyArray<StandingConstraint>): string => {
  if (constraints.length === 0) {
    return "(none on file)";
  }
  // Every constraint the caller passed in is rendered, unconditionally — no
  // truncation/sampling here. This is the structural half of ADR 0011 §2's
  // "a hard constraint missed because the agent didn't think to query is a
  // safety failure" guarantee: when constraints exist, they are ALWAYS in
  // the seed, never left to on-demand retrieval.
  return constraints
    .map((c) => `- [${c.severity.toUpperCase()}] ${c.text} (id: ${c.id})`)
    .join("\n");
};

export const renderEvidenceRoster = (roster: ReadonlyArray<EvidenceClaim>): string => {
  if (roster.length === 0) return "(seed corpus empty)";
  return roster.map((e) => `- ${e.claim} — ${e.source} (applies to: ${e.applicability})`).join("\n");
};

/**
 * The retrieval-guardrail instruction (ADR 0003 §3). Stated ONCE here and
 * injected into `assembleSeed` — which the deliberator, the Intake seed
 * (`assembleIntakeSeed`) and the Revision-run seed (`assembleRevisionSeed`)
 * all build on — so the source bar and the no-source fallback cannot drift
 * apart between cadences. Because the seed floor above is tiny, retrieval
 * carries most citations, which makes retrieval quality the product's
 * credibility (ADR 0003 §3).
 */
const RETRIEVAL_GUARDRAILS_INSTRUCTION =
  "## Retrieval guardrails (ADR 0003 §3)\n" +
  "Source bar: scientific sources only, with a real stable URL — PubMed, meta-analyses and systematic " +
  "reviews as the primary tier, reputable evidence-based practitioners as a lower sub-tier. An open-web " +
  "blog or forum post never clears this bar, however well it seems to support a claim.\n" +
  "No-source fallback: if nothing checkable clears that bar, you have exactly two honest options — fall " +
  "back to a seed principle from the Evidence-base roster above and say so, or surface the point flagged " +
  "\"reasoning only, uncited\". A fabricated or invented reference is never acceptable.";

const renderCheckIns = (checkIns: ReadonlyArray<CheckIn>): string => {
  if (checkIns.length === 0) return "(none recorded)";
  return checkIns.map((c) => `- ${c.recordedAt}: ${c.summary}`).join("\n");
};

const renderContextNotes = (notes: ReadonlyArray<ContextNote>): string => {
  if (notes.length === 0) return "(none recorded)";
  // An Entry-anchored note (issue #130, migration `018`) says which Entry it
  // is about, mirroring `renderStandingConstraints`'s `(id: ...)` idiom —
  // the deliberator can join `entry_id` against `entry`/`exercise_catalog`
  // (both in the data dictionary above) for the exercise name.
  return notes
    .map((n) => `- ${n.recordedAt}: ${n.text}${n.entryId === undefined ? "" : ` (entry: ${n.entryId})`}`)
    .join("\n");
};

const renderGoal = (goal: GoalSummary | undefined): string => {
  if (goal === undefined) return "(not yet set — Intake has not sharpened a Goal for this user)";
  return `${goal.statement}\nProxies: ${goal.proxies.length > 0 ? goal.proxies.join(", ") : "(none chosen yet)"}`;
};

/**
 * The escalation-judgment instruction (ADR 0011 §5, issue #30 — 2B slice 5):
 * a PROMPT-level directive, present for EVERY cadence (the anti-twitchy bar is
 * a mechanism promise, not a structural lane, ADR 0011 §4). It names the soft,
 * no-hardcoded-counter bar, the two directive actions the runner applies
 * (`escalate` → roll the supporting Observations into ONE Proposal that
 * references their ids; `close` → retire a stale/contradicted one), and the
 * acute/safety carve-out that may surface a Proposal WITHOUT an accumulated
 * trend. It is stated as guidance the agent obeys, never enforced in code.
 */
const ESCALATION_JUDGMENT_INSTRUCTION =
  "Judge whether the fresh data plus these priors now clear a SOFT bar for a real trend — there is NO " +
  "fixed count of Observations that forces a Proposal; use judgment. When the bar is cleared, emit ONE " +
  "Proposal that rolls up the supporting Observations and reference each of their ids with an `escalate` " +
  "observation_directive (the runner flips those to `escalated`). Retire any Observation that fresh data " +
  "has made stale or contradicted with a `close` directive (the runner flips it to `expired`). An acute " +
  "or safety finding may surface directly as a Proposal WITHOUT waiting for an accumulated trend.";

const renderOpenObservations = (priors: ReadonlyArray<ObservationPrior>): string => {
  if (priors.length === 0) return "(none open — nothing accumulated to judge yet)";
  // Every open Observation is rendered with its id so the agent can name it
  // back in an `escalate`/`close` directive — the id is the only join between
  // the seed's priors and the run's `observation_directives`.
  return priors.map((o) => `- [id: ${o.id}] (${o.createdAt}) ${o.summary} — ${o.rationale}`).join("\n");
};

/**
 * The catalog-enrichment section (#104, ADR 0016) — rendered ONLY when there
 * are rows outstanding, which is why it returns a list of lines to splice in
 * rather than a "(none)" placeholder like the sections above. A review with
 * nothing to enrich must be byte-identical to the review it would have been
 * before this feature: no instruction it has nothing to apply, and no output
 * field it has nothing to put in.
 *
 * It states plainly what the coach owns here. The user typed the name and
 * that is theirs; the metadata is the part a coach is better placed to author
 * than the user, and it is a **fact about the world, not a judgment about
 * this user's training** — so it needs no Proposal, no citation and no
 * approval, and the instruction says so rather than leaving the model to
 * infer that from the absence of a Decision slot.
 */
const renderEnrichmentSection = (roster: ReadonlyArray<UnenrichedExercise>): ReadonlyArray<string> => {
  if (roster.length === 0) return [];
  return [
    "## Exercise catalog rows awaiting metadata (ADR 0016)",
    "These catalog rows carry a name and nothing else — the user typed them, and the metadata is yours to",
    "supply. Until you do, each one joins to no muscle, so everything the user has already trained through it",
    "counts as ZERO volume toward every muscle in the analytics you reason over. Because that volume is",
    "derived rather than stored, filling these in repairs the history rather than only helping from now on.",
    ...roster.map((exercise) => `- [id: ${exercise.id}] ${exercise.name}`),
    "",
    "For each row you can honestly complete, add an entry to a top-level `catalog_enrichments` array in your",
    "final JSON object, alongside `decisions` and `observation_directives`:",
    "",
    '    { "exercise_id": "<id above, exactly>", "tracked_metrics": ["reps", "load"],',
    '      "muscles": ["quadriceps", "gluteus maximus"], "movement_pattern": "squat" }',
    "",
    "`tracked_metrics` is drawn from the closed set {reps, load, duration, distance, rpe, tempo} and DRIVES THE",
    "LOGGING FIELD LAYOUT — a set row renders exactly the metrics you name here, so a plank should say duration",
    "and a loaded carry should say load and distance rather than defaulting everything to reps and load.",
    "`muscles` is free text, and it is the join key per-muscle volume is derived from. `movement_pattern` is one",
    "short label (squat, hinge, horizontal press, vertical pull, carry, …).",
    "",
    "This is a PLAIN WRITE, not a Decision. Which muscles a lift trains is lookup, not a judgment about this",
    "user's training: it needs no Proposal, no Observation, no citation and no approval, it is applied silently,",
    "and it appears nowhere on the user's screen. Do NOT emit a decision about it. Enrich only what you can",
    "state confidently — omit a row you cannot place, and omit any single field you are unsure of rather than",
    "guessing. A row you leave alone stays usable and comes back on the next review; a wrong answer here is",
    "invisible and permanent unless the user happens to rename the exercise.",
    "",
  ];
};

const renderDataDictionary = (): string =>
  DATA_DICTIONARY.map((entry) => `- ${entry.table}(${entry.columns})`).join("\n");

/**
 * Builds the seed string from `SeedInputs` (ADR 0011 §2): run header
 * (cadence + Plan snapshot + Goal/proxies), ALL Standing constraints
 * (hard/soft), the Evidence-base roster, recent Check-ins/Context notes, and
 * a pointer digest — followed by plain-language pointers + the compact data
 * dictionary naming the read-only snapshot DB the agent's native tools
 * (`Bash`+`sqlite3`, `Read`, `Grep`) should target.
 */
export const assembleSeed = (inputs: SeedInputs): string =>
  [
    `# Deliberation run — ${inputs.cadence}`,
    "",
    CADENCE_FRAMING[inputs.cadence],
    "",
    "## Goal",
    renderGoal(inputs.goal),
    "",
    "## Plan snapshot",
    JSON.stringify(inputs.planSnapshot, null, 2),
    "",
    "## Standing constraints (ALWAYS honored — hard constraints are inviolable)",
    renderStandingConstraints(inputs.standingConstraints),
    "",
    "## Evidence-base roster (corpus-verified claims)",
    renderEvidenceRoster(inputs.evidenceRoster),
    "",
    RETRIEVAL_GUARDRAILS_INSTRUCTION,
    "",
    "## Recent Check-ins",
    renderCheckIns(inputs.checkIns),
    "",
    "## Recent Context notes",
    renderContextNotes(inputs.contextNotes),
    "",
    "## Open Observations (priors — the anti-twitchy accumulation, ADR 0011 §5)",
    renderOpenObservations(inputs.openObservations),
    "",
    ESCALATION_JUDGMENT_INSTRUCTION,
    "",
    ...renderEnrichmentSection(inputs.unenrichedExercises),
    "## Pointer digest",
    `- Sessions since last review: ${inputs.pointerDigest.sessionsSinceLastReview}`,
    `- Open Observations: ${inputs.pointerDigest.openObservationCount}`,
    `- Last Cycle review: ${inputs.pointerDigest.lastCycleReviewAt ?? "(none yet)"}`,
    "",
    "## Retrieval pointers",
    `The Log, full analytics, and the Decision log were NOT front-loaded above — pull them yourself with ` +
      `your native tools (Read/Bash/Grep/WebSearch/WebFetch) as you need them. The database is a ` +
      `READ-ONLY snapshot at:`,
    "",
    `    ${inputs.snapshotDbPath}`,
    "",
    // Issue #93: the first live Session review could not read the Log at all.
    // The seed named `sqlite3` and nothing else, and the home host has no
    // `sqlite3` binary — so every review ran blind and said so honestly in its
    // rationale, which is the good failure but still a worthless run. Node is
    // the one query engine guaranteed present (it is what the server runs on),
    // so it leads; `sqlite3` stays as the shorter path where it exists.
    "Query it with Node's built-in SQLite — the server's own runtime, so it is always available:",
    "",
    `    node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify(d.prepare('SELECT ...').all()))" '${shellSafePath(inputs.snapshotDbPath)}'`,
    "",
    `If the sqlite3 CLI happens to be installed, it is shorter: sqlite3 -readonly '${shellSafePath(inputs.snapshotDbPath)}' "SELECT ..."`,
    "Check that your query actually returned rows. If BOTH of the above fail, say so plainly in your",
    "rationale and reason only from what was injected above — never present unread data as read.",
    "It cannot be written to — this is a throwaway copy, not the live database.",
    "",
    "## Data dictionary (table -> columns)",
    renderDataDictionary(),
  ].join("\n");

// --- Revision-run seed assembly (ADR 0013 §6, issue #66 slice 2) -----------

/**
 * The target Decision, in full (ADR 0013 §6: "summary, rationale, citations,
 * and its Data window"). Deliberately a narrow, seed-local shape rather than
 * `Store`'s `DecisionRecord` — `seedContext.ts` has no dependency on
 * `@repcoach/persistence`, and the runner (which DOES read `Store`) is the
 * one place that maps a `DecisionRecord` down to this.
 */
export interface RevisionSeedTarget {
  readonly summary: string;
  readonly rationale: string;
  readonly citations: ReadonlyArray<Citation>;
  /** The target's `data_window_json`, verbatim — `null` on a row that somehow has none. */
  readonly dataWindowJson: string | null;
}

/**
 * Everything `assembleRevisionSeed` adds on top of the ordinary seed (ADR
 * 0013 §6): the target Decision in full, the prior exchange turns oldest
 * first (`Store.getProposalExchange`'s `entries`), and the user's own prose
 * for THIS turn.
 */
export interface RevisionSeedContext {
  readonly targetDecision: RevisionSeedTarget;
  readonly priorTurns: ReadonlyArray<ProposalExchangeEntry>;
  readonly revisionProse: string;
}

const renderCitations = (citations: ReadonlyArray<Citation>): string => {
  if (citations.length === 0) return "(no citations)";
  return citations.map((c) => `- ${c.claim} — ${c.source_url} [${c.trust}]`).join("\n");
};

const renderTargetDecision = (target: RevisionSeedTarget): string =>
  [
    `Summary: ${target.summary}`,
    `Rationale: ${target.rationale}`,
    "Citations:",
    renderCitations(target.citations),
    "Data window (this Proposal's own provenance envelope):",
    target.dataWindowJson ?? "(none recorded)",
  ].join("\n");

/**
 * Renders the prior exchange turns oldest-first, exactly as
 * `Store.getProposalExchange`'s `entries` are already ordered (ADR 0013 §9) —
 * the user's Revise prose, the coach's Answers, and any collapsed prior
 * (superseded) Proposal version, so the agent reads the argument as it
 * actually unfolded rather than as an undifferentiated bag of context.
 */
const renderPriorTurns = (turns: ReadonlyArray<ProposalExchangeEntry>): string => {
  if (turns.length === 0) {
    return "(no prior turns — this is the first Revise on this Proposal)";
  }
  return turns
    .map((turn) => {
      switch (turn.kind) {
        case "revise":
          return `- [${turn.createdAt}] THE USER (Revise): ${turn.text}`;
        case "answer":
          return `- [${turn.createdAt}] YOU, previously (Answer): ${turn.summary} — ${turn.rationale}`;
        case "superseded-proposal":
          return `- [${turn.createdAt}] (an earlier version this chain superseded): ${turn.summary} — ${turn.rationale}`;
      }
    })
    .join("\n");
};

/**
 * The Revision-run seed (ADR 0013 §6): the SAME `assembleSeed` every
 * Session/Cycle/on-demand run gets — same snapshot, same tools, same sweep —
 * plus the target Decision in full and the prior exchange turns. Reuses
 * `assembleSeed` rather than duplicating it, so a Revision run's seed can
 * never silently drift from the ordinary one it is a framing of.
 *
 * `inputs.cadence` must be `"revision-run"` — the caller (the runner) is
 * responsible for resolving `SeedInputs` via `buildSeedInputs({ cadence:
 * "revision-run", ... })` so `CADENCE_FRAMING`'s Revision-run framing is the
 * one that lands in the seed.
 */
export const assembleRevisionSeed = (inputs: SeedInputs, revision: RevisionSeedContext): string =>
  [
    assembleSeed(inputs),
    "",
    "## The Proposal you drafted, in full (ADR 0013 §6 — the subject of this Revise)",
    renderTargetDecision(revision.targetDecision),
    "",
    "## Prior exchange turns on this Proposal, oldest first (ADR 0013 §4/§9)",
    renderPriorTurns(revision.priorTurns),
    "",
    "## The user's current Revise",
    revision.revisionProse,
  ].join("\n");

/**
 * The snapshot path as the agent's shell will actually see it (issue #93).
 *
 * `Bash` on the home host is git-bash, and the snapshot lives at a Windows
 * path (`C:\Users\…\Temp\…`). Pasted raw into a command, the backslashes are
 * eaten as escapes and the query fails with "unable to open database file" —
 * which reads exactly like "the data isn't there". Forward slashes are
 * understood by both Node and sqlite3 on Windows, and are a no-op elsewhere.
 */
const shellSafePath = (filePath: string): string => filePath.replace(/\\/g, "/");

/**
 * The Intake seed (ADR 0011 §7, ADR 0014 §1): the ordinary seed plus the four
 * form fields, verbatim.
 *
 * Verbatim is the point. §1's form asks only what a model cannot guess, and it
 * deliberately leaves `goal` un-validated ("get stronger") and `lifts` as free
 * text ("squat 100, bench 70", or nothing at all) — sharpening the Goal and
 * interpreting the lifts are the coach's job, so pre-parsing them here would
 * quietly take back the thing the form was shaped to hand over. An absent lifts
 * field is a real answer ("I haven't been training"), not missing input, and it
 * is labelled as such rather than rendered as an empty list.
 */
export const assembleIntakeSeed = (
  inputs: SeedInputs,
  form: {
    readonly goal: string;
    readonly daysPerWeek: number;
    readonly equipment: ReadonlyArray<string>;
    readonly lifts?: string;
  },
  catalog: ReadonlyArray<{ readonly id: string; readonly name: string; readonly trackedMetrics: ReadonlyArray<string> }>,
): string =>
  [
    assembleSeed(inputs),
    "",
    // Injected, not left to retrieval, for the same reason Standing constraints
    // are (§2) — but as ids to REUSE, not as a fence.
    //
    // This section used to declare the catalog a closed set, because the first
    // live Intake (issue #93) drafted a sensible plan around ids that existed
    // nowhere and Accept rejected the whole thing after the user had converged.
    // ADR 0016 removed that failure: `materializeDraftPlan` now mints a catalog
    // row for every unknown `exerciseId` an accepted draft names, so a name the
    // coach invents is it AUTHORING an Exercise, not a refused Accept. The
    // closed-set wording outlived the constraint it described, and at cold
    // start — where the catalog is empty by definition — it instructed the
    // coach to refuse a plan that would in fact have accepted cleanly. The
    // catalog is only ever populated BY accepting a plan, so a closed empty
    // catalog is a deadlock, not a guard rail.
    //
    // What is left is the real risk: two rows for one movement, splitting the
    // user's history. That is a reuse instruction, not a prohibition.
    "## Exercise catalog — reuse these ids where they fit, mint new ones where they don't",
    "`exerciseId` is the join key between your draft and the Exercise catalog. Accepting the plan CREATES a",
    "catalog row for every id in it the catalog does not already hold (ADR 0016), so you are not limited to the",
    "list below — prescribe the training the user actually needs.",
    "Two rules:",
    "- REUSE an id below, character for character, whenever it is the same movement. A second id for a movement",
    "  already in the catalog splits the user's training history across two rows that never join back up.",
    "- Otherwise MINT one, as `exercise-<kebab-case-name>` (`exercise-barbell-row`, `exercise-incline-db-press`).",
    "  Give that entry an `exerciseName` a human would recognise and the `trackedMetrics` it should log — those",
    "  two fields are what the new catalog row is written from, and a row that declares no metrics renders an",
    "  empty logging grid until a later Session review repairs it.",
    ...(catalog.length === 0
      ? [
          "- (the catalog is empty — this is a cold start, so every exercise you prescribe mints a new row. That is",
          "  the normal first-plan case, not a problem to report.)",
        ]
      : catalog.map(
          (exercise) => `- ${exercise.id} — ${exercise.name} (tracks: ${exercise.trackedMetrics.join(", ")})`,
        )),
    "",
    "## The user's Intake form (verbatim — this is everything they told you)",
    `- Goal, in their words: ${form.goal}`,
    `- Days per week: ${form.daysPerWeek}`,
    `- Equipment: ${form.equipment.length > 0 ? form.equipment.join(", ") : "(not stated)"}`,
    `- Current lifts and working weights: ${
      form.lifts === undefined || form.lifts.trim() === ""
        ? "(skipped — they may not have been training; treat starting loads as your judgment call and say so)"
        : form.lifts
    }`,
  ].join("\n");

// --- SeedInputsProvider: sources every input from the real Store -----------

/**
 * "Recent" window caps for Check-ins/Context notes (ADR 0011 §2: "recent
 * Check-ins / Context notes (small, always relevant to recovery)") — `Store`
 * returns every stored row, oldest-first; the provider slices the tail here
 * so the seed stays compact even once a user has months of history. Not
 * user-configurable (yet) — a plain constant, easy to revisit.
 */
const RECENT_CHECK_INS_LIMIT = 14;
const RECENT_CONTEXT_NOTES_LIMIT = 10;

export class SeedInputsProvider extends Context.Service<
  SeedInputsProvider,
  {
    readonly buildSeedInputs: (params: {
      readonly cadence: DeliberationCadence;
      readonly snapshotDbPath: string;
    }) => Effect.Effect<SeedInputs>;
  }
>()("@repcoach/server/SeedInputsProvider") {}

/**
 * The real provider (issue #34): every one of the six seed inputs is sourced
 * from the live `Store` — Plan snapshot, Goal, Standing constraints
 * (ALL of them, hard+soft — ADR 0011 §2's always-injected guarantee),
 * the Evidence-base roster, recent Check-ins/Context notes, and the pointer
 * digest (`openObservationCount` from `decision` rows;
 * `sessionsSinceLastReview`/`lastCycleReviewAt` DERIVED from
 * `logged_session`/`decision` timestamps via `Store.getPointerDigestHistory`
 * — see `store.ts`'s `deriveDigestHistory`). Nothing is stubbed anymore.
 */
export const SeedInputsProviderLive: Layer.Layer<SeedInputsProvider, never, Store> = Layer.effect(
  SeedInputsProvider,
)(
  Effect.gen(function* () {
    const store = yield* Store;

    const buildSeedInputs: (params: {
      readonly cadence: DeliberationCadence;
      readonly snapshotDbPath: string;
    }) => Effect.Effect<SeedInputs> = (params) =>
      Effect.gen(function* () {
        const planSnapshot = yield* store.getPlan;
        const decisions = yield* store.listDecisionsForTest;
        // The open Observations are BOTH counted (pointer digest) and injected
        // in full as priors (ADR 0011 §5, issue #30) — one filter, one source
        // of truth. `listDecisionsForTest` is the same read the existing
        // `openObservationCount` already sourced from; a dedicated
        // `listOpenObservations` Store method is a possible later cleanup, but
        // reusing this read keeps the two derivations consistent by
        // construction.
        const openObservationRecords = decisions.filter(
          (d) => d.kind === "observation" && d.status === "open",
        );
        const openObservations: ReadonlyArray<ObservationPrior> = openObservationRecords.map((d) => ({
          id: d.id,
          summary: d.summary,
          rationale: d.rationale,
          createdAt: d.createdAt,
        }));
        const openObservationCount = openObservationRecords.length;

        const goal = yield* store.getGoal;
        // ALL Standing constraints, hard + soft — never truncated or
        // filtered here (ADR 0011 §2's "always injected" guarantee is only
        // real if every stored constraint reaches `assembleSeed`).
        const standingConstraints = yield* store.listStandingConstraints;
        const evidenceRoster = yield* store.listEvidenceRoster;
        const allCheckIns = yield* store.listCheckIns;
        const allContextNotes = yield* store.listContextNotes;
        const { sessionsSinceLastReview, lastCycleReviewAt } = yield* store.getPointerDigestHistory;

        // Enrichment rides Session review and nothing else (ADR 0016): no new
        // run type, no model call per name typed, and the latency is
        // self-correcting because the user added the exercise in order to
        // train it. Read here rather than unconditionally so the other
        // cadences' seeds are untouched — a Cycle review or a Revision run
        // that was handed the roster would be invited to do work its runner
        // will not write.
        const unenrichedExercises =
          params.cadence === "session-review" ? yield* store.listUnenrichedExercises : [];

        const seedInputs: SeedInputs = {
          cadence: params.cadence,
          planSnapshot,
          goal,
          standingConstraints,
          evidenceRoster,
          checkIns: allCheckIns.slice(-RECENT_CHECK_INS_LIMIT),
          contextNotes: allContextNotes.slice(-RECENT_CONTEXT_NOTES_LIMIT),
          openObservations,
          unenrichedExercises,
          pointerDigest: {
            sessionsSinceLastReview,
            openObservationCount,
            lastCycleReviewAt,
          },
          snapshotDbPath: params.snapshotDbPath,
        };
        return seedInputs;
      });

    return SeedInputsProvider.of({ buildSeedInputs });
  }),
);
