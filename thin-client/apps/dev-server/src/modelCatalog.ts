import { query } from "@anthropic-ai/claude-agent-sdk";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AvailableModel, DeliberationEffort, ListModelsResult } from "@repcoach/contracts";

/**
 * Where the Settings model selector gets its options (issue #81 follow-up).
 *
 * The first build authored the list by hand in `Settings.tsx` — a three-entry
 * `KNOWN_MODELS` array plus a "Custom…" escape hatch — on the reasoning that
 * the CONTRACT should not enumerate models. That reasoning still holds; the
 * mistake was concluding the *client* should. A hand-authored list goes stale
 * the week a model ships, offers models the signed-in account may not be
 * entitled to run, and has no way to know which of them honour an effort
 * level. The Agent SDK already answers all three questions about THIS
 * installation, so the list is asked for rather than declared.
 *
 * This is a port, not a helper, for the usual reason: the real implementation
 * spins up an SDK session, so anything that wants a deterministic catalog
 * (tests, the canned server) swaps the layer instead of mocking a module.
 */
export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    /**
     * Never fails. A catalog that could not be read comes back empty with a
     * stated `unavailableReason`: the model selector's free-text field still
     * works, the persisted setting is still shown, and Settings does not go
     * down because a background SDK handshake did.
     */
    readonly list: Effect.Effect<ListModelsResult>;
  }
>()("@repcoach/dev-server/ModelCatalog") {}

/** Effort levels the contract accepts, as a set, for filtering the SDK's reported list. */
const CONTRACT_EFFORT_LEVELS: ReadonlySet<string> = new Set<DeliberationEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** The SDK's `ModelInfo`, narrowed to the fields this catalog reads. */
interface SdkModelInfo {
  readonly value?: unknown;
  readonly displayName?: unknown;
  readonly description?: unknown;
  readonly supportsEffort?: unknown;
  readonly supportedEffortLevels?: unknown;
}

/**
 * Maps one SDK `ModelInfo` row onto the contract's `AvailableModel`, dropping
 * anything without a usable id.
 *
 * Defensive about every optional field because this crosses a version
 * boundary: an SDK upgrade that adds, renames, or stops populating a field
 * must degrade the row (no effort control, an empty description) rather than
 * throw and blank the whole catalog.
 */
const toAvailableModel = (info: SdkModelInfo): AvailableModel | undefined => {
  const id = typeof info.value === "string" ? info.value.trim() : "";
  if (id.length === 0) return undefined;

  const levels = Array.isArray(info.supportedEffortLevels)
    ? info.supportedEffortLevels.filter(
        (level): level is DeliberationEffort =>
          typeof level === "string" && CONTRACT_EFFORT_LEVELS.has(level),
      )
    : [];

  return {
    id,
    displayName: typeof info.displayName === "string" ? info.displayName : id,
    description: typeof info.description === "string" ? info.description : "",
    // `supportsEffort` is optional on the SDK type, so a row that only reports
    // levels still counts as supporting them.
    supportsEffort: info.supportsEffort === true || levels.length > 0,
    effortLevels: levels,
  };
};

/**
 * Reads the catalog off a real Agent SDK session.
 *
 * `supportedModels()` is a control-protocol call on a LIVE `query()`, so a
 * session has to exist to ask — but nothing needs to be *said* in it. The
 * prompt is a stream that never yields: the session initialises, answers the
 * control request, and is aborted without ever consuming a model turn or
 * spending a token. The session is torn down in a `finally` so an abort path
 * cannot leave the SDK process behind.
 */
const readSdkModelCatalog = (timeoutMs: number): Effect.Effect<ListModelsResult> =>
  // `Effect.promise`, not `tryPromise`: this read has no failure channel by
  // design (see `ModelCatalog.list`), so the degrade-to-empty path lives
  // inside the promise rather than in a `catch` combinator downstream.
  Effect.promise(async (): Promise<ListModelsResult> => {
    try {
      const abortController = new AbortController();
      // Never yields; the session stays open on the control channel until we
      // abort it. `await new Promise(() => {})` parks forever by design.
      const idlePrompt = async function* () {
        await new Promise<void>(() => {});
        yield undefined as never;
      };

      const session = query({
        prompt: idlePrompt() as never,
        options: { abortController, tools: [] },
      });

      try {
        const infos = (await Promise.race([
          session.supportedModels(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error(`the SDK did not answer within ${timeoutMs}ms`)),
              timeoutMs,
            ),
          ),
        ])) as ReadonlyArray<SdkModelInfo>;

        const models = infos
          .map(toAvailableModel)
          .filter((model): model is AvailableModel => model !== undefined);

        return { models, unavailableReason: null };
      } finally {
        abortController.abort();
      }
    } catch (cause) {
      // Logged rather than swallowed: an installation whose SDK auth has
      // expired shows an empty selector, and the log is where "why" lives.
      // eslint-disable-next-line no-console
      console.error(`[repcoach-server] could not read the SDK model catalog: ${String(cause)}`);
      return {
        models: [],
        unavailableReason: `Could not read the model list from the Agent SDK: ${String(cause)}`,
      };
    }
  });

/** How long to wait on the SDK's handshake before giving up and degrading. */
const DEFAULT_CATALOG_TIMEOUT_MS = 15_000;

/**
 * The real catalog, cached for the process's lifetime.
 *
 * The set of models an account can run does not change minute to minute, and
 * the read costs an SDK handshake, so opening the Settings surface twice must
 * not open two sessions. A failed read is cached too — deliberately: a phone
 * that keeps the surface mounted would otherwise retry the handshake on every
 * render. Restarting the server re-reads, which is the same granularity as
 * every other server-lifetime configuration here.
 */
export const RealModelCatalog = (
  timeoutMs: number = DEFAULT_CATALOG_TIMEOUT_MS,
): Layer.Layer<ModelCatalog> =>
  Layer.effect(
    ModelCatalog,
    Effect.map(Effect.cached(readSdkModelCatalog(timeoutMs)), (list) => ModelCatalog.of({ list })),
  );

/**
 * A fixed catalog for tests and the canned server: real-shaped rows covering
 * both branches the UI cares about — a model that supports effort (and says
 * which levels) and one that does not.
 */
export const CANNED_MODEL_CATALOG: ReadonlyArray<AvailableModel> = [
  {
    id: "opus",
    displayName: "Opus",
    description: "Most capable; for the rare, expensive cadences.",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "sonnet",
    displayName: "Sonnet",
    description: "Balanced speed and capability.",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high"],
  },
  {
    id: "haiku",
    displayName: "Haiku",
    description: "Fastest and cheapest; for the frequent cadences.",
    supportsEffort: false,
    effortLevels: [],
  },
];

export const CannedModelCatalog: Layer.Layer<ModelCatalog> = Layer.succeed(ModelCatalog)({
  list: Effect.succeed({ models: CANNED_MODEL_CATALOG, unavailableReason: null }),
});
