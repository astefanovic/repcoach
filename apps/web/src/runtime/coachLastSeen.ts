import { useCallback, useEffect, useState } from "react";

/**
 * When `/coach` was last opened on this device (issue #150) — the marker the
 * activity pip compares Deliberation runs against.
 *
 * This is device-local `localStorage`, the same size of tool `inFlightSession`
 * uses and for the same reasons: the read has to be synchronous so the chrome
 * can decide whether to show the pip on its first render, and the cost of the
 * value being wrong is small — a pip that lingers one extra visit, or clears a
 * beat early, never lost data. A second device keeps its own marker and its
 * own pip; ADR 0021 accepts that and `docs/design/uat-watchlist.md` #16 is
 * where it gets judged. The fallback, if it bites, is a server-side
 * `coachSeenAt` — the run list is already server state.
 *
 * The value is an ISO-8601 timestamp: the newest settled run the user could
 * have read when they opened the record (`seenThrough` in `coachActivity.ts`).
 * `markSeen` only ever moves it forward, so a stale write from a background
 * tab cannot un-see a run.
 */
const KEY = "repcoach.coachSeenAt";

function read(): string | undefined {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null || raw === "" ? undefined : raw;
  } catch (cause) {
    console.warn("[coach-seen] ignored unreadable marker", cause);
    return undefined;
  }
}

function write(at: string): void {
  try {
    const current = read();
    if (current !== undefined && current >= at) return;
    window.localStorage.setItem(KEY, at);
  } catch (cause) {
    console.warn("[coach-seen] could not persist the marker", cause);
  }
}

export function useCoachLastSeen(): {
  readonly lastSeenAt: string | undefined;
  readonly markSeen: (at: string) => void;
} {
  const [lastSeenAt, setState] = useState<string | undefined>(read);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) setState(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const markSeen = useCallback((at: string) => {
    write(at);
    setState(read());
  }, []);

  return { lastSeenAt, markSeen };
}
