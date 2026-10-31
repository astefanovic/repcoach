import * as fs from "node:fs";
import * as path from "node:path";

import { siblingFileFor } from "./serverAuth.ts";

/**
 * `~/.repcoach/repcoach.runtime.json` — which server is running, on which port
 * (t3code's `server-runtime.json`). Lets the CLI answer "is it running?" and
 * mint a pairing link for it without guessing the port, and lets `install`
 * reuse a server that is already up instead of starting a second one.
 *
 * Written when the server is listening, removed on a clean exit. A file left
 * by a crash is detected by its pid no longer being alive. Named after the
 * database, like `serverAuth.ts`'s session file, so a commissioning server
 * beside the real one keeps its own.
 */

export interface RuntimeState {
  readonly pid: number;
  readonly port: number;
  readonly host: string;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly dbPath: string;
  readonly managed: boolean;
}

export const runtimeStatePath = (dbPath: string): string => siblingFileFor(dbPath, "runtime.json");

export const writeRuntimeState = (dbPath: string, state: RuntimeState): void => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(runtimeStatePath(dbPath), JSON.stringify(state, null, 2));
};

export const clearRuntimeState = (dbPath: string, pid: number): void => {
  const current = readRuntimeState(dbPath);
  if (current?.pid === pid) fs.rmSync(runtimeStatePath(dbPath), { force: true });
};

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: alive, owned by someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The recorded state, or `undefined` if there is none or its process is gone. */
export const readRuntimeState = (dbPath: string): RuntimeState | undefined => {
  try {
    const state = JSON.parse(fs.readFileSync(runtimeStatePath(dbPath), "utf8")) as RuntimeState;
    return typeof state.pid === "number" && isProcessAlive(state.pid) ? state : undefined;
  } catch {
    return undefined;
  }
};
