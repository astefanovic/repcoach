import type { PrescribedSession } from "@repcoach/contracts";

/**
 * What the session picker shows for each Prescribed Session (#71 user story
 * 2): enough to tell a short accessory day from a long squat day without
 * opening it.
 */
export interface PlanSessionSummary {
  readonly title: string;
  readonly entryCount: number;
  readonly setCount: number;
  /** True when the Session cannot be run as written — no exercises at all. The Plan view marks this as caution, not error (#43). */
  readonly isEmpty: boolean;
}

/**
 * A Session's display name. Sessions authored through the Plan view always
 * carry one; the seed and older fixtures do not, so the fallback is
 * positional — the same "Session 3" the create flow would have offered.
 */
export function planSessionTitle(session: PrescribedSession, index: number): string {
  return session.name ?? `Session ${index + 1}`;
}

/**
 * Set counts multiply through a Block's target rounds: three rounds of a
 * circuit of two exercises with two Sets each is twelve Sets of work, and
 * the picker's job is to say how long the day is.
 */
export function summarizePlanSession(
  session: PrescribedSession,
  index: number,
): PlanSessionSummary {
  let entryCount = 0;
  let setCount = 0;
  for (const block of session.blocks) {
    const rounds = block.params?.targetRounds ?? 1;
    entryCount += block.entries.length;
    for (const entry of block.entries) {
      setCount += entry.sets.length * rounds;
    }
  }
  return {
    title: planSessionTitle(session, index),
    entryCount,
    setCount,
    isEmpty: entryCount === 0,
  };
}
