#!/bin/bash
#
# PreToolUse guardrail: blocks destructive git before it executes.
#
# Adapted from the `git-guardrails-claude-code` skill, with two deliberate
# divergences from the bundled script.
#
# 1. PUSHING is ALLOWED, master included. The overnight ticket runner
#    (.claude/skills/loop-me/workflows/overnight-ticket-runner.md) delivers its
#    work as a pushed branch plus a PR, and runs unattended under full
#    permission bypass — so the guardrail must distinguish "publish work" from
#    "rewrite history". It guards the second only.
#
#    Landing on master was blocked here originally; that rule was dropped
#    because the owner merges and pushes master routinely, and a guardrail
#    tripped by ordinary work teaches you to reach for the override. Force-push
#    remains blocked in every spelling, so a bad push to master is always
#    recoverable by moving the ref forward.
#
# 2. It does NOT use `jq`, which is not installed on this machine. The bundled
#    script shells out to jq unconditionally, so on this box it exited 0 on
#    every invocation — a guardrail that silently permitted everything it
#    claimed to block. Parsing is done with `node` instead, and the script
#    FAILS CLOSED: if the command cannot be extracted, it is blocked rather
#    than waved through. An unattended agent at 03:00 is exactly the case where
#    an unreadable input must not be assumed safe.

INPUT=$(cat)

COMMAND=$(printf '%s' "$INPUT" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const parsed = JSON.parse(raw);
      const cmd = parsed?.tool_input?.command;
      // A non-Bash/PowerShell tool has no `command`; nothing to inspect.
      process.stdout.write(typeof cmd === "string" ? cmd : "");
    } catch {
      process.exit(1);
    }
  });
' 2>/dev/null)

# Fail closed: node missing, or the payload did not parse.
if [ $? -ne 0 ]; then
  echo "BLOCKED: the git guardrail could not read the tool input, so the command was refused rather than assumed safe. Check that node is on PATH." >&2
  exit 2
fi

# An empty command means a tool with no command field — nothing to guard.
[ -z "$COMMAND" ] && exit 0

DANGEROUS_PATTERNS=(
  # History rewriting — never, in any position or spelling.
  "push.*--force"
  "push.*--force-with-lease"
  "push.*[[:space:]]-f([[:space:]]|$)"
  # Destroying uncommitted or committed work.
  "git reset --hard"
  "reset --hard"
  "git clean -fd"
  "git clean -f"
  "git branch -D"
  "git checkout \."
  "git restore \."
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if printf '%s' "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: '$COMMAND' matches dangerous pattern '$pattern'. The user has prevented you from doing this." >&2
    exit 2
  fi
done

exit 0
