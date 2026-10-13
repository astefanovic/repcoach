import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * `serverGetConfig` — used by the connection supervisor's resume
 * health-probe (see thin-client-experiment.md, mechanism 1) to distinguish a
 * live server from a zombie socket. Intentionally minimal for Task 1; grows
 * as the dev-server (Task 2) needs to advertise more.
 */
export const ServerConfig = Schema.Struct({
  serverName: TrimmedNonEmptyString,
  serverVersion: TrimmedNonEmptyString,
  protocolVersion: TrimmedNonEmptyString,
  /**
   * The git commit the **server** is running (issue #111). The client bakes
   * the commit it was *built* from into its own bundle and compares the two on
   * connect; a difference means the served bundle and the server are speaking
   * different contract versions, which is exactly the drift that made every
   * Intake fail while the transport stayed perfectly healthy.
   *
   * `"unknown"` when git could not be consulted. The comparison treats that as
   * "cannot tell" and stays quiet rather than crying wolf — a check that fires
   * when it has no evidence is a check people learn to ignore.
   *
   * Additive on purpose: `Schema.Struct` ignores excess properties, so a client
   * built before this field existed still decodes this config and connects
   * normally. It simply cannot report the drift — which is inherent, since the
   * comparison lives in client code that such a bundle predates.
   */
  buildRef: TrimmedNonEmptyString,
});
export type ServerConfig = typeof ServerConfig.Type;

export class ServerConfigUnavailableError extends Schema.TaggedErrorClass<ServerConfigUnavailableError>()(
  "ServerConfigUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `serverGetConfig failed: ${this.reason}`;
  }
}
