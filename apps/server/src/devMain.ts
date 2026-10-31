import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeAgentBacking, readAgentModeSettings } from "./agents/agentMode.ts";
import { makeDevServer } from "./server.ts";

/**
 * Boots the Task 2 dev server (issue #16): the Effect-RPC WebSocket server
 * over `/rpc` plus the `/__test__/*` control channel, both served from one
 * Node HTTP server on `PORT` (default 4010, localhost only).
 *
 * `REPCOACH_AGENT_MODE` (issue #95) selects which agents it runs — `canned`
 * (the default, and what every existing flow and CI run gets), `replay`
 * (the real adapters over recorded transcripts) or `live` (the real adapters
 * over real Agent SDK sessions, bounded and logged). See `agentMode.ts` and
 * docs/agents/testing.md.
 */
const port = Number(process.env["PORT"] ?? 4010);

const agentSettings = readAgentModeSettings();
const agentBacking = makeAgentBacking(agentSettings);

const { layer, nodeServer } = makeDevServer({
  port,
  ...(agentBacking === undefined ? {} : { agentBacking }),
});

Layer.launch(layer).pipe(
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      // eslint-disable-next-line no-console
      console.error("[dev-server] fatal:", Cause.pretty(cause));
      process.exitCode = 1;
    }),
  ),
  Effect.runFork,
);

process.on("SIGINT", () => nodeServer.close());
process.on("SIGTERM", () => nodeServer.close());

// eslint-disable-next-line no-console
console.log(
  `[dev-server] listening on ws://127.0.0.1:${port}/rpc (control channel on the same port, agents: ${agentSettings.mode})`,
);
