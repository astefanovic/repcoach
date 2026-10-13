import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_WORKING_DIRECTORY_ENV_VAR,
  AgentWorkingDirectoryError,
  assertUsableAgentWorkingDirectory,
  prepareAgentWorkingDirectory,
  resolveAgentWorkingDirectory,
} from "./agentWorkingDirectory.ts";
import { withAgentCwd } from "./deliberationRunner.ts";

/**
 * Issue #93 — where the real Agent SDK sessions run from. Production used to
 * pass no `cwd`, so the sessions inherited the server process's directory (the
 * repo, on the home host). These tests pin the resolved default, the two
 * directories that are refused outright, and that the choice actually reaches
 * every agent's session config rather than one of the four.
 */
describe("agent working directory (issue #93)", () => {
  const created: Array<string> = [];

  const tempRoot = (): string => {
    const dir = path.join(os.tmpdir(), `repcoach-agent-cwd-test-${randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    created.push(dir);
    return dir;
  };

  afterEach(() => {
    while (created.length > 0) {
      const dir = created.pop();
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to a sibling of the live DB, not the DB's own directory", () => {
    const dbPath = path.join(os.homedir(), ".repcoach", "repcoach.sqlite");
    const resolved = resolveAgentWorkingDirectory({ liveDbPath: dbPath, env: {} });

    expect(resolved).toBe(path.join(os.homedir(), ".repcoach", "agent-workdir"));
    expect(path.dirname(dbPath)).not.toBe(resolved);
  });

  it("lets the env var override the default outright", () => {
    const override = tempRoot();
    const resolved = resolveAgentWorkingDirectory({
      liveDbPath: path.join(os.homedir(), ".repcoach", "repcoach.sqlite"),
      env: { [AGENT_WORKING_DIRECTORY_ENV_VAR]: override },
    });

    expect(resolved).toBe(path.resolve(override));
  });

  it("prefers a caller-supplied override over the env var", () => {
    const override = tempRoot();
    const resolved = resolveAgentWorkingDirectory({
      liveDbPath: path.join(os.homedir(), ".repcoach", "repcoach.sqlite"),
      override,
      env: { [AGENT_WORKING_DIRECTORY_ENV_VAR]: path.join(os.tmpdir(), "from-env") },
    });

    expect(resolved).toBe(path.resolve(override));
  });

  it("refuses the live DB's own directory (ADR 0011 §3)", () => {
    const root = tempRoot();
    const dbPath = path.join(root, "repcoach.sqlite");

    expect(() => assertUsableAgentWorkingDirectory(root, dbPath)).toThrow(AgentWorkingDirectoryError);
  });

  it("refuses anywhere inside a git working tree — the repo included", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const nested = path.join(root, "thin-client", "apps");
    fs.mkdirSync(nested, { recursive: true });

    expect(() => assertUsableAgentWorkingDirectory(nested, path.join(os.tmpdir(), "elsewhere.sqlite"))).toThrow(
      /git working tree/,
    );
  });

  it("creates the directory and drops a marker explaining what it is", () => {
    const root = tempRoot();
    const target = path.join(root, "workdir");

    const prepared = prepareAgentWorkingDirectory({
      liveDbPath: path.join(root, "repcoach.sqlite"),
      override: target,
    });

    expect(prepared).toBe(path.resolve(target));
    expect(fs.existsSync(prepared)).toBe(true);
    expect(fs.readFileSync(path.join(prepared, "README.txt"), "utf8")).toContain("read-only snapshot");
  });

  it("is idempotent across restarts and does not rewrite the marker", () => {
    const root = tempRoot();
    const target = path.join(root, "workdir");
    const first = prepareAgentWorkingDirectory({ liveDbPath: path.join(root, "db.sqlite"), override: target });
    fs.writeFileSync(path.join(first, "README.txt"), "edited by hand", "utf8");

    const second = prepareAgentWorkingDirectory({ liveDbPath: path.join(root, "db.sqlite"), override: target });

    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(second, "README.txt"), "utf8")).toBe("edited by hand");
  });

  describe("reaching the session configs", () => {
    it("fills in a cwd for a config that has none", () => {
      expect(withAgentCwd({ maxTurns: 40, wallClockMs: 1000 }, "/run/here")).toEqual({
        maxTurns: 40,
        wallClockMs: 1000,
        cwd: "/run/here",
      });
    });

    it("fills in a cwd even when the caller passed no config at all", () => {
      expect(withAgentCwd(undefined, "/run/here")?.cwd).toBe("/run/here");
    });

    it("leaves an explicitly configured cwd alone", () => {
      expect(withAgentCwd({ maxTurns: 40, wallClockMs: 1000, cwd: "/chosen" }, "/run/here")?.cwd).toBe("/chosen");
    });

    it("hands the config through untouched when there is no commissioned directory", () => {
      expect(withAgentCwd(undefined, undefined)).toBeUndefined();
      expect(withAgentCwd({ maxTurns: 1, wallClockMs: 1 }, undefined)).toEqual({ maxTurns: 1, wallClockMs: 1 });
    });
  });
});
