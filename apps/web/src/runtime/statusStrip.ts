import type { RunStatus } from "@repcoach/contracts";

import type { StripState } from "../ui/chrome.ts";

/**
 * The real status strip's text and tone (#50), derived from live connection
 * and outbox state instead of the prototype's canned `stripStates` array.
 *
 * This is the whole of what #50 asks the shell to render for real — "something
 * minimal but real — the connection indicator is enough" — expressed through
 * the strip #42 settled rather than as loose debug text. It is a pure function
 * so it can be unit-tested without a browser; the DOM adapters underneath it
 * are proven by the Playwright flows instead.
 *
 * **What is settled and what is chosen here.** #42 settled the strip's
 * *semantics*, and this honours them, with one amendment:
 *
 * - neutral by default, **yellow on exception** — being offline mid-gym is
 *   expected, not a failure, so it never escalates past caution;
 * - **red on a hard failure** (issue #111, amending #42's never-red rule):
 *   reserved for the two states the app cannot recover from on its own — a
 *   client bundle that has drifted from its server, and a coach run that
 *   failed. See `ui/chrome.ts` for the argument; the short version is that
 *   yellow made "this will fix itself" and "this will keep costing you money"
 *   look identical;
 * - one line, always present;
 * - green is temporal only (a ~3s flash on run completion), **produced here**
 *   for both run kinds #50 left unwired: a Revision run landing (issue #66
 *   slice 3) and a Deliberation run landing (issue #78). This function stays
 *   pure, so every transient flash window is the caller's timer, not state
 *   kept in here.
 *
 * **The two run kinds and their precedence.** A Revision run is the one the
 * user is standing there waiting on; a Deliberation run — scheduled or
 * session-review — is ambient. The strip is one line, so where both are live
 * the Revision states win, and a Deliberation flash never displaces a Revision
 * run in flight. Within a kind, its landing flash beats its own running state:
 * a run that just finished is no longer running.
 *
 * What #42 did *not* settle is the exact wording. The strings below follow the
 * prototype's own idiom (lowercase, `·`-separated, count-first) because that
 * is the only evidence available, but they are a **choice, not a decision** —
 * flagged for the adversarial e2e author and for #72, which will have more
 * strip states still to name.
 */
export interface StatusStripInput {
  /** From `useConnectionState` — `projection !== "ready"`. */
  readonly notConnectedToHome: boolean;
  /** `outbox.queued.length` — work captured on this device but not yet acknowledged. */
  readonly pendingCount: number;
  /**
   * A Revision run is queued or running against some Proposal (ADR 0013 §5:
   * "the persistent status strip picks up `coach running`"). Optional and
   * defaulted to `false` so every existing call site is untouched.
   */
  readonly revisionRunning?: boolean;
  /**
   * The ~3s window after a Revision run lands — the caller owns the timer
   * (this function is pure and has no clock of its own) and clears it after
   * the flash has been visible. Takes priority over `revisionRunning`: a run
   * that just finished is no longer running.
   */
  readonly revisionJustLanded?: boolean;
  /**
   * The Deliberation runner's current status (issue #78) — the scheduled /
   * session-review run kind, which `apps/expo`'s retired
   * `DeliberationStateIndicator` was the only surface for. Ambient rather than
   * foreground, so it sits *below* the Revision states in the precedence
   * below: when both are live the strip's one line belongs to the run the user
   * is standing there waiting on.
   */
  readonly deliberationStatus?: RunStatus;
  /**
   * How many Deliberation runs are deferred behind the current one. ADR 0011
   * §8 requires the queue be **said out loud** rather than becoming a silent
   * delay, so this is named in the text instead of collapsing into "running".
   */
  readonly deliberationQueuedCount?: number;
  /**
   * The ~3s window after a Deliberation run lands. Same contract as
   * `revisionJustLanded`: the caller owns the timer, and it takes priority
   * over `deliberationStatus`.
   */
  readonly deliberationJustLanded?: boolean;
  /**
   * Only present while `deliberationStatus === "failed"` (issue #90) — a
   * human-readable line naming which failure mode fired (turn cap, wall
   * clock, unparseable output, or the session could not start).
   */
  readonly deliberationFailureReason?: string;
  /**
   * The served bundle and the server came from different commits (issue #111)
   * — `runtime/useServerBuildRef.ts`.
   *
   * Outranks everything below, including offline, and deliberately so: every
   * other state on this strip describes an app that is working, and this one
   * describes an app whose replies its own client cannot read. Nothing the user
   * does from here works, and some of what they try (an Intake draft) bills a
   * live agent session before failing.
   */
  readonly clientOutOfDate?: boolean;
}

/**
 * The pending count, deliberately **without a noun** since #80.
 *
 * It used to read "3 sets pending", which was true while the outbox could only
 * hold logged Sets. Now that it also carries Plan edits, "3 sets" is simply
 * wrong whenever one of them is an edit — and the strip's entire job while
 * offline is to be credible about what has been captured.
 *
 * The obvious repair, naming the mixture ("2 sets · 1 change"), was rejected
 * twice over: it doubles the strip's length for a distinction the user cannot
 * act on — everything here drains the same way, on reconnect, with nothing to
 * decide — and "Change" is a CONTEXT term for the recorded artifact, not for a
 * command in flight, so spending it here would blur a word the coaching
 * surfaces rely on. Bare "3 pending" is honest about the only thing that
 * matters: how much of your work the server has not got yet.
 */
function pending(count: number): string {
  return `${count} pending`;
}

function runs(count: number): string {
  return count === 1 ? "1 run" : `${count} runs`;
}

export function statusStripState(input: StatusStripInput): StripState {
  // First, above even offline (issue #111). An out-of-date client is not a
  // state the app trades around — it is one where every reply is unreadable, so
  // there is nothing truer to say underneath it. The text names the fix rather
  // than the diagnosis: "reload" is the only move the user has, and on a phone
  // it is the one they would not think of.
  if (input.clientOutOfDate === true) {
    return { tone: "error", text: "out of date · reload this page" };
  }

  if (input.notConnectedToHome) {
    // Caution, not an error: the whole point of the outbox is that logging
    // keeps working here. Naming the pending count is what makes that
    // credible to the user rather than something they have to trust.
    return {
      tone: "caution",
      text:
        input.pendingCount > 0
          ? `offline · ${pending(input.pendingCount)}`
          : "offline · not connected to home",
    };
  }

  // The flash wins over every other connected state: it is the one moment
  // #42 spends green, and it would be pointless buried under "coach running"
  // the instant the run it was celebrating finishes.
  if (input.revisionJustLanded === true) {
    return { tone: "flash", text: "revision ready" };
  }

  // "coach running" (ADR 0013 §5) — neutral, not caution: a Revision run in
  // flight is expected, not an exception, and red is reserved for the coach's
  // proposed change (#43), never for the strip. Above the Deliberation states
  // because it is the run the user is waiting on: an ambient run landing must
  // not steal the line from it, not even for the flash's three seconds.
  if (input.revisionRunning === true) {
    return { tone: "neutral", text: "coach running · revising" };
  }

  if (input.deliberationJustLanded === true) {
    return { tone: "flash", text: "deliberation ready" };
  }

  // A killed session, an unparseable output, or a session that could not
  // start (issue #90) — **red** since #111. It was caution, on #42's never-red
  // rule, which put it in the same colour class as being offline; but offline
  // resolves itself the moment you walk back into signal, and a coach run that
  // died does not. It needs someone to look at the server, and nothing about
  // yellow says so.
  if (input.deliberationStatus === "failed") {
    return {
      tone: "error",
      text:
        input.deliberationFailureReason !== undefined
          ? `coach failed · ${input.deliberationFailureReason}`
          : "coach failed",
    };
  }

  // A Deliberation run in flight — neutral for the same reason a Revision run
  // is: scheduled thinking is the system working, not an exception. The
  // backlog rides along in the text (ADR 0011 §8), because runs deferred
  // *behind* this one are exactly as silent as ones deferred behind nothing.
  if (input.deliberationStatus === "running") {
    const queued = input.deliberationQueuedCount ?? 0;
    return {
      tone: "neutral",
      text:
        queued > 0
          ? `coach running · deliberating · ${runs(queued)} queued`
          : "coach running · deliberating",
    };
  }

  // ADR 0011 §8: the deferral queue is honest. A run waiting its turn says so,
  // with its backlog counted, rather than presenting as idle for however long
  // the run ahead of it takes.
  if (input.deliberationStatus === "queued") {
    return {
      tone: "neutral",
      text: `coach queued · ${runs(input.deliberationQueuedCount ?? 0)} pending`,
    };
  }

  // Connected with a backlog is genuinely transient — the flusher drains it
  // as soon as the session is available — so it stays neutral rather than
  // spending the caution colour on something already resolving.
  return input.pendingCount > 0
    ? { tone: "neutral", text: `syncing · ${pending(input.pendingCount)}` }
    : { tone: "neutral", text: "synced · idle" };
}
