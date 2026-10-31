import { useEffect, useState } from "react";

import { RPC_METHODS, type PlanSnapshot, type SessionId } from "@repcoach/contracts";

import { callRpc } from "./rpc.ts";
import { useRuntime } from "./RuntimeProvider.tsx";
import { useConnectionState } from "./useConnectionState.ts";

/**
 * "Next up" for Today's hero (ADR 0023). The server derives it; this hook asks
 * once connected and again whenever the Plan or the in-flight workout changes,
 * since a reorder, a finish or a cancel can each move it.
 *
 * The last answer is kept in device-local `localStorage`, the same size of tool
 * the Resume pointer uses, so the hero still renders offline (disabled, like
 * the rows). Wrong costs little: a stale suggestion the user can ignore, which
 * the next connected read replaces. Today only shows it if the session is
 * still in the Plan and startable.
 */
const KEY = "repcoach.nextUp";

function read(): SessionId | undefined {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null || raw === "" ? undefined : (raw as SessionId);
  } catch (cause) {
    console.warn("[next-up] ignored unreadable hint", cause);
    return undefined;
  }
}

function write(sessionId: SessionId | undefined): void {
  try {
    if (sessionId === undefined) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, sessionId);
  } catch (cause) {
    console.warn("[next-up] could not persist the hint", cause);
  }
}

export function useNextUp(plan: PlanSnapshot | undefined, inFlightId: string | undefined): SessionId | undefined {
  const runtime = useRuntime();
  const { notConnectedToHome } = useConnectionState(runtime.supervisor);
  const connected = !notConnectedToHome;
  const [nextUp, setNextUp] = useState<SessionId | undefined>(read);

  useEffect(() => {
    if (!connected || plan === undefined) return;
    let cancelled = false;

    void callRpc(runtime, RPC_METHODS.getNextUp, {}).then(
      ({ prescribedSessionId }) => {
        if (cancelled) return;
        write(prescribedSessionId);
        setNextUp(prescribedSessionId);
      },
      () => {
        // Offline / RPC failure — keep the last known hint.
      },
    );

    return () => {
      cancelled = true;
    };
  }, [runtime, connected, plan, inFlightId]);

  return nextUp;
}
