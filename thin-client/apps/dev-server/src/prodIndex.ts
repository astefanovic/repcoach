import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeRecordingTransport } from "./agentCassette.ts";
import { LiveAgentSdkTransport } from "./agentTransport.ts";
import { makeProductionServer } from "./server.ts";

/**
 * Production entrypoint (Step 2A / task 2A.5): the persistent RepCoach server
 * for the always-on home host (ADR 0005). Unlike `index.ts` (the dev server)
 * this build mounts ONLY `/rpc` — the `/__test__/*` control channel is
 * deliberately absent (a prod server exposing drop-socket/reset/mutate is a
 * footgun and a data-integrity hole; see `makeProductionServer`).
 *
 * Config comes from the environment so the same build runs on any host:
 *   PORT             — TCP port (default 4020).
 *   HOST             — bind interface (default 127.0.0.1). The tailnet reach
 *                      (ADR 0005) is provided by `tailscale serve` fronting
 *                      this loopback port with HTTPS + a stable MagicDNS URL
 *                      (mirroring t3code's `@t3tools/tailscale`), so the raw
 *                      port stays loopback-only — nothing unencrypted is
 *                      exposed on the LAN/tailnet. Set HOST=0.0.0.0 only to
 *                      expose the raw port directly (no Tailscale fronting).
 *   REPCOACH_DB_PATH — SQLite file (default ~/.repcoach/repcoach.sqlite; its
 *                      parent dir is created by `SqlStore` on first open).
 *   REPCOACH_AGENT_RECORD_DIR — when set, every live Agent SDK session this
 *                      server runs is written there as a replay cassette
 *                      (issue #95). This is how the rung-2 fixtures are
 *                      refreshed: drive a real Intake against a THROWAWAY db
 *                      and commit what lands. Off by default — a production
 *                      server does not write transcripts of its own runs to
 *                      disk unless asked.
 *   REPCOACH_AGENT_CWD — working directory the Agent SDK sessions run from
 *                      (default ~/.repcoach/agent-workdir). Never the repo and
 *                      never the live DB's own directory — issue #93,
 *                      `agentWorkingDirectory.ts` refuses both.
 *
 * Runtime: system Node ≥22.16 (needs the `node:sqlite` builtin) — the home
 * host is on Node 26.5.0 via nvm.
 */
const port = Number(process.env["PORT"] ?? 4020);
const host = process.env["HOST"] ?? "127.0.0.1";
const dbPath =
  process.env["REPCOACH_DB_PATH"] ?? path.join(os.homedir(), ".repcoach", "repcoach.sqlite");

/**
 * The thin client's web build (t3code model): the server serves the client's
 * build output itself, so a phone browser opening the server URL gets the app,
 * already pointed at this server (same-origin). `REPCOACH_STATIC_DIR`
 * overrides; the default is the monorepo build output, mirroring t3code's
 * `resolveStaticDir` monorepo fallback. Absent build -> warn and serve `/rpc`
 * only.
 *
 * Repointed from `apps/expo/dist` to `apps/web/dist` by #50 (ADR 0012).
 * `apps/expo`, the `expo export` white-screen workaround (#47) it needed, and
 * `scripts/Build-WebClient.ps1` are gone (#53) — Vite is the only bundler in
 * the serving path now.
 */
const defaultStaticDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
const staticDirCandidate = process.env["REPCOACH_STATIC_DIR"] ?? defaultStaticDir;
const staticDir = fs.existsSync(path.join(staticDirCandidate, "index.html"))
  ? staticDirCandidate
  : undefined;
if (staticDir === undefined) {
  // eslint-disable-next-line no-console
  console.warn(
    `[repcoach-server] no web client build at ${staticDirCandidate} (run: pnpm --filter @repcoach/web build) — serving /rpc only`,
  );
}

const recordDir = process.env["REPCOACH_AGENT_RECORD_DIR"];

const { layer, nodeServer, agentWorkingDirectory } = makeProductionServer({
  port,
  host,
  dbPath,
  ...(staticDir === undefined ? {} : { staticDir }),
  ...(recordDir === undefined || recordDir.trim() === ""
    ? {}
    : {
        agentTransport: makeRecordingTransport({
          inner: LiveAgentSdkTransport,
          dir: recordDir,
          provenance: "recorded from a live Agent SDK session on the production server",
        }),
      }),
});

Layer.launch(layer).pipe(
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      // eslint-disable-next-line no-console
      console.error("[repcoach-server] fatal:", Cause.pretty(cause));
      process.exitCode = 1;
    }),
  ),
  Effect.runFork,
);

process.on("SIGINT", () => nodeServer.close());
process.on("SIGTERM", () => nodeServer.close());

// eslint-disable-next-line no-console
console.log(
  `[repcoach-server] listening on http://${host}:${port} (rpc: /rpc, db: ${dbPath}${
    staticDir === undefined ? "" : `, web client: ${staticDir}`
  }, agent cwd: ${agentWorkingDirectory}${
    recordDir === undefined || recordDir.trim() === "" ? "" : `, recording agent sessions to: ${recordDir}`
  })`,
);
