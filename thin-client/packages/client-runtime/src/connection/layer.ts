import * as Layer from "effect/Layer";

import * as ConnectionDriver from "./driver.ts";
import * as RpcSession from "../rpc/session.ts";

/**
 * Adapted from t3code's `connection/layer.ts`. t3code composes a resolver +
 * driver + registry + onboarding + platform-registration-reconciliation
 * stack; this experiment has one statically-known target (the Task 2
 * dev-server) and no registry/onboarding, so the composed layer is just
 * "driver, provided the RPC session factory it needs."
 */
export const layer = ConnectionDriver.layer.pipe(Layer.provide(RpcSession.layer));
