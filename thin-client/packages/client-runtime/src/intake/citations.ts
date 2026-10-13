import type {
  ConvergeIntakeResult,
  IntakeCitationVerdict,
  IntakeRationaleLine,
  IntakeSweepDisclosure,
  IntakeTurn,
} from "@repcoach/contracts";

/**
 * The citation's provisional-then-verdict lifecycle (ADR 0014 §3 and §5), and
 * the scoping rule that keeps the sweep's disclosure honest (#74).
 *
 * A citation attaches to a rationale line and nowhere else — the contract makes
 * that structural — so "the citations this plan carries" is always *derived
 * from the rationale in front of the user*, never from a table written for some
 * other version of the plan. That single rule is what stops a user who
 * converged after one turn from being told the sweep removed sources they never
 * saw.
 */

/** What the surface renders next to a rationale line. */
export type IntakeCitationView =
  | {
      readonly status: "provisional";
      readonly id: string;
      readonly claim: string;
      readonly source_url: string;
    }
  | {
      readonly status: "verified";
      readonly id: string;
      readonly claim: string;
      readonly source_url: string;
      readonly trust: "corpus-verified" | "retrieved-unverified";
    }
  | {
      readonly status: "removed";
      readonly id: string;
      readonly claim: string;
      readonly source_url: string;
      /** Stated for removals — a disclosure without the reason is worthless. */
      readonly why?: string;
    };

/** Looks a rationale line's citation up. `undefined` in, `undefined` out: an uncited line is a legitimate, labelled state. */
export type IntakeCitationLookup = (citationId: string | undefined) => IntakeCitationView | undefined;

/**
 * The citation ids **this** plan's rationale actually cites, in the order the
 * rationale states them. This is the scope every other function here reads —
 * the sweep's wait, the disclosure filter and the card all key off it, which is
 * why the count the wait narrates can never contradict the card that follows.
 *
 * Duplicates collapse (one source can back two lines); an id no citation
 * matches is dropped, since there is nothing to check.
 */
export function citedIds(
  rationale: ReadonlyArray<IntakeRationaleLine>,
  known?: ReadonlyArray<{ readonly id: string }>,
): ReadonlyArray<string> {
  const available = known === undefined ? undefined : new Set(known.map((each) => each.id));
  const seen = new Set<string>();
  const ids: Array<string> = [];
  for (const line of rationale) {
    const id = line.citationId;
    if (id === undefined || seen.has(id)) continue;
    if (available !== undefined && !available.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** The citations one turn's draft carries, scoped to what its rationale cites. */
export function turnCitationIds(turn: IntakeTurn): ReadonlyArray<string> {
  return citedIds(turn.rationale, turn.citations);
}

/**
 * §3: interim citations are shown and marked **provisional** — kept, because
 * hiding the coach's reasoning at the moment the user is deciding whether to
 * argue with it is the worse failure, and marked, because the pending sweep has
 * to be a visible promise rather than a backstage step.
 *
 * The absence of `trust` on `IntakeProvisionalCitation` is what makes an
 * unearned badge unrenderable; this lookup preserves that by never producing a
 * `verified` view before the sweep has ruled.
 */
export function provisionalCitations(turn: IntakeTurn): IntakeCitationLookup {
  const byId = new Map(turn.citations.map((citation) => [citation.id, citation]));
  return (citationId) => {
    if (citationId === undefined) return undefined;
    const citation = byId.get(citationId);
    if (citation === undefined) return undefined;
    return {
      status: "provisional",
      id: citation.id,
      claim: citation.claim,
      source_url: citation.source_url,
    };
  };
}

/**
 * The same slot after the sweep — the promise from §3 discharged in public.
 * A verdict of `removed` produces a `removed` view rather than nothing, so the
 * line it backed can be marked reasoning-only instead of quietly losing its
 * support.
 */
export function sweptCitations(result: ConvergeIntakeResult): IntakeCitationLookup {
  const verified = new Map(result.citations.map((citation) => [citation.id, citation]));
  const verdicts = new Map(
    result.disclosure.verdicts.map((verdict) => [verdict.citationId, verdict]),
  );

  return (citationId) => {
    if (citationId === undefined) return undefined;
    const citation = verified.get(citationId);
    if (citation !== undefined) {
      return {
        status: "verified",
        id: citation.id,
        claim: citation.claim,
        source_url: citation.source_url,
        trust: citation.trust,
      };
    }
    const verdict = verdicts.get(citationId);
    if (verdict === undefined) return undefined;
    return {
      status: "removed",
      id: verdict.citationId,
      claim: verdict.claim,
      source_url: verdict.source_url,
      ...(verdict.why === undefined ? {} : { why: verdict.why }),
    };
  };
}

/**
 * The disclosure, scoped to the citations the plan carried **when it was sent
 * to be swept** — `turnCitationIds` of the last turn the user saw, captured
 * before converging.
 *
 * It has to be that list and not the swept rationale's: the sweep's rewrite has
 * already dropped the sources it removed, so scoping to the returned rationale
 * would disclose exactly the removals it is supposed to hide and none of the
 * ones it is supposed to report.
 *
 * The runner already scopes this, and the client scopes it **again** — not from
 * distrust, but because the scope is the surface's own invariant: the wait's
 * "source 3 of 5" and the card that follows it are rendered from one derived
 * list, so they cannot drift even if one side of the wire changes. A verdict
 * for a citation the user never saw is dropped; the surviving order is the
 * order that plan's rationale stated them in.
 */
export function scopeDisclosure(
  disclosure: IntakeSweepDisclosure,
  scope: ReadonlyArray<string>,
): ReadonlyArray<IntakeCitationVerdict> {
  const byId = new Map(disclosure.verdicts.map((verdict) => [verdict.citationId, verdict]));
  return scope.flatMap((id) => {
    const verdict = byId.get(id);
    return verdict === undefined ? [] : [verdict];
  });
}
