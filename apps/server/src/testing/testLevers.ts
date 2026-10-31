import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { Store } from "../store.ts";

import type { AgentBacking } from "../agents/agentMode.ts";
import { DeliberationAgent, ZERO_TOKEN_USAGE, CANNED_RUN_OUTPUT } from "../agents/deliberationAgent.ts";
import {
  DeliberationRunner,
  makeCannedDeliberationRunnerLayer,
  makeRealDeliberationRunnerLayer,
} from "../deliberation/deliberationRunner.ts";
import { CannedIntakeSessionAgent } from "../agents/intakeSessionAgent.ts";
import { makeCannedQuotaService } from "../agents/quotaService.ts";

/**
 * Dev-only levers over the deliberation pipeline (issue #77), mounted on the
 * `/__test__/*` control channel by `testControl.ts`.
 *
 * Why they exist: the dev-server's canned deliberator returns instantly, so
 * every state ADR 0013 §5 puts on the Proposal card while a Revise is in
 * flight — the lock, the two-word spinner ("queued" vs "running"), Cancel —
 * flickers past faster than a browser can observe it. The rung-2 author is
 * forbidden client hooks (docs/agents/testing.md), so the knob has to live
 * here, on the server, exactly like `pause-acks` does for the outbox.
 *
 * Two knobs, matching the two states:
 *
 * - **hold / release** gates the deliberator itself, so a dispatched run sits
 *   in `running` for as long as the flow needs.
 * - **quota low / available** drives the runner's deferral queue (ADR 0011
 *   §8), so a Revise sits in `queued` instead of dispatching.
 *
 * `resetLevers` restores both to their default (nothing held, quota
 * available) and is folded into `POST /__test__/reset`, so a flow that fails
 * mid-hold cannot leave the next one wedged.
 */
export interface DeliberationLevers {
  /** Every subsequent deliberator call blocks until `releaseRuns`. */
  readonly holdRuns: Effect.Effect<void>;
  /** Releases anything blocked by `holdRuns` and stops gating new runs. */
  readonly releaseRuns: Effect.Effect<void>;
  /** Quota reads as low: a requested run queues rather than dispatching. */
  readonly setQuotaLow: Effect.Effect<void>;
  /** Quota recovers: the runner drains anything it queued. */
  readonly setQuotaAvailable: Effect.Effect<void>;
  /**
   * Back to the default posture — nothing held, quota available — with any
   * run still in flight ABANDONED rather than completed.
   *
   * The distinction matters: `releaseRuns` lets a held run finish and commit
   * its revision, which is what a flow wants mid-test. At teardown that same
   * commit would land *after* the store had been reseeded and leave the next
   * flow looking at a revised Proposal instead of the seeded one.
   */
  readonly resetLevers: Effect.Effect<void>;
}

/**
 * The canned deliberator, wrapped in a release gate. Identical output to
 * `CannedDeliberationAgent` — the only difference is *when* it returns.
 */
const makeGatedDeliberationAgent = (): {
  readonly layer: Layer.Layer<DeliberationAgent>;
  readonly hold: Effect.Effect<void>;
  readonly release: Effect.Effect<void>;
  readonly abandon: Effect.Effect<void>;
} => {
  // `abandoned` is decided at the moment the gate opens, so it is carried on
  // the gate value itself rather than alongside it: a run waiting on THIS
  // gate learns why it was woken, and a later `hold` gets a fresh gate whose
  // verdict cannot be confused with the previous one's.
  interface Gate {
    readonly deferred: Deferred.Deferred<void, never>;
    readonly abandoned: Ref.Ref<boolean>;
  }
  // A `Ref`, matching `quotaService.ts`'s canned stand-in — both this and the
  // routes that drive it are Effects, so there is nothing to thread by hand.
  const gateRef = Effect.runSync(Ref.make<Gate | undefined>(undefined));

  const hold = Effect.gen(function* () {
    if ((yield* Ref.get(gateRef)) !== undefined) return;
    yield* Ref.set(gateRef, {
      deferred: yield* Deferred.make<void, never>(),
      abandoned: yield* Ref.make(false),
    });
  });

  const openGate = (abandoned: boolean) =>
    Effect.gen(function* () {
      const gate = yield* Ref.getAndSet(gateRef, undefined);
      if (gate === undefined) return;
      // The verdict is written BEFORE anyone is woken: a waiter reads it off
      // the gate it captured, and would otherwise race this write.
      yield* Ref.set(gate.abandoned, abandoned);
      yield* Deferred.succeed(gate.deferred, void 0);
    });

  const layer = Layer.succeed(DeliberationAgent)({
    run: (_assembledPrompt, _model) =>
      Effect.gen(function* () {
        const gate = yield* Ref.get(gateRef);
        if (gate !== undefined) {
          yield* Deferred.await(gate.deferred);
          // Abandoned: die here rather than returning an output. The runner
          // swallows the interrupt (its background Revision fiber catches
          // every cause) and, crucially, never reaches its commit.
          if (yield* Ref.get(gate.abandoned)) return yield* Effect.interrupt;
        }
        return { output: CANNED_RUN_OUTPUT, usage: ZERO_TOKEN_USAGE, costUsd: 0 };
      }),
  });

  return { layer, hold, release: openGate(false), abandon: openGate(true) };
};

/**
 * The dev-server's `DeliberationRunner` layer: the same canned wiring as
 * `makeCannedDeliberationRunnerLayer`, but with the deliberator gated and the
 * quota service controllable, plus the `levers` handle the control channel
 * drives them through.
 */
export const makeDeliberationLevers = <E, R>(
  storeLayer: Layer.Layer<Store, E, R>,
): {
  readonly layer: Layer.Layer<DeliberationRunner, E, R>;
  readonly levers: DeliberationLevers;
} => {
  const gated = makeGatedDeliberationAgent();
  const quota = makeCannedQuotaService();

  const layer = makeCannedDeliberationRunnerLayer(storeLayer, {
    deliberationAgent: gated.layer,
    quotaService: quota.layer,
    // #82: the dev-server is the only place a browser can reach Intake, so it
    // is the only place a scripted coach earns its keep. Everything else keeps
    // the unwired default and fails loudly if it reaches Intake by accident.
    intakeSessionAgent: CannedIntakeSessionAgent,
  });

  const levers: DeliberationLevers = {
    holdRuns: gated.hold,
    releaseRuns: gated.release,
    setQuotaLow: quota.setLow,
    setQuotaAvailable: quota.setAvailable,
    // Order matters, and it is the opposite of what reads naturally: CLOSE
    // the gate first, so a run the quota recovery is about to drain parks on
    // it instead of racing through the pipeline; give the drain a beat to get
    // there; only then wake everything as abandoned. Reversing this lets a
    // queued run commit its revision straight after the store was reseeded.
    resetLevers: gated.hold.pipe(
      Effect.andThen(quota.setAvailable),
      Effect.andThen(Effect.sleep("50 millis")),
      Effect.andThen(gated.abandon),
    ),
  };

  return { layer, levers };
};

/**
 * The dev-server's deliberation wiring when it is running the REAL adapters
 * against replayed or live agent sessions (issue #95).
 *
 * Same server, same control channel, same flows — only the four agent adapters
 * change, which is the point: an agent-backed run has to exercise the wiring a
 * canned run does, or it is testing a different application.
 *
 * Two levers behave differently here, and both differences are honest rather
 * than papered over:
 *
 * - **hold / release does nothing.** It gates the *canned* deliberator's return
 *   (`makeGatedDeliberationAgent`), which does not exist in this wiring. A real
 *   or replayed run has its own duration, so the states the lever was invented
 *   to make observable (#77) are either genuinely visible or genuinely absent.
 *   Failing the route instead was tempting, but a lever that 500s mid-teardown
 *   would break `reset` for flows that never asked for it.
 * - **quota stays canned**, so `quota-low`/`quota-available` still drive the
 *   deferral queue. The alternative — `QuotaServiceLive` — polls the real SDK
 *   for rate limits, i.e. opens a session, which a *replay* run must never do.
 */
export const makeAgentBackedDeliberation = <E, R>(
  storeLayer: Layer.Layer<Store, E, R>,
  options: {
    readonly backing: AgentBacking;
    readonly liveDbPath: string;
    readonly agentCwd: string;
  },
): {
  readonly layer: Layer.Layer<DeliberationRunner, E, R>;
  readonly levers: DeliberationLevers;
} => {
  const quota = makeCannedQuotaService();

  const layer = makeRealDeliberationRunnerLayer(storeLayer, {
    liveDbPath: options.liveDbPath,
    agentCwd: options.agentCwd,
    quotaService: quota.layer,
    transport: options.backing.transport,
  });

  const levers: DeliberationLevers = {
    holdRuns: Effect.void,
    releaseRuns: Effect.void,
    setQuotaLow: quota.setLow,
    setQuotaAvailable: quota.setAvailable,
    // Cassette cursors rewind here, so the next flow in a file replays the same
    // transcripts the first one did rather than running off the end of them.
    resetLevers: quota.setAvailable.pipe(Effect.andThen(Effect.sync(options.backing.reset))),
  };

  return { layer, levers };
};
