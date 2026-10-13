import type { PrescribedSession, SessionId } from "@repcoach/contracts";

import { summarizePlanSession } from "./summary.ts";

/**
 * Next up (ADR 0023 §2): the startable Prescribed Session after the one the
 * most recently finished workout came from, in the Plan's authored order,
 * wrapping from the last back to the first. A hint, never a schedule — it is
 * derived on every read and stored nowhere.
 *
 * `finishedNewestFirst` is the Prescribed Session each finished workout came
 * from, newest first (cancelled and in-flight workouts excluded by the
 * caller). A finished workout whose session has since been deleted from the
 * Plan is skipped in favour of the next older one; with none left, next up is
 * the first startable session. Empty sessions cannot be started, so they are
 * never next up.
 */
export function nextUpSession(
  sessions: ReadonlyArray<PrescribedSession>,
  finishedNewestFirst: Iterable<SessionId>,
): SessionId | undefined {
  const startable = sessions.map((session, index) => !summarizePlanSession(session, index).isEmpty);
  if (!startable.includes(true)) return undefined;

  for (const finished of finishedNewestFirst) {
    const at = sessions.findIndex((session) => session.id === finished);
    if (at === -1) continue;
    // Walk forward from the one after it, all the way round: with a single
    // startable session, next up is that same session again.
    for (let step = 1; step <= sessions.length; step++) {
      const candidate = (at + step) % sessions.length;
      if (startable[candidate]) return sessions[candidate]!.id;
    }
  }

  return sessions[startable.indexOf(true)]!.id;
}
