import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Where the Agent SDK sessions run from (issue #93 — commissioning the real
 * agent path).
 *
 * Every real session — the deliberator, the adversarial sweep, the held-open
 * Intake session and the Intake sweep — is a Claude Code session holding
 * `Bash` and `Read` (ADR 0011 §2, native tools only). Until this existed the
 * production server passed no `cwd` at all, so those sessions inherited
 * whatever directory the server process happened to be started from: on this
 * host, the repo. A free-reasoning agent whose default `Read`/`Grep`/`Bash`
 * scope is the source tree of the app reviewing its own user is a footgun on
 * two counts — it can read code it was never given as context, and a slipped
 * write lands in a git working tree.
 *
 * So production points them at a **deliberate, empty scratch directory**, and
 * the only real data the run can reach is the read-only snapshot it is handed
 * by absolute path (`deliberationSnapshot.ts`, ADR 0011 §3).
 *
 * This is a *deliberate default*, not a sandbox: a session with `Bash` can
 * `cd` anywhere the server's user can. The read-only-snapshot chmod is the
 * enforcement point for data integrity; this is the "what does the agent see
 * when it looks around" decision.
 */

/** Env var that overrides the resolved working directory outright. */
export const AGENT_WORKING_DIRECTORY_ENV_VAR = "REPCOACH_AGENT_CWD";

/** Directory name used under the live DB's parent when nothing overrides it. */
export const AGENT_WORKING_DIRECTORY_NAME = "agent-workdir";

/**
 * The marker file dropped into a freshly created working directory. It exists
 * so that a human (or an agent that runs `ls`) finding this directory knows
 * what created it and that its contents are disposable.
 */
const MARKER_FILE_NAME = "README.txt";

const MARKER_CONTENTS = `This directory is the working directory RepCoach's Deliberation/Intake
Agent SDK sessions run from (see docs/adr/0011 §3 and docs/ops/repcoach-server.md).

It is deliberately empty. Nothing here is read by the app, and anything an
agent session leaves behind is disposable. The data a run is allowed to read
is a read-only snapshot of the live DB, handed to it by absolute path.
`;

export class AgentWorkingDirectoryError extends Error {
  constructor(detail: string) {
    super(`[repcoach-server] refusing to run Agent SDK sessions from this working directory: ${detail}`);
    this.name = "AgentWorkingDirectoryError";
  }
}

/**
 * Resolves the directory without touching the filesystem: the env override if
 * set, otherwise a sibling of the live DB (`~/.repcoach/agent-workdir` for the
 * default DB path). A sibling rather than the DB's own directory — the point of
 * the exercise is that the agent's default scope does not contain the live DB
 * file.
 */
export const resolveAgentWorkingDirectory = (options: {
  readonly liveDbPath: string;
  /** Caller-supplied directory (a test harness); beats the env var. */
  readonly override?: string;
  readonly env?: NodeJS.ProcessEnv;
}): string => {
  const fromEnv = (options.env ?? process.env)[AGENT_WORKING_DIRECTORY_ENV_VAR];
  const override = options.override ?? fromEnv;
  if (override !== undefined && override.trim() !== "") return path.resolve(override.trim());
  return path.join(path.dirname(path.resolve(options.liveDbPath)), AGENT_WORKING_DIRECTORY_NAME);
};

/**
 * The two things a working directory must not be, checked rather than assumed
 * because both are silent when wrong and expensive when discovered late:
 *
 * - it must not **contain the live DB** (that is the directory whose files the
 *   ADR 0011 §3 snapshot exists to keep out of reach);
 * - it must not be **inside a git working tree** — the repo, or any checkout.
 *   A `.git` directory at or above the candidate is the cheap, reliable tell.
 */
export const assertUsableAgentWorkingDirectory = (workingDirectory: string, liveDbPath: string): void => {
  const resolved = path.resolve(workingDirectory);
  const resolvedDb = path.resolve(liveDbPath);

  if (path.dirname(resolvedDb) === resolved) {
    throw new AgentWorkingDirectoryError(
      `${resolved} is the live database's own directory (${resolvedDb}) — ADR 0011 §3 keeps the live DB out of a run's reach`,
    );
  }

  for (let dir = resolved; ; ) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      throw new AgentWorkingDirectoryError(`${resolved} is inside the git working tree rooted at ${dir}`);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
};

/**
 * Resolves, validates and creates the working directory, returning its path.
 * Called once at production boot so a misconfiguration fails the server rather
 * than surfacing as a strange run hours later.
 */
export const prepareAgentWorkingDirectory = (options: {
  readonly liveDbPath: string;
  readonly override?: string;
  readonly env?: NodeJS.ProcessEnv;
}): string => {
  const workingDirectory = resolveAgentWorkingDirectory(options);
  assertUsableAgentWorkingDirectory(workingDirectory, options.liveDbPath);
  fs.mkdirSync(workingDirectory, { recursive: true });
  const marker = path.join(workingDirectory, MARKER_FILE_NAME);
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, MARKER_CONTENTS, "utf8");
  return workingDirectory;
};
