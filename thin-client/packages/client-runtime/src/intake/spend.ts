import { totalTokens, type TokenUsage } from "@repcoach/contracts";

/**
 * The one quiet provenance footer (ADR 0014 §4). Spend accumulates across the
 * held-open session, client-side, because `usage` is reported **per returned
 * run** — a counter ticking during a run it cannot measure is a lie the surface
 * would be telling.
 *
 * The consequence, and the whole reason this is a function rather than a
 * template literal in JSX: nothing is shown until a run has actually returned.
 */
export interface IntakeSpend {
  readonly tokens: number;
  readonly turns: number;
}

export const noIntakeSpend: IntakeSpend = { tokens: 0, turns: 0 };

/**
 * Adds one returned run's own usage. `countsAsTurn` is false for the cold
 * draft and the sweep.
 *
 * Sums all FOUR usage fields (issue #81 — `TokenUsage` widened from
 * `{prompt, completion}`), not just input/output: a held-open Intake session
 * is precisely where cache reads dominate (ADR 0014 §4's correction), so
 * dropping `cacheRead`/`cacheCreation` here would keep this footer
 * understating the exchange even after the contract stopped discarding them.
 */
export function addIntakeSpend(
  spend: IntakeSpend,
  usage: TokenUsage,
  options?: { readonly countsAsTurn?: boolean },
): IntakeSpend {
  return {
    tokens: spend.tokens + totalTokens(usage),
    turns: spend.turns + (options?.countsAsTurn === true ? 1 : 0),
  };
}

/**
 * `intake · claude-sonnet-4.5 · 38.4k tokens · 2 turns`, or `undefined` when
 * there is nothing to report yet. The model is whatever the `intake` cadence is
 * configured with; it is omitted rather than guessed if that read failed, since
 * a provenance footer naming the wrong model is worse than one naming none.
 */
export function formatIntakeSpend(
  spend: IntakeSpend,
  model?: string,
): string | undefined {
  if (spend.tokens === 0) return undefined;
  return [
    "intake",
    ...(model === undefined ? [] : [model]),
    `${(spend.tokens / 1000).toFixed(1)}k tokens`,
    ...(spend.turns === 0 ? [] : [`${spend.turns} turn${spend.turns === 1 ? "" : "s"}`]),
  ].join(" · ");
}
