import type { IntakeToolEvent } from "@repcoach/contracts";

/**
 * The activity line (ADR 0014 §4) — the element that carries the app's longest
 * wait, and the only thing standing between a first-time user and a blank
 * chrome-free screen.
 *
 * **Phrasing is the client's job.** The runner forwards what the SDK reports —
 * a tool name plus whatever it gives as a subject — so "reading up on training
 * frequency" is copy, and copy lives here rather than in JSX or on the server.
 * The consequence that matters: a tool nobody has phrased yet **must still
 * render honestly** off its name and subject rather than blanking, because a
 * silent gap in the list reads as the wait having stalled.
 *
 * **Ordinals are derived here, ordering is the runner's.** The runner
 * guarantees `seq` order and that the sweep emits one `verify_citation` per
 * citation in the same order as the disclosure it later returns; the client
 * holds the citations, so "source 3 of 5" is counted here — off the *scoped*
 * citation list, so the number the wait narrates can never contradict the card
 * that follows it.
 */

/** One rendered line. `seq` is the runner's, so React can key on it and the list can never reorder. */
export interface IntakeActivityLine {
  readonly seq: number;
  readonly text: string;
}

/** A URL subject reads better as its host — "reading pubmed.ncbi.nlm.nih.gov", not a 120-character link. */
function hostOrSubject(subject: string | undefined): string | undefined {
  if (subject === undefined) return undefined;
  const trimmed = subject.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return new URL(trimmed).host;
  } catch {
    return trimmed;
  }
}

/** `verify_citation` -> `Verify citation`: the honest fallback for a tool the phrasing does not know. */
function humaniseToolName(tool: string): string {
  const words = tool
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.length > 0 ? words : "working";
}

/** Where a line sits in the citation sweep, when it is one — supplied by `intakeActivityLines`. */
interface CitationOrdinal {
  readonly index: number;
  readonly total: number;
}

/**
 * One event as a line of plain language. Everything here is copy, chosen so it
 * says what the coach is *doing* rather than which tool it called — §4's
 * "reading up on training frequency" and not "WebSearch".
 */
export function phraseIntakeToolEvent(
  event: IntakeToolEvent,
  ordinal?: CitationOrdinal,
): string {
  const subject = hostOrSubject(event.subject);
  switch (event.tool) {
    case "WebSearch":
      return subject === undefined ? "reading up on the training literature" : `reading up on ${subject}`;
    case "WebFetch":
      return subject === undefined ? "reading a source" : `reading ${subject}`;
    case "Read":
    case "Grep":
    case "Glob":
      return subject === undefined ? "looking through what it knows about you" : `looking through ${subject}`;
    case "collect_claims":
      return "collecting every claim in the plan";
    case "verify_citation":
      // The count is the scoped one. Without an ordinal there is no honest
      // number to give, so the line says what it is doing and no more.
      return ordinal === undefined
        ? "checking a source"
        : `checking source ${ordinal.index} of ${ordinal.total}`;
    case "rewrite_rationale":
      return "rewriting the rationale around what held";
    default:
      // The unrecognised tool. It renders — name and subject, in that order —
      // because a blank line in the wait is worse than an unpolished one.
      return subject === undefined
        ? humaniseToolName(event.tool)
        : `${humaniseToolName(event.tool)} — ${subject}`;
  }
}

/**
 * The whole list, in `seq` order, deduplicated by `seq`. Dedup matters because
 * the subscription is re-established on every session change (`Rpc.subscribe`
 * switches streams), and a replayed event must not appear twice in a list whose
 * entire job is to look like an honest record of what happened.
 *
 * `citationCount` is the number of citations *the plan being swept actually
 * carries*, and it is what makes the wait's "source 3 of 5" agree with the
 * disclosure card. Omit it outside the sweep.
 */
export function intakeActivityLines(
  events: ReadonlyArray<IntakeToolEvent>,
  options?: { readonly citationCount?: number },
): ReadonlyArray<IntakeActivityLine> {
  const bySeq = new Map<number, IntakeToolEvent>();
  for (const event of events) {
    bySeq.set(event.seq, event);
  }
  const ordered = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);

  const total = options?.citationCount;
  let verified = 0;
  return ordered.map((event) => {
    if (event.tool === "verify_citation" && total !== undefined && total > 0) {
      verified += 1;
      return {
        seq: event.seq,
        text: phraseIntakeToolEvent(event, { index: Math.min(verified, total), total }),
      };
    }
    return { seq: event.seq, text: phraseIntakeToolEvent(event) };
  });
}
