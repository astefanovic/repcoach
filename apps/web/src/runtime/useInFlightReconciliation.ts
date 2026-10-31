import { useEffect, useRef } from "react";

import { RPC_METHODS } from "@repcoach/contracts";

import { reconcileInFlight } from "./inFlightReconcile.ts";
import { useInFlightSession } from "./inFlightSession.ts";
import { callRpc } from "./rpc.ts";
import { useRuntime } from "./RuntimeProvider.tsx";
import { useConnectionState } from "./useConnectionState.ts";

/**
 * Keep the Resume pointer honest against the server (issue #147).
 *
 * Once connected, ask `listActiveSessions` and reconcile: adopt an `active`
 * session the pointer lost (site-data loss, a second device), or clear a
 * pointer the server no longer calls `active`. While disconnected this is a
 * no-op — the pointer is all there is, and offline resume (ADR 0009 gate 3)
 * must keep working on it alone.
 *
 * Rendered once, high on Today (`TodaySurface`), below the boot gate so
 * `useRuntime()` is safe.
 */
export function useInFlightReconciliation(): void {
  const runtime = useRuntime();
  const { inFlight, setInFlight, clearInFlight } = useInFlightSession();
  const { notConnectedToHome } = useConnectionState(runtime.supervisor);
  const connected = !notConnectedToHome;

  // Read the current pointer without making it a dependency: a reconcile that
  // adopts a session would otherwise re-fire itself.
  const pointerRef = useRef(inFlight);
  pointerRef.current = inFlight;

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;

    void callRpc(runtime, RPC_METHODS.listActiveSessions, {}).then(
      ({ sessions }) => {
        if (cancelled) return;
        const action = reconcileInFlight({
          pointer: pointerRef.current,
          activeSessions: sessions,
        });
        if (action.kind === "adopt") setInFlight(action.session);
        else if (action.kind === "clear") clearInFlight();
      },
      () => {
        // Offline / RPC failure — leave the pointer be.
      },
    );

    return () => {
      cancelled = true;
    };
  }, [runtime, connected, setInFlight, clearInFlight]);
}
