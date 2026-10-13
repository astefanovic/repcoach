/**
 * ADR 0014 §8's failures, in words (#74).
 *
 * Almost all of them read as **caution, not error**: the machinery is working
 * in public, and a first-time user watching a coach fail to reach its sources
 * must not conclude the app broke. So there is no "sorry", no "unfortunately",
 * no error colour implied — every message states what happened, what was and
 * was not lost, and what to do next.
 *
 * The exception is the out-of-date client (issue #111), and it is an exception
 * because the app genuinely *is* broken there: the reply arrived and this
 * bundle could not read it. Calm would be dishonest, and worse, would invite
 * the retry that bills another agent run for a draft this version will discard
 * again.
 *
 * **On saying what was charged.** These messages used to promise "nothing was
 * charged" on a failed cold draft. That was false — a draft that reached the
 * model is billed whatever the client ends up rendering — and it is the reason
 * the same failure was retried five times before anyone looked. What was lost
 * and what it cost are two different questions, and both get answered honestly.
 *
 * Quota is the one that also points at the manual path: Intake is exempt from
 * the deferral queue, because a queue position is not actionable for a
 * blocking, abandonable cold start.
 */

/** One failure, ready to render. */
export interface IntakeFailureMessage {
  /** The small-caps label above it — names the stage, never the exception. */
  readonly heading: string;
  readonly text: string;
  /** Whether to offer "write the first plan myself" beside it. */
  readonly offerManualPath: boolean;
}

/** Effect's typed errors travel as tagged values; anything else is a transport or programming failure. */
const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error
    ? String((error as { readonly _tag: unknown })._tag)
    : undefined;

/**
 * Whether the failure is this client failing to *read* a reply it did receive
 * (issue #111), rather than a reply that never came.
 *
 * The distinction is the whole point. A schema decode failure means the server
 * answered, in full, and this bundle could not understand the answer — which is
 * a stale client, not a sick network, and the fix is a reload rather than a
 * retry. Retrying is in fact the worst thing the user can do: a cold draft
 * re-runs a live agent session and is billed again, and the same bundle throws
 * the reply away again.
 *
 * A heuristic, and knowingly so. Effect's RPC client surfaces a response that
 * fails its success schema as a parse/schema error whose tag is not part of
 * this app's own error vocabulary, so this matches on the shape of that rather
 * than on a contract constant. Being wrong is cheap in one direction and not
 * the other: a false positive tells the user to reload (harmless, and the
 * status strip is already saying so if the commits really did drift), while a
 * false negative just falls through to the honest default below.
 */
const isUnreadableReply = (error: unknown): boolean => {
  const tag = tagOf(error) ?? "";
  if (/Schema|Parse/i.test(tag)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /is missing|expected .* actual|ParseError|Schema/i.test(message);
};

const QUOTA: IntakeFailureMessage = {
  heading: "the coach is unavailable",
  text:
    "The coach is out of quota for now, so it can't draft anything. Nothing was saved. " +
    "You can try again in a while, or write the first plan yourself — that needs no agent at all.",
  offerManualPath: true,
};

/**
 * §8: a failed cold draft hands the **form** back with every value intact. The
 * one unforgivable version of this is losing what was typed, so the statement
 * sits above the form rather than replacing it.
 */
export function coldDraftFailureMessage(error: unknown): IntakeFailureMessage {
  if (tagOf(error) === "IntakeQuotaExhaustedError") return QUOTA;

  // Issue #111: the failure that cost five drafts. The coach answered every
  // time; this app was too old to read the answer. It does NOT invite a retry,
  // because retrying is what made it expensive.
  if (isUnreadableReply(error)) {
    return {
      heading: "this app is out of date",
      text:
        "The coach answered, but this version of the app couldn't read the reply — it's older than the " +
        "server it's talking to. Reload the page to pick up the current version. Your answers are still " +
        "here. Don't retry until you have: the draft is written and charged for each time, and this " +
        "version will discard it again.",
      offerManualPath: false,
    };
  }

  return {
    heading: "the draft failed",
    // Deliberately no longer claims "nothing was charged" (issue #111). It was
    // false: the ONLY way to reach this card is for the request to have got as
    // far as the runner, and a cold draft that reached the model has already
    // run a full agent session and been billed for it whatever the client saw.
    // Telling the user a failed attempt is free is what made retrying feel
    // costless — five times over, at roughly $0.18 a go.
    text:
      "The draft didn't come back. Nothing was saved and no plan was created, but if the coach got as " +
      "far as drafting, that attempt still counted against your quota. Your answers are still here.",
    offerManualPath: false,
  };
}

/**
 * §8 + §2: a failed turn is a **genuine no-op**. Interim turns write nothing,
 * so there is no half-applied state to reconcile — the draft on screen is still
 * exactly the draft, and saying so is the whole message.
 *
 * A session that is gone is the one turn failure that cannot be retried: ADR
 * 0014's mortality rule keeps no resurrection path, so the message says the
 * session ended rather than inviting a re-send that will fail again.
 */
export function turnFailureMessage(error: unknown): IntakeFailureMessage {
  switch (tagOf(error)) {
    case "IntakeQuotaExhaustedError":
      return QUOTA;
    case "IntakeSessionNotFoundError":
      return {
        heading: "the session ended",
        text:
          "This intake session has ended, so there is nothing left to revise. Nothing was saved. " +
          "Start again from the form, or write the first plan yourself.",
        offerManualPath: true,
      };
    default:
      return {
        heading: "that didn't reach the coach",
        text: "Nothing changed — the draft is exactly as it was. Send it again.",
        offerManualPath: false,
      };
  }
}

/**
 * §8: a failed sweep offers **no Proposal**. An unverified plan cannot be
 * accepted and the sweep is never skipped, so the only doors are retry and keep
 * tweaking — which is why this message ends by saying the draft is untouched
 * rather than by apologising.
 */
export function sweepFailureMessage(error: unknown): IntakeFailureMessage {
  switch (tagOf(error)) {
    case "IntakeQuotaExhaustedError":
      return QUOTA;
    case "IntakeSweepRejectedError":
      return {
        heading: "the sources didn't pass",
        text:
          "The check rejected this plan outright, so nothing was committed. The draft is untouched — " +
          "keep tweaking it and have the sources checked again.",
        offerManualPath: false,
      };
    case "IntakeSessionNotFoundError":
      return {
        heading: "the session ended",
        text:
          "This intake session has ended before the sources could be checked. Nothing was saved. " +
          "Start again from the form, or write the first plan yourself.",
        offerManualPath: true,
      };
    default:
      return {
        heading: "the sources couldn't be checked",
        text:
          "The coach lost its connection during verification. The plan can't be accepted until the " +
          "sources are checked. Nothing was lost; the draft is untouched.",
        offerManualPath: false,
      };
  }
}
