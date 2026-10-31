import { useCallback, useSyncExternalStore } from "react";

import type { LoggedSessionId, SessionId } from "@repcoach/contracts";

/**
 * Which Logged Session is in flight (#72 user story 5: a locked phone
 * mid-workout must come back to Resume, not to a picker).
 *
 * This is a *pointer*, not data — the session itself lives on the server and
 * in the prescription cache — so `localStorage` is the right size of tool.
 * The rule that IndexedDB earns elsewhere ("a write is durable when the
 * transaction commits") buys nothing for a value that can be re-derived by
 * the user tapping Start again; what matters here is that the read is
 * synchronous, because Today has to decide between a Resume hero and a
 * picker on its first render rather than flashing one and then the other.
 *
 * The pointer is cleared by finishing the workout and by nothing else. In
 * particular it survives a failed `finishWorkout` — the session really is
 * still open in that case, and stranding the user's in-flight work behind a
 * cleared pointer is the one failure this exists to prevent.
 *
 * That claim was only made true by issue #132. `finishWorkout` used to run the
 * Session review inside the same call, so a *review* failure rejected it with
 * the status transition already committed — "the session really is still open"
 * was then false, and the user was left holding Resume for a session the server
 * considered finished, where tapping Finish again silently did nothing. The RPC
 * now returns once the session is finalized and the review is owed separately,
 * so a rejection means the finalization itself failed and the sentence above
 * holds again.
 */
const KEY = "repcoach.inFlightSession";

export interface InFlightSession {
  readonly loggedSessionId: LoggedSessionId;
  /** The Prescribed Session it was instantiated from — what `logSetActual` carries alongside. */
  readonly prescribedSessionId: SessionId;
  readonly startedAt: string;
}

function read(): InFlightSession | undefined {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as InFlightSession).loggedSessionId === "string" &&
      typeof (value as InFlightSession).prescribedSessionId === "string"
    ) {
      return value as InFlightSession;
    }
    return undefined;
  } catch (cause) {
    console.warn("[in-flight] ignored unreadable pointer", cause);
    return undefined;
  }
}

function write(session: InFlightSession | undefined): void {
  try {
    if (session === undefined) {
      window.localStorage.removeItem(KEY);
      return;
    }
    window.localStorage.setItem(KEY, JSON.stringify(session));
  } catch (cause) {
    console.warn("[in-flight] could not persist the pointer", cause);
  }
}

/**
 * One process-wide view of the pointer, behind `useSyncExternalStore`.
 *
 * Every `useInFlightSession()` caller — Today's hero, the Logging surface's
 * finish/cancel, and the reconciliation hook (#147) — has to agree *within
 * this document*, which a per-hook `useState` does not: `storage` events fire
 * only in *other* tabs, so a `useState` copy would go stale the moment
 * another consumer wrote. A shared snapshot plus a listener set fixes that,
 * and keeps the cross-tab `storage` sync the original had.
 */
let snapshot: InFlightSession | undefined = read();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** The one write path — persists, updates the shared snapshot, notifies React. */
function commit(session: InFlightSession | undefined): void {
  write(session);
  snapshot = session;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) {
      snapshot = read();
      emit();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The pointer, plus the two writes that move it. A second tab starting or
 * finishing a workout reaches this one through the `storage` listener in
 * `subscribe`, so it never offers a Resume that no longer exists.
 */
export function useInFlightSession(): {
  readonly inFlight: InFlightSession | undefined;
  readonly setInFlight: (session: InFlightSession) => void;
  readonly clearInFlight: () => void;
} {
  const inFlight = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

  const setInFlight = useCallback((session: InFlightSession) => commit(session), []);
  const clearInFlight = useCallback(() => commit(undefined), []);

  return { inFlight, setInFlight, clearInFlight };
}

/** The pointer outside React — used by the one-shot start/finish commands. */
export const inFlightSession = { read, write: commit };
