#!/bin/bash
#
# PreToolUse guardrail: blocks an agent from spending the owner's subscription
# quota on live Agent SDK sessions.
#
# The rule the owner stated: **live agents run when I ask, not when an agent
# decides to.** Live sessions bill against a weekly rate limit with no undo, so
# "the default is canned" is not enough — a default only stops an accident, and
# an agent that has read docs/agents/testing.md knows exactly which variable to
# set.
#
# Two families are blocked, because both spend and only the first is new:
#
# 1. `REPCOACH_AGENT_MODE=live` — the agent-backed e2e mode (#95). The
#    quota-free equivalent, `replay`, exercises the same real adapters against
#    recorded transcripts and is what an agent should reach for.
#
# 2. **Starting the production server** — `Start-RepcoachServer.ps1`,
#    `prodIndex.ts`, `dev-server start`, or the `commissioning` entry in
#    .claude/launch.json. This predates #95 and is the larger exposure: the
#    production wiring is live by construction, and merely BOOTING it opens
#    sessions before anyone drives a run — `RealModelCatalog` calls
#    `supportedModels()` on a live `query()`, and `QuotaServiceLive` polls the
#    plan's rate limits on a schedule.
#
# The ordinary dev-server (`pnpm --filter @repcoach/dev-server dev`), every
# test rung, and `REPCOACH_AGENT_MODE=replay` are all untouched: they wire the
# canned catalog and canned quota service and cannot open a session at all.
#
# Same two divergences from the bundled skill script as block-dangerous-git.sh:
# parsing is done with `node` (no jq on this machine), and it FAILS CLOSED — an
# input it cannot read is refused rather than waved through.
#
# The owner overrides by running the command themselves, in their own shell,
# where none of this applies. There is deliberately no in-band override phrase:
# an override an agent can type is not a guardrail.
#
# KNOWN FALSE POSITIVE, kept on purpose: this matches the *text* of a command,
# so merely WRITING the forbidden strings is blocked too — a `git commit -m`
# whose message quotes the variable, an `echo` of a doc line. Distinguishing
# "runs live" from "mentions live" needs a shell parser, and the failure modes
# are not symmetric: a guardrail that reasons its way to "this one is only a
# mention" is one prompt-injection away from being no guardrail. The workaround
# is ordinary practice anyway — put the text in a file and use `git commit -F`,
# or the Write tool.

INPUT=$(cat)

# Two tool shapes carry a live-run request: a shell command (`command`), and
# `preview_start`, whose launch.json config is named by `name`. Both are read,
# joined, and matched against the same patterns.
SUBJECT=$(printf '%s' "$INPUT" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const parsed = JSON.parse(raw);
      const input = parsed?.tool_input ?? {};
      const parts = [input.command, input.name, input.url].filter((v) => typeof v === "string");
      // Space-joined. It was a stray control byte here that made this script
      // binary to git — a hook nobody can read in a diff is a hook nobody
      // reviews, so the separator stays boring on purpose.
      process.stdout.write(parts.join(" "));
    } catch {
      process.exit(1);
    }
  });
' 2>/dev/null)

# Fail closed: node missing, or the payload did not parse.
if [ $? -ne 0 ]; then
  echo "BLOCKED: the live-agent guardrail could not read the tool input, so the call was refused rather than assumed safe. Check that node is on PATH." >&2
  exit 2
fi

# Nothing inspectable on this tool call.
[ -z "$SUBJECT" ] && exit 0

# `REPCOACH_AGENT_MODE=live` in every spelling that reaches a shell: bash
# assignment and prefix form, PowerShell `$env:` with either quote or none.
LIVE_MODE_PATTERNS=(
  "REPCOACH_AGENT_MODE[[:space:]]*=[[:space:]]*[\"']?live"
  "REPCOACH_AGENT_MODE[[:space:]]*=[[:space:]]*[\"']?live[\"']?"
)

# Starting the production server, by script, by package script, by entrypoint
# file, or by the launch.json config that wraps the script.
PRODUCTION_SERVER_PATTERNS=(
  "Start-RepcoachServer"
  "prodIndex"
  "dev-server[[:space:]]+start"
  "@repcoach/dev-server[[:space:]]+start"
  "commissioning"
)

for pattern in "${LIVE_MODE_PATTERNS[@]}"; do
  if printf '%s' "$SUBJECT" | grep -qiE "$pattern"; then
    echo "BLOCKED: this would run the agents in LIVE mode, which spends the owner's subscription quota. The owner has asked that live runs happen only when they ask for one. Use REPCOACH_AGENT_MODE=replay instead — same real adapters, recorded transcripts, no quota. If a live run is genuinely needed, say so and let the owner start it." >&2
    exit 2
  fi
done

for pattern in "${PRODUCTION_SERVER_PATTERNS[@]}"; do
  if printf '%s' "$SUBJECT" | grep -qiE "$pattern"; then
    echo "BLOCKED: this starts the PRODUCTION server, which wires the real Agent SDK agents and spends the owner's subscription quota just by booting (live model catalog, live quota poller, the cycle-review schedule). The owner starts this themselves. For a server to test against, use the dev-server: 'pnpm --filter @repcoach/dev-server dev'." >&2
    exit 2
  fi
done

exit 0
