import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";

import { ConnectionTransientError, type SupervisorConnectionState } from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { TARGET, PREPARED_CONNECTION, makeFakeConnectionHarness } from "../testing/fakeConnectionDriver.ts";

/**
 * Rung-1 tests for the vendored supervisor (Task 3a scope, issue #17): the
 * backoff schedule `[1,2,4,8,16]s`, the 30s-stable reset, offline parking,
 * and the resume-probe tearing down a zombie socket. Ported from t3code's
 * `supervisor.test.ts`, narrowed to this repo's single connection target and
 * run against plain `vitest` + `effect/testing/TestClock` (no `@effect/vitest`
 * dependency in this workspace).
 */
function transient(message = "Connection failed."): ConnectionTransientError {
  return new ConnectionTransientError({ reason: "transport", detail: message });
}

function awaitState(
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  return SubscriptionRef.changes(state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

const eventuallyState = Effect.fn("Test.eventuallyState")(function* (
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  let lastState = yield* SubscriptionRef.get(state);
  for (let iteration = 0; iteration < 200; iteration += 1) {
    lastState = yield* SubscriptionRef.get(state);
    if (predicate(lastState)) {
      return lastState;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(
    new Error(
      `Expected supervisor state was not observed. Last state: phase=${lastState.phase}, attempt=${lastState.attempt}, generation=${lastState.generation}`,
    ),
  );
});

function runTest<A>(effect: Effect.Effect<A, unknown, any>): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(TestClock.layer())) as Effect.Effect<
      A,
      unknown,
      never
    >,
  );
}

describe("EnvironmentSupervisor (rung 1, fake driver)", () => {
  it("does not attempt a connection until it is desired", () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeFakeConnectionHarness();
        const supervisor = yield* EnvironmentSupervisor.make(TARGET).pipe(
          Effect.provide(harness.dependencies),
        );

        expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("available");
      }),
    ));

  it("retries forever with exponential backoff capped at sixteen seconds", () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeFakeConnectionHarness({ prepare: () => Effect.fail(transient()) });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "backoff" && state.attempt === 1);

        for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000, 16_000].entries()) {
          const before = yield* SubscriptionRef.get(supervisor.state);
          expect(before.retryAt).not.toBeNull();
          yield* TestClock.adjust(delay);
          yield* eventuallyState(
            supervisor.state,
            (state) => state.phase === "backoff" && state.attempt === index + 2,
          );
        }
      }),
    ));

  it("waits while offline and connects immediately when the network returns (offline parks attempts)", () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeFakeConnectionHarness({ networkStatus: "offline" });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "offline");
        expect(yield* Ref.get(harness.prepareCount)).toBe(0);

        yield* harness.setNetworkStatus("online");
        const ready = yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        expect(ready).toMatchObject({ phase: "connected", generation: 1, attempt: 1 });
      }),
    ));

  it("resets the backoff schedule after 30 stable seconds connected", () =>
    runTest(
      Effect.gen(function* () {
        let firstAttemptFailed = false;
        const harness = yield* makeFakeConnectionHarness({
          prepare: () => {
            if (!firstAttemptFailed) {
              firstAttemptFailed = true;
              return Effect.fail(transient());
            }
            return Effect.succeed(PREPARED_CONNECTION);
          },
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "backoff" && state.attempt === 1);
        yield* TestClock.adjust(1_000);
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 1,
        );

        // Stay connected for the full 30s stability window before dropping.
        yield* TestClock.adjust(30_000);
        yield* harness.closeLatestSession(transient("Dropped after stability window."));
        const backoffAfterStableDrop = yield* awaitState(
          supervisor.state,
          (state) => state.phase === "backoff",
        );
        // Because the prior connection was stable for >=30s, the internal
        // failure counter was reset to 0 before this failure, so the retry
        // delay restarts at the schedule's first rung (1s) rather than
        // continuing to escalate from the earlier backoff sequence.
        expect(backoffAfterStableDrop.retryAt).toBe((yield* Clock.currentTimeMillis) + 1_000);
      }),
    ));

  it("resume-probe (application-active) tears down a zombie socket and reconnects", () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeFakeConnectionHarness({
          probe: (attempt) => (attempt === 1 ? Effect.fail(transient("Zombie socket.")) : Effect.void),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* harness.wake("application-active");
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        expect(yield* Ref.get(harness.releaseCount)).toBe(1);

        yield* TestClock.adjust(1_000);
        yield* eventuallyState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 2,
        );
        expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      }),
    ));

  it("a healthy resume-probe leaves a connected session untouched", () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeFakeConnectionHarness();
        const supervisor = yield* EnvironmentSupervisor.make(TARGET, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* harness.wake("application-active");
        yield* Effect.yieldNow;

        expect(yield* Ref.get(harness.sessionCount)).toBe(1);
        expect(yield* Ref.get(harness.releaseCount)).toBe(0);
        expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
      }),
    ));

  it("explicit disconnect releases the session and returns to available", () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeFakeConnectionHarness();
        const supervisor = yield* EnvironmentSupervisor.make(TARGET, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* supervisor.disconnect;
        yield* awaitState(supervisor.state, (state) => state.phase === "available");

        expect(yield* Ref.get(harness.releaseCount)).toBe(1);
        expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
      }),
    ));
});
