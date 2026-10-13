// Moves `@anthropic-ai/claude-agent-sdk` to the newest release that is at
// least a day old. Run by `.github/workflows/agent-sdk-update.yml`; safe to run
// by hand from `thin-client/`, followed by `pnpm install`.
//
// Why bother: the Settings model picker persists family aliases (`opus`,
// `sonnet`, `haiku`) and the installed SDK decides which model each resolves
// to. 0.3.214 sent `opus` to Opus 4.8; 0.3.281 sends it to Opus 5.5. A stale
// SDK silently means a stale model (docs/ops/repcoach-server.md → *Models*).
//
// Why a day old: pnpm 11's `minimumReleaseAge` refuses anything younger, and
// that cooling-off window is the point of the guard. Picking an eligible
// version here means no `minimumReleaseAgeExclude` entry is ever needed, and
// any SDK entries left in that list from a hand-bump are dropped.
//
// Considers every plain x.y.z release, not just the `latest` dist-tag: new
// models have landed on `next` first (0.3.281) and the tag is not promoted on
// a schedule.
//
// Writes `current`, `target` and `bumped` to $GITHUB_OUTPUT when set.

import { execSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const PACKAGE = "@anthropic-ai/claude-agent-sdk";
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const MANIFEST = "apps/dev-server/package.json";
const WORKSPACE = "pnpm-workspace.yaml";

const npmView = (field) =>
  JSON.parse(execSync(`npm view ${PACKAGE} ${field} --json`, { encoding: "utf8" }));

const parse = (version) => version.split(".").map(Number);
const compare = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

const published = new Set(npmView("versions"));
const times = npmView("time");
const now = Date.now();

const eligible = Object.entries(times)
  .filter(([version]) => /^\d+\.\d+\.\d+$/.test(version) && published.has(version))
  .filter(([, time]) => now - Date.parse(time) >= MIN_AGE_MS)
  .map(([version]) => version)
  .sort(compare);
const target = eligible.at(-1);
if (target === undefined) throw new Error(`no ${PACKAGE} release is at least a day old`);

const manifest = readFileSync(MANIFEST, "utf8");
const rangePattern = new RegExp(`("${PACKAGE}":\\s*")\\^?(\\d+\\.\\d+\\.\\d+)(")`);
const match = manifest.match(rangePattern);
if (match === null) throw new Error(`${MANIFEST} does not pin ${PACKAGE} as ^x.y.z`);
const current = match[2];

const bumped = compare(target, current) > 0;
if (bumped) {
  writeFileSync(MANIFEST, manifest.replace(rangePattern, `$1^${target}$3`));

  // Drop SDK entries from `minimumReleaseAgeExclude`, and the key itself if
  // that empties it (an empty YAML key is `null`, which pnpm rejects).
  const workspace = readFileSync(WORKSPACE, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(`- '${PACKAGE}`))
    .join("\n")
    .replace(/^minimumReleaseAgeExclude:\r?\n(?:[ \t]*\r?\n)+/m, "");
  writeFileSync(WORKSPACE, workspace);
}

console.log(bumped ? `${PACKAGE}: ${current} -> ${target}` : `${PACKAGE}: ${current} is current (newest eligible: ${target})`);
if (process.env["GITHUB_OUTPUT"]) {
  appendFileSync(process.env["GITHUB_OUTPUT"], `current=${current}\ntarget=${target}\nbumped=${bumped}\n`);
}
