import * as Effect from "effect/Effect";

import { Connection, Rpc } from "@repcoach/client-runtime";

import type { RepCoachRuntime } from "./RuntimeProvider.tsx";

/**
 * The one place the React layer crosses into Effect (#72).
 *
 * Every RPC in `@repcoach/client-runtime` is written against the
 * `EnvironmentSupervisor` service, and the supervisor the provider booted is
 * a plain value. Providing it is therefore the whole adapter — there is no
 * second runtime, no `ManagedRuntime`, and no component that has to know
 * what a `Layer` is.
 *
 * Everything here returns a **promise that rejects on failure** rather than
 * an `Effect`, because the calling code is React event handlers and effects.
 * The typed failure is preserved as the rejection value (`Exit`'s cause is
 * squashed to it), so a caller can still tell `PrescribedSessionNotFound`
 * from a dead socket.
 */

export function callRpc<TTag extends Rpc.EnvironmentUnaryRpcTag>(
  runtime: RepCoachRuntime,
  tag: TTag,
  input: Rpc.EnvironmentRpcInput<TTag>,
): Promise<Rpc.EnvironmentRpcSuccess<TTag>> {
  return runEffect(runtime, Rpc.request(tag, input));
}

/**
 * Runs an Effect that needs the supervisor (or nothing at all) and settles a
 * promise with it. `Effect.runPromise` would do — this exists so the service
 * is provided in exactly one place and no call site can forget it.
 */
export function runEffect<A, E>(
  runtime: RepCoachRuntime,
  effect: Effect.Effect<A, E, Connection.EnvironmentSupervisor>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provideService(Connection.EnvironmentSupervisor, runtime.supervisor)),
  );
}

/**
 * A failure, as a line the UI can put on screen.
 *
 * Every surface here has the same job with a rejected promise — an honest
 * error state rather than an empty one (#72 story 38) — so the shape of the
 * message is decided once. The truncation matters: an Effect cause rendered
 * in full is a stack of spans, and a status strip or a caption cannot carry
 * it.
 */
export function describeFailure(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
