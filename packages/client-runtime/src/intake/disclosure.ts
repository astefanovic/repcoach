import type { IntakeCitationVerdict } from "@repcoach/contracts";

/**
 * "What checking the sources changed" (ADR 0014 §5) — the swept card's
 * disclosure of its own edits, on the exact surface where the user decides
 * whether to trust the plan at all.
 *
 * Every sentence here is stated flatly, with the reason, and without a single
 * apologetic word: yellow is caution, and caution is what this is. A sweep that
 * guts the plan is **not an error** — the prescription stands, the rationale is
 * thinner, and the plan is still offered.
 */

/** The card's read of one scoped verdict list. */
export interface IntakeDisclosureSummary {
  readonly total: number;
  readonly removed: ReadonlyArray<IntakeCitationVerdict>;
  readonly kept: ReadonlyArray<IntakeCitationVerdict>;
  readonly verified: ReadonlyArray<IntakeCitationVerdict>;
  /** The headline sentence, in the coach's voice. */
  readonly statement: string;
  /**
   * "The sets and reps you settled on are unchanged." Shown **only** when
   * something was removed — with nothing struck through it denies an accusation
   * nobody made.
   */
  readonly prescriptionUntouched: boolean;
  /** More removed than kept: one further sentence, still no error colour. */
  readonly gutted: boolean;
}

/**
 * "Two sources didn't hold up" reads as a person talking; "2 sources didn't
 * hold up" reads as a log line. The disclosure is the coach speaking, so the
 * small counts are words — while every number inside the tally stays a numeral,
 * because that half *is* the accounting.
 */
const WORDS: ReadonlyArray<string> = ["No", "One", "Two", "Three", "Four", "Five"];
const asWord = (n: number): string => WORDS[n] ?? String(n);

function statementFor(
  total: number,
  removed: number,
  kept: number,
  verified: number,
): string {
  if (total === 0) {
    // Converging off a draft that cited nothing at all is legitimate — the
    // coach may have reasoned uncited throughout — and saying so is better than
    // an empty block implying the sweep did not run.
    return "This plan cited no sources, so there was nothing to check. Everything above is my judgment.";
  }
  if (removed === 0) {
    // "1 of 1 are in the corpus" is a log line, not a person talking — and this
    // whole block is the coach speaking.
    return (
      `Every source held up. ${verified} of ${total} ${verified === 1 ? "is" : "are"} in the corpus` +
      (total > verified ? "; the rest were re-retrieved and are marked as such." : ".")
    );
  }
  const plural = removed === 1 ? "" : "s";
  const wasWere = removed === 1 ? "was" : "were";
  const tail =
    kept === 0
      ? "Nothing survived verification."
      : `${asWord(kept)} held: ${verified} verified against the corpus` +
        (kept > verified ? `, ${kept - verified} retrieved but unverified.` : ".");
  return `${asWord(removed)} source${plural} didn't hold up and ${wasWere} removed. ${tail}`;
}

/**
 * Reads a **scoped** verdict list (see `scopeDisclosure`) into everything the
 * card renders. Pass anything wider and the card starts reporting removals the
 * user never saw, which is the one failure this whole disclosure exists to
 * avoid.
 */
export function summariseDisclosure(
  verdicts: ReadonlyArray<IntakeCitationVerdict>,
): IntakeDisclosureSummary {
  const removed = verdicts.filter((verdict) => verdict.outcome === "removed");
  const kept = verdicts.filter((verdict) => verdict.outcome !== "removed");
  const verified = verdicts.filter((verdict) => verdict.outcome === "corpus-verified");
  return {
    total: verdicts.length,
    removed,
    kept,
    verified,
    statement: statementFor(verdicts.length, removed.length, kept.length, verified.length),
    prescriptionUntouched: removed.length > 0,
    gutted: removed.length > kept.length,
  };
}
