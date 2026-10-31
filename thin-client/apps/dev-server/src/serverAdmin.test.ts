import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { ServerStatus, ServiceActionResult } from "@repcoach/contracts";

import { CannedModelCatalog } from "./modelCatalog.ts";
import { QuotaServiceAlwaysAvailable } from "./quotaService.ts";
import { makeProductionServer } from "./server.ts";
import { ServerAuth } from "./serverAuth.ts";
import type { ServiceManager } from "./serviceManager.ts";
import { TailscaleExposure } from "./tailscaleExposure.ts";
import { waitForServerReady } from "./testServerReady.ts";

/**
 * The pairing gate on a real socket: `/rpc` and `/api/server/*` answer only
 * paired devices, pairing hands back a cookie that opens both, and a revoked
 * device is shut out again. Booted with the canned catalog and quota service,
 * so no Agent SDK session is opened.
 */
describe("production server: pairing gate and admin routes", () => {
  let baseUrl: string;
  let fiber: Fiber.Fiber<never, never>;
  let dataDir: string;
  let auth: ServerAuth;
  const exits: Array<string> = [];
  const installs: Array<string> = [];

  const services: ServiceManager = {
    kind: "startup-folder",
    status: async () => ({
      platform: "win32",
      kind: "startup-folder",
      installed: installs.length > 0,
      managed: false,
      logPath: null,
      legacy: [],
      detail: null,
    }),
    install: async (): Promise<ServiceActionResult> => {
      installs.push("install");
      return { ok: true, restarting: true, message: "Installed." };
    },
    uninstall: async () => ({ ok: true, restarting: false, message: "Removed." }),
    startService: async () => {
      installs.push("started");
    },
  };

  beforeAll(async () => {
    dataDir = path.join(os.tmpdir(), `repcoach-admin-${randomUUID()}`);
    fs.mkdirSync(dataDir, { recursive: true });
    auth = ServerAuth.open(path.join(dataDir, "repcoach.sqlite"));
    const exposure = new TailscaleExposure({
      run: async () => ({ kind: "not-installed" }),
      localPort: 0,
      instanceId: "test-instance",
      enabled: false,
      log: () => undefined,
    });
    await exposure.check();

    let port = 0;
    const { layer, nodeServer } = makeProductionServer({
      port: 0,
      host: "127.0.0.1",
      dbPath: path.join(dataDir, "repcoach.sqlite"),
      agentWorkingDirectory: path.join(dataDir, "agent-cwd"),
      quotaService: QuotaServiceAlwaysAvailable,
      modelCatalog: CannedModelCatalog,
      admin: {
        auth,
        exposure,
        services,
        identity: () => ({ app: "repcoach", instanceId: "test-instance", buildRef: "test", startedAt: "", phoneUrl: null }),
        port: () => port,
        dbPath: path.join(dataDir, "repcoach.sqlite"),
        requestExit: (reason) => exits.push(reason),
      },
    });
    const listening = new Promise<void>((resolve) => nodeServer.once("listening", () => resolve()));
    fiber = Effect.runFork(Layer.launch(layer) as Effect.Effect<never, never>);
    await listening;
    const address = nodeServer.address();
    if (address === null || typeof address === "string") throw new Error("expected an AddressInfo");
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;
    await waitForServerReady(baseUrl);
  });

  afterAll(async () => {
    await Effect.runPromise(Fiber.interrupt(fiber));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const pairDevice = async (): Promise<string> => {
    const { code } = auth.mintPairingCode();
    const response = await fetch(`${baseUrl}/api/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, "user-agent": "Chrome/130 Android" },
      body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    return cookie.split(";")[0]!;
  };

  const openSocket = (headers: Record<string, string>): Promise<"open" | number> =>
    new Promise((resolve) => {
      const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/rpc`, { headers });
      socket.once("open", () => {
        socket.close();
        resolve("open");
      });
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("error", () => resolve(0));
    });

  it("answers the identity probe and the app shell without pairing", async () => {
    const identity = await fetch(`${baseUrl}/.well-known/repcoach/server`);
    expect(await identity.json()).toMatchObject({ app: "repcoach", instanceId: "test-instance" });
    expect((await fetch(`${baseUrl}/api/auth/session`)).status).toBe(401);
  });

  it("refuses /rpc and the admin routes to an unpaired device", async () => {
    expect(await openSocket({ origin: baseUrl })).toBe(401);
    expect((await fetch(`${baseUrl}/api/server/status`)).status).toBe(401);
  });

  it("a paired device's cookie opens /rpc and the status, which lists it as this device", async () => {
    const cookie = await pairDevice();
    expect(await openSocket({ cookie, origin: baseUrl })).toBe("open");

    const status = (await (await fetch(`${baseUrl}/api/server/status`, { headers: { cookie } })).json()) as ServerStatus;
    expect(status.currentDeviceId).not.toBeNull();
    expect(status.devices.find((device) => device.id === status.currentDeviceId)?.label).toBe("Chrome on Android");
    expect(status.phoneAccess.kind).toBe("disabled");
  });

  it("refuses a socket from another origin even with a valid cookie", async () => {
    const cookie = await pairDevice();
    expect(await openSocket({ cookie, origin: "https://evil.example" })).toBe(403);
  });

  it("mints pairing links with a QR code", async () => {
    const cookie = await pairDevice();
    const response = await fetch(`${baseUrl}/api/server/pairing`, { method: "POST", headers: { cookie, origin: baseUrl } });
    const link = (await response.json()) as { url: string; qrSvg: string };
    // A fragment, so the one-time code never reaches the request log.
    expect(link.url).toMatch(/\/pair#code=/);
    expect(link.qrSvg).toContain("<svg");
  });

  it("installing the service hands over: starts it, then exits", async () => {
    const cookie = await pairDevice();
    const response = await fetch(`${baseUrl}/api/server/service/install`, {
      method: "POST",
      headers: { cookie, origin: baseUrl },
    });
    expect(await response.json()).toMatchObject({ ok: true, restarting: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(installs).toEqual(["install", "started"]);
    expect(exits).toHaveLength(1);
  });

  it("a revoked device is shut out", async () => {
    const cookie = await pairDevice();
    const status = (await (await fetch(`${baseUrl}/api/server/status`, { headers: { cookie } })).json()) as ServerStatus;
    const revoke = await fetch(`${baseUrl}/api/server/devices/${status.currentDeviceId}/revoke`, {
      method: "POST",
      headers: { cookie, origin: baseUrl },
    });
    expect(revoke.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/server/status`, { headers: { cookie } })).status).toBe(401);
  });
});
