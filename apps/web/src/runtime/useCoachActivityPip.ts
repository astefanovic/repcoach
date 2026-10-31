import { coachHasUnseenActivity } from "./coachActivity.ts";
import { useCoachLastSeen } from "./coachLastSeen.ts";
import { useDeliberationRuns } from "./useDeliberationRuns.ts";

/**
 * Whether the Coach glyph should carry an activity pip (issue #150): a
 * Deliberation run has settled that the user has not opened `/coach` to see.
 *
 * Rides `useDeliberationRuns` — the same subscription the Coach record itself
 * reads, which replays the full run set on every reconnect — and compares it
 * against the device-local "last opened `/coach`" marker. The predicate is
 * `coachActivity.ts`, unit-tested; this hook is only the wiring.
 *
 * While the runs are still loading, or the subscription has failed, the pip
 * stays dark: an unproven "there might be something" dot is worse than no dot,
 * and the same reasoning keeps the numeric badge at its last value rather than
 * flashing on a stale feed.
 */
export function useCoachActivityPip(): boolean {
  const runs = useDeliberationRuns();
  const { lastSeenAt } = useCoachLastSeen();

  if (runs.status !== "ready") return false;
  return coachHasUnseenActivity({ runs: runs.runs, lastSeenAt });
}
