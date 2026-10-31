import { RepCoachRpcGroup } from "@repcoach/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/unstable/rpc";

/**
 * Vendored from t3code's `rpc/protocol.ts`, swapping `WsRpcGroup` (from
 * `@t3tools/contracts`) for this repo's `RepCoachRpcGroup` (Task 1,
 * `@repcoach/contracts`).
 */
export const makeWsRpcProtocolClient = RpcClient.make(RepCoachRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
