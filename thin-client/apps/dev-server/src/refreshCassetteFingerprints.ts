import * as fs from "node:fs";
import * as path from "node:path";

import { DEFAULT_CASSETTE_DIR } from "./agentMode.ts";
import { agentPromptFingerprint } from "./agentPromptFingerprint.ts";
import { isAgentSessionStage } from "./agentTransport.ts";

/**
 * Restamps every cassette's `promptFingerprint` against this build's prompts
 * (issue #95).
 *
 *   pnpm --filter @repcoach/dev-server cassettes:restamp
 *
 * Replay refuses a cassette recorded against a different prompt scaffold, and
 * the normal answer to that refusal is to **re-record** against a live run
 * (`REPCOACH_AGENT_RECORD_DIR` — see docs/agents/testing.md). This is the other
 * answer, for a prompt change that provably cannot invalidate the recorded
 * replies: a typo, a reordered paragraph, a clarification that asks for the
 * same JSON in the same shape.
 *
 * Reach for it deliberately. A green suite over replies the model would no
 * longer give is exactly the silent rot the fingerprint exists to prevent, and
 * this is the one tool in the repo that can cause it.
 */
const dir = process.argv[2] ?? DEFAULT_CASSETTE_DIR;

let changed = 0;
for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".json"))) {
  const full = path.join(dir, name);
  const cassette = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>;
  const stage = cassette["stage"];
  if (typeof stage !== "string" || !isAgentSessionStage(stage)) {
    throw new Error(`${name}: "stage" is not one of the four agent stages`);
  }
  const fingerprint = agentPromptFingerprint(stage);
  if (cassette["promptFingerprint"] === fingerprint) continue;
  // eslint-disable-next-line no-console
  console.log(`${name}: ${String(cassette["promptFingerprint"])} -> ${fingerprint}`);
  fs.writeFileSync(
    full,
    `${JSON.stringify({ ...cassette, promptFingerprint: fingerprint }, null, 2)}\n`,
    "utf8",
  );
  changed += 1;
}

// eslint-disable-next-line no-console
console.log(
  changed === 0 ? "every cassette already matches this build's prompts" : `restamped ${changed} cassette(s)`,
);
