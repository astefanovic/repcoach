import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { SqlStore } from "@repcoach/persistence";
import { MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS, Store } from "@repcoach/persistence/store";

import { QuotaServiceAlwaysAvailable } from "./quotaService.ts";
import { CannedModelCatalog } from "./modelCatalog.ts";
import { makeProductionServer } from "./server.ts";
import { fetchWithRetry, openWebSocketWithRetry, waitForServerReady } from "./testServerReady.ts";

/**
 * Step 2A / task 2A.5 — the production server. The headline guarantee is a
 * security one: the `/__test__/*` control channel that the dev-server mounts
 * (drop-socket / reset / mutate-prescribed-session / …) MUST be absent here —
 * a prod server exposing those would let anyone on the tailnet wipe or corrupt
 * the single user's real logged data. These tests boot `makeProductionServer`
 * over a real socket on an ephemeral port against a temp SQLite file and prove
 * the test levers are gone (404) while `/rpc` is still mounted and upgrades.
 *
 * RPC request/response semantics themselves aren't re-proven here: the prod
 * server reuses the byte-identical `RpcRuntime` the dev-server does, already
 * covered exhaustively by `rpcHandlers.test.ts` / `clientIntegration.test.ts`.
 */
describe("production server (Step 2A / task 2A.5)", () => {
  let baseUrl: string;
  let wsUrl: string;
  let fiber: Fiber.Fiber<never, never>;
  let dbPath: string;
  let agentCwd: string;
  let agentWorkingDirectory: string;

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `repcoach-prod-server-${randomUUID()}.sqlite`);
    agentCwd = path.join(os.tmpdir(), `repcoach-prod-agent-cwd-${randomUUID()}`);
    const { layer, nodeServer, agentWorkingDirectory: preparedCwd } = makeProductionServer({
      port: 0,
      host: "127.0.0.1",
      dbPath,
      // Issue #93: the sessions run from a deliberate directory. Pointed at a
      // temp one here so a unit rung never creates anything beside the real DB.
      agentWorkingDirectory: agentCwd,
      // Booting a prod server must not spawn an Agent SDK session just to read
      // the subscription's rate limits (issue #88): this rung is about the
      // socket, not the quota poller.
      quotaService: QuotaServiceAlwaysAvailable,
      // Same posture, for the same reason (issue #81 follow-up): reading the
      // real model catalog opens an Agent SDK session.
      modelCatalog: CannedModelCatalog,
    });
    agentWorkingDirectory = preparedCwd;

    const listening = new Promise<void>((resolve) => {
      nodeServer.once("listening", () => resolve());
    });
    fiber = Effect.runFork(Layer.launch(layer) as Effect.Effect<never, never>);
    await listening;

    const address = nodeServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from the production server's Node HTTP server");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/rpc`;
    await waitForServerReady(baseUrl);
  });

  afterAll(async () => {
    await Effect.runPromise(Fiber.interrupt(fiber));
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    fs.rmSync(agentCwd, { recursive: true, force: true });
  });

  it.each([
    ["POST", "/__test__/reset"],
    ["POST", "/__test__/drop-socket"],
    ["POST", "/__test__/pause-acks"],
    ["POST", "/__test__/mutate-prescribed-session"],
    ["POST", "/__test__/open-prescribed-load"],
    ["POST", "/__test__/hold-deliberation"],
    ["POST", "/__test__/release-deliberation"],
    ["POST", "/__test__/quota-low"],
    ["POST", "/__test__/quota-available"],
    ["GET", "/__test__/logged-actuals"],
    ["GET", "/__test__/context-notes"],
    ["GET", "/__test__/plan"],
  ])("does NOT expose the %s %s test lever (returns 404)", async (method, route) => {
    const response = await fetchWithRetry(`${baseUrl}${route}`, { method });
    expect(response.status).toBe(404);
  });

  it("still mounts /rpc: a WebSocket connection upgrades and opens", async () => {
    const socket = await openWebSocketWithRetry(wsUrl);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  // Issue #91 — the production server, and ONLY it, runs the monthly
  // Cycle-review schedule (ADR 0011 §4). Probed through the schedule's own
  // state rather than by waiting a month out: booting ticks once immediately,
  // and that tick starts the persisted clock. So a claim dated a year on finds
  // a window to take. Had nothing scheduled, the row would not exist yet and
  // this claim would be the BOOTSTRAP one, which by design claims nothing —
  // exactly what the dev-server's mirror of this test asserts (`server.test.ts`).
  it("runs the Cycle-review schedule: booting starts the persisted clock", async () => {
    const claim = await Effect.gen(function* () {
      const store = yield* Store;
      return yield* store.claimDueCycleReview({
        now: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        intervalMillis: MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS,
      });
    }).pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);

    expect(claim.claimed).toBe(true);
  });

  it("commissions a working directory for the Agent SDK sessions, and it exists (issue #93)", () => {
    // Prod used to hand the sessions no `cwd` at all, so they inherited the
    // server process's directory. Booting must now settle that deliberately.
    expect(agentWorkingDirectory).toBe(path.resolve(agentCwd));
    expect(fs.statSync(agentWorkingDirectory).isDirectory()).toBe(true);
    expect(path.dirname(dbPath)).not.toBe(agentWorkingDirectory);
  });
});

/**
 * Task 2A.6 (t3code model): with a `staticDir`, the production server serves
 * the thin client's web build itself — a phone browser opening the server URL
 * gets the app, no Metro/Expo Go. Mirrors t3code's `staticAndDevRouteLayer`
 * semantics: `/` -> index.html, real assets served with their content type,
 * unknown paths fall back to the SPA shell, and the `GET *` catch-all never
 * revives the `/__test__/*` levers (GETs serve the shell, POSTs still 404).
 */
describe("production server serving the web client (Step 2A / task 2A.6)", () => {
  let baseUrl: string;
  let wsUrl: string;
  let fiber: Fiber.Fiber<never, never>;
  let dbPath: string;
  let staticDir: string;

  const INDEX_HTML = "<!doctype html><html><body>repcoach-web-client</body></html>";
  const APP_JS = "console.log('repcoach');";
  const MANIFEST = '{"name":"RepCoach"}';

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `repcoach-prod-static-${randomUUID()}.sqlite`);
    staticDir = path.join(os.tmpdir(), `repcoach-prod-static-dir-${randomUUID()}`);
    fs.mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(staticDir, "index.html"), INDEX_HTML);
    fs.writeFileSync(path.join(staticDir, "assets", "app.js"), APP_JS);
    fs.writeFileSync(path.join(staticDir, "manifest.webmanifest"), MANIFEST);

    const { layer, nodeServer } = makeProductionServer({
      port: 0,
      host: "127.0.0.1",
      dbPath,
      staticDir,
      quotaService: QuotaServiceAlwaysAvailable,
      // Same posture, for the same reason (issue #81 follow-up): reading the
      // real model catalog opens an Agent SDK session.
      modelCatalog: CannedModelCatalog,
    });
    const listening = new Promise<void>((resolve) => {
      nodeServer.once("listening", () => resolve());
    });
    fiber = Effect.runFork(Layer.launch(layer) as Effect.Effect<never, never>);
    await listening;

    const address = nodeServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from the production server's Node HTTP server");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/rpc`;
    await waitForServerReady(baseUrl);
  });

  afterAll(async () => {
    await Effect.runPromise(Fiber.interrupt(fiber));
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  it("GET / serves the web client's index.html", async () => {
    const response = await fetchWithRetry(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it("GET a real asset serves it with the right content type", async () => {
    const response = await fetchWithRetry(`${baseUrl}/assets/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toBe(APP_JS);
  });

  // Served as octet-stream under nosniff, the browser ignores the manifest and
  // "Add to Home Screen" degrades to a bookmark.
  it("GET the web app manifest serves it as application/manifest+json", async () => {
    const response = await fetchWithRetry(`${baseUrl}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    expect(await response.text()).toBe(MANIFEST);
  });

  it("an unknown path falls back to the SPA shell (client-side routing)", async () => {
    const response = await fetchWithRetry(`${baseUrl}/some/client/route`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it("GET /__test__/plan serves the app shell, never lever data; POST levers still 404", async () => {
    const getResponse = await fetchWithRetry(`${baseUrl}/__test__/plan`);
    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toBe(INDEX_HTML);

    const postResponse = await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });
    expect(postResponse.status).toBe(404);
  });

  it("/rpc still upgrades: the exact WebSocket route beats the static catch-all", async () => {
    const socket = await openWebSocketWithRetry(wsUrl);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});
