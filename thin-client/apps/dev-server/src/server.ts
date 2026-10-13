import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { NodeFileSystem, NodeHttpServer, NodePath } from "@effect/platform-node";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import type { ServeError } from "effect/unstable/http/HttpServerError";
import type { PlatformError } from "effect/PlatformError";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import type { MigrationError } from "effect/unstable/sql/Migrator";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { RepCoachRpcGroup } from "@repcoach/contracts";
import { SqlStore } from "@repcoach/persistence";

import type { AgentBacking } from "./agentMode.ts";
import type { AgentSdkTransport } from "./agentTransport.ts";
import { prepareAgentWorkingDirectory } from "./agentWorkingDirectory.ts";
import { ConnectionRegistry } from "./connectionRegistry.ts";
import { makeCycleReviewScheduleLayer, type CycleReviewScheduleConfig } from "./cycleReviewSchedule.ts";
import { makeRealDeliberationRunnerLayer } from "./deliberationRunner.ts";
import type { QuotaService } from "./quotaService.ts";
import { CannedModelCatalog, ModelCatalog, RealModelCatalog } from "./modelCatalog.ts";
import { RpcHandlersLayer } from "./rpcHandlers.ts";
import { makeSessionReviewDrainLayer, type SessionReviewDrainConfig } from "./sessionReviewDrain.ts";
import { makeStaticRoutesLayer } from "./staticFiles.ts";
import { makeTestControlRoutesLayer } from "./testControl.ts";
import { makeAgentBackedDeliberation, makeDeliberationLevers } from "./testLevers.ts";

/**
 * Wires the Task 1 `RepCoachRpcGroup` onto an Effect-RPC WebSocket server
 * (mirroring t3code `apps/server/src/ws.ts`'s wiring style). Two builders
 * share the same RPC runtime:
 *
 * - `makeDevServer` (Task 2, issue #16) additionally mounts the `/__test__/*`
 *   control channel so the adversarial e2e author can induce offline/blip
 *   conditions from outside the client.
 * - `makeProductionServer` (Step 2A / task 2A.5) mounts ONLY `/rpc` against a
 *   configured persistent SQLite file, bound to a configurable interface so
 *   the tailnet (Tailscale) can reach it. It deliberately does NOT mount the
 *   control channel — a production server exposing `drop-socket`/`reset`/
 *   `mutate-prescribed-session` would be a footgun and a data-integrity hole.
 */

/**
 * The shared `/rpc` runtime: the Effect-RPC WebSocket protocol plus the
 * handler map, over the default `HttpRouter`. State-free (the `/rpc` path and
 * the handler group are constants), so both builders reuse this one Layer
 * value; each server graph provides its own `SqlStore`/`NodeHttpServer` at the
 * end. Mirrors t3code `apps/server/src/server.ts`: the app layer is served
 * with its `Store` requirement still open and only closed out by the
 * `provide([...])` at the very end (resolving `Store` per-route earlier left a
 * `Requires<Store>` phantom dangling in `serve`'s output).
 */
const RpcRuntime = RpcServer.layer(RepCoachRpcGroup).pipe(
  Layer.provideMerge(
    RpcServer.layerProtocolWebsocket({ path: "/rpc" }).pipe(Layer.provide(HttpRouter.layer)),
  ),
  Layer.provide(RpcHandlersLayer),
);

export interface DevServerHandle {
  readonly layer: Layer.Layer<never, ServeError | SqlError | MigrationError | PlatformError>;
  readonly registry: ConnectionRegistry;
  readonly nodeServer: http.Server;
  /**
   * This instance's temp SQLite file. Exposed so a suite can inspect what the
   * dev-server's own boot did (or did not) write — e.g. proving the dev-server
   * never starts the Cycle-review schedule (issue #91).
   */
  readonly dbPath: string;
  /**
   * Which agents this instance is running (issue #95). `"canned"` unless a
   * backing was passed — reported so the boot log, and the control channel, can
   * say so rather than leaving it to be inferred from behaviour.
   */
  readonly agentMode: "canned" | "replay" | "live";
}

export const makeDevServer = (options: {
  readonly port: number;
  /**
   * Runs the REAL agent adapters against replayed or live sessions instead of
   * the canned layers (issue #95). Absent — the default, and what CI runs —
   * keeps the scripted layers and every existing flow exactly as it was.
   */
  readonly agentBacking?: AgentBacking;
}): DevServerHandle => {
  const nodeServer = http.createServer();
  const registry = new ConnectionRegistry();
  nodeServer.on("connection", registry.track);

  // Step 2A / task 2A.1: the dev-server runs against a real SQLite
  // `SqlStore` instead of the in-memory `Store.layer`, so the existing 14
  // thin-client Playwright flows prove parity against real persistence.
  // Each `makeDevServer` call gets its own uniquely-named temp-file DB
  // (never `:memory:` — that would defeat the point of proving durability)
  // so concurrent test files/server instances in the same process never
  // share state; `/__test__/reset` wipes + reseeds it back to the seed.
  const dbPath = path.join(os.tmpdir(), `repcoach-dev-server-${randomUUID()}.sqlite`);

  // Both the RPC handlers' direct `Store` requirement AND the
  // `DeliberationRunner`'s are satisfied from this ONE `SqlStore.layer`
  // value, so "run now" and every other RPC read/write the same DB file.
  const StoreLive = SqlStore.layer({ filename: dbPath });

  // The dev-server's deliberation wiring is the canned one, with the two
  // rung-2 levers on it (issue #77 — see `testLevers.ts`): the control
  // channel needs the handle, so the runner layer is built here rather than
  // inline in `provide` below.
  //
  // With an `agentBacking` it is the REAL adapters instead (issue #95), over a
  // replayed or live transport. The agent working directory is prepared the
  // same way production's is — these sessions hold `Bash` and `Read`, and a
  // dev-server that let them inherit the repo would be the exact defect #93
  // fixed for production, reintroduced through the test harness.
  const deliberation =
    options.agentBacking === undefined
      ? makeDeliberationLevers(StoreLive)
      : makeAgentBackedDeliberation(StoreLive, {
          backing: options.agentBacking,
          liveDbPath: dbPath,
          agentCwd: prepareAgentWorkingDirectory({
            liveDbPath: dbPath,
            override: path.join(os.tmpdir(), "repcoach-e2e-agent-workdir"),
          }),
        });

  const ControlRoutes = makeTestControlRoutesLayer(registry, deliberation.levers, {
    ...(options.agentBacking === undefined ? {} : { agentBacking: options.agentBacking }),
  }).pipe(Layer.provide(HttpRouter.layer));
  const AppLayer = Layer.mergeAll(RpcRuntime, ControlRoutes);

  const HttpServerLive = HttpRouter.serve(AppLayer, { disableListenLog: true }).pipe(
    Layer.provide([
      NodeHttpServer.layer(() => nodeServer, { port: options.port }),
      RpcSerialization.layerNdjson,
      StoreLive,
      deliberation.layer,
      // The dev-server's model catalog is canned for the same reason its
      // agents are: reading the real one opens an Agent SDK session, and a
      // suite that boots a dev-server must never do that.
      CannedModelCatalog,
    ]),
  );

  return {
    layer: HttpServerLive,
    registry,
    nodeServer,
    dbPath,
    agentMode: options.agentBacking?.mode ?? "canned",
  };
};

export interface ProductionServerHandle {
  readonly layer: Layer.Layer<never, ServeError | SqlError | MigrationError | PlatformError>;
  readonly nodeServer: http.Server;
  /** The directory the real Agent SDK sessions will run from (issue #93) — reported so the boot log can name it. */
  readonly agentWorkingDirectory: string;
}

/**
 * The always-on production server (Step 2A / task 2A.5): the same `/rpc`
 * runtime as the dev-server but over a configured **persistent** SQLite file,
 * bound to `host` so the tailnet interface can reach it, with **no**
 * `/__test__/*` control channel. No `ConnectionRegistry` either — that only
 * exists to back the test channel's `drop-socket` lever.
 *
 * When `staticDir` points at the `apps/web` (Vite) build, the
 * server also serves the thin client itself (task 2A.6, t3code model — see
 * `staticFiles.ts`): open the server URL in a browser and the app loads and
 * connects back same-origin. The `GET *` static catch-all is registered
 * alongside `/rpc`; the exact-path WebSocket route wins for `/rpc` itself.
 */
export const makeProductionServer = (options: {
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
  readonly staticDir?: string;
  /**
   * Overrides the live quota poller (issue #88). Production leaves it alone and
   * gets `QuotaServiceLive`; the suites that boot this server over a real socket
   * pass `QuotaServiceAlwaysAvailable` so booting a server in a unit rung never
   * spawns an Agent SDK session just to read the subscription's rate limits.
   */
  readonly quotaService?: Layer.Layer<QuotaService>;
  /**
   * Tunes the monthly Cycle-review schedule (issue #91). Production leaves it
   * alone and gets ADR 0011 §4's plain month checked hourly; it exists so a
   * suite can compress the cadence instead of waiting one out.
   */
  readonly cycleReviewSchedule?: CycleReviewScheduleConfig;
  /**
   * Tunes the Session-review drain's poll interval (issue #132). Production
   * leaves it alone; it exists so a suite can compress the retry interval
   * instead of waiting one out.
   */
  readonly sessionReviewDrain?: SessionReviewDrainConfig;
  /**
   * Overrides the working directory the Agent SDK sessions run from (issue
   * #93). Production leaves it alone and gets the prepared
   * `~/.repcoach/agent-workdir`; suites that boot this server over a real
   * socket point it at a temp directory so a unit rung never creates anything
   * beside the user's real DB.
   */
  readonly agentWorkingDirectory?: string;
  /**
   * Overrides the live Agent SDK model catalog (issue #81 follow-up). Same
   * posture as `quotaService`: production leaves it alone and reads the real
   * catalog, while suites that boot this server over a real socket pass
   * `CannedModelCatalog` so a unit rung never opens an SDK session just to
   * populate a dropdown.
   */
  readonly modelCatalog?: Layer.Layer<ModelCatalog>;
  /**
   * What runs the Agent SDK sessions (issue #95). Production leaves it alone
   * and gets live sessions. The one thing it is set to in practice is a
   * *recording* wrapper around those same live sessions
   * (`REPCOACH_AGENT_RECORD_DIR`), which is how the replay fixtures are
   * refreshed: drive a real Intake on the real server and the transcripts land
   * on disk. Recording is the only production use — nothing here should ever
   * point production at a replay.
   */
  readonly agentTransport?: AgentSdkTransport;
}): ProductionServerHandle => {
  const nodeServer = http.createServer();

  const AppLayer =
    options.staticDir === undefined
      ? RpcRuntime
      : Layer.mergeAll(
          RpcRuntime,
          makeStaticRoutesLayer(options.staticDir).pipe(
            Layer.provide(HttpRouter.layer),
            Layer.provide([NodeFileSystem.layer, NodePath.layer]),
          ),
        );

  // `seedDemoFixtures: false` — a real user's Exercise catalog and Plan
  // start empty and are built through Intake/Deliberation, never pre-filled
  // with the dev/e2e demo Plan + catalog rows `SqlStore.layer` seeds by
  // default (issue: intake drafts were reusing the seeded demo catalog).
  const StoreLive = SqlStore.layer({ filename: options.dbPath, seedDemoFixtures: false });

  // The real Agent SDK deliberator (issue #27 — 2B slice 2) + the real
  // adversarial sweep (issue #28 — 2B slice 3) are what production runs
  // "run now" against — the read-only DB snapshot
  // (`makeRealDeliberationRunnerLayer`'s `liveDbPath`) is copied from this
  // exact `options.dbPath` file per run, and the sweep runs as a SECOND
  // Agent SDK session over the deliberator's draft (ADR 0011 §1) before
  // anything is committed. Dev-server/tests keep the canned agent + canned
  // sweep (`makeDevServer` above), since the real agents need live Agent SDK
  // sessions this repo's automated rungs cannot exercise (ADR 0011 /
  // issue #27 / issue #28 — verified in e2e/UAT instead).
  // Where those sessions RUN FROM (issue #93). Prepared eagerly, at boot: a
  // working directory that turns out to be the repo (or the live DB's own
  // directory) must fail the server here, not surface as a strange run hours
  // later. `agentWorkingDirectory` overrides it for harnesses that boot this
  // server without wanting a directory created under the real DB.
  const agentCwd = prepareAgentWorkingDirectory({
    liveDbPath: options.dbPath,
    ...(options.agentWorkingDirectory === undefined ? {} : { override: options.agentWorkingDirectory }),
  });

  const DeliberationRunnerLive = makeRealDeliberationRunnerLayer(StoreLive, {
    liveDbPath: options.dbPath,
    agentCwd,
    ...(options.quotaService === undefined ? {} : { quotaService: options.quotaService }),
    ...(options.agentTransport === undefined ? {} : { transport: options.agentTransport }),
  });

  // The monthly Cycle-review schedule (ADR 0011 §4, issue #91) — PRODUCTION
  // ONLY. `makeDevServer` deliberately has no equivalent: a dev server that
  // starts firing background Deliberation runs would be spending subscription
  // quota underneath every suite that boots one.
  //
  // Merged as a sibling of the HTTP graph rather than provided into it: it
  // outputs nothing, and its `Store`/`DeliberationRunner` requirements are
  // closed with the SAME layer VALUES the server uses. Layer memoization is by
  // reference within one build, so the scheduler ticks against the same store
  // and the same runner `/rpc` does — not a second copy of either.
  const CycleReviewScheduleLive = makeCycleReviewScheduleLayer(options.cycleReviewSchedule).pipe(
    Layer.provide(DeliberationRunnerLive),
    Layer.provide(StoreLive),
  );

  // The Session-review drain (issue #132) — same construction and the same
  // production-only reasoning as the Cycle-review schedule above. This is the
  // path that recovers a review lost to a failed run, a low-quota deferral, or
  // a restart; its first tick is immediate, so a server booting with stranded
  // sessions reviews them at startup rather than a poll interval later.
  const SessionReviewDrainLive = makeSessionReviewDrainLayer(options.sessionReviewDrain).pipe(
    Layer.provide(DeliberationRunnerLive),
    Layer.provide(StoreLive),
  );

  const HttpServerLive = HttpRouter.serve(AppLayer, { disableListenLog: true }).pipe(
    Layer.provide([
      NodeHttpServer.layer(() => nodeServer, { port: options.port, host: options.host }),
      RpcSerialization.layerNdjson,
      StoreLive,
      DeliberationRunnerLive,
      options.modelCatalog ?? RealModelCatalog(),
    ]),
  );

  return {
    layer: Layer.mergeAll(HttpServerLive, CycleReviewScheduleLive, SessionReviewDrainLive),
    nodeServer,
    agentWorkingDirectory: agentCwd,
  };
};
