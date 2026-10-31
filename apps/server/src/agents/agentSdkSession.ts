import { query } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { addTokenUsage, ZERO_TOKEN_USAGE, type TokenUsage } from "@repcoach/contracts";

/**
 * Shared Agent SDK session-running mechanics (ADR 0011 §1/§4), factored out
 * of `realDeliberationAgent.ts` when the adversarial sweep (issue #28 — 2B
 * slice 3) needed the SAME max-turns/wall-clock kill approach for a SECOND,
 * separate Agent SDK session. Both the deliberator (`realDeliberationAgent.ts`)
 * and the sweep (`realDeliberationSweepAgent.ts`) run one `query()` session
 * each through `runAgentSdkSession` — same kill guard, same "pull the final
 * `result` message's text out" shape — so the two can't drift out of step on
 * how a runaway session gets stopped.
 */

export class DeliberationRunKilledError extends Schema.TaggedErrorClass<DeliberationRunKilledError>()(
  "DeliberationRunKilledError",
  {
    // "could-not-start" (issue #90) is distinct from "wall-clock": it fires
    // when the SDK session throws before yielding a single message — the
    // session never got underway, rather than running away and then failing
    // partway through.
    //
    // "not-authenticated" is distinct from BOTH, and outranks them: the CLI's
    // OAuth session expired (or was never signed in), so nothing was spent and
    // nothing timed out. It gets its own reason because it is the one failure
    // here with a human fix — sign in again — and because the sign-in failure
    // can arrive either before or after the first SDK message, which used to
    // make an auth expiry read as "wall-clock" on the status strip: a run that
    // was never near its budget, reported as one that blew it.
    reason: Schema.Literals(["max-turns", "wall-clock", "could-not-start", "not-authenticated"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Deliberation run killed (${this.reason}): ${this.detail}`;
  }
}

export class DeliberationRunOutputParseError extends Schema.TaggedErrorClass<DeliberationRunOutputParseError>()(
  "DeliberationRunOutputParseError",
  {
    /**
     * WHICH way the output was unreadable (issue #94) — the same three-way
     * split `AgentPayloadFailure` makes, carried through to the failed run
     * state so "the model answered in prose" and "the model missed a required
     * key" are not the same line in a log. Optional because a caller with
     * nothing better to say than "it did not parse" should not have to invent
     * a category.
     */
    reason: Schema.optionalKey(Schema.Literals(["no-json", "invalid-json", "contract"])),
    detail: Schema.String,
  },
) {
  override get message(): string {
    const reason = this.reason === undefined ? "" : ` (${this.reason})`;
    return `Deliberation run output failed to parse against the contract${reason}: ${this.detail}`;
  }
}

/**
 * How an agent run can fail at the SDK boundary (issue #94): the session was
 * killed by the guard, or its final message could not be read as the contract's
 * object even after the one repair turn.
 *
 * It is a TYPED failure on `DeliberationAgent`/`DeliberationSweepAgent` rather
 * than a defect thrown past them: "the model's last message was unreadable" is
 * an outcome these boundaries genuinely have, and a caller that must decide
 * between committing and failing a run should not have to catch a defect to
 * learn about it. The canned/test implementations produce no error at all, and
 * `never` widens into this union for free, so nothing but the real adapters
 * pays for it.
 */
export type DeliberationRunFailure = DeliberationRunKilledError | DeliberationRunOutputParseError;

export interface AgentSdkSessionConfig {
  /** Hard turn cap (ADR 0011 §4 kill guard). The SDK stops the session itself once hit. */
  readonly maxTurns: number;
  /**
   * Hard wall-clock cap in milliseconds for a ONE-SHOT run — belt-and-braces
   * alongside `maxTurns`. Held-open sessions ignore it (issue #72): there the
   * agent's clock is a human's, and `maxTurns` plus the client connection are
   * the guard — see `openHeldAgentSdkSession`.
   */
  readonly wallClockMs: number;
  /** Optional model override (ADR 0011 §4 — model is configurable per cadence). */
  readonly model?: string;
  /**
   * Optional reasoning-effort override (issue #81), passed straight through
   * to the SDK's own `effort` option. Not every model supports every level
   * (or any level) — the SDK silently downgrades/ignores an unsupported
   * value, so this adapter does not validate it against a per-model
   * capability list it has no way to know.
   */
  readonly effort?: EffortLevel;
  /** Working directory the SDK session runs from — never the repo itself in prod use. */
  readonly cwd?: string;
}

/**
 * Overlays the runner's per-cadence `model`/`effort` onto a layer's default
 * session config (issue #81).
 *
 * Every real adapter needs the identical three-state overlay — leave the
 * layer's default when the setting is unset, override when it is set, for
 * each of the two independently — and each of them used to open-code the
 * `model` half alone (`model === undefined ? config : { ...config, model }`).
 * Spelling it once is what keeps `effort` from being wired into three
 * adapters and forgotten in the fourth.
 *
 * `undefined` means "not configured, use the layer default", so it is skipped
 * rather than written: spreading `{ effort: undefined }` over a config that
 * has one would erase it, which is the opposite of what an unset setting says.
 */
export const withSessionOverrides = (
  config: AgentSdkSessionConfig,
  model: string | undefined,
  effort: EffortLevel | undefined,
): AgentSdkSessionConfig => ({
  ...config,
  ...(model === undefined ? {} : { model }),
  ...(effort === undefined ? {} : { effort }),
});

/**
 * There is nobody to answer a permission prompt (issue #93).
 *
 * The first two live Session reviews read **nothing**: every attempt to query
 * the snapshot came back `This command requires approval`, because a `query()`
 * session defaults to prompting for `Bash` and a background server process has
 * no one to prompt. The run reasoned from the injected seed alone and said so
 * honestly in its rationale — the good failure, and still a worthless run,
 * since retrieval-on-demand is half of ADR 0011 §2.
 *
 * `dontAsk` would have failed the same way (deny instead of ask). So the
 * sessions bypass prompting, and the safety story is where the ADR always put
 * it: the agent sees an **OS-read-only snapshot** (§3, `chmod 0o444`), never
 * the live DB, from a working directory that is neither the repo nor the DB's
 * own (`agentWorkingDirectory.ts`), with a fixed native-tool list and no write
 * path back. A permission prompt nobody can answer was never that boundary.
 */
const NON_INTERACTIVE_PERMISSIONS = {
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
} as const;

/** "Within reason" defaults (ADR 0011 §1): generous, but never unbounded. */
export const DEFAULT_AGENT_SDK_SESSION_CONFIG: AgentSdkSessionConfig = {
  maxTurns: 40,
  wallClockMs: 10 * 60 * 1000,
};

/**
 * Every candidate substring of a final message that might be the object, in
 * the order worth trying (issue #94).
 *
 * The old extraction was one regex that stripped a single ```-fence and hoped.
 * That covers exactly two shapes — bare object, or object in a ```json fence —
 * and every real model has a long tail beyond them: a tilde fence, a fence it
 * opened and never closed, a "Here's the plan:" sentence in front, a "Let me
 * know if you'd like changes." sentence behind. None of those are the model
 * disobeying in a way that matters; all of them used to throw away a completed
 * run.
 *
 * Order is deliberate. The whole message first, because a compliant model is
 * the common case and its message parses as-is. Then fenced blocks, because a
 * fence is an explicit "the payload is in here" marker. Only then the
 * brace scan, which is the guess — and within it, LONGEST first, so a
 * `{ "reps": 8 }` quoted inside the surrounding prose never wins over the
 * object that contains the whole plan.
 */
const jsonCandidates = function* (resultText: string): Generator<string> {
  const text = resultText.trim();
  yield text;

  // Any fence: three-or-more backticks or tildes, optional language tag, and
  // a closing run that may never arrive (the model ran out of message).
  const fences = /(?:^|\n)[ \t]*(`{3,}|~{3,})[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*\1|$)/g;
  for (const match of text.matchAll(fences)) {
    const body = match[2];
    if (body !== undefined) yield body.trim();
  }

  yield* balancedObjectSpans(text);
};

/**
 * Every balanced `{…}` span at brace-depth zero, longest first.
 *
 * String-aware on purpose: a `"summary": "we go from {8} to {10} reps"` has
 * braces inside a JSON string, and a naive depth counter would close the
 * object early and hand `JSON.parse` a truncated fragment — which fails in a
 * way that looks exactly like the model emitting garbage.
 */
const balancedObjectSpans = (text: string): ReadonlyArray<string> => {
  const spans: Array<string> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) spans.push(text.slice(start, index + 1));
    }
  }

  return spans.sort((a, b) => b.length - a.length);
};

/**
 * Pulls the model's final structured JSON object out of a `result` SDK
 * message's text, tolerating prose around it and any fence variant
 * (issue #94). Returns `undefined` when nothing in the message parses as a
 * JSON **object** — an array or a bare string is not the contract's shape and
 * is not worth pretending about.
 *
 * Both cadence agents and both Intake agents call this one function. That is
 * the point of it living here: a fifth shape the extraction learns to survive
 * must be learnt for all four at once, and the sweep must never be a little
 * more tolerant than the deliberator whose output it rewrites.
 */
export const extractJsonPayload = (resultText: string): unknown | undefined => {
  for (const candidate of jsonCandidates(resultText)) {
    if (candidate === "" || !candidate.includes("{")) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {
      // Not this candidate; the next one may still be the object.
    }
  }
  return undefined;
};

/**
 * Drops `null`-valued properties, recursively, from a parsed agent payload
 * (issue #93 — observed against the first live Intake session).
 *
 * Every optional field in the agent-facing contracts is `Schema.optionalKey`:
 * absence is the way to say "nothing here", and ADR 0011 §6 is emphatic that
 * nothing may soften an omission into `[]` or `""`. A real model, asked to
 * omit a field, very often writes `"citationId": null` instead — the same
 * claim, spelled the other way — and the run died on it: a whole drafted Plan
 * thrown away over a JSON idiom.
 *
 * `null` and absent mean the identical thing here, so collapsing one into the
 * other loses no information and softens nothing: a `null` measurement stays
 * "no measurement", it does not become an empty list. No agent-facing contract
 * field accepts `null` as a legitimate *value*, which is what makes this safe
 * to apply to the whole payload rather than field by field.
 */
export const dropNullValues = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(dropNullValues);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null) continue;
    out[key] = dropNullValues(entry);
  }
  return out;
};

/**
 * Fills in the two list fields on a decision draft where **empty and absent
 * say the same thing** (issue #93, observed on a live Session review that had
 * done all its reasoning and then failed on `Missing key at
 * ["decisions"][0]["reasoning_only_points"]`).
 *
 * `citations: []` is "no sources" and `reasoning_only_points: []` is "no
 * uncited points" — a model with nothing to put in either writes neither, and
 * throwing the whole run away over that is a bad trade for a list whose empty
 * value is not ambiguous.
 *
 * `surface` is filled in too, and the run that forced it is the argument:
 * the prompt tells the model "surface only matters for observation kind
 * decisions", the model dutifully omitted it on a Proposal, and the contract
 * — which requires it on every draft — threw the run away. ADR 0011 §6 is
 * unambiguous about the Proposal case (a feed entry for **every** Proposal),
 * so `proposal` defaults to `true` and nothing is being decided on the coach's
 * behalf. An `observation` with no `surface` defaults to `false`: the feed
 * stays signal-dense, which is what §6 wants it for, and the Decision is
 * recorded in full on the Coach record either way — the quiet side of a
 * genuinely ambiguous omission, rather than binning a finished run.
 *
 * The three WORKING fields (`measurements`, `rule`, `uncertainty`) are
 * deliberately NOT defaulted, and must never be: ADR 0011 §6 turns on the
 * difference between "the coach offered no evidence" and "the coach offered
 * empty evidence", and a block that always renders teaches the user to skip
 * it.
 */
/**
 * Drops anything in `catalog_enrichments` that could not be written anyway
 * (#104, ADR 0016), so a malformed enrichment can never fail the review it
 * rode in on.
 *
 * The asymmetry with the decisions above is the point. A decision that will
 * not decode is a finding about the user's training being thrown away, and
 * the fix there was to fill in the fields whose empty value is unambiguous.
 * An enrichment is a lookup the coach volunteered on the side: a run that
 * spent minutes reasoning over the Log and then named one metric this app
 * does not track must not lose all of that. So the bad entry is discarded and
 * everything else — the decisions, and the enrichments that ARE well-formed —
 * still lands. The row it named stays name-only and usable, and comes back on
 * the next review.
 *
 * Structural only: it drops what is obviously unwritable (a missing id, a
 * metric outside the closed set, a non-string muscle) and leaves judgment
 * about the CONTENT to the schema decode that follows and to the store, which
 * refuses to touch a row that is already enriched.
 */
const KNOWN_METRIC_NAMES: ReadonlySet<string> = new Set([
  "reps",
  "load",
  "duration",
  "distance",
  "rpe",
  "tempo",
]);

const nonEmptyStrings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : undefined;

export const sanitizeCatalogEnrichments = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const root = value as Record<string, unknown>;
  const enrichments = root["catalog_enrichments"];
  // Absent is the common case (no un-enriched rows, so the seed never
  // mentioned the field) and must stay absent — an empty array here would be
  // a claim the run made about a question it was never asked.
  if (enrichments === undefined) return root;
  if (!Array.isArray(enrichments)) {
    const { catalog_enrichments: _dropped, ...rest } = root;
    return rest;
  }

  const cleaned = enrichments.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const enrichment = entry as Record<string, unknown>;
    const exerciseId = enrichment["exercise_id"];
    if (typeof exerciseId !== "string" || exerciseId.trim() === "") return [];

    const trackedMetrics = nonEmptyStrings(enrichment["tracked_metrics"])?.filter((metric) =>
      KNOWN_METRIC_NAMES.has(metric),
    );
    const muscles = nonEmptyStrings(enrichment["muscles"]);
    const movementPattern = enrichment["movement_pattern"];

    return [
      {
        exercise_id: exerciseId,
        ...(trackedMetrics === undefined ? {} : { tracked_metrics: trackedMetrics }),
        ...(muscles === undefined ? {} : { muscles }),
        ...(typeof movementPattern === "string" && movementPattern.trim() !== ""
          ? { movement_pattern: movementPattern }
          : {}),
      },
    ];
  });

  return { ...root, catalog_enrichments: cleaned };
};

export const defaultEmptyDecisionLists = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const root = value as Record<string, unknown>;
  const decisions = root["decisions"];
  if (!Array.isArray(decisions)) return value;
  return {
    ...root,
    decisions: decisions.map((decision) => {
      if (typeof decision !== "object" || decision === null) return decision;
      const draft = decision as Record<string, unknown>;
      return {
        ...draft,
        citations: draft["citations"] ?? [],
        reasoning_only_points: draft["reasoning_only_points"] ?? [],
        surface: draft["surface"] ?? draft["kind"] === "proposal",
      };
    }),
  };
};

/**
 * Why a final message could not be turned into the contract's object
 * (issue #94). Three reasons, and they are genuinely different failures:
 *
 * - `no-json` — nothing object-shaped in the message at all. The model
 *   answered in prose, or refused, or hit its own output limit mid-sentence.
 * - `invalid-json` — something object-shaped is there and does not parse
 *   (a trailing comma, a smart quote, a truncated tail).
 * - `contract` — it parsed, and the object is not the shape the contract
 *   wants. This is the class commissioning actually observed (issue #93:
 *   `citationId: null`, then two omitted required keys), and the one a repair
 *   turn can most reliably fix, because the decoder's own message names the
 *   offending path.
 */
export type AgentPayloadFailureReason = "no-json" | "invalid-json" | "contract";

/**
 * A final message that could not be read, as a value rather than a defect.
 * Each adapter wraps it in its own error type (`DeliberationRunOutputParseError`
 * for the cadences, `IntakeAgentError` for Intake) — the shared code does not
 * pick one, because Intake's failure is a survivable turn and a cadence's is a
 * dead run.
 */
export interface AgentPayloadFailure {
  readonly reason: AgentPayloadFailureReason;
  /** Human-readable, and already carries the reason, the decoder's complaint and an excerpt. */
  readonly detail: string;
}

/** The head of a message that failed to decode — the only artifact left of a reply that is otherwise gone. */
const PAYLOAD_EXCERPT_CHARS = 400;
const payloadExcerpt = (text: string): string =>
  ` | message began: ${JSON.stringify(text.slice(0, PAYLOAD_EXCERPT_CHARS))}`;

/**
 * One agent payload's shape: the contract schema plus whatever normalisation
 * the adapter applies before decoding (`dropNullValues`, and for the two
 * cadence agents `defaultEmptyDecisionLists` on top).
 *
 * It exists as a value so the four adapters can hand the SAME decode path
 * their four different schemas, and so a test can iterate all four and prove
 * they recover identically (issue #94: "they share the extraction and must not
 * diverge"). `label` is what the failure detail calls the payload.
 */
export interface AgentPayloadShape<A> {
  readonly label: string;
  readonly decode: (raw: unknown) => Effect.Effect<A, string>;
}

export const makeAgentPayloadShape = <S extends Schema.Top>(params: {
  readonly label: string;
  readonly schema: S;
  /** Applied to the parsed object before the schema sees it. Defaults to `dropNullValues`. */
  readonly normalize?: (raw: unknown) => unknown;
}): AgentPayloadShape<S["Type"]> => {
  const normalize = params.normalize ?? dropNullValues;
  return {
    label: params.label,
    decode: (raw) =>
      Schema.decodeUnknownEffect(params.schema)(normalize(raw)).pipe(
        Effect.mapError((cause) => String(cause)),
      ) as Effect.Effect<S["Type"], string>,
  };
};

/**
 * Reads one final message into the shape's contract type, or explains why it
 * could not be (issue #94). No session, no spend — this is the free half of
 * the recovery, and the half that runs on every message.
 */
export const decodeAgentPayload = <A>(
  shape: AgentPayloadShape<A>,
  text: string,
): Effect.Effect<A, AgentPayloadFailure> =>
  Effect.suspend(() => {
    const parsed = extractJsonPayload(text);
    if (parsed === undefined) {
      // "Contains a brace but nothing parsed" and "no object anywhere" are
      // different stories to whoever reads the log: the first is a mangled
      // object, the second is a model that answered in prose.
      const reason: AgentPayloadFailureReason = text.includes("{") ? "invalid-json" : "no-json";
      const failure: AgentPayloadFailure = {
        reason,
        detail: `${shape.label} carried no readable JSON object (${reason})${payloadExcerpt(text)}`,
      };
      return Effect.fail(failure);
    }
    return shape.decode(parsed).pipe(
      Effect.mapError(
        (cause): AgentPayloadFailure => ({
          reason: "contract",
          detail: `${shape.label} failed contract decode: ${cause}${payloadExcerpt(text)}`,
        }),
      ),
    );
  });

/**
 * The one repair ask, phrased from the failure that motivated it.
 *
 * It names the deviation rather than repeating the format rules the model has
 * already read once: a model that emitted the object inside a paragraph does
 * not need the schema again, and a model that omitted a required key needs to
 * be told WHICH key. The "do not change the content" clause is the important
 * one — a repair turn that re-reasons is a second, unreviewed run, and the
 * value being rescued is precisely the reasoning already done.
 */
export const buildRepairInstruction = (failure: AgentPayloadFailure): string =>
  `Your last message could not be read as the required JSON object.

${failure.detail}

Send the object again, and ONLY the object: no prose before or after it, no markdown fence, one single
JSON object. Do NOT redo any reasoning, retrieval or verification, and do NOT add, drop or change any
content — the substance of your last message was fine, only its shape was not. If a required key is
genuinely missing, fill it from what you already said; never invent a citation, a source or a number to
fill a hole.`;

/**
 * Reads a final message, and if it cannot be read, spends **exactly one**
 * repair turn asking for the object again (issue #94).
 *
 * Bounded by construction rather than by configuration: the second decode is
 * terminal, and there is no attempt counter to set to three. A repair that
 * comes back just as unreadable fails with BOTH stories in the detail —
 * "recovery was tried and did not work" is a different diagnosis from "the
 * output was bad", and the person reading the log needs to tell them apart.
 *
 * Why a repair turn at all, when commissioning (issue #93) saw no bare-JSON
 * drift in five live sessions: the drift it DID see was contract-shaped, three
 * times, and each one threw away a completed run. Two of those were absorbed
 * by named fixups (`dropNullValues`, `defaultEmptyDecisionLists`) — this is the
 * general case of the same thing, for the fourth deviation nobody has seen yet.
 * It costs nothing on the happy path, which is the only path observed so far.
 *
 * Usage is SUMMED across both turns, never replaced: the repair's spend is
 * real, it lands on the same run's ledger row, and hiding it would make the
 * cheapest possible bug — a model that needs repairing on every single run —
 * invisible in exactly the numbers meant to catch it (ADR 0011 §8).
 */
export const decodeAgentPayloadWithRepair = <A>(params: {
  readonly shape: AgentPayloadShape<A>;
  readonly session: AgentSdkSessionResult;
  /** Sends the repair ask and returns the retried message. */
  readonly repair: (instruction: string) => Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError>;
}): Effect.Effect<{ readonly value: A; readonly usage: TokenUsage; readonly costUsd: number }, AgentPayloadFailure> =>
  decodeAgentPayload(params.shape, params.session.text).pipe(
    Effect.map((value) => ({ value, usage: params.session.usage, costUsd: params.session.costUsd })),
    Effect.catch((failure: AgentPayloadFailure) =>
      Effect.sync(() => {
        // eslint-disable-next-line no-console
        console.error(
          `[repcoach-server] ${params.shape.label} unreadable, spending one repair turn: ${failure.detail}`,
        );
      }).pipe(
        Effect.andThen(
          params.repair(buildRepairInstruction(failure)).pipe(
            Effect.mapError(
              (killed): AgentPayloadFailure => ({
                reason: failure.reason,
                detail: `${failure.detail} | the one repair turn could not run: ${killed.message}`,
              }),
            ),
          ),
        ),
        Effect.flatMap((retried) =>
          decodeAgentPayload(params.shape, retried.text).pipe(
            Effect.map((value) => ({
              value,
              usage: addTokenUsage(params.session.usage, retried.usage),
              costUsd: params.session.costUsd + retried.costUsd,
            })),
            Effect.mapError(
              (second): AgentPayloadFailure => ({
                reason: second.reason,
                detail: `${failure.detail} | the one repair turn did not fix it: ${second.detail}`,
              }),
            ),
          ),
        ),
      ),
    ),
  );

/**
 * SDK usage counts for one session, normalised to the contract's `TokenUsage`
 * shape (ADR 0005/0011 §8 amendment, issue #81) — all four fields the SDK
 * reports, not the uncached-only `{prompt, completion}` pair this used to
 * carry. `costUsd` is the SDK's own `total_cost_usd` for the session, carried
 * so the runner's ledger write can store it (ADR 0011 §8: stored, not
 * rendered).
 */
export interface AgentSdkSessionResult {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;
}

/** Reads all four usage fields plus cost off an SDK `result` message's `usage`/`total_cost_usd`, defaulting anything absent to zero. */
const readSdkUsage = (message: {
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
  readonly total_cost_usd?: number;
}): { readonly usage: TokenUsage; readonly costUsd: number } => ({
  usage:
    message.usage === undefined
      ? ZERO_TOKEN_USAGE
      : {
          input: message.usage.input_tokens ?? 0,
          output: message.usage.output_tokens ?? 0,
          cacheRead: message.usage.cache_read_input_tokens ?? 0,
          cacheCreation: message.usage.cache_creation_input_tokens ?? 0,
        },
  costUsd: message.total_cost_usd ?? 0,
});

/**
 * Marks of an authentication failure in whatever the SDK threw.
 *
 * The SDK gives us no code for this — the CLI's sign-in state surfaces as prose
 * inside an ordinary `Error` ("Claude Code returned an error result: Failed to
 * authenticate: OAuth session expired and could not be refreshed") — so text is
 * genuinely all there is to match on. The patterns stay anchored on words that
 * appear only in an auth failure: the cost of a false positive is telling the
 * owner to sign in when the real fault was something else entirely.
 */
const AUTH_FAILURE_MARKS: ReadonlyArray<RegExp> = [
  /failed to authenticate/i,
  /oauth/i,
  /authentication_error/i,
  /\bunauthorized\b/i,
  /not logged in/i,
  /invalid api key/i,
];

const isAuthFailure = (cause: unknown): boolean => {
  const text = String(cause);
  return AUTH_FAILURE_MARKS.some((mark) => mark.test(text));
};

/**
 * Turns whatever an SDK session threw into the kill reason and the line the
 * owner reads on the status strip.
 *
 * Shared by the one-shot and the held-open session so the two cannot disagree
 * about what an expired login looks like — the misreport this fixes was exactly
 * that kind of gap, where an auth failure arriving after the first message fell
 * through to the `receivedAnyMessage` branch and was named a wall-clock kill.
 */
const classifyThrownCause = (
  cause: unknown,
  context: { readonly receivedAnyMessage: boolean; readonly subject: string },
): DeliberationRunKilledError =>
  isAuthFailure(cause)
    ? new DeliberationRunKilledError({
        reason: "not-authenticated",
        // The remedy rides in the detail because this is the one failure here
        // the owner can act on, and the status strip is where they meet it.
        detail: `Claude Code is not signed in — run \`claude\` and \`/login\`, then re-run. (${String(cause)})`,
      })
    : new DeliberationRunKilledError({
        reason: context.receivedAnyMessage ? "wall-clock" : "could-not-start",
        detail: context.receivedAnyMessage
          ? `${context.subject} threw: ${String(cause)}`
          : `session could not start: ${String(cause)}`,
      });

/**
 * Runs one Agent SDK (`query()`) session to completion under a max-turns +
 * wall-clock kill guard, returning the final `result` message's text AND the
 * SDK's reported token usage (input→`prompt`, output→`completion`) so the
 * runner can surface real usage counts (issue #32). `allowedTools` lets each
 * session (deliberator vs. sweep) restrict/extend its native tool surface
 * independently — both currently use native tools only (ADR 0011 §2, no
 * custom MCP tools).
 */
export const runAgentSdkSession = (
  prompt: string,
  config: AgentSdkSessionConfig,
  allowedTools: ReadonlyArray<string>,
): Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError> =>
  Effect.callback<AgentSdkSessionResult, DeliberationRunKilledError>((resume) => {
    const abortController = new AbortController();
    const wallClockTimer = setTimeout(() => {
      abortController.abort();
      resume(
        Effect.fail(
          new DeliberationRunKilledError({
            reason: "wall-clock",
            detail: `run exceeded ${config.wallClockMs}ms wall-clock budget`,
          }),
        ),
      );
    }, config.wallClockMs);

    let settled = false;
    let finalResultText: string | undefined;
    let finalUsage: TokenUsage = ZERO_TOKEN_USAGE;
    let finalCostUsd = 0;
    // Set once the session has yielded at least one SDK message — distinguishes
    // "threw before it ever got underway" (could-not-start) from "threw after
    // making progress" (issue #90).
    let receivedAnyMessage = false;

    const finish = (effect: Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockTimer);
      resume(effect);
    };

    void (async () => {
      try {
        for await (const message of query({
          prompt,
          options: {
            tools: [...allowedTools],
            maxTurns: config.maxTurns,
            abortController,
            ...NON_INTERACTIVE_PERMISSIONS,
            ...(config.model === undefined ? {} : { model: config.model }),
            ...(config.effort === undefined ? {} : { effort: config.effort }),
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          },
        }) as AsyncIterable<SDKMessage>) {
          receivedAnyMessage = true;
          if (message.type === "result") {
            const read = readSdkUsage(
              message as {
                readonly usage?: {
                  readonly input_tokens?: number;
                  readonly output_tokens?: number;
                  readonly cache_read_input_tokens?: number;
                  readonly cache_creation_input_tokens?: number;
                };
                readonly total_cost_usd?: number;
              },
            );
            finalUsage = read.usage;
            finalCostUsd = read.costUsd;
            if (message.subtype === "success") {
              finalResultText = message.result;
            } else if (message.stop_reason === "max_turns") {
              finish(
                Effect.fail(
                  new DeliberationRunKilledError({
                    reason: "max-turns",
                    detail: `run hit the ${config.maxTurns}-turn cap`,
                  }),
                ),
              );
              return;
            } else {
              finish(
                Effect.fail(
                  new DeliberationRunKilledError({
                    reason: "max-turns",
                    detail: `run ended without success: ${message.subtype}`,
                  }),
                ),
              );
              return;
            }
          }
        }

        if (finalResultText === undefined) {
          finish(
            Effect.fail(
              new DeliberationRunKilledError({
                reason: "max-turns",
                detail: "run ended with no result message",
              }),
            ),
          );
          return;
        }
        finish(Effect.succeed({ text: finalResultText, usage: finalUsage, costUsd: finalCostUsd }));
      } catch (cause) {
        finish(Effect.fail(classifyThrownCause(cause, { receivedAnyMessage, subject: "run" })));
      }
    })();

    // Fiber-interruption cleanup: stop the SDK session and the timer so a
    // caller-side interrupt (e.g. server shutdown) can't leave an orphaned
    // process/timer running past the Effect that spawned it.
    return Effect.sync(() => {
      clearTimeout(wallClockTimer);
      abortController.abort();
    });
  });

/**
 * The repair turn's own budget (issue #94). A repair does no retrieval and no
 * reasoning — it re-emits a message it has already been handed — so it gets ONE
 * turn, no tools at all, and two minutes. Those are not tuning knobs: they are
 * what makes "recovery cannot spend unboundedly" true by construction rather
 * than by a default nobody re-checks.
 */
const REPAIR_MAX_TURNS = 1;
const REPAIR_WALL_CLOCK_MS = 2 * 60 * 1000;
const REPAIR_NO_TOOLS: ReadonlyArray<string> = [];

/**
 * Caps how much of an unreadable message is pasted back for repair. A message
 * this long is already pathological; sending all of it would let one runaway
 * reply buy a second, equally runaway prompt.
 */
const REPAIR_MESSAGE_CHARS = 20_000;

/**
 * Builds the repair function for a ONE-SHOT session (the deliberator, the
 * cadence sweep, the Intake sweep) — the three places where the session that
 * produced the bad message is already finished and cannot be resumed.
 *
 * So the repair is a fresh, deliberately tiny session that is handed the bad
 * message as text. It keeps the run's model/effort/cwd, because a repair on a
 * different model is a different writer, and drops the tools entirely: there
 * is nothing to look up in "say that again as one object".
 *
 * The held-open Intake session does NOT use this — it resumes the same session
 * (`session.send`), which is both cheaper and better, since the model still has
 * the conversation the message came from.
 */
export type RepairSessionRunner = (
  prompt: string,
  config: AgentSdkSessionConfig,
  allowedTools: ReadonlyArray<string>,
) => Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError>;

export const oneShotRepairTurn =
  (
    config: AgentSdkSessionConfig,
    unreadable: string,
    /**
     * What actually runs the repair session (issue #95). Defaults to a live SDK
     * session, so production is unchanged — but the adapters pass their
     * transport, because a repair turn is a session like any other: a replay run
     * whose repair reached the real SDK would be neither deterministic nor free,
     * and would do it at the least visible moment in the pipeline.
     */
    run: RepairSessionRunner = runAgentSdkSession,
  ) =>
  (instruction: string): Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError> =>
    run(
      `${instruction}

## The message to re-emit

<<<MESSAGE
${unreadable.slice(0, REPAIR_MESSAGE_CHARS)}
MESSAGE`,
      {
        ...config,
        maxTurns: REPAIR_MAX_TURNS,
        wallClockMs: Math.min(config.wallClockMs, REPAIR_WALL_CLOCK_MS),
      },
      REPAIR_NO_TOOLS,
    );

/**
 * One tool call the SDK reported, forwarded verbatim (ADR 0014 §4): the tool's
 * name plus whatever it gave as the subject. Deliberately not phrased — copy
 * lives in the client, so a tool nobody has written a phrase for still renders
 * honestly off the subject instead of blanking.
 */
export interface AgentSdkToolCall {
  readonly tool: string;
  readonly subject?: string;
}

/**
 * A HELD-OPEN Agent SDK session (ADR 0014 §2): one `query()` kept alive across
 * many turns instead of being run to completion and killed. `send` resumes it;
 * `close` tears it down.
 *
 * The kill guard applies to the **session**, not the turn — a held-open session
 * that runs away is still killed, which is the whole reason "within reason"
 * (ADR 0011 §1) survives the move to a conversation. Once killed, every
 * subsequent `send` fails rather than silently opening a fresh session behind
 * the user's back.
 */
export interface HeldAgentSdkSession {
  readonly send: (text: string) => Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError>;
  readonly close: Effect.Effect<void>;
}

/**
 * Opens a held-open `query()` session and sends it the seed, returning the
 * session alongside its first result.
 *
 * The mechanics are unavoidably imperative — the SDK's streaming-input mode
 * wants an `AsyncIterable` of user messages it can pull from for the session's
 * lifetime, and the messages it yields back interleave tool calls with per-turn
 * `result` messages. So: a promise-based mailbox feeds the SDK, a single
 * background loop consumes its output, and each turn's `result` settles the turn
 * that is currently in flight. Effect wraps the edges rather than the middle.
 *
 * Verified through the runner against scripted ports; this adapter itself is
 * exercised by UAT, exactly as the deliberator and sweep adapters are.
 */
export const openHeldAgentSdkSession = (
  seed: string,
  config: AgentSdkSessionConfig,
  allowedTools: ReadonlyArray<string>,
  onToolCall: (call: AgentSdkToolCall) => void,
): Effect.Effect<
  { readonly session: HeldAgentSdkSession; readonly first: AgentSdkSessionResult },
  DeliberationRunKilledError
> =>
  Effect.gen(function* () {
    const abortController = new AbortController();

    // Pending user messages the SDK has not pulled yet, and the resolver the
    // async generator is parked on when it is ahead of us.
    const outbox: Array<string> = [seed];
    let waitingForInput: ((text: string | undefined) => void) | undefined;
    let closed = false;

    // The turn currently awaiting its `result` message.
    let pendingTurn:
      | {
          readonly settle: (result: Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError>) => void;
        }
      | undefined;
    let killed: DeliberationRunKilledError | undefined;

    const settlePending = (
      effect: Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError>,
    ): void => {
      const turn = pendingTurn;
      pendingTurn = undefined;
      turn?.settle(effect);
    };

    const kill = (error: DeliberationRunKilledError): void => {
      killed ??= error;
      closed = true;
      abortController.abort();
      waitingForInput?.(undefined);
      waitingForInput = undefined;
      settlePending(Effect.fail(error));
    };

    // NOTE: a held-open session has NO wall-clock guard at all (issue #72), and
    // `config.wallClockMs` is deliberately unread here. The clock was the wrong
    // instrument twice over: scoped to the session it killed conversations for
    // the user's thinking time, and scoped to the turn it would still cut off a
    // long retrieval turn mid-flight, throwing away work whose only sin was
    // taking a while. What actually bounds this session is `maxTurns` (a
    // runaway agent is one that will not stop taking turns) and the client
    // connection: the event stream's lifetime IS the session's, so a closed tab
    // or a dropped socket tears the session down through the stream's finalizer
    // (ADR 0014 §8). Nothing here is left to leak on a timer's say-so.

    const nextUserMessage = (): Promise<string | undefined> => {
      const queued = outbox.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve(undefined);
      return new Promise<string | undefined>((resolve) => {
        waitingForInput = resolve;
      });
    };

    const promptStream = async function* () {
      for (;;) {
        const text = await nextUserMessage();
        if (text === undefined) return;
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: text },
          parent_tool_use_id: null,
          session_id: "",
        };
      }
    };

    void (async () => {
      try {
        for await (const message of query({
          prompt: promptStream(),
          options: {
            tools: [...allowedTools],
            maxTurns: config.maxTurns,
            abortController,
            ...NON_INTERACTIVE_PERMISSIONS,
            ...(config.model === undefined ? {} : { model: config.model }),
            ...(config.effort === undefined ? {} : { effort: config.effort }),
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          },
        } as never) as AsyncIterable<SDKMessage>) {
          if (message.type === "assistant") {
            // Tool activity is the only thing the activity line is allowed to
            // report (§4: "driven by real tool events", never staged progress).
            const content = (message as { readonly message?: { readonly content?: unknown } }).message?.content;
            if (Array.isArray(content)) {
              for (const block of content as ReadonlyArray<Record<string, unknown>>) {
                if (block["type"] !== "tool_use") continue;
                const input = block["input"];
                const subject =
                  typeof input === "object" && input !== null
                    ? Object.values(input as Record<string, unknown>).find(
                        (value): value is string => typeof value === "string",
                      )
                    : undefined;
                onToolCall({
                  tool: String(block["name"] ?? "tool"),
                  ...(subject === undefined ? {} : { subject }),
                });
              }
            }
            continue;
          }

          if (message.type !== "result") continue;

          const read = readSdkUsage(
            message as {
              readonly usage?: {
                readonly input_tokens?: number;
                readonly output_tokens?: number;
                readonly cache_read_input_tokens?: number;
                readonly cache_creation_input_tokens?: number;
              };
              readonly total_cost_usd?: number;
            },
          );

          if (message.subtype === "success") {
            settlePending(Effect.succeed({ text: message.result, usage: read.usage, costUsd: read.costUsd }));
            continue;
          }
          if (message.stop_reason === "max_turns") {
            kill(
              new DeliberationRunKilledError({
                reason: "max-turns",
                detail: `held-open Intake session hit the ${config.maxTurns}-turn cap`,
              }),
            );
            return;
          }
          kill(
            new DeliberationRunKilledError({
              reason: "max-turns",
              detail: `held-open Intake session ended without success: ${message.subtype}`,
            }),
          );
          return;
        }

        // The SDK's stream ended. Anything still in flight will never be
        // answered, so fail it rather than leaving the caller parked forever.
        kill(
          new DeliberationRunKilledError({
            reason: "max-turns",
            detail: "held-open Intake session ended with no result message",
          }),
        );
      } catch (cause) {
        // `receivedAnyMessage: true`: a held-open session's turns are awaited
        // by a caller already talking to it, so there is no "never got
        // underway" state here worth its own reason. An expired login still
        // comes back as "not-authenticated" either way.
        kill(classifyThrownCause(cause, { receivedAnyMessage: true, subject: "held-open Intake session" }));
      }
    })();

    const awaitTurn: Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError> =
      Effect.callback<AgentSdkSessionResult, DeliberationRunKilledError>((resume) => {
        if (killed !== undefined) {
          resume(Effect.fail(killed));
          return;
        }
        pendingTurn = { settle: resume };
      });

    const first = yield* awaitTurn;

    const send = (text: string): Effect.Effect<AgentSdkSessionResult, DeliberationRunKilledError> =>
      Effect.suspend(() => {
        if (killed !== undefined) return Effect.fail(killed);
        const waiting = waitingForInput;
        waitingForInput = undefined;
        if (waiting !== undefined) waiting(text);
        else outbox.push(text);
        return awaitTurn;
      });

    const close: Effect.Effect<void> = Effect.sync(() => {
      closed = true;
      waitingForInput?.(undefined);
      waitingForInput = undefined;
      abortController.abort();
    });

    return { session: { send, close }, first };
  });
