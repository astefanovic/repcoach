import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { Connection, Outbox, Prescription, Rpc } from "@repcoach/client-runtime";

import { domConnectivityLayer } from "../platform/connectivity.ts";
import { indexedDbOutboxStorage } from "../platform/outboxStorage.ts";
import { indexedDbPrescriptionCacheStorage } from "../platform/prescriptionCacheStorage.ts";
import { domWakeupsLayer } from "../platform/wakeups.ts";
import { domWebSocketConstructorLayer } from "../platform/webSocket.ts";
import { resolveWebServerBaseUrls } from "./serverTarget.ts";

const { ConnectionDriverModule, DevServerConnectionTarget, SupervisorModule } = Connection;

/**
 * The Effect bootstrap, lifted out of the retired native/Expo client's
 * `App.tsx` into a root provider (#50; the Expo client itself was deleted by
 * #53, ADR 0012). This is the whole reason #50 existed ahead of any component
 * work: it proves the supervisor, the outbox and the prescription cache all
 * boot under a standard bundler, on DOM adapters, with no React Native
 * anywhere.
 *
 * The three services and their order are carried over deliberately from that
 * bootstrap, because the order is load-bearing:
 *
 * 1. the **supervisor**, which owns the RPC session and the connection verdict;
 * 2. the **outbox**, loaded from durable storage *before* the flusher forks, so
 *    sets captured in a previous session are recovered and drained rather than
 *    stranded (ADR 0009 gate 1);
 * 3. the **prescription cache**, likewise loaded from storage first, so an app
 *    kill mid-workout comes back with the prescription intact (gate 3).
 *
 * `Effect.never` holds the scope open for the document's lifetime; the
 * cleanup interrupts the fiber, which releases the scope and every finalizer
 * inside it (the socket, the event listeners). React Strict Mode's
 * double-invoke therefore tears down cleanly and rebuilds rather than leaking
 * a second supervisor.
 */
export interface RepCoachRuntime {
  readonly supervisor: Connection.EnvironmentSupervisor["Service"];
  readonly outbox: Outbox.OutboxManager;
  readonly prescriptions: Prescription.PrescriptionCache;
}

/**
 * Boot is a three-state affair and the UI has to be honest about all three.
 * The retired native/Expo client only ever had "not ready yet" and rendered
 * `null` for it forever if boot failed — a white screen with nothing in the
 * DOM to explain it. A failed boot here is a real state with a real cause.
 */
export type RuntimeState =
  | { readonly status: "booting" }
  | { readonly status: "ready"; readonly runtime: RepCoachRuntime }
  | { readonly status: "failed"; readonly cause: string };

const RuntimeContext = createContext<RuntimeState>({ status: "booting" });

/**
 * The connection target. Resolved once at module load rather than per-render:
 * it is derived from the serving origin and build-time env, neither of which
 * changes while the document is alive.
 */
const { httpBaseUrl, wsBaseUrl } = resolveWebServerBaseUrls();

const target = new DevServerConnectionTarget({
  environmentId: "dev-server",
  label: "RepCoach home server",
  httpBaseUrl,
  wsBaseUrl,
});

const dependencies = Layer.mergeAll(
  domConnectivityLayer,
  domWakeupsLayer,
  ConnectionDriverModule.layer.pipe(
    Layer.provide(Rpc.sessionLayer.pipe(Layer.provide(domWebSocketConstructorLayer))),
  ),
);

export function RuntimeProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<RuntimeState>({ status: "booting" });

  useEffect(() => {
    const boot = Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* SupervisorModule.make(target, { initiallyDesired: true });

        const outbox = yield* Outbox.makeOutboxManager(indexedDbOutboxStorage);
        // Load BEFORE forking the flusher: the flusher drains whatever the
        // manager holds, so anything still on disk from a previous run has to
        // be in memory before it starts, or it will not be sent until the next
        // enqueue happens to reload it.
        yield* outbox.load;
        yield* Effect.forkScoped(Outbox.runFlusher(supervisor, outbox));

        const prescriptions = yield* Prescription.makePrescriptionCache(
          indexedDbPrescriptionCacheStorage,
        );
        yield* prescriptions.load;

        // One atomic hand-off rather than the Expo app's three progressive
        // `setState`s. There is no useful UI for "supervisor but no outbox",
        // and a partial runtime is a shape every consumer would otherwise have
        // to defend against.
        yield* Effect.sync(() => setState({ status: "ready", runtime: { supervisor, outbox, prescriptions } }));

        yield* Effect.never;
      }),
    ).pipe(
      Effect.provide(dependencies),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          // Interruption is the normal teardown path (the cleanup below, or
          // Strict Mode's double-invoke) — not a failure to report.
          if (Cause.hasInterruptsOnly(cause)) {
            return;
          }
          console.error("[runtime] boot failed", cause);
          setState({ status: "failed", cause: Cause.pretty(cause) });
        }),
      ),
    );

    const fiber = Effect.runFork(boot);
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, []);

  return <RuntimeContext.Provider value={state}>{children}</RuntimeContext.Provider>;
}

/** The runtime, or the reason there isn't one yet. */
export function useRuntimeState(): RuntimeState {
  return useContext(RuntimeContext);
}

/**
 * The runtime once it exists, for components rendered below a boot gate.
 * Throws if called while booting or failed — which is a programming error,
 * not a runtime condition, since the gate is what guarantees it.
 */
export function useRuntime(): RepCoachRuntime {
  const state = useRuntimeState();
  if (state.status !== "ready") {
    throw new Error(
      `useRuntime() called while the runtime was "${state.status}" — render it below the boot gate.`,
    );
  }
  return state.runtime;
}

/**
 * The outbox's pending count, subscribed rather than polled. Lives here beside
 * the provider because the strip is its only consumer today; #72 will have
 * several and may want it hoisted.
 */
export function useOutboxPendingCount(outbox: Outbox.OutboxManager): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const fiber = Effect.runFork(
      SubscriptionRef.changes(outbox.queued).pipe(
        Stream.runForEach((items) => Effect.sync(() => setCount(items.length))),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [outbox]);

  return count;
}
