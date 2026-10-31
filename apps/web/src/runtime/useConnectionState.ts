import { useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { Connection } from "@repcoach/client-runtime";

/**
 * Surfaces the supervisor's connection state to the UI (#50), moved across
 * from the retired native/Expo client's `src/connection/useConnectionState.ts`
 * (deleted by #53, ADR 0012) **unchanged** — it was already
 * platform-agnostic (React plus Effect, no React Native import), so the
 * migration was a file move.
 *
 * `connectionProjectionPhase` is what decides the indicator: `disconnected`
 * and `synchronizing` both count as "not connected to home", and only `ready`
 * clears it.
 */
export interface ConnectionUiState {
  readonly phase: Connection.SupervisorConnectionPhase;
  readonly projection: Connection.ConnectionProjectionPhase;
  readonly notConnectedToHome: boolean;
}

function toUiState(state: Connection.SupervisorConnectionState): ConnectionUiState {
  const projection = Connection.connectionProjectionPhase(state);
  return {
    phase: state.phase,
    projection,
    notConnectedToHome: projection !== "ready",
  };
}

export function useConnectionState(
  supervisor: Connection.EnvironmentSupervisor["Service"],
): ConnectionUiState {
  const [uiState, setUiState] = useState<ConnectionUiState>(() =>
    toUiState(Connection.AVAILABLE_CONNECTION_STATE),
  );

  useEffect(() => {
    const fiber = Effect.runFork(
      SubscriptionRef.changes(supervisor.state).pipe(
        Stream.runForEach((state) => Effect.sync(() => setUiState(toUiState(state)))),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [supervisor]);

  return uiState;
}
