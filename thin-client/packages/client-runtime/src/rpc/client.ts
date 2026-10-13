import { RPC_METHODS } from "@repcoach/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";

/**
 * Adapted from t3code's `rpc/client.ts` — the `request`/`subscribe` helpers
 * that read the supervisor's current `RpcSession` are kept intact; the
 * `EnvironmentRpcTag` union is narrowed from t3code's large
 * `WS_METHODS`/`ORCHESTRATION_WS_METHODS` surface to this repo's six
 * `RPC_METHODS` (Task 1, `@repcoach/contracts`), and `runStream` (t3code's
 * command-stream helper for things like `gitRunStackedAction`) is dropped —
 * none of this repo's methods are stream-shaped commands, only
 * subscriptions.
 */
export class EnvironmentRpcUnavailableError extends Schema.TaggedErrorClass<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export type EnvironmentRpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends EnvironmentRpcTag> = WsRpcProtocolClient[TTag];

export type EnvironmentSubscriptionRpcTag =
  | typeof RPC_METHODS.subscribeCoachingFeed
  | typeof RPC_METHODS.subscribeProposals
  | typeof RPC_METHODS.subscribePlan
  // #74: the Intake activity line. Unlike the other three this stream is
  // deliberately NOT durable — the session dies with the connection (ADR 0014
  // §8's mortality rule), so a client that stops watching has missed the
  // events, which is correct for a once-per-lifetime flow.
  | typeof RPC_METHODS.subscribeIntakeEvents
  // ADR 0013 / issue #66 slice 3: the Proposal card's exchange stream —
  // durable like the first three (replays current state on reconnect), just
  // like `subscribeProposals`. Added here because this union was hand-narrowed
  // from `WsRpcProtocolClient` rather than derived from it, so a new stream-
  // shaped RPC added to `RepCoachRpcGroup` (contracts) does not automatically
  // become callable through `Rpc.subscribe` without also being named here.
  | typeof RPC_METHODS.subscribeProposalExchanges
  // ADR 0011 §8 / issue #78: the status strip's run-visibility stream
  // (`deliberation.subscribeState`). Same hand-narrowing tax as the line
  // above — `SubscribeDeliberationStateRpc` has been `stream: true` in
  // contracts since 2B slice 7, but `useDeliberationActivity` could not call
  // it through `Rpc.subscribe` until it was named here.
  | typeof RPC_METHODS.subscribeDeliberationState
  // ADR 0011 §8: the Coach record's run history
  // (`deliberation.subscribeRuns`). Durable, and read off the STORE rather
  // than the runner's live state — which is the difference between the two
  // deliberation streams: the one above is "is the coach busy right now" and
  // forgets everything on restart, this one is the record of every run it has
  // ever made, including the ones that emitted nothing and the ones that died.
  | typeof RPC_METHODS.subscribeDeliberationRuns;

export type EnvironmentUnaryRpcTag = Exclude<EnvironmentRpcTag, EnvironmentSubscriptionRpcTag>;
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

export type EnvironmentRpcInput<TTag extends EnvironmentRpcTag> = Parameters<RpcMethod<TTag>>[0];

export type EnvironmentRpcSuccess<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcFailure<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<any, infer E, any>
    ? E
    : never;

export type EnvironmentRpcStreamValue<TTag extends EnvironmentSubscriptionRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcStreamFailure<TTag extends EnvironmentSubscriptionRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<any, infer E, any>
    ? E
    : never;

const currentSession = Effect.fn("EnvironmentRpc.currentSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: `${supervisor.target.label} is not connected.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

export const request = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  const method = session.client[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  return yield* method(input);
});

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: {
    readonly onExpectedFailure?: (
      cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
    ) => Effect.Effect<void, never, never>;
    readonly retryExpectedFailureAfter?: Duration.Input;
  },
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    EnvironmentSupervisor.pipe(
      Effect.map((supervisor) =>
        SubscriptionRef.changes(supervisor.session).pipe(
          Stream.switchMap(
            Option.match({
              onNone: () => Stream.empty,
              onSome: (session) => {
                const method = session.client[tag] as (
                  input: EnvironmentRpcInput<TTag>,
                ) => Stream.Stream<
                  EnvironmentRpcStreamValue<TTag>,
                  EnvironmentRpcStreamFailure<TTag>
                >;
                const subscribeToSession = (): Stream.Stream<
                  EnvironmentRpcStreamValue<TTag>,
                  EnvironmentRpcStreamFailure<TTag>
                > =>
                  Stream.suspend(() =>
                    method(input).pipe(
                      Stream.catchCause((cause) => {
                        const hasOnlyExpectedFailures =
                          cause.reasons.length > 0 &&
                          cause.reasons.every((reason) => reason._tag === "Fail");
                        const isTransportFailure =
                          hasOnlyExpectedFailures &&
                          cause.reasons.every(
                            (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                          );
                        if (isTransportFailure) {
                          return Stream.fromEffect(
                            Effect.logWarning(
                              "Durable RPC subscription lost its transport; waiting for the next session.",
                              {
                                cause: Cause.pretty(cause),
                                method: tag,
                                environmentId: supervisor.target.environmentId,
                              },
                            ),
                          ).pipe(Stream.drain);
                        }
                        if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                          const handled = Stream.fromEffect(options.onExpectedFailure(cause)).pipe(
                            Stream.drain,
                          );
                          if (options.retryExpectedFailureAfter === undefined) {
                            return handled;
                          }
                          return handled.pipe(
                            Stream.concat(
                              Stream.fromEffect(
                                Effect.sleep(options.retryExpectedFailureAfter),
                              ).pipe(Stream.drain),
                            ),
                            Stream.concat(subscribeToSession()),
                          );
                        }
                        return Stream.failCause(cause);
                      }),
                    ),
                  );
                return subscribeToSession();
              },
            }),
          ),
        ),
      ),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export const config = Effect.gen(function* () {
  const session = yield* currentSession();
  return yield* session.initialConfig;
}).pipe(Effect.withSpan("EnvironmentRpc.config"));
