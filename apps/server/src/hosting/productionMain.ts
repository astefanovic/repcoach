import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import type { ServerIdentity } from "@repcoach/contracts";

import { makeRecordingTransport } from "../agents/agentCassette.ts";
import { LiveAgentSdkTransport } from "../agents/agentTransport.ts";
import { SERVER_BUILD_REF } from "../buildRef.ts";
import { clearRuntimeState, writeRuntimeState } from "./runtimeState.ts";
import { makeProductionServer } from "../server.ts";
import { ServerAuth } from "./serverAuth.ts";
import { SERVICE_ENV_FLAG, makeServiceManager, type ServiceManager } from "./serviceManager.ts";
import { DEFAULT_SERVE_PORT, nodeTailscaleRunner } from "./tailscale.ts";
import { TailscaleExposure } from "./tailscaleExposure.ts";

/**
 * Boots the production server: the RPC runtime and web client
 * (`makeProductionServer`), device pairing, Tailscale Serve, and the runtime
 * state file. Called by `cli.ts` — `pnpm repcoach …`, `pnpm --filter
 * @repcoach/server start`, and every background service.
 *
 * Configuration is environment variables, so the same build runs on any host
 * and a service can pin them:
 *
 *   PORT                      — TCP port (default 4020).
 *   HOST                      — bind interface (default 127.0.0.1). Tailscale
 *                               Serve fronts the loopback port with HTTPS, so
 *                               nothing unencrypted is exposed. Set 0.0.0.0
 *                               only to expose the raw port yourself.
 *   REPCOACH_DB_PATH          — SQLite file (default ~/.repcoach/repcoach.sqlite).
 *                               Its directory also holds the pairing secret,
 *                               `<db>.auth.json` (paired devices),
 *                               `<db>.runtime.json` and `logs/`.
 *   REPCOACH_STATIC_DIR       — the built web client (default apps/web/dist).
 *   REPCOACH_AGENT_CWD        — where Agent SDK sessions run from (default
 *                               ~/.repcoach/agent-workdir; never the repo or the
 *                               DB's own directory — issue #93).
 *   REPCOACH_AGENT_RECORD_DIR — record every live agent session as a replay
 *                               cassette (issue #95). Off by default.
 *   REPCOACH_TAILSCALE_SERVE  — `0` to leave Tailscale Serve alone (default on).
 *   REPCOACH_TAILSCALE_SERVE_PORT — the HTTPS port Serve publishes on (default
 *                               443). A second server (a commissioning run)
 *                               uses another one.
 *
 * Runtime: Node ≥ 22.16 (the `node:sqlite` builtin).
 */

export interface ProductionConfig {
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
  readonly staticDir: string | undefined;
  readonly agentCwd: string | undefined;
  readonly recordDir: string | undefined;
  readonly tailscaleServe: boolean;
  readonly tailscaleServePort: number;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value;

export const DEFAULT_PORT = 4020;
export const defaultDbPath = (): string => path.join(os.homedir(), ".repcoach", "repcoach.sqlite");
export const defaultStaticDir = (): string => fileURLToPath(new URL("../../../web/dist", import.meta.url));

export const productionConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): ProductionConfig => ({
  port: Number(env["PORT"] ?? DEFAULT_PORT),
  host: env["HOST"] ?? "127.0.0.1",
  dbPath: nonEmpty(env["REPCOACH_DB_PATH"]) ?? defaultDbPath(),
  staticDir: nonEmpty(env["REPCOACH_STATIC_DIR"]),
  agentCwd: nonEmpty(env["REPCOACH_AGENT_CWD"]),
  recordDir: nonEmpty(env["REPCOACH_AGENT_RECORD_DIR"]),
  tailscaleServe: env["REPCOACH_TAILSCALE_SERVE"] !== "0",
  tailscaleServePort: Number(env["REPCOACH_TAILSCALE_SERVE_PORT"] ?? DEFAULT_SERVE_PORT),
});

/** The directory beside the DB that holds everything the server keeps besides the DB. */
export const dataDirFor = (config: Pick<ProductionConfig, "dbPath">): string => path.dirname(config.dbPath);

/**
 * What a background service runs: this checkout's `cli.ts start`, under the
 * Node binary running now (so an nvm-managed Node is pinned by path), with the
 * current server settings fixed into its environment.
 */
export const serviceManagerFor = (config: ProductionConfig): ServiceManager => {
  const require = createRequire(import.meta.url);
  const pinned: Record<string, string> = {
    PORT: String(config.port),
    HOST: config.host,
    REPCOACH_DB_PATH: config.dbPath,
    ...(config.staticDir === undefined ? {} : { REPCOACH_STATIC_DIR: config.staticDir }),
    ...(config.agentCwd === undefined ? {} : { REPCOACH_AGENT_CWD: config.agentCwd }),
    ...(config.tailscaleServe ? {} : { REPCOACH_TAILSCALE_SERVE: "0" }),
    ...(config.tailscaleServePort === DEFAULT_SERVE_PORT
      ? {}
      : { REPCOACH_TAILSCALE_SERVE_PORT: String(config.tailscaleServePort) }),
    // systemd and launchd start services with a bare PATH; the agents need git
    // and friends. The Windows launcher inherits the logon environment instead.
    ...(process.platform !== "win32" && process.env["PATH"] !== undefined ? { PATH: process.env["PATH"] } : {}),
  };
  return makeServiceManager({
    nodePath: process.execPath,
    args: [require.resolve("tsx/cli"), fileURLToPath(new URL("./cli.ts", import.meta.url)), "start"],
    workingDirectory: fileURLToPath(new URL("../..", import.meta.url)),
    env: pinned,
    dataDir: dataDirFor(config),
  });
};

export interface RunningServer {
  readonly port: number;
  readonly instanceId: string;
  readonly auth: ServerAuth;
  readonly exposure: TailscaleExposure;
  readonly services: ServiceManager;
  readonly dataDir: string;
  /** Stops the server and resolves once it has. */
  readonly stop: () => Promise<void>;
}

// eslint-disable-next-line no-console
const log = (line: string): void => console.log(line);

export const startProductionServer = async (config: ProductionConfig): Promise<RunningServer> => {
  const dataDir = dataDirFor(config);
  const staticDirCandidate = config.staticDir ?? defaultStaticDir();
  const staticDir = fs.existsSync(path.join(staticDirCandidate, "index.html")) ? staticDirCandidate : undefined;
  if (staticDir === undefined) {
    // eslint-disable-next-line no-console
    console.warn(
      `[repcoach-server] no web client build at ${staticDirCandidate} (run: pnpm --filter @repcoach/web build) — serving /rpc only`,
    );
  }

  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const managed = process.env[SERVICE_ENV_FLAG] === "1";
  const auth = ServerAuth.open(config.dbPath);
  const services = serviceManagerFor(config);
  let boundPort = config.port;
  const exposure = new TailscaleExposure({
    run: nodeTailscaleRunner,
    get localPort() {
      return boundPort;
    },
    instanceId,
    enabled: config.tailscaleServe,
    servePort: config.tailscaleServePort,
    log,
  });
  const identity = (): ServerIdentity => ({
    app: "repcoach",
    instanceId,
    buildRef: SERVER_BUILD_REF,
    startedAt,
    phoneUrl: exposure.phoneUrl,
  });

  let stopping: Promise<void> | undefined;
  let fiber: Fiber.Fiber<never, unknown> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      exposure.stop();
      clearRuntimeState(config.dbPath, process.pid);
      if (fiber !== undefined) await Effect.runPromise(Fiber.interrupt(fiber));
    })();
    return stopping;
  };

  const { layer, nodeServer, agentWorkingDirectory } = makeProductionServer({
    port: config.port,
    host: config.host,
    dbPath: config.dbPath,
    ...(staticDir === undefined ? {} : { staticDir }),
    ...(config.agentCwd === undefined ? {} : { agentWorkingDirectory: config.agentCwd }),
    ...(config.recordDir === undefined
      ? {}
      : {
          agentTransport: makeRecordingTransport({
            inner: LiveAgentSdkTransport,
            dir: config.recordDir,
            provenance: "recorded from a live Agent SDK session on the production server",
          }),
        }),
    admin: {
      auth,
      exposure,
      services,
      identity,
      port: () => boundPort,
      dbPath: config.dbPath,
      requestExit: (reason) => {
        log(`[repcoach-server] exiting: ${reason}`);
        void stop().finally(() => process.exit(0));
      },
    },
  });

  const listening = new Promise<void>((resolve, reject) => {
    nodeServer.once("listening", () => resolve());
    nodeServer.once("error", reject);
  });
  fiber = Effect.runFork(
    Layer.launch(layer).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          // eslint-disable-next-line no-console
          console.error("[repcoach-server] fatal:", Cause.pretty(cause));
          process.exitCode = 1;
        }),
      ),
    ) as Effect.Effect<never>,
  );
  await listening;

  const address = nodeServer.address();
  if (address !== null && typeof address !== "string") boundPort = address.port;
  writeRuntimeState(config.dbPath, {
    pid: process.pid,
    port: boundPort,
    host: config.host,
    instanceId,
    startedAt,
    dbPath: config.dbPath,
    managed,
  });

  log(
    `[repcoach-server] listening on http://${config.host}:${boundPort} (rpc: /rpc, db: ${config.dbPath}${
      staticDir === undefined ? "" : `, web client: ${staticDir}`
    }, agent cwd: ${agentWorkingDirectory}${
      config.recordDir === undefined ? "" : `, recording agent sessions to: ${config.recordDir}`
    }${managed ? ", managed by the background service" : ""})`,
  );
  if (auth.listDevices().length === 0) {
    log("[repcoach-server] no devices paired yet — run `pnpm repcoach pair` (or `pnpm repcoach install`) to pair one.");
  }
  exposure.start();

  return { port: boundPort, instanceId, auth, exposure, services, dataDir, stop };
};

/** SIGINT/SIGTERM stop the server cleanly (runtime state removed, fiber interrupted). */
export const exitOnSignals = (server: RunningServer): void => {
  const onSignal = () => {
    void server.stop().finally(() => process.exit(0));
    // A wedged shutdown must not hold the port forever.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
};
