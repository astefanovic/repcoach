import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeServiceManager, renderSystemdUnit, renderWindowsLoop, type ServiceLaunchSpec } from "./serviceManager.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const specIn = (root: string): ServiceLaunchSpec => ({
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  args: ["C:\\repo\\node_modules\\tsx\\dist\\cli.mjs", "C:\\repo\\apps\\dev-server\\src\\cli.ts", "start"],
  workingDirectory: "C:\\repo\\apps\\dev-server",
  env: { PORT: "4020", REPCOACH_DB_PATH: "C:\\Users\\me\\.repcoach\\repcoach.sqlite" },
  dataDir: path.join(root, ".repcoach"),
});

const noCommands = async () => ({ code: 1, stdout: "", stderr: "" });

describe("background service", () => {
  it("Windows: the loop marks the process as managed, logs, and stops restarting once its file is gone", () => {
    const loop = renderWindowsLoop(specIn("C:\\x"), "C:\\x\\server.log");
    expect(loop).toContain('set "REPCOACH_SERVICE=1"');
    expect(loop).toContain('set "PORT=4020"');
    expect(loop).toContain('if not exist "%~f0" exit /b 0');
    expect(loop).toContain('>> "C:\\x\\server.log" 2>&1');
  });

  it("Windows: install writes the hidden launcher, removes the old .cmd launcher, and starts it through WMI", async () => {
    const root = path.join(os.tmpdir(), `repcoach-svc-${randomUUID()}`);
    roots.push(root);
    const appData = path.join(root, "AppData");
    const startup = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    fs.mkdirSync(startup, { recursive: true });
    fs.writeFileSync(path.join(startup, "RepcoachServer.cmd"), "old");

    const ran: Array<ReadonlyArray<string>> = [];
    const services = makeServiceManager(specIn(root), {
      platform: "win32",
      homeDir: root,
      env: { APPDATA: appData },
      run: async (file, args) => {
        ran.push([file, ...args]);
        return { code: 1, stdout: "", stderr: "" };
      },
    });

    expect((await services.status()).legacy).toHaveLength(1);
    const result = await services.install();
    expect(result).toMatchObject({ ok: true, restarting: true });
    expect(fs.existsSync(path.join(startup, "RepcoachServer.vbs"))).toBe(true);
    expect(fs.existsSync(path.join(startup, "RepcoachServer.cmd"))).toBe(false);
    expect(await services.status()).toMatchObject({ installed: true, managed: false, legacy: [] });

    await services.startService();
    expect(ran.at(-1)?.[0]).toBe("powershell.exe");

    await services.uninstall();
    expect((await services.status()).installed).toBe(false);
  });

  it("an already-managed server updates its service in place instead of handing over", async () => {
    const root = path.join(os.tmpdir(), `repcoach-svc-${randomUUID()}`);
    roots.push(root);
    const services = makeServiceManager(specIn(root), {
      platform: "win32",
      homeDir: root,
      env: { APPDATA: path.join(root, "AppData"), REPCOACH_SERVICE: "1" },
      run: noCommands,
    });
    expect(await services.install()).toMatchObject({ ok: true, restarting: false });
    expect((await services.status()).managed).toBe(true);
  });

  it("Linux: the systemd unit restarts the server and appends to the log", () => {
    const unit = renderSystemdUnit(specIn("/home/me"), "/home/me/.repcoach/logs/server.log");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain('Environment="REPCOACH_SERVICE=1"');
    expect(unit).toContain("StandardOutput=append:/home/me/.repcoach/logs/server.log");
  });
});
