import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ServiceActionResult, ServiceKind, ServiceStatus } from "@repcoach/contracts";

/**
 * Installs the server as a per-user background service, from Settings.
 *
 * One flavour per platform, all without admin rights:
 *
 * | Platform | Mechanism | Restarts on crash | Runs with nobody logged in |
 * |---|---|---|---|
 * | Windows | Startup-folder launcher running a restart loop, hidden | yes (5 s) | no |
 * | Linux | systemd user unit (+ `loginctl enable-linger` when allowed) | yes | with linger |
 * | macOS | launchd LaunchAgent | yes | no |
 *
 * Every flavour runs the same command — this repo's `cli.ts start` under the
 * Node that installed it — with `REPCOACH_SERVICE=1`, which is how a running
 * server knows it is managed.
 *
 * **Handover.** Installing from the web UI happens on a server the owner
 * started by hand. After writing the service it starts the service — waiting
 * until the service manager has actually launched it, so nothing depends on a
 * child of this process surviving its exit — and then exits. The service's
 * first attempt may find the port still held for a moment, fails, and its
 * restart policy brings it up a few seconds later. The page polls until it
 * answers again.
 *
 * The NSSM service and Scheduled Task scripts in `scripts/` are not managed
 * here (both need elevation); an NSSM install is reported as `legacy`.
 */

export const SERVICE_ENV_FLAG = "REPCOACH_SERVICE";
const UNIT_NAME = "repcoach.service";
const LAUNCHD_LABEL = "com.repcoach.server";
const RESTART_DELAY_SECONDS = 5;

export interface ServiceLaunchSpec {
  /** Absolute path of the Node binary to run. */
  readonly nodePath: string;
  /** `node <args…>` — the tsx loader and the CLI entry, absolute. */
  readonly args: ReadonlyArray<string>;
  readonly workingDirectory: string;
  /** Server configuration to pin into the service (PORT, HOST, REPCOACH_DB_PATH, …). */
  readonly env: Readonly<Record<string, string>>;
  /** `~/.repcoach` — where the launcher and the log live. */
  readonly dataDir: string;
}

export type CommandRunner = (
  file: string,
  args: ReadonlyArray<string>,
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

const nodeCommandRunner: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { windowsHide: true, timeout: 20_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface ServiceManagerDeps {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: CommandRunner;
}

export interface ServiceManager {
  readonly kind: ServiceKind | null;
  status(): Promise<ServiceStatus>;
  install(): Promise<ServiceActionResult>;
  uninstall(): Promise<ServiceActionResult>;
  /** Starts the installed service, resolving once its manager has launched it. Call right before exiting this process. */
  startService(): Promise<void>;
}

const quoteCmd = (value: string): string => `"${value}"`;

export const renderWindowsLoop = (spec: ServiceLaunchSpec, logPath: string): string => {
  const sets = Object.entries({ ...spec.env, [SERVICE_ENV_FLAG]: "1" })
    .map(([key, value]) => `set "${key}=${value}"`)
    .join("\r\n");
  const command = [spec.nodePath, ...spec.args].map(quoteCmd).join(" ");
  return [
    "@echo off",
    "rem RepCoach background service, installed from Settings.",
    "rem Restarts the server whenever it exits. Delete this file (or use Settings) to stop restarting it.",
    "setlocal",
    sets,
    `cd /d ${quoteCmd(spec.workingDirectory.replace(/[\\/]+$/, ""))}`,
    ":loop",
    'if not exist "%~f0" exit /b 0',
    `${command} >> ${quoteCmd(logPath)} 2>&1`,
    'if not exist "%~f0" exit /b 0',
    `ping -n ${RESTART_DELAY_SECONDS + 1} 127.0.0.1 >nul`,
    "goto loop",
    "",
  ].join("\r\n");
};

export const renderWindowsLauncher = (loopPath: string): string =>
  [
    "' RepCoach background service launcher, installed from Settings.",
    "' Runs the server's restart loop with no window.",
    `CreateObject("WScript.Shell").Run """${loopPath}""", 0, False`,
    "",
  ].join("\r\n");

export const renderSystemdUnit = (spec: ServiceLaunchSpec, logPath: string): string =>
  [
    "[Unit]",
    "Description=RepCoach server",
    "After=network-online.target",
    "",
    "[Service]",
    `WorkingDirectory=${spec.workingDirectory}`,
    ...Object.entries({ ...spec.env, [SERVICE_ENV_FLAG]: "1" }).map(([key, value]) => `Environment="${key}=${value}"`),
    `ExecStart=${[spec.nodePath, ...spec.args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ")}`,
    "Restart=always",
    `RestartSec=${RESTART_DELAY_SECONDS}`,
    `StandardOutput=append:${logPath}`,
    `StandardError=append:${logPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

const xml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const renderLaunchdPlist = (spec: ServiceLaunchSpec, logPath: string): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[spec.nodePath, ...spec.args].map((part) => `    <string>${xml(part)}</string>`),
    "  </array>",
    `  <key>WorkingDirectory</key><string>${xml(spec.workingDirectory)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries({ ...spec.env, [SERVICE_ENV_FLAG]: "1" }).map(
      ([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`,
    ),
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    `  <key>ThrottleInterval</key><integer>${RESTART_DELAY_SECONDS}</integer>`,
    `  <key>StandardOutPath</key><string>${xml(logPath)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

/** PowerShell's `-EncodedCommand` takes UTF-16LE base64, which sidesteps every quoting layer. */
const encodePowerShell = (script: string): string => Buffer.from(script, "utf16le").toString("base64");

export const makeServiceManager = (spec: ServiceLaunchSpec, deps: ServiceManagerDeps = {}): ServiceManager => {
  const platform = deps.platform ?? process.platform;
  const homeDir = deps.homeDir ?? os.homedir();
  const env = deps.env ?? process.env;
  const run = deps.run ?? nodeCommandRunner;
  const managed = env[SERVICE_ENV_FLAG] === "1";
  const logPath = path.join(spec.dataDir, "logs", "server.log");
  const ensureDirs = () => fs.mkdirSync(path.dirname(logPath), { recursive: true });

  if (platform === "win32") {
    const startupDir = path.join(
      env["APPDATA"] ?? path.join(homeDir, "AppData", "Roaming"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
    );
    const launcherPath = path.join(startupDir, "RepcoachServer.vbs");
    const legacyLauncherPath = path.join(startupDir, "RepcoachServer.cmd");
    const loopPath = path.join(spec.dataDir, "service", "run-server.cmd");

    const legacy = async (): Promise<ReadonlyArray<string>> => {
      const found: Array<string> = [];
      if (fs.existsSync(legacyLauncherPath)) found.push(`Startup-folder launcher from Install-RepcoachServer-Startup.ps1 (${legacyLauncherPath})`);
      const nssm = await run("sc.exe", ["query", "RepcoachServer"]);
      if (nssm.code === 0) found.push("Windows service \"RepcoachServer\" (NSSM) — remove it from an elevated shell: nssm remove RepcoachServer confirm");
      return found;
    };

    return {
      kind: "startup-folder",
      status: async () => ({
        platform,
        kind: "startup-folder",
        installed: fs.existsSync(launcherPath) && fs.existsSync(loopPath),
        managed,
        logPath,
        legacy: await legacy(),
        detail: "Starts when you log on to Windows and restarts the server if it stops.",
      }),
      install: async () => {
        ensureDirs();
        fs.mkdirSync(path.dirname(loopPath), { recursive: true });
        fs.mkdirSync(startupDir, { recursive: true });
        fs.writeFileSync(loopPath, renderWindowsLoop(spec, logPath));
        fs.writeFileSync(launcherPath, renderWindowsLauncher(loopPath));
        // The old launcher would start a second copy at the next logon.
        fs.rmSync(legacyLauncherPath, { force: true });
        return {
          ok: true,
          restarting: !managed,
          message: managed
            ? "Background service updated."
            : "Installed. Handing over to the background service — the server restarts in a few seconds.",
        };
      },
      uninstall: async () => {
        fs.rmSync(launcherPath, { force: true });
        fs.rmSync(loopPath, { force: true });
        return {
          ok: true,
          restarting: false,
          message: managed
            ? "Removed. This server keeps running until it stops or you log off, and will not be restarted."
            : "Removed.",
        };
      },
      startService: async () => {
        // Win32_Process.Create has WMI start the launcher, outside this
        // process's job object, so it survives the terminal (or agent session)
        // that started this server closing — the failure the ops doc calls #1.
        // A plain detached spawn does not: it dies with the job when we exit.
        const script = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'wscript.exe "${launcherPath.replace(/'/g, "''")}"' } | Out-Null`;
        await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)]);
      },
    };
  }

  if (platform === "linux") {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", UNIT_NAME);
    return {
      kind: "systemd-user",
      status: async () => {
        const linger = await run("loginctl", ["show-user", os.userInfo().username, "--property=Linger"]);
        const lingerOn = linger.stdout.includes("Linger=yes");
        return {
          platform,
          kind: "systemd-user",
          installed: fs.existsSync(unitPath),
          managed,
          logPath,
          legacy: [],
          detail: lingerOn
            ? "Starts at boot and keeps running after you log out; restarts the server if it stops."
            : `Starts when you log in. To keep it running after logout: sudo loginctl enable-linger ${os.userInfo().username}`,
        };
      },
      install: async () => {
        ensureDirs();
        fs.mkdirSync(path.dirname(unitPath), { recursive: true });
        fs.writeFileSync(unitPath, renderSystemdUnit(spec, logPath));
        const reload = await run("systemctl", ["--user", "daemon-reload"]);
        const enable = await run("systemctl", ["--user", "enable", UNIT_NAME]);
        if (reload.code !== 0 || enable.code !== 0) {
          return { ok: false, restarting: false, message: `systemctl failed: ${(enable.stderr || reload.stderr).trim()}` };
        }
        await run("loginctl", ["enable-linger"]);
        return {
          ok: true,
          restarting: !managed,
          message: managed ? "Background service updated." : "Installed. Handing over to the background service.",
        };
      },
      uninstall: async () => {
        await run("systemctl", ["--user", "disable", UNIT_NAME]);
        fs.rmSync(unitPath, { force: true });
        await run("systemctl", ["--user", "daemon-reload"]);
        return {
          ok: true,
          restarting: false,
          message: managed ? "Removed. This server keeps running until it stops, and will not be restarted." : "Removed.",
        };
      },
      startService: async () => {
        await run("systemctl", ["--user", "start", UNIT_NAME]);
      },
    };
  }

  if (platform === "darwin") {
    const plistPath = path.join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const domain = `gui/${os.userInfo().uid}`;
    return {
      kind: "launchd",
      status: async () => ({
        platform,
        kind: "launchd",
        installed: fs.existsSync(plistPath),
        managed,
        logPath,
        legacy: [],
        detail: "Starts when you log in and restarts the server if it stops. Keep the Mac logged in and awake.",
      }),
      install: async () => {
        ensureDirs();
        fs.mkdirSync(path.dirname(plistPath), { recursive: true });
        fs.writeFileSync(plistPath, renderLaunchdPlist(spec, logPath));
        return {
          ok: true,
          restarting: !managed,
          message: managed ? "Background service updated; takes effect at next login." : "Installed. Handing over to the background service.",
        };
      },
      uninstall: async () => {
        fs.rmSync(plistPath, { force: true });
        if (!managed) await run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
        return {
          ok: true,
          restarting: false,
          message: managed ? "Removed. This server keeps running until you log out." : "Removed.",
        };
      },
      startService: async () => {
        await run("launchctl", ["bootstrap", domain, plistPath]);
      },
    };
  }

  const unsupported: ServiceActionResult = {
    ok: false,
    restarting: false,
    message: `Background services are not supported on ${platform}.`,
  };
  return {
    kind: null,
    status: async () => ({
      platform,
      kind: null,
      installed: false,
      managed,
      logPath: null,
      legacy: [],
      detail: `Background services are not supported on ${platform}. Run the server under your own supervisor.`,
    }),
    install: async () => unsupported,
    uninstall: async () => unsupported,
    startService: async () => undefined,
  };
};
